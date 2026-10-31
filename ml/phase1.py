"""Reproducible cold weak-label training, reload, benchmark, evaluation and export."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from .data import read_jsonl, write_json
from .demo import validate_gpu


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--gpu", required=True, help="one GPU explicitly authorized by the owner")
    p.add_argument("--root", type=Path, default=Path("/root/p14-data"))
    p.add_argument("--workdir", type=Path, required=True)
    p.add_argument("--epochs", type=int, default=4)
    p.add_argument("--max-steps", type=int, default=512)
    args = p.parse_args()
    os.environ.update(CUDA_DEVICE_ORDER="PCI_BUS_ID", CUDA_VISIBLE_DEVICES=validate_gpu(args.gpu),
                      TOKENIZERS_PARALLELISM="false", PYTHONIOENCODING="utf-8")
    root, out = args.root.resolve(), args.workdir.resolve()
    if (out.is_relative_to(root) or any(x in {"tone-chat-deploy", "tone-chat-llm"} for x in out.parts)):
        raise ValueError("output must be outside original data and production directories")
    out.mkdir(parents=True, exist_ok=False)
    source = Path(__file__).resolve().parent.parent
    stages = []
    phase = "preflight"

    def run(name, module, *options):
        nonlocal phase
        phase = name
        with (out / (name + ".log")).open("w", encoding="utf-8") as stream:
            subprocess.run([sys.executable, "-m", module, *map(str, options)], cwd=source,
                           stdout=stream, stderr=subprocess.STDOUT, check=True)
        stages.append(name)

    from .model import device_for
    from .telemetry import Monitor
    try:
        device_for("cuda")
        with Monitor(args.gpu, out / "gpu.jsonl"):
            run("data", "ml.cold_data", "--root", root, "--output", out / "data")
            run("training", "ml.train", "--train", out / "data/train.jsonl", "--validation", out / "data/validation.jsonl",
                "--output", out / "training", "--device", "cuda", "--label-mode", "cold-weak", "--epochs", args.epochs,
                "--max-steps", args.max_steps, "--batch-size", 2, "--accumulation", 4)
            checkpoint = out / "training/model"
            row = read_jsonl(out / "data/validation.jsonl")[0]
            write_json(out / "inference-input.json", {k: row[k] for k in ("relation", "context", "last_them", "draft")})
            run("inference", "ml.infer", "--checkpoint", checkpoint, "--input-json", out / "inference-input.json",
                "--device", "cuda", "--warmup", 10, "--runs", 100, "--output", out / "latency.json")
            run("evaluation", "ml.evaluate", "--checkpoint", checkpoint, "--data", out / "data/validation.jsonl",
                "--label-mode", "cold-weak", "--device", "cuda", "--output", out / "reevaluation.json")
            run("contrast", "ml.contrast", "--checkpoint", checkpoint, "--device", "cuda", "--output", out / "contrast.json")
            run("export", "ml.export", "--checkpoint", checkpoint, "--output", out / "export",
                "--inputs", out / "data/validation.jsonl", "--device", "cpu")
        write_json(out / "summary.json", {"status": "complete", "stages": stages, "checkpoint": str(checkpoint),
                                          "label_mode": "cold-weak", "human_reviewed": 0})
    except Exception as error:
        write_json(out / "failure.json", {"status": "failed", "phase": phase, "passed": stages,
                                          "error_type": type(error).__name__})
        raise


if __name__ == "__main__":
    main()
