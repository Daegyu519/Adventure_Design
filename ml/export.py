"""TorchScript export plus fresh-process verification on held-out real inputs."""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

from .data import read_jsonl, write_json
from .model import Predictor, encode


def verify(checkpoint: Path, exported: Path, inputs: Path, device: str) -> dict:
    import torch
    predictor = Predictor(checkpoint, device)
    script = torch.jit.load(str(exported / "model.ts"), map_location=predictor.device).eval()
    rows = read_jsonl(inputs)[:8]
    if len(rows) < 2:
        raise ValueError("two or more held-out inputs required")
    comparisons = []
    for batch in [rows[:1], rows[:2], rows]:
        tokens = predictor.tokenizer.pad([encode(predictor.tokenizer, r, predictor.metadata["max_length"], input_format=predictor.metadata.get("input_format","legacy-v1"))
                                          for r in batch], return_tensors="pt").to(predictor.device)
        with torch.inference_mode():
            reference = predictor.model(**tokens).logits.softmax(-1)[:, 1]
            actual = script(tokens["input_ids"], tokens["attention_mask"], tokens["token_type_ids"]).softmax(-1)[:, 1]
        error = float((reference - actual).abs().max())
        if not math.isfinite(error) or error > 1e-5:
            raise RuntimeError("TorchScript parity failed")
        comparisons.append({"batch": len(batch), "length": tokens["input_ids"].shape[1], "max_abs_error": error})
    return {"status": "passed", "format": "TorchScript", "fresh_process": True,
            "device": device, "comparisons": comparisons, "tolerance": 1e-5}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    if args.verify_only:
        result = verify(args.checkpoint, args.output, args.inputs, args.device)
        write_json(args.output / "verification.json", result)
        print(json.dumps(result))
        return
    import torch
    predictor = Predictor(args.checkpoint, args.device)
    if args.output.exists():
        raise ValueError("use a new export directory")
    args.output.mkdir(parents=True)
    row = read_jsonl(args.inputs)[0]
    tokens = predictor.tokenizer.pad([encode(predictor.tokenizer, row, predictor.metadata["max_length"], input_format=predictor.metadata.get("input_format","legacy-v1"))],
                                     return_tensors="pt").to(predictor.device)

    class Wrapper(torch.nn.Module):
        def __init__(self, model):
            super().__init__()
            self.model = model
        def forward(self, ids, mask, types):
            return self.model(input_ids=ids, attention_mask=mask, token_type_ids=types, return_dict=False)[0]

    with torch.inference_mode():
        traced = torch.jit.trace(Wrapper(predictor.model).eval(),
                                 (tokens["input_ids"], tokens["attention_mask"], tokens["token_type_ids"]))
        torch.jit.save(traced, str(args.output / "model.ts"))
    predictor.tokenizer.save_pretrained(args.output)
    write_json(args.output / "pipeline.json", predictor.metadata)
    del predictor, traced
    subprocess.run([sys.executable, "-m", "ml.export", "--verify-only", "--checkpoint", str(args.checkpoint),
                    "--output", str(args.output), "--inputs", str(args.inputs), "--device", args.device], check=True)


if __name__ == "__main__":
    main()
