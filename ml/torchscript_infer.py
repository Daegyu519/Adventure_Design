"""Standalone exported-model inference: no PyTorch reference checkpoint needed."""
import argparse
import json
import math
import time
from pathlib import Path

from .model import device_for, encode


class ScriptPredictor:
    def __init__(self, exported: Path, device="cpu"):
        import torch
        from transformers import AutoTokenizer
        self.device = device_for(device)
        self.metadata = json.loads((exported / "pipeline.json").read_text(encoding="utf-8"))
        self.tokenizer = AutoTokenizer.from_pretrained(exported, local_files_only=True)
        self.model = torch.jit.load(str(exported / "model.ts"), map_location=self.device).eval()

    def predict(self, row):
        import torch
        if self.device.type == "cuda":
            torch.cuda.synchronize()
        started = time.perf_counter()
        tokens = self.tokenizer.pad([encode(self.tokenizer, row, self.metadata["max_length"],input_format=self.metadata.get("input_format","legacy-v1"))],
                                     return_tensors="pt").to(self.device)
        with torch.inference_mode():
            score = self.model(tokens["input_ids"], tokens["attention_mask"], tokens["token_type_ids"]).softmax(-1)[0, 1].item()
        if not math.isfinite(score) or not 0 <= score <= 1:
            raise RuntimeError("invalid exported score")
        if self.device.type == "cuda":
            torch.cuda.synchronize()
        return score, (time.perf_counter() - started) * 1000


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--export", type=Path, required=True)
    p.add_argument("--input-json", type=Path, required=True)
    p.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    args = p.parse_args()
    predictor = ScriptPredictor(args.export, args.device)
    score, latency = predictor.predict(json.loads(args.input_json.read_text(encoding="utf-8-sig")))
    print(json.dumps({"cold_score": score, "model_id": predictor.metadata["model"], "latency_ms": latency,
                      "format": "TorchScript", "label_mode": predictor.metadata.get("label_mode"),
                      "interpretation": "Uncalibrated experimental weak-label score; human accuracy unvalidated."}))


if __name__ == "__main__":
    main()
