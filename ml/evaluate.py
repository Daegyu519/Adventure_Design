"""Re-evaluate an approved AI-Hub validation split with a saved model."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .data import read_jsonl, validate_rows
from .model import Predictor, evaluate


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--label-mode", choices=["reviewed", "weak-demo", "cold-weak"], default="reviewed")
    args = parser.parse_args()
    rows = read_jsonl(args.data)
    if args.label_mode == "reviewed":
        validate_rows(rows, "validation")
    elif args.label_mode == "cold-weak":
        from .cold_data import audit
        # Audit validation with its original train split to detect provenance leakage.
        audit(read_jsonl(args.data.parent / "train.jsonl"), rows)
    else:
        from .weak import validate_weak
        validate_weak(rows, "validation")
    predictor = Predictor(args.checkpoint, args.device)
    result = evaluate(predictor, rows, args.output, predictor.metadata["threshold"])
    result["label_mode"] = args.label_mode
    from .data import write_json
    write_json(args.output, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
