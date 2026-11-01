"""P-14b: Gemma tone_fast (live, via scripts/gpu up tunnel) + classifier as second tone signal on the contrast set.

Run from repo root with the engine venv, shim running (ml.classifier_shim), USE_LOCAL_MODEL=1:
  USE_LOCAL_MODEL=1 uv run --project engine python -m ml.ensemble_eval --runs 2 --output out.json
Ensemble rule (test only): alert = gemma.alert OR cold_score >= t. Calls run concurrently; latency = wall time of both.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))

from app.settings import DEFAULT_MODELS_PATH  # noqa: E402
from experts.base import ExpertRequest  # noqa: E402
from experts.classifier import load_classifiers  # noqa: E402
from experts.registry import Registry  # noqa: E402
from harness.schemas import Conversation, Turn  # noqa: E402
from harness.store import ProfileStore  # noqa: E402
from pipeline import realtime  # noqa: E402

THRESHOLDS = (0.3, 0.4, 0.5, 0.6)


class HttpBackend:
    def __init__(self, port: int):
        self.url = f"http://127.0.0.1:{port}/predict"

    def predict(self, row: dict) -> tuple[float, float]:
        req = urllib.request.Request(self.url, json.dumps(row).encode(), {"Content-Type": "application/json"})
        out = json.load(urllib.request.urlopen(req, timeout=5))
        return out["score"], out["latency_ms"]


def pr(pairs: list[tuple[bool, bool]]) -> dict:
    tp = sum(p and a for p, a in pairs); fp = sum(p and not a for p, a in pairs); fn = sum(a and not p for p, a in pairs)
    return {"precision": round(tp / (tp + fp), 3) if tp + fp else None, "recall": round(tp / (tp + fn), 3) if tp + fn else None,
            "tp": tp, "fp": fp, "fn": fn}


def p95(xs: list[float]) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(0.95 * len(xs)))]


async def main_async(a) -> dict:
    items = [json.loads(l) for l in (ROOT / "eval/contrast_set.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    entries = __import__("yaml").safe_load((ROOT / "ml/p14b_classifiers.test.yaml").read_text())["classifiers"]
    (cls,) = load_classifiers(entries, ROOT / "ml", factory=lambda path, device: HttpBackend(a.port))
    reg = Registry.load(DEFAULT_MODELS_PATH, False)
    store = ProfileStore()
    rows = []
    for run in range(a.runs):
        for it in items:
            c = Conversation(pair_id=f"p14b-{it['pair']}", relation=it["relation"], turns=[Turn(speaker="them", text=it["them"])])

            async def gemma():
                t = time.monotonic()
                v = (await realtime(reg, it["draft"], c, store, "eval", [], time.monotonic())).verdict
                return v, (time.monotonic() - t) * 1000

            async def clf():
                t = time.monotonic()
                s = await cls.run(ExpertRequest.from_convo("realtime", it["draft"], c, []), time.monotonic() + 1.5)
                return s, (time.monotonic() - t) * 1000

            (v, gms), (s, cms) = await asyncio.gather(gemma(), clf())
            rows.append({"run": run, "alert": it["alert"], "g": bool(v and v.alert), "gms": gms,
                         "cold": s.cold_score if s else None, "cms": cms, "both_ms": max(gms, cms)})
    out = {"n": len(rows), "runs": a.runs,
           "gemma_alone": {**pr([(r["g"], r["alert"]) for r in rows]), "p95_ms": round(p95([r["gms"] for r in rows]))},
           "classifier_ms_p95_via_http": round(p95([r["cms"] for r in rows]), 1), "abstained_classifier": sum(r["cold"] is None for r in rows)}
    for t in THRESHOLDS:
        out[f"classifier_alone@{t}"] = pr([((r["cold"] or 0) >= t, r["alert"]) for r in rows])
        ens = [(r["g"] or (r["cold"] or 0) >= t, r["alert"]) for r in rows]
        out[f"ensemble_or@{t}"] = {**pr(ens), "p95_ms": round(p95([r["both_ms"] for r in rows]))}
    out["per_run_gemma"] = [pr([(r["g"], r["alert"]) for r in rows if r["run"] == k]) for k in range(a.runs)]
    out["per_run_ensemble@0.5"] = [pr([(r["g"] or (r["cold"] or 0) >= .5, r["alert"]) for r in rows if r["run"] == k]) for k in range(a.runs)]
    return out


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--port", type=int, default=11480)
    p.add_argument("--runs", type=int, default=2)
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    out = asyncio.run(main_async(a))
    a.output.write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
