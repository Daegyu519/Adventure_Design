"""Import separately generated variants into a PENDING review queue.

Input JSONL: candidate_id, draft, generator (human/rule:<version>/open-model:<revision+license>).
The generator runs separately, locally on the server; this module calls no external API.
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

from .data import REVIEW_FIELDS, read_jsonl


def propose(candidates_path: Path, variants_path: Path, output: Path) -> int:
    originals = read_jsonl(candidates_path)
    index = {r["candidate_id"]: r for r in originals}
    variants = read_jsonl(variants_path)
    pending = []
    seen = set()
    for variant in variants:
        cid, draft, generator = variant["candidate_id"], variant["draft"], variant["generator"]
        if cid not in index or not isinstance(draft, str) or not draft.strip():
            raise ValueError("variant must reference an exported candidate and contain text")
        if generator != "human" and not generator.startswith(("rule:", "open-model:")):
            raise ValueError("declare human/rule version/open model revision+license")
        if any(s in generator.lower() for s in ("chatgpt", "claude", "openai")):
            raise ValueError("disallowed training-data generator")
        key = (cid, draft)
        if key in seen or draft == index[cid]["original_reply"]:
            raise ValueError("duplicate variant")
        seen.add(key)
        pending.append({"candidate_id": cid, "draft": draft, "generator": generator, "status": "pending"})
    # A new CSV, never overwrite an existing human review.
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=REVIEW_FIELDS)
        writer.writeheader()
        for row in originals:
            writer.writerow({"candidate_id": row["candidate_id"], "draft": row["original_reply"],
                             "generator": "original", "status": "pending"})
        writer.writerows(pending)
    return len(pending)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--variants", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(f"pending variants: {propose(args.candidates, args.variants, args.output)}")


if __name__ == "__main__":
    main()
