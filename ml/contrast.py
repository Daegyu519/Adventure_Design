"""Evaluate frozen ToneChat alert labels as an imperfect proxy for coldness."""
import argparse
from collections import defaultdict
from pathlib import Path

from .data import read_jsonl, write_json
from .model import Predictor, metrics


def evaluate_contrast(predictor, rows):
    scores = []
    pairs = defaultdict(dict)
    for row in rows:
        score, _ = predictor.predict({"relation": row["relation"], "last_them": row["them"],
                                       "context": [], "draft": row["draft"]})
        scores.append(score)
        pairs[row["pair"]][row["side"]] = score
    result = metrics([int(r["alert"]) for r in rows], scores, .5)
    result.update({"source": "eval/contrast_set.jsonl", "threshold_policy": "fixed 0.5; no tuning",
                   "context_ordered": sum(p["B"] > p["A"] for p in pairs.values()),
                   "context_split": sum(p["A"] < .5 <= p["B"] for p in pairs.values()),
                   "pairs": len(pairs), "pair_scores": dict(pairs),
                   "limitation": "16 alert labels in 8 pairs; alert is not a coldness label; preliminary proxy only"})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--data", type=Path, default=Path("eval/contrast_set.jsonl"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    args = parser.parse_args()
    result = evaluate_contrast(Predictor(args.checkpoint, args.device), read_jsonl(args.data))
    write_json(args.output, result)
    print(__import__("json").dumps(result))


if __name__ == "__main__":
    main()
