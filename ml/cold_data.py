"""Extractive weak coldness labels; every training utterance comes from AI-Hub.

Rule: a bare acknowledgement after an explicit factual confirmation (weak 0),
versus the same acknowledgement after a detailed distressed disclosure (weak 1).
The original response to that disclosure is weak 0 only when existing topic and
support selectors agree. These are unreviewed operational labels, not truth.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
from collections import Counter, defaultdict
from pathlib import Path

from .data import candidates, documents, write_json, write_jsonl
from .weak import DISTRESS, eligible, signature

VERSION = "extractive-ack-context-v1"
ACK = re.compile(r"^(네|응|그래|알겠어|알았어|그래요)(?=[,.!~ ]|$)")
CONFIRM = re.compile(r"맞지|맞나요|맞죠|해도 되|보내.*돼|[0-9].*(시|분)|일정|시간.*[?？]")
HIGH_STAKES = re.compile(r"죽|사망|돌아가|장례|사고|수술|응급|헤어|이별|미안|생일|축하")


def neutral(row):
    text = row["last_them"]
    return bool(CONFIRM.search(text) and not DISTRESS.search(text) and not HIGH_STAKES.search(text)
                and re.search(r"[?？]", text))


def audit(train, validation):
    all_sources = []
    output = {}
    for split, rows in (("train", train), ("validation", validation)):
        if not rows or {r["label"] for r in rows} != {0, 1}:
            raise ValueError("both classes required in each split")
        seen, sources, groups = set(), set(), defaultdict(list)
        replies = defaultdict(set)
        for r in rows:
            if (r["split"] != split or type(r["label"]) is not int or r["label"] not in (0, 1)
                    or r["label_source"] != "heuristic" or r["human_approved"] is not False
                    or r["rule_version"] != VERSION or r["source"]["dataset"] != "AI-Hub-046"
                    or r["review_status"] != "weak_unreviewed" or r["draft"] not in r["original_reply"]):
                raise ValueError("invalid extractive cold weak provenance")
            if (r.get("source_conversation_id") != r["conversation_id"]
                    or r["source_conversation_ids"] != sorted(set(r["source_conversation_ids"]))
                    or r["conversation_id"] not in r["source_conversation_ids"]):
                raise ValueError("incomplete source lineage")
            sig = signature(r)
            if sig in seen or r["sample_id"] != hashlib.sha256(sig.encode()).hexdigest():
                raise ValueError("duplicate or changed cold input")
            seen.add(sig)
            sources.update(r["source_conversation_ids"])
            groups[r["contrast_group_id"]].append(r)
            replies[r["draft"]].add(r["label"])
            prefix = ACK.match(r["original_reply"].strip())
            if not prefix:
                raise ValueError("acknowledgement not found in source")
            if r["labeling_rule"] == "factual-confirmation-ack":
                valid = r["label"] == 0 and neutral(r) and r["draft"] == prefix.group(1)
            elif r["labeling_rule"] == "distress-bare-ack":
                valid = (r["label"] == 1 and eligible(r) and r["draft"] == prefix.group(1)
                         and len(r["last_them"]) >= 20 and DISTRESS.search(r["last_them"]))
            elif r["labeling_rule"] == "distress-support-topic":
                valid = r["label"] == 0 and eligible(r) and r["draft"] == r["original_reply"]
            else:
                valid = False
            if not valid:
                raise ValueError("cold rule evidence mismatch")
        for members in groups.values():
            if len(members) != 3 or len({tuple(r["source_conversation_ids"]) for r in members}) != 1:
                raise ValueError("incomplete contrast group")
            if (members[0]["source_conversation_ids"] != sorted({r["conversation_id"] for r in members})
                    or len({r["relation"] for r in members}) != 1
                    or {r["labeling_rule"] for r in members} != {"factual-confirmation-ack", "distress-bare-ack", "distress-support-topic"}):
                raise ValueError("contrast group lineage/rules mismatch")
            ordered = {r["labeling_rule"]: r for r in members}
            factual, bare, supportive = (ordered[k] for k in ("factual-confirmation-ack", "distress-bare-ack", "distress-support-topic"))
            if (factual["draft"] != bare["draft"] or any(bare[k] != supportive[k]
                    for k in ("conversation_id", "context", "last_them", "original_reply"))):
                raise ValueError("contrast group is not counterfactual")
        all_sources.append(sources)
        output[split] = {"n": len(rows), "labels": dict(Counter(r["label"] for r in rows)),
                         "groups": len(groups), "source_conversations": len(sources),
                         "same_reply_opposite_labels": sum(v == {0, 1} for v in replies.values())}
    if all_sources[0] & all_sources[1]:
        raise ValueError("source conversation leakage")
    if {signature(r) for r in train} & {signature(r) for r in validation}:
        raise ValueError("input leakage")
    if {r["contrast_group_id"] for r in train} & {r["contrast_group_id"] for r in validation}:
        raise ValueError("contrast group leakage")
    return output


def prepare(root, output, max_train=2048, max_validation=256):
    if output.exists():
        raise ValueError("use a new data directory")
    datasets = {}
    manifest = {"version": VERSION, "seed": 14, "human_reviewed": 0, "splits": {},
                "limitations": "Extracted acknowledgements can still be appropriate after distress; factual labels may miss relational context. No human accuracy claim."}
    source_ids, selected_inputs = set(), set()
    for split, limit in (("train", max_train), ("validation", max_validation)):
        stats = Counter()
        factual, distressed = defaultdict(list), defaultdict(list)
        for obj, source in documents(root / split, stats):
            cid = obj["info"]["id"]
            if cid in source_ids:
                raise ValueError("duplicate source conversation")
            source_ids.add(cid)
            for row in candidates(obj, source, split):
                stats["listener_candidates"] += 1
                match = ACK.match(row["original_reply"].strip())
                if not match or not row["relation"] or row["relation"] == "미상":
                    stats["deferred_candidates"] += 1
                    continue
                key = row["relation"], match.group(1)
                if neutral(row):
                    factual[key].append(row)
                elif len(row["last_them"]) >= 20 and DISTRESS.search(row["last_them"]) and eligible(row):
                    distressed[key].append(row)
                else:
                    stats["deferred_candidates"] += 1
        rows, used, seen = [], set(), set()
        rng = random.Random(14)
        keys = sorted(set(factual) & set(distressed))
        for key in keys:
            rng.shuffle(factual[key]); rng.shuffle(distressed[key])
        # Round-robin relation/prefix groups and use each source conversation once.
        for index in range(max((len(distressed[k]) for k in keys), default=0)):
            for key in keys:
                if index >= len(distressed[key]) or len(rows) + 3 > limit:
                    continue
                emotional = distressed[key][index]
                if emotional["conversation_id"] in used:
                    continue
                ordinary = next((r for r in factual[key] if r["conversation_id"] not in used
                                 and r["conversation_id"] != emotional["conversation_id"]), None)
                if ordinary is None:
                    continue
                ids = sorted([ordinary["conversation_id"], emotional["conversation_id"]])
                group = hashlib.sha256('|'.join(ids).encode()).hexdigest()
                proposed = []
                for base, draft, label, rule in [(ordinary, key[1], 0, "factual-confirmation-ack"),
                        (emotional, key[1], 1, "distress-bare-ack"),
                        (emotional, emotional["original_reply"], 0, "distress-support-topic")]:
                    r = {**base, "draft": draft, "label": label, "label_source": "heuristic",
                         "human_approved": False, "review_status": "weak_unreviewed", "rule_version": VERSION,
                         "labeling_rule": rule, "source_conversation_ids": ids,
                         "source_conversation_id": base["conversation_id"], "contrast_group_id": group}
                    r["sample_id"] = r["example_id"] = hashlib.sha256(signature(r).encode()).hexdigest()
                    proposed.append(r)
                if any(signature(r) in seen or signature(r) in selected_inputs for r in proposed):
                    stats["duplicate_groups_excluded"] += 1
                    continue
                rows.extend(proposed); used.update(ids); seen.update(signature(r) for r in proposed)
        selected_inputs.update(seen)
        datasets[split] = rows
        manifest["splits"][split] = {**stats, "factual_candidates": sum(map(len, factual.values())),
                                    "distress_candidates": sum(map(len, distressed.values())), "selected_rows": len(rows)}
    manifest["audit"] = audit(datasets["train"], datasets["validation"])
    for split, rows in datasets.items():
        write_jsonl(output / (split + '.jsonl'), rows)
    write_json(output / "manifest.json", manifest)
    write_json(output / "rules.json", {"version": VERSION, "ack": ACK.pattern, "confirmation": CONFIRM.pattern,
                                      "exclude": HIGH_STAKES.pattern, "label_source": "heuristic"})
    return manifest


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    print(json.dumps(prepare(args.root, args.output)))


if __name__ == '__main__':
    main()
