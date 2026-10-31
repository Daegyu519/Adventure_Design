"""One-command real data -> weak labels -> training -> saved-model CLI verification."""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from .data import CONFIG, read_jsonl, write_json


def validate_gpu(gpu: str) -> str:
    if not re.fullmatch(r"[0-7]", gpu):
        raise ValueError("pass exactly ONE approved physical GPU index (0..7), never a list")
    return gpu


def run_demo(args: argparse.Namespace) -> dict:
    # Set visibility BEFORE any torch/transformers import, including CUDA checks.
    if args.device == "cuda":
        os.environ["CUDA_DEVICE_ORDER"] = "PCI_BUS_ID"
        os.environ["CUDA_VISIBLE_DEVICES"] = validate_gpu(args.gpu)
    from .model import device_for
    device_for(args.device)  # Fail fast, never silently fall back to CPU.
    output = args.workdir.resolve()
    if any(part.lower() in {"tone-chat-deploy", "tone-chat-llm"} for part in output.parts):
        raise ValueError("demo output must be outside production service folders")
    if output.is_relative_to(args.root.resolve()):
        raise ValueError("demo output must be outside the original data directory")
    output.mkdir(parents=True, exist_ok=False)
    os.environ.setdefault("HF_HOME", str(output.parent / "hf-cache"))
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["PYTHONIOENCODING"] = "utf-8"
    source_root = Path(__file__).resolve().parent.parent
    phase = "preflight"

    def command(name: str, argv: list[str]) -> None:
        nonlocal phase
        phase = name
        print(json.dumps({"phase": phase, "status": "running"}), flush=True)
        with (output / f"{name}.log").open("w", encoding="utf-8") as log:
            subprocess.run([sys.executable, *argv], cwd=source_root, env=os.environ.copy(),
                           stdout=log, stderr=subprocess.STDOUT, check=True)
        print(json.dumps({"phase": phase, "status": "passed"}), flush=True)

    from .telemetry import Monitor
    monitor = Monitor(args.gpu, output / "gpu.jsonl") if args.device == "cuda" else contextlib.nullcontext()
    try:
        with monitor:
            if not args.skip_tests:
                command("tests", ["-m", "pytest", "ml/tests", "-q", "-W", "error", "--basetemp", str(output / "tests-temp")])
            command("data", ["-m", "ml.weak", "--root", str(args.root.resolve()), "--output", str(output / "data"),
                             "--train-size", str(args.train_size), "--validation-size", str(args.validation_size)])
            # CPU/small-model option is explicit for local tests; default is real KcELECTRA CUDA.
            model_args = ["--model", args.model] if args.model else []
            revision_args = ["--revision", args.revision] if args.revision else []
            command("training", ["-m", "ml.train", "--train", str(output / "data/train.jsonl"),
                                  "--validation", str(output / "data/validation.jsonl"), "--output", str(output / "training"),
                                  "--device", args.device, "--label-mode", "weak-demo", "--batch-size", str(args.batch_size),
                                  "--accumulation", "8", "--epochs", str(args.epochs), "--max-steps", str(args.max_steps),
                                  *model_args, *revision_args])
            checkpoint = output / "training/model"
            # Unattended CLI smoke uses an actual held-out source row, never invented text.
            selected = read_jsonl(output / "data/validation.jsonl")[0]
            write_json(output / "demo_input.json", {k: selected[k] for k in ("relation", "context", "last_them", "draft")})
            command("inference", ["-m", "ml.infer", "--checkpoint", str(checkpoint), "--device", args.device,
                                   "--input-json", str(output / "demo_input.json"), "--warmup", "5", "--runs", "30",
                                   "--output", str(output / "latency.json")])
            command("reevaluation", ["-m", "ml.evaluate", "--checkpoint", str(checkpoint), "--device", args.device,
                                      "--label-mode", "weak-demo", "--data", str(output / "data/validation.jsonl"),
                                      "--output", str(output / "reevaluation.json")])
            run = json.loads((output / "training/run.json").read_text(encoding="utf-8"))
            reevaluation = json.loads((output / "reevaluation.json").read_text(encoding="utf-8"))
            if run["evaluation"]["confusion_matrix"] != reevaluation["confusion_matrix"]:
                raise RuntimeError("independent saved-model reevaluation mismatch")
            summary = {"status": "complete", "device": run["device"], "gpu": run["gpu"],
                       "label_mode": "weak-demo", "claim": "weak proxy pipeline demo; NOT human tone accuracy",
                       "checkpoint": str(checkpoint), "optimizer_steps": run["optimizer_steps"],
                       "weight_max_abs_delta": run["weight_max_abs_delta"], "reload_error": run["reload_absolute_error"],
                       "evaluation": run["evaluation"], "latency": json.loads((output / "latency.json").read_text(encoding="utf-8")),
                       "created_utc": datetime.now(timezone.utc).isoformat()}
            write_json(output / "summary.json", summary)
        return summary
    except Exception as error:
        write_json(output / "failure.json", {"phase": phase, "error_type": type(error).__name__,
                                               "status": "failed", "note": "inspect phase log; no success result fabricated"})
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gpu", help="the ONE physical GPU index explicitly approved for this run")
    parser.add_argument("--root", type=Path, default=Path("/root/p14-data"))
    parser.add_argument("--workdir", type=Path, default=Path("/root/p14-work") / ("auto-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")))
    parser.add_argument("--train-size", type=int, default=1024)
    parser.add_argument("--validation-size", type=int, default=256)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--max-steps", type=int, default=64)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cuda")
    parser.add_argument("--model", help="default: config.json KcELECTRA; local tiny model only for explicit CPU smoke tests")
    parser.add_argument("--revision")
    parser.add_argument("--skip-tests", action="store_true")
    args = parser.parse_args()
    if args.device == "cuda" and not args.gpu:
        if not sys.stdin.isatty():
            parser.error("--gpu must specify the approved GPU index in unattended runs")
        args.gpu = input("승인받은 GPU 번호(1개): ").strip()
    print(json.dumps(run_demo(args), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
