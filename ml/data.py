"""ZIP -> unlabeled candidates -> independently reviewed examples.

No rating, emotion, response length or generation rule assigns a tone label.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterator
from zipfile import ZipFile

CONFIG = Path(__file__).with_name("config.json")
REVIEW_FIELDS = ["candidate_id", "draft", "generator", "label", "status", "reviewer", "rationale"]


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")


def documents(root: Path, stats: Counter) -> Iterator[tuple[dict, dict]]:
    """Recursive, case insensitive ZIP/JSON discovery. Fail on corrupt data."""
    archives = sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() == ".zip")
    if not archives:
        raise ValueError(f"no ZIP files: {root}")
    for archive in archives:
        stats["zip_files"] += 1
        with ZipFile(archive) as zipped:
            for member in sorted(zipped.namelist()):
                if not member.lower().endswith(".json"):
                    continue
                try:
                    raw = zipped.read(member)
                    obj = json.loads(raw.decode("utf-8-sig"))
                    if not isinstance(obj, dict) or not isinstance(obj["utterances"], list):
                        raise ValueError("invalid conversation")
                    if not isinstance(obj["info"]["id"], str) or not obj["info"]["id"].strip():
                        raise ValueError("missing conversation ID")
                except Exception as error:
                    raise ValueError(f"invalid source: {archive.name}/{member}: {type(error).__name__}") from error
                stats["conversations"] += 1
                yield obj, {"dataset": "AI-Hub-046", "zip": archive.relative_to(root).as_posix(),
                            "member": member, "json_sha256": hashlib.sha256(raw).hexdigest()}


def candidates(obj: dict, source: dict, split: str, context_turns: int = 8) -> Iterator[dict]:
    if context_turns < 1:
        raise ValueError("context_turns must be positive")
    info = obj["info"]
    history: list[dict] = []
    last_them = ""
    for index, turn in enumerate(obj["utterances"]):
        role, text = turn["role"], turn["text"]
        if role not in {"speaker", "listener"} or not isinstance(text, str) or not text.strip():
            raise ValueError("invalid utterance role/text")
        if role == "listener":
            if not last_them:
                raise ValueError("listener without previous speaker")
            yield {"candidate_id": f"{info['id']}:{index}", "conversation_id": str(info["id"]),
                   "split": split, "relation": info.get("relation", "미상"),
                   "speaker_emotion": info.get("speaker_emotion"), "situation": info.get("situation"),
                   "context": history[-context_turns:], "last_them": last_them,
                   "original_reply": text, "source": source, "utterance_index": index,
                   "label": None, "review_status": "pending"}
        else:
            last_them = text
        history.append({"role": "them" if role == "speaker" else "me", "text": text})


def prepare(root: Path, output: Path, limit: int = 0) -> dict:
    """limit samples export only; scan ALL sources to audit split identity/counts."""
    if limit < 0:
        raise ValueError("limit must be nonnegative")
    if output.exists() and any(output.iterdir()):
        raise ValueError("output must be empty; existing human reviews are protected")
    output.mkdir(parents=True, exist_ok=True)
    seen: dict[str, str] = {}
    manifest: dict = {"dataset": "AI-Hub-046", "root": str(root.resolve()), "splits": {}}
    turns = json.loads(CONFIG.read_text(encoding="utf-8"))["context_turns"]
    for split in ("train", "validation"):
        stats: Counter = Counter()
        rows = []
        for obj, source in documents(root / split, stats):
            cid = str(obj["info"]["id"])
            if cid in seen:
                raise ValueError(f"duplicate conversation ID: {cid} ({seen[cid]}, {split})")
            seen[cid] = split
            for row in candidates(obj, source, split, turns):
                stats["listener_candidates"] += 1
                if not limit or len(rows) < limit:
                    rows.append(row)
        write_jsonl(output / f"{split}.candidates.jsonl", rows)
        with (output / f"{split}.review.csv").open("w", newline="", encoding="utf-8-sig") as stream:
            writer = csv.DictWriter(stream, fieldnames=REVIEW_FIELDS)
            writer.writeheader()
            for row in rows:
                writer.writerow({"candidate_id": row["candidate_id"], "draft": row["original_reply"],
                                 "generator": "original", "status": "pending"})
        manifest["splits"][split] = {**stats, "exported_candidates": len(rows), "read_errors": 0}
    write_json(output / "source_manifest.json", manifest)
    return manifest


def validate_rows(rows: list[dict], split: str) -> None:
    if not rows:
        raise ValueError("empty labeled dataset")
    ids = set()
    for row in rows:
        if "weak_label" in row or row.get("label_source") == "heuristic":
            raise ValueError("weak-demo data is not human-approved training data")
        if row["split"] != split or row["source"].get("dataset") != "AI-Hub-046":
            raise ValueError("only original AI-Hub split provenance accepted")
        if type(row.get("label")) is not int or row["label"] not in (0, 1):
            raise ValueError("binary integer label required")
        if row.get("review_status") != "approved" or not row.get("reviewer") or not row.get("rationale"):
            raise ValueError("approved human review required")
        if not row.get("draft", "").strip() or row["example_id"] in ids:
            raise ValueError("empty draft or duplicate example")
        ids.add(row["example_id"])


def audit(train: list[dict], validation: list[dict]) -> dict:
    for rows, split in ((train, "train"), (validation, "validation")):
        validate_rows(rows, split)
        if {r["label"] for r in rows} != {0, 1}:
            raise ValueError(f"both classes required: {split}")
    if {r["conversation_id"] for r in train} & {r["conversation_id"] for r in validation}:
        raise ValueError("conversation leakage across splits")
    def signature(row: dict) -> str:
        return json.dumps([row["relation"], row["context"], row["last_them"], row["draft"]], ensure_ascii=False, sort_keys=True)
    if {signature(r) for r in train} & {signature(r) for r in validation}:
        raise ValueError("identical input leakage across splits")
    result = {}
    for name, rows in (("train", train), ("validation", validation)):
        by_reply: dict[str, set] = defaultdict(set)
        by_input: dict[str, int] = {}
        for r in rows:
            key = signature(r)
            if key in by_input and by_input[key] != r["label"]:
                raise ValueError("conflicting labels for identical input")
            by_input[key] = r["label"]
            by_reply[r["draft"].strip()].add(r["label"])
        result[name] = {"n": len(rows), "labels": dict(Counter(r["label"] for r in rows)),
                        "mean_chars_by_label": {str(k): sum(len(r["draft"]) for r in rows if r["label"] == k)
                                                / sum(r["label"] == k for r in rows) for k in (0, 1)},
                        "same_reply_opposite_labels": sum(v == {0, 1} for v in by_reply.values())}
    return result


def finalize(directory: Path, output: Path) -> dict:
    if output.exists() and any(output.iterdir()):
        raise ValueError("output must be empty; use a new labeled dataset version")
    labeled = {}
    for split in ("train", "validation"):
        originals = read_jsonl(directory / f"{split}.candidates.jsonl")
        index = {r["candidate_id"]: r for r in originals}
        rows = []
        with (directory / f"{split}.review.csv").open(newline="", encoding="utf-8-sig") as stream:
            for review in csv.DictReader(stream):
                if review["status"] != "approved":
                    continue
                base = index[review["candidate_id"]]
                generator = review["generator"].strip()
                if generator not in {"original", "human"} and not generator.startswith(("rule:", "open-model:")):
                    raise ValueError("generator must be original/human/rule:<version>/open-model:<license+revision>")
                if any(word in generator.lower() for word in ("chatgpt", "claude", "openai")):
                    raise ValueError("disallowed training-data generator")
                if generator == "original" and review["draft"] != base["original_reply"]:
                    raise ValueError("modified reply must declare generator")
                if review["label"] not in {"0", "1"}:
                    raise ValueError("approved row needs 0/1")
                row = {**base, "draft": review["draft"], "generator": generator,
                       "label": int(review["label"]), "review_status": "approved",
                       "reviewer": review["reviewer"].strip(), "rationale": review["rationale"].strip()}
                row["example_id"] = hashlib.sha256((row["candidate_id"] + "\0" + row["draft"]).encode()).hexdigest()
                rows.append(row)
        labeled[split] = rows
    report = audit(labeled["train"], labeled["validation"])
    for split, rows in labeled.items():
        write_jsonl(output / f"{split}.jsonl", rows)
    write_json(output / "label_audit.json", report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prep = sub.add_parser("prepare")
    prep.add_argument("--root", type=Path, required=True)
    prep.add_argument("--output", type=Path, required=True)
    prep.add_argument("--limit-per-split", type=int, default=0)
    final = sub.add_parser("finalize")
    final.add_argument("--reviews", type=Path, required=True)
    final.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = (prepare(args.root, args.output, args.limit_per_split) if args.command == "prepare"
              else finalize(args.reviews, args.output))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
