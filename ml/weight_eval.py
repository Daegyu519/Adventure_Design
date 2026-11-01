"""P-28: choose aggregate.weights.clf with a live measurement (contrast set, realtime path, production thresholds).

Needs `scripts/gpu up` (Gemma :11435, tone-clf :11481) and USE_LOCAL_MODEL=1; HINT_* env overrides must be unset.
  USE_LOCAL_MODEL=1 uv run --project engine python -m ml.weight_eval --runs 2 --output out.json
Each row is run live once (Gemma + classifier); the aggregate is then recomputed per weight from the same inputs.
Rule: highest recall with precision >= 0.75 (tie: higher precision); else max F1.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))

from app.settings import DEFAULT_MODELS_PATH  # noqa: E402
from experts.registry import Registry  # noqa: E402
from harness.schemas import Conversation, Turn  # noqa: E402
from harness.store import ProfileStore  # noqa: E402
from layers.aggregate import aggregate  # noqa: E402
from pipeline import realtime  # noqa: E402

GRID = (0.5, 1.0, 1.5, 2.0, 3.0)


def pr(pairs: list[tuple[bool, bool]]) -> dict:
    tp = sum(p and a for p, a in pairs); fp = sum(p and not a for p, a in pairs); fn = sum(a and not p for p, a in pairs)
    p_ = tp / (tp + fp) if tp + fp else None
    r_ = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * p_ * r_ / (p_ + r_) if p_ and (p_ + r_) else 0.0
    return {"precision": None if p_ is None else round(p_, 3), "recall": round(r_, 3), "f1": round(f1, 3),
            "tp": tp, "fp": fp, "fn": fn}


def choose(table: dict[float, dict]) -> tuple[float, str]:
    ok = [w for w, m in table.items() if m["precision"] is not None and m["precision"] >= 0.75]
    if ok:
        return max(ok, key=lambda w: (table[w]["recall"], table[w]["precision"])), "recall-max with precision >= 0.75"
    return max(table, key=lambda w: table[w]["f1"]), "no weight reached precision 0.75: max F1"


async def main_async(a) -> dict:
    assert not any(k.startswith("HINT_") for k in os.environ), "unset HINT_* overrides (production thresholds only)"
    assert os.environ.get("USE_LOCAL_MODEL") == "1"
    items = [json.loads(l) for l in (ROOT / "eval/contrast_set.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    reg = Registry.load(DEFAULT_MODELS_PATH, False)
    assert [c.id for c in reg.classifiers] == ["clf_cold"], "classifier not loaded"
    if a.deadline_ms:   # Gemma on the shared server can exceed 1.2 s; this only keeps its answer from being dropped, thresholds stay production
        reg.cfg["paths"]["realtime"]["expert_deadline_ms"] = a.deadline_ms
    agg = reg.cfg["aggregate"]
    store, rows = ProfileStore(), []
    for run in range(a.runs):
        for it in items:
            c = Conversation(pair_id=f"p28-{it['pair']}", relation=it["relation"], turns=[Turn(speaker="them", text=it["them"])])
            t = time.monotonic()
            out = await realtime(reg, it["draft"], c, store, "eval", [], t)
            ms = (time.monotonic() - t) * 1000
            tones = [(r.output, reg.weight(r.expert_id)) for r in out.results if r.role == "tone"]
            alerts = {}
            for w in (None, *GRID):
                if not out.gate.passed:
                    alerts[w] = False
                    continue
                cfg = {**agg, "weights": {**agg["weights"], "clf": w or 0.0}}
                v = aggregate(it["draft"], out.gate, None, tones, store, c, cfg, None if w is None else out.clf)
                alerts[w] = v.alert
            rows.append({"run": run, "label": it["alert"], "gated": not out.gate.passed, "clf": out.clf, "ms": ms, "alerts": alerts})
    table = {w: pr([(r["alerts"][w], r["label"]) for r in rows]) for w in GRID}
    best, why = choose(table)
    return {"n": len(rows), "runs": a.runs, "gate_threshold": reg.cfg["paths"]["realtime"]["gate_threshold"],
            "alert_threshold": agg["alert_threshold"], "expert_deadline_ms": reg.cfg["paths"]["realtime"]["expert_deadline_ms"], "weights_other": agg["weights"],
            "gemma_alone": pr([(r["alerts"][None], r["label"]) for r in rows]),
            "table": {str(w): m for w, m in table.items()},
            "per_run": {str(w): [pr([(r["alerts"][w], r["label"]) for r in rows if r["run"] == k]) for k in range(a.runs)] for w in GRID},
            "clf_missing": sum(r["clf"] is None for r in rows), "gated": sum(r["gated"] for r in rows),
            "clf_scores": [None if r["clf"] is None else round(r["clf"], 3) for r in rows], "labels": [r["label"] for r in rows],
            "p95_ms": round(sorted(r["ms"] for r in rows)[int(0.95 * len(rows)) - 1]), "chosen": best, "rule": why}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--runs", type=int, default=2)
    p.add_argument("--deadline-ms", type=int, default=0, help="override realtime expert_deadline_ms (default: production)")
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    out = asyncio.run(main_async(a))
    a.output.write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
