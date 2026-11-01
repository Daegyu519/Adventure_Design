"""P-14b: weak labels from a LOCAL LLM teacher (llama-server, OpenAI-compatible).

sample   AI-Hub 046 listener replies, stratified by relation (rows stay on the server)
variants deterministic rule-based cold replies (fixed phrase lists; no external LLM text)
label    engine/prompts/tone_fast.md -> r[5] -> soft = r[cold]+r[careless]+r[angry]
Usage: python -m ml.teacher sample|label ... (see --help). Rows, scores and the report never go to git.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import time
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .data import candidates, documents, read_jsonl, write_jsonl

PROMPT = Path(__file__).resolve().parent.parent / "engine" / "prompts" / "tone_fast.md"
LABEL_SOURCE = "teacher:qwen3-30b-a3b"
ACK = ["ㅇㅇ", "응", "알겠어", "네.", "그래서?", "ㅋㅋ", "ㅇㅋ", "그래"]
REFUSE = ["싫어", "안 해.", "안 돼.", "안 할래", "별로야."]
TOPIC = ["아 근데 오늘 저녁 뭐 먹지", "그건 그렇고 나 배고프다", "아 맞다 그거 봤어? 드라마", "근데 주말에 뭐해"]
CURT = ["그래.", "몰라.", "알아서 해.", "어쩌라고.", "그러든가.", "됐어."]
GROUPS = [ACK, REFUSE, TOPIC, CURT]


def prompt_hash() -> str:
    return hashlib.sha256(PROMPT.read_bytes()).hexdigest()[:12]


def sample(root: Path, split: str, n: int, seed: int) -> list[dict]:
    """Per-relation reservoir over all listener candidates, then equal-ish draw per relation."""
    rng = random.Random(seed)
    cap, pools, seen = n, defaultdict(list), Counter()
    for obj, source in documents(root / split, Counter()):
        for row in candidates(obj, source, split):
            row.pop("source", None)
            rel = row["relation"]
            seen[rel] += 1
            if len(pools[rel]) < cap:
                pools[rel].append(row)
            elif (j := rng.randrange(seen[rel])) < cap:
                pools[rel][j] = row
    rels = sorted(pools)
    quota = {r: n // len(rels) for r in rels}
    # relations smaller than their quota donate the remainder to the rest
    spare = n - sum(min(quota[r], len(pools[r])) for r in rels)
    for r in sorted(rels, key=lambda r: -len(pools[r])):
        extra = min(spare, len(pools[r]) - quota[r]) if spare > 0 else 0
        quota[r] += max(0, extra)
        spare -= max(0, extra)
    out = []
    for r in rels:
        rng.shuffle(pools[r])
        out += pools[r][:quota[r]]
    rng.shuffle(out)
    return out


def variants(rows: list[dict], seed: int, share: float = 0.4) -> list[dict]:
    """Replace the reply of ~share of rows with a short cold-style reply. Deterministic."""
    rng = random.Random(seed)
    out = []
    for row in rows:
        row = {**row, "variant": "original"}
        if rng.random() < share:
            kind = rng.randrange(len(GROUPS))
            row.update(draft=rng.choice(GROUPS[kind]), variant=("ack", "refuse", "topic", "curt")[kind])
        else:
            row["draft"] = row["original_reply"]
        out.append(row)
    return out


def parse_reading(text: str) -> tuple[list[float], float] | None:
    m = re.search(r"\{.*\}", text, re.S)
    try:
        obj = json.loads(m.group(0)) if m else None
        r, c = [float(x) for x in obj["r"]], float(obj["c"])
    except Exception:
        return None
    if len(r) != 5 or not all(0 <= x <= 1 for x in r + [c]):
        return None
    return r, c


def ask(url: str, model: str, system: str, user: str, timeout: float = 60) -> str:
    body = json.dumps({"model": model, "temperature": 0, "max_tokens": 80,
                       "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}).encode()
    req = urllib.request.Request(url + "/chat/completions", body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)["choices"][0]["message"]["content"]


def label_one(row: dict, url: str, model: str) -> dict:
    text = PROMPT.read_text(encoding="utf-8")
    system, user = text.split("## system", 1)[1].split("## user", 1)
    user = user.strip().format(room="1:1", relation=row["relation"], last_them=row["last_them"], draft=row["draft"])
    for attempt in range(2):
        try:
            parsed = parse_reading(ask(url, model, system.strip(), user))
        except Exception:
            parsed = None
            time.sleep(1)
        if parsed:
            r, c = parsed
            soft = min(1.0, r[0] + r[1] + r[2])
            return {**row, "teacher_r": r, "teacher_c": c, "soft": soft, "label": int(soft >= .5)}
    return {**row, "teacher_r": None}


def label(rows: list[dict], url: str, model: str, workers: int = 4, min_conf: float = .4) -> tuple[list[dict], dict]:
    with ThreadPoolExecutor(workers) as pool:
        done = list(pool.map(lambda r: label_one(r, url, model), rows))
    ok = [r for r in done if r["teacher_r"] is not None]
    kept = [{**r, "label_source": LABEL_SOURCE, "prompt_hash": prompt_hash()} for r in ok if r["teacher_c"] >= min_conf]
    return kept, {"in": len(rows), "valid_json": len(ok), "kept": len(kept), "min_conf": min_conf,
                  "positive": sum(r["label"] for r in kept), "prompt_hash": prompt_hash()}


def report(train: list[dict], rule_labeled: list[dict], n_examples: int = 20) -> dict:
    """Server-side sanity report: balance, teacher vs rule labels, random examples (text!)."""
    by = Counter((r["variant"], r["label"]) for r in train)
    cm = [[0, 0], [0, 0]]
    for r in rule_labeled:
        cm[r["rule_label"]][r["label"]] += 1
    soft = sorted(r["soft"] for r in train)
    ex = random.Random(1).sample(train, min(n_examples, len(train)))
    return {"rows": len(train), "positive": sum(r["label"] for r in train),
            "soft_quantiles": [soft[int(q * (len(soft) - 1))] for q in (0, .1, .25, .5, .75, .9, 1)],
            "by_variant_label": {f"{k[0]}:{k[1]}": v for k, v in sorted(by.items())},
            "teacher_vs_rule_confusion[rule][teacher]": cm,
            "examples": [{"context": r["last_them"], "draft": r["draft"], "score": round(r["soft"], 2)} for r in ex]}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sample")
    s.add_argument("--root", type=Path, required=True)
    s.add_argument("--split", choices=["train", "validation"], required=True)
    s.add_argument("--n", type=int, required=True)
    s.add_argument("--seed", type=int, default=14)
    s.add_argument("--output", type=Path, required=True)
    lb = sub.add_parser("label")
    lb.add_argument("--input", type=Path, required=True)
    lb.add_argument("--output", type=Path, required=True)
    lb.add_argument("--url", default="http://127.0.0.1:11470/v1")
    lb.add_argument("--model", default="qwen3-30b-a3b")
    lb.add_argument("--workers", type=int, default=4)
    rp = sub.add_parser("report")
    rp.add_argument("--train", type=Path, required=True)
    rp.add_argument("--rule-labeled", type=Path, required=True, help="rule rows (label=rule) after `label` (soft/label=teacher)")
    a = p.parse_args()
    if a.cmd == "report":
        rule = [{**r, "rule_label": r["rule_label"]} for r in read_jsonl(a.rule_labeled)]
        print(json.dumps(report(read_jsonl(a.train), rule), ensure_ascii=False, indent=1))
    elif a.cmd == "sample":
        write_jsonl(a.output, variants(sample(a.root, a.split, a.n, a.seed), a.seed))
    else:
        kept, stats = label(read_jsonl(a.input), a.url, a.model, a.workers)
        write_jsonl(a.output, kept)
        print(json.dumps(stats))


if __name__ == "__main__":
    main()
