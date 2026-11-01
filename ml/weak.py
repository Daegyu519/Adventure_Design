"""DEMO ONLY: extractive, paired topic-incongruity weak supervision.

No authored reply templates, external LLMs, human approvals or random negatives.
Every draft is an exact substring of an AI-Hub listener response. A topic-specific
supportive response is paired with its own disclosure (weak 0) and with another
real disclosure of the SAME relation and strictly disjoint topics (weak 1).
Both responses are swapped symmetrically, so each context AND draft occurs with
both labels. This is a proxy task, not validated coldness ground truth.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
from collections import Counter, defaultdict
from pathlib import Path

from .data import CONFIG, candidates, documents, write_json, write_jsonl

VERSION = "topic-swap-v1"
GENERATOR = "python:extractive-topic-swap-v1"
# Lexical selectors, NEVER reply templates or per-example model judgments.
TOPICS = {
    "study": r"시험|성적|공부|과제|학점|수능|등록금|대학|학원|교수|숙제",
    "work": r"직장|회사|상사|야근|퇴사|취업|면접|이직|월급|업무|직원",
    "health": r"병원|수술|진단|치료|건강|입원|퇴원|질병|아프|아파|다쳤|통증",
    "romance": r"남자친구|여자친구|남친|여친|연애|이별|헤어|짝사랑|결혼|애인",
    "money": r"대출|빚|저축|투자|주식|적금|생활비|돈이|돈을|금전",
    "parent": r"부모|엄마|아빠|어머니|아버지|시어머니|장모",
    "child": r"육아|자녀|아들이|딸이|아이를|어린이집|유치원|출산|임신",
    "friend": r"친구|우정|동창|절친",
    "pet": r"강아지|고양이|반려|동물병원",
    "housing": r"집주인|전세|월세|이사|아파트|보증금|부동산",
    "body": r"다이어트|몸무게|체중|살이|살을|외모",
    "sleep": r"불면|잠을|잠이|수면|악몽",
}
SUPPORT = re.compile(r"힘들|속상|걱정|고생|응원|괜찮|다행|이해|수고|잘될|잘 될|슬프|마음이|마음은|안타깝")
DISTRESS = re.compile(r"힘들|걱정|속상|불안|슬프|짜증|스트레스|무섭|고민|우울|화가|괴롭|답답|실망|외롭|싫|어렵|어려|아프|아파")


def topics(text: str) -> set[str]:
    return {name for name, pattern in TOPICS.items() if re.search(pattern, text)}


def signature(row: dict) -> str:
    return json.dumps([row["relation"], row["context"], row["last_them"], row["draft"]], ensure_ascii=False, sort_keys=True)


def eligible(row: dict) -> bool:
    history = "\n".join(t["text"] for t in row["context"])
    disclosure = "\n".join(t["text"] for t in row["context"] if t["role"] == "them")
    ct, rt = topics(history), topics(row["original_reply"])
    return bool(ct and rt and rt <= ct and SUPPORT.search(row["original_reply"])
                and DISTRESS.search(disclosure) and row["relation"].strip())


def drafts(row: dict) -> list[tuple[str, str]]:
    original = row["original_reply"]
    result = [(original, "whole-response")]
    # Extract a complete ORIGINAL sentence containing both support and topic.
    # No new strings are composed as training utterances.
    for match in re.finditer(r"[^.!?。！？\n]+[.!?。！？]?", original):
        clause = match.group().strip()
        if clause and clause != original and SUPPORT.search(clause) and topics(clause):
            if not any(text == clause for text, _ in result):
                result.append((clause, "sentence-extraction"))
                break
    return result


def derived(target: dict, donor: dict, draft: str, label: int, pair: str, transform: str) -> dict:
    rule = "support-and-topic-aligned" if label == 0 else "same-relation-disjoint-topic-swap"
    row = {**target, "draft": draft, "label": label, "weak_label": label,
           "label_source": "heuristic", "human_approved": False, "review_status": "weak_unreviewed",
           "generator": GENERATOR, "labeling_rule": rule, "rule_version": VERSION,
           "transform": transform, "pair_id": pair,
           "source_conversation_ids": sorted({target["conversation_id"], donor["conversation_id"]}),
           "reply_source": {"candidate_id": donor["candidate_id"], "conversation_id": donor["conversation_id"],
                            "split": donor["split"], "source": donor["source"], "original_reply": donor["original_reply"],
                            "relation": donor["relation"]},
           "rule_evidence": {"context_topics": sorted(topics("\n".join(t["text"] for t in target["context"]))),
                             "reply_topics": sorted(topics(draft))}}
    row.pop("reviewer", None)
    row.pop("rationale", None)
    row["example_id"] = hashlib.sha256(signature(row).encode()).hexdigest()
    row["sample_id"] = row["example_id"]
    row["source_conversation_id"] = row["conversation_id"]
    row["contrast_group_id"] = pair
    return row


def build_pairs(pool: list[dict], max_rows: int) -> list[dict]:
    """Deterministic targeted matching. No random reply is assigned label 1."""
    if max_rows < 4 or max_rows % 4:
        raise ValueError("max_rows must be a positive multiple of 4")
    groups = defaultdict(list)
    for row in pool:
        if eligible(row):
            groups[row["relation"]].append(row)
    # Stable hash order spreads selection across source IDs, unlike first-N.
    groups = {key: sorted(rows, key=lambda r: hashlib.sha256(r["candidate_id"].encode()).hexdigest())
              for key, rows in groups.items()}
    used, seen_inputs, units = set(), set(), defaultdict(list)
    topic_map = {r["candidate_id"]: topics("\n".join(t["text"] for t in r["context"]))
                 for members in groups.values() for r in members}
    for relation in sorted(groups):
        members = groups[relation]
        for i, left in enumerate(members):
            if left["candidate_id"] in used:
                continue
            lt = topic_map[left["candidate_id"]]
            for right in members[i + 1:]:
                if right["candidate_id"] in used or left["conversation_id"] == right["conversation_id"]:
                    continue
                rt = topic_map[right["candidate_id"]]
                if lt & rt:
                    continue
                pair = hashlib.sha256((left["candidate_id"] + "|" + right["candidate_id"]).encode()).hexdigest()
                added = False
                for left_draft, right_draft in zip(drafts(left), drafts(right)):
                    new = []
                    for donor, other, (draft, transform) in ((left, right, left_draft), (right, left, right_draft)):
                        new.extend([derived(donor, donor, draft, 0, pair, transform),
                                    derived(other, donor, draft, 1, pair, transform)])
                    # Always keep all FOUR symmetric inputs or none.
                    if any(signature(x) in seen_inputs for x in new):
                        continue
                    units[relation].append(new)
                    seen_inputs.update(signature(r) for r in new)
                    added = True
                if not added:
                    continue
                used.update((left["candidate_id"], right["candidate_id"]))
                break
            if len(units[relation]) * 4 >= max_rows:
                break
    # Round-robin relations rather than exhausting the alphabetically first one.
    rows = []
    for index in range(max((len(v) for v in units.values()), default=0)):
        for relation in sorted(units):
            if index < len(units[relation]):
                rows.extend(units[relation][index])
                if len(rows) >= max_rows:
                    return rows
    return rows


def validate_weak(rows: list[dict], split: str) -> None:
    if not rows:
        raise ValueError(f"no eligible weak pairs: {split}; no unsafe fallback labels generated")
    seen = set()
    for row in rows:
        label = row.get("label")
        if type(label) is not int or label not in (0, 1) or type(row.get("weak_label")) is not int or row["weak_label"] != label:
            raise ValueError("invalid weak label")
        if (row.get("review_status") != "weak_unreviewed" or row.get("human_approved") is not False
                or row.get("generator") != GENERATOR or row.get("label_source") != "heuristic"
                or row.get("rule_version") != VERSION or row.get("reviewer") or row.get("rationale")):
            raise ValueError("weak labels must never impersonate human approvals")
        donor = row["reply_source"]
        if donor["relation"] != row["relation"] or not eligible(row):
            raise ValueError("weak pairs require eligible same-relation source candidates")
        if (row["split"] != split or donor["split"] != split
                or row["source"].get("dataset") != "AI-Hub-046" or donor["source"].get("dataset") != "AI-Hub-046"):
            raise ValueError("weak source split/dataset mismatch")
        if row["source_conversation_ids"] != sorted({row["conversation_id"], donor["conversation_id"]}):
            raise ValueError("incomplete weak source lineage")
        if not row["draft"].strip() or row["draft"] not in donor["original_reply"]:
            raise ValueError("draft must be an extract from original AI-Hub response")
        ct = topics("\n".join(t["text"] for t in row["context"]))
        dt = topics(row["draft"])
        if not dt or not SUPPORT.search(row["draft"]):
            raise ValueError("unsupported weak response")
        if label == 0:
            if donor["candidate_id"] != row["candidate_id"] or not dt <= ct or row["labeling_rule"] != "support-and-topic-aligned":
                raise ValueError("invalid positive alignment")
        elif not ct or ct & dt or donor["conversation_id"] == row["conversation_id"] or row["labeling_rule"] != "same-relation-disjoint-topic-swap":
            raise ValueError("invalid negative topic mismatch")
        sig = signature(row)
        if row["example_id"] != hashlib.sha256(sig.encode()).hexdigest() or sig in seen:
            raise ValueError("duplicate/tampered weak input")
        seen.add(sig)


def weak_audit(train: list[dict], validation: list[dict]) -> dict:
    for rows, split in ((train, "train"), (validation, "validation")):
        validate_weak(rows, split)
    ids = [{cid for row in rows for cid in row["source_conversation_ids"]} for rows in (train, validation)]
    if ids[0] & ids[1]:
        raise ValueError("conversation leakage including reply donors")
    if {signature(r) for r in train} & {signature(r) for r in validation}:
        raise ValueError("identical input leakage across weak splits")
    report = {"label_mode": "weak-demo", "claim": "proxy task only; NOT human tone accuracy"}
    for name, rows in (("train", train), ("validation", validation)):
        by_reply = [Counter(r["draft"] for r in rows if r["label"] == label) for label in (0, 1)]
        by_context = [Counter(json.dumps([r["relation"], r["context"], r["last_them"]], sort_keys=True, ensure_ascii=False)
                              for r in rows if r["label"] == label) for label in (0, 1)]
        # These invariants make length/keywords/relation alone uninformative.
        if by_reply[0] != by_reply[1] or by_context[0] != by_context[1]:
            raise ValueError("paired weak dataset must balance each draft AND context across labels")
        report[name] = {"n": len(rows), "labels": dict(Counter(r["label"] for r in rows)),
                        "same_reply_opposite_labels": len(by_reply[0]),
                        "draft_histograms_identical": True, "context_histograms_identical": True,
                        "mean_chars_by_label": {str(label): sum(len(r["draft"]) for r in rows if r["label"] == label)
                                                / sum(r["label"] == label for r in rows) for label in (0, 1)},
                        "strata": dict(Counter(str((r.get("speaker_emotion"), r["relation"])) for r in rows)),
                        "rules": dict(Counter(r["labeling_rule"] for r in rows)),
                        "transforms": dict(Counter(r["transform"] for r in rows))}
    return report


def prepare_weak(root: Path, output: Path, train_size: int = 1024, validation_size: int = 256,
                 bucket_size: int = 64, seed: int = 14) -> dict:
    if bucket_size < 1 or any(n < 4 or n % 4 for n in (train_size, validation_size)):
        raise ValueError("positive bucket_size and split sizes divisible by 4 required")
    if output.exists() and any(output.iterdir()):
        raise ValueError("weak output must be empty")
    rng = random.Random(seed)
    seen_ids, datasets, manifest = set(), {}, {"root": str(root.resolve()), "rule_version": VERSION,
                                               "seed": seed, "bucket_size": bucket_size, "splits": {}}
    turns = json.loads(CONFIG.read_text(encoding="utf-8"))["context_turns"]
    for split, size in (("train", train_size), ("validation", validation_size)):
        stats, buckets, counts = Counter(), defaultdict(list), Counter()
        for obj, source in documents(root / split, stats):
            cid = obj["info"]["id"]
            if cid in seen_ids:
                raise ValueError(f"duplicate conversation ID across/full sources: {cid}")
            seen_ids.add(cid)
            for row in candidates(obj, source, split, turns):
                stats["listener_candidates"] += 1
                if not eligible(row):
                    stats["abstained_candidates"] += 1
                    continue
                stats["eligible_candidates"] += 1
                key = (row["relation"], row.get("speaker_emotion"), tuple(sorted(topics(row["original_reply"]))))
                counts[key] += 1
                reservoir = buckets[key]
                if len(reservoir) < bucket_size:
                    reservoir.append(row)
                else:
                    index = rng.randrange(counts[key])
                    if index < bucket_size:
                        reservoir[index] = row
        pool = [row for key in sorted(buckets, key=str) for row in buckets[key]]
        datasets[split] = build_pairs(pool, size)
        manifest["splits"][split] = {**stats, "pool_size": len(pool), "requested_rows": size,
                                      "actual_rows": len(datasets[split]), "read_errors": 0}
        print(json.dumps({"phase": "weak-data", "split": split, **manifest["splits"][split]}), flush=True)
    report = weak_audit(datasets["train"], datasets["validation"])
    # Preserve every symmetric four-row unit; insufficient selection fails clearly.
    if len(datasets["train"]) < 16 or len(datasets["validation"]) < 8:
        raise ValueError("too few eligible weak pairs (minimum train=16, validation=8); full data required")
    for split, rows in datasets.items():
        write_jsonl(output / f"{split}.jsonl", rows)
    write_json(output / "source_manifest.json", manifest)
    write_json(output / "weak_audit.json", report)
    write_json(output / "weak_rules.json", {"version": VERSION, "topics": TOPICS, "support_regex": SUPPORT.pattern,
                                            "distress_regex": DISTRESS.pattern, "human_approved": False,
                                            "limitations": "topic incongruity may be appropriate in real conversations; weak 0 can still be cold"})
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--train-size", type=int, default=1024)
    parser.add_argument("--validation-size", type=int, default=256)
    args = parser.parse_args()
    print(json.dumps(prepare_weak(args.root, args.output, args.train_size, args.validation_size), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
