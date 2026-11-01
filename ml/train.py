"""Single-device Transformers sequence classification fine tuning (FP32)."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import random
from pathlib import Path

from .data import CONFIG, audit, read_jsonl, write_json
from .model import Predictor, device_for, encode, evaluate


def file_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def epoch_evaluate(model, tokenizer, rows: list[dict], max_length: int, device, batch_size: int, input_format="legacy-v1") -> dict:
    """Fixed-threshold monitoring only. Preserve training mode, parameters and labels."""
    import torch
    from .model import metrics
    scores = []
    was_training = model.training
    try:
        model.eval()
        with torch.inference_mode():
            for start in range(0, len(rows), batch_size):
                batch = tokenizer.pad([encode(tokenizer, r, max_length,input_format=input_format) for r in rows[start:start+batch_size]],
                                      return_tensors="pt").to(device)
                scores.extend(model(**batch).logits.softmax(-1)[:, 1].cpu().tolist())
    finally:
        model.train(was_training)
    labels = [r["label"] for r in rows]
    result = metrics(labels, scores, .5)
    matrix = result["confusion_matrix"]
    result["recall_by_class"] = {str(k): matrix[k][k] / sum(matrix[k]) if sum(matrix[k]) else None for k in (0, 1)}
    result["score_by_true_class"] = {}
    for k in (0, 1):
        values = [s for y, s in zip(labels, scores) if y == k]
        result["score_by_true_class"][str(k)] = {"mean": sum(values)/len(values), "min": min(values), "max": max(values)} if values else None
    return result


def train(args: argparse.Namespace) -> dict:
    import numpy as np
    import torch
    import transformers
    from torch.utils.data import DataLoader
    from transformers import AutoModelForSequenceClassification, AutoTokenizer, DataCollatorWithPadding

    if min(args.epochs, args.batch_size, args.accumulation, args.max_steps) < 1 or args.learning_rate <= 0:
        raise ValueError("positive training settings required")
    if args.output.exists() and any(args.output.iterdir()):
        raise ValueError("output must be empty; use a new run directory")
    if int(os.environ.get("WORLD_SIZE", "1")) != 1:
        raise ValueError("single-device script; do not use torchrun")
    device = device_for(args.device)
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    seed = config["seed"]
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if device.type == "cuda":
        torch.cuda.manual_seed_all(seed)
        torch.backends.cudnn.benchmark = False
    train_rows, val_rows = read_jsonl(args.train), read_jsonl(args.validation)
    label_mode = getattr(args, "label_mode", "reviewed")
    if label_mode == "weak-demo":
        from .weak import weak_audit
        data_audit = weak_audit(train_rows, val_rows)
    elif label_mode == "cold-weak":
        from .cold_data import audit as cold_audit
        data_audit = cold_audit(train_rows, val_rows)
    elif label_mode == "reviewed":
        data_audit = audit(train_rows, val_rows)
    else:
        raise ValueError("invalid label mode")
    if any(data_audit[s]["same_reply_opposite_labels"] == 0 for s in ("train", "validation")):
        raise ValueError("include reviewed same-reply/different-context examples of both labels in each split")
    tokenizer = AutoTokenizer.from_pretrained(args.model or config["model"], revision=args.revision or config["revision"])
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model or config["model"], revision=args.revision or config["revision"], num_labels=2,
        id2label={0: "ordinary", 1: "possibly_cold"}, label2id={"ordinary": 0, "possibly_cold": 1},
    ).to(device)
    if config["max_length"] > model.config.max_position_embeddings:
        raise ValueError("max_length exceeds model capacity")
    input_format = getattr(args,"input_format","legacy-v1")
    encoded = [{**encode(tokenizer, row, config["max_length"],input_format=input_format), "labels": row["label"]} for row in train_rows]
    loader = DataLoader(encoded, batch_size=args.batch_size, shuffle=True, num_workers=0,
                        generator=torch.Generator().manual_seed(seed), collate_fn=DataCollatorWithPadding(tokenizer))
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=0.01)
    # Track a FULL encoder matrix and classifier matrix, not only a changing head.
    encoder_name, encoder_parameter = next((n, p) for n, p in model.named_parameters()
                                           if n.startswith(model.base_model_prefix + ".") and p.ndim == 2 and p.requires_grad)
    head_name, head_parameter = next((n, p) for n, p in model.named_parameters()
                                     if not n.startswith(model.base_model_prefix + ".") and p.ndim == 2 and p.requires_grad)
    initial = {encoder_name: encoder_parameter.detach().cpu().clone(), head_name: head_parameter.detach().cpu().clone()}
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats()
    args.output.mkdir(parents=True, exist_ok=True)
    step, logs = 0, []
    optimizer.zero_grad(set_to_none=True)
    for epoch in range(args.epochs):
        model.train()
        window_loss = 0.0
        for batch_index, batch in enumerate(loader):
            window_start = batch_index // args.accumulation * args.accumulation
            window_examples = min(args.accumulation * args.batch_size,
                                  len(encoded) - window_start * args.batch_size)
            batch = {key: value.to(device) for key, value in batch.items()}
            loss = model(**batch).loss
            if not torch.isfinite(loss):
                raise RuntimeError("non-finite training loss")
            weight = len(batch["labels"]) / window_examples
            (loss * weight).backward()
            window_loss += float(loss.detach()) * weight
            if (batch_index + 1) % args.accumulation == 0 or batch_index + 1 == len(loader):
                grad_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0, error_if_nonfinite=True)
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)
                step += 1
                record = {"step": step, "epoch": epoch + 1, "loss": window_loss, "grad_norm": float(grad_norm)}
                if device.type == "cuda":
                    record.update(cuda_allocated_mb=torch.cuda.memory_allocated() / 2**20,
                                  cuda_reserved_mb=torch.cuda.memory_reserved() / 2**20,
                                  cuda_peak_allocated_mb=torch.cuda.max_memory_allocated() / 2**20)
                logs.append(record)
                with (args.output / "loss.jsonl").open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(record) + "\n")
                print(json.dumps(record), flush=True)
                window_loss = 0.0
                if step >= args.max_steps:
                    break
        if getattr(args, "epoch_metrics", False):
            epoch_record = {"epoch": epoch + 1, "optimizer_steps": step,
                            "train": epoch_evaluate(model, tokenizer, train_rows, config["max_length"], device, args.batch_size,input_format),
                            "validation": epoch_evaluate(model, tokenizer, val_rows, config["max_length"], device, args.batch_size,input_format),
                            "threshold_policy": "fixed 0.5; monitor only; no checkpoint/threshold selection"}
            with (args.output / "epoch_metrics.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(epoch_record) + "\n")
        if step >= args.max_steps:
            break
    parameters = dict(model.named_parameters())
    changes = {name: float((parameters[name].detach().cpu() - before).abs().max()) for name, before in initial.items()}
    if step == 0 or not all(math.isfinite(delta) and delta > 0 for delta in changes.values()):
        raise RuntimeError("could not prove encoder and head weight updates")
    checkpoint = args.output / "model"
    model.save_pretrained(checkpoint, safe_serialization=True)
    tokenizer.save_pretrained(checkpoint)
    metadata = {**config, "model": args.model or config["model"], "requested_revision": args.revision or config["revision"],
                "resolved_commit": getattr(model.config, "_commit_hash", None), "threshold": 0.5,
                "input_format": input_format,
                "claim": "technical_validation_only", "label_mode": label_mode,
                "label_map": {"0": "ordinary", "1": "possibly_cold"}}
    write_json(checkpoint / "pipeline.json", metadata)
    # Separate optimizer artifact enables inspection without polluting inference files.
    torch.save({"optimizer": optimizer.state_dict(), "step": step, "seed": seed}, args.output / "optimizer.pt")
    model.eval()
    batch = tokenizer.pad([encode(tokenizer, val_rows[0], config["max_length"],input_format=input_format)], return_tensors="pt").to(device)
    with torch.inference_mode():
        before_reload = model(**batch).logits.softmax(-1)[0, 1].item()
    gpu_memory = {"peak_allocated_mb": torch.cuda.max_memory_allocated() / 2**20,
                  "peak_reserved_mb": torch.cuda.max_memory_reserved() / 2**20} if device.type == "cuda" else None
    del model, optimizer, parameters, encoder_parameter, head_parameter, batch, loss
    if device.type == "cuda":
        torch.cuda.empty_cache()
    predictor = Predictor(checkpoint, args.device)
    after_reload = predictor.predict(val_rows[0])[0]
    if not math.isclose(before_reload, after_reload, abs_tol=1e-6):
        raise RuntimeError("checkpoint reload changed prediction")
    evaluation = evaluate(predictor, val_rows, args.output / "evaluation.json")
    if label_mode == "weak-demo":
        from .diagnostics import diagnostics
        diagnostics(train_rows, val_rows, predictor, args.output / "weak_diagnostics.json")
    report = {"device": str(device), "gpu": torch.cuda.get_device_name(0) if device.type == "cuda" else None,
              "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES"), "torch": torch.__version__,
              "cuda_device_order": os.environ.get("CUDA_DEVICE_ORDER"),
              "cuda_runtime": torch.version.cuda, "transformers": transformers.__version__, "python": platform.python_version(),
              "precision": "fp32", "gpu_memory": gpu_memory, "label_mode": label_mode,
              "optimizer_steps": step, "weight_max_abs_delta": changes,
              "planned_epoch_steps": math.ceil(len(loader) / args.accumulation) * args.epochs,
              "requested_max_steps": args.max_steps,
              "termination_reason": "max_steps" if step >= args.max_steps else "epochs_exhausted",
              "reload_absolute_error": abs(before_reload - after_reload),
              "train_sha256": file_sha(args.train), "validation_sha256": file_sha(args.validation),
              "settings": {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
              "data_audit": data_audit, "evaluation": evaluation, "model": metadata,
              "limitations": "Technical pipeline demonstration only; independent human evaluation pending."}
    write_json(args.output / "run.json", report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--train", type=Path, required=True)
    parser.add_argument("--validation", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cuda")
    parser.add_argument("--model")
    parser.add_argument("--revision")
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--max-steps", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--accumulation", type=int, default=4)
    parser.add_argument("--learning-rate", type=float, default=2e-5)
    parser.add_argument("--epoch-metrics", action="store_true", help="record train/validation scores and class recall after each epoch")
    parser.add_argument("--input-format", choices=["legacy-v1","context-pair-v2"], default="legacy-v1",
                        help="v2 explicitly inserts CLS/SEP; requires NEW training, never reinterpret old checkpoints")
    parser.add_argument("--label-mode", choices=["reviewed", "weak-demo", "cold-weak"], default="reviewed",
                        help="weak-demo requires unreviewed, explicitly marked paired heuristic data")
    print(json.dumps(train(parser.parse_args()), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
