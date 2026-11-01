"""P-14b: KcELECTRA fine tuning on SOFT teacher labels (cross entropy against [1-s, s]).

Same checkpoint layout as ml.train (pipeline.json + HF model), so ml.model.Predictor,
ml.export and ml.torchscript_infer work unchanged. Early stopping on validation soft loss.
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from .data import CONFIG, read_jsonl, write_json
from .model import Predictor, device_for, encode, metrics

FORMAT = "context-pair-v2"


def soft_loss(logits, soft):
    import torch
    return -(torch.stack([1 - soft, soft], -1) * logits.log_softmax(-1)).sum(-1).mean()


def batches(tokenizer, rows, max_length, size, shuffle, rng):
    order = list(range(len(rows)))
    if shuffle:
        rng.shuffle(order)
    for i in range(0, len(order), size):
        chunk = [rows[j] for j in order[i:i + size]]
        enc = tokenizer.pad([encode(tokenizer, r, max_length, input_format=FORMAT) for r in chunk], return_tensors="pt")
        yield enc, [r["soft"] for r in chunk]


def run(args: argparse.Namespace) -> dict:
    import copy
    import numpy as np
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    if args.output.exists() and any(args.output.iterdir()):
        raise ValueError("output must be empty")
    rng = random.Random(cfg["seed"])
    torch.manual_seed(cfg["seed"])
    device = device_for(args.device)
    train, val = read_jsonl(args.train), read_jsonl(args.validation)
    tok = AutoTokenizer.from_pretrained(cfg["model"], revision=cfg["revision"])
    model = AutoModelForSequenceClassification.from_pretrained(
        cfg["model"], revision=cfg["revision"], num_labels=2,
        id2label={0: "ordinary", 1: "possibly_cold"}, label2id={"ordinary": 0, "possibly_cold": 1}).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    total = args.epochs * -(-len(train) // args.batch_size)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / (0.06 * total)) * max(0.0, (total - s) / total))

    def val_pass():
        model.eval()
        losses, probs = [], []
        with torch.inference_mode():
            for enc, soft in batches(tok, val, args.max_length, 32, False, rng):
                logits = model(**enc.to(device)).logits
                s = torch.tensor(soft, device=device)
                losses.append(float(soft_loss(logits, s)) * len(soft))
                probs += logits.softmax(-1)[:, 1].cpu().tolist()
        return sum(losses) / len(val), probs

    best, best_state, history, bad = 1e9, None, [], 0
    for epoch in range(args.epochs):
        model.train()
        for enc, soft in batches(tok, train, args.max_length, args.batch_size, True, rng):
            loss = soft_loss(model(**enc.to(device)).logits, torch.tensor(soft, device=device))
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step(); sched.step(); opt.zero_grad(set_to_none=True)
        vloss, probs = val_pass()
        m = metrics([r["label"] for r in val], probs, .5)
        history.append({"epoch": epoch + 1, "val_soft_loss": vloss, "p@.5": m["precision"], "r@.5": m["recall"]})
        print(json.dumps(history[-1]), flush=True)
        if vloss < best:
            best, bad = vloss, 0
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
        else:
            bad += 1
            if bad >= args.patience:
                break
    model.load_state_dict(best_state)
    ckpt = args.output / "model"
    model.save_pretrained(ckpt, safe_serialization=True)
    tok.save_pretrained(ckpt)
    write_json(ckpt / "pipeline.json", {**cfg, "max_length": args.max_length, "threshold": 0.5, "input_format": FORMAT,
                                        "label_mode": "teacher-soft", "label_map": {"0": "ordinary", "1": "possibly_cold"},
                                        "claim": "weak teacher labels; not human validated"})
    del model, opt
    probs = Predictor(ckpt, args.device).predict_batch(val[:64])
    result = {"history": history, "best_val_soft_loss": best, "train_rows": len(train), "val_rows": len(val),
              "reload_ok": len(probs) == min(64, len(val))}
    write_json(args.output / "run.json", result)
    return result


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--train", type=Path, required=True)
    p.add_argument("--validation", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--device", choices=["cpu", "cuda"], default="cuda")
    p.add_argument("--epochs", type=int, default=4)
    p.add_argument("--batch-size", type=int, default=16)
    p.add_argument("--lr", type=float, default=3e-5)
    p.add_argument("--max-length", type=int, default=192)
    p.add_argument("--patience", type=int, default=1)
    print(json.dumps(run(p.parse_args()), indent=1))


if __name__ == "__main__":
    main()
