"""대조 세트 평가. 같은 문장이 맥락에 따라 다르게 판단되는지, 알림이 얼마나 정확한지 본다.
프롬프트나 모델을 바꿀 때마다 돌린다.   uv run --project engine python eval/run_eval.py [--mock] [--detail] [--json]

보는 숫자
- 정밀도: 알림을 띄운 것 중 실제로 알림이 맞았던 비율 (가장 중요). 알림이 0개면 0.0
- 재현율: 알림이 필요했던 것 중 띄운 비율 (정답 알림이 0개면 None)
- 기권률: 판단이 갈려 말하지 않은 비율
- 맥락 구분: 같은 문장 쌍에서 A는 알림 없음, B는 알림 있음으로 정확히 갈린 쌍의 비율
mock 모드 숫자는 배관 점검용이라 의미가 없다. --json이면 stdout에 JSON 한 줄만 낸다."""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "engine"))

from app.settings import DEFAULT_MODELS_PATH  # noqa: E402
from experts.registry import Registry  # noqa: E402
from harness.schemas import Conversation, Turn  # noqa: E402
from harness.store import ProfileStore  # noqa: E402
from pipeline import detail as run_detail, realtime  # noqa: E402


async def evaluate(force_mock: bool, detail: bool, rows_out: list | None = None) -> dict:
    items = [json.loads(l) for l in (HERE / "contrast_set.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    reg = Registry.load(DEFAULT_MODELS_PATH, force_mock)
    store = ProfileStore()
    rows = []
    for it in items:
        c = Conversation(pair_id=f"eval-{it['pair']}", relation=it["relation"],
                         turns=[Turn(speaker="them", text=it["them"])])
        if detail:
            v = (await run_detail(reg, it["draft"], c, store, "eval", [], None, time.monotonic())).verdict
        else:
            v = (await realtime(reg, it["draft"], c, store, "eval", [], time.monotonic())).verdict
        rows.append({**it, "pred": bool(v and v.alert), "abstain": bool(v and v.abstain),
                     "risk": v.risk if v else None})

    tp = sum(r["pred"] and r["alert"] for r in rows)
    fp = sum(r["pred"] and not r["alert"] for r in rows)
    fn = sum((not r["pred"]) and r["alert"] for r in rows)
    pairs: dict = {}
    for r in rows:
        pairs.setdefault(r["pair"], {})[r["side"]] = r["pred"]
    split_ok = sum(1 for p in pairs.values() if p.get("A") is False and p.get("B") is True)
    if rows_out is not None:
        rows_out.extend(rows)
    return {
        "precision": round(tp / (tp + fp), 2) if tp + fp else 0.0,
        "recall": round(tp / (tp + fn), 2) if tp + fn else None,
        "abstain_rate": round(sum(r["abstain"] for r in rows) / len(rows), 2),
        "context_split": f"{split_ok}/{len(pairs)}",
        "mode": "mock" if force_mock or not any(t["ok"] and not t["model"].startswith("mock")
                                                 for t in reg.router.traces) else "live",
        "n": len(rows),
    }


def main(argv: list[str]) -> None:
    rows: list = []
    m = asyncio.run(evaluate("--mock" in argv, "--detail" in argv, rows))
    if "--json" not in argv:
        print(f"{'쌍':<3}{'면':<3}{'상대의 말':<28}{'문장':<10}{'정답':<6}{'예측':<6}{'risk':<6}")
        for r in rows:
            mark = "" if r["pred"] == r["alert"] else "  ← 틀림"
            print(f"{r['pair']:<3}{r['side']:<3}{r['them'][:24]:<28}{r['draft']:<10}"
                  f"{str(r['alert']):<6}{str(r['pred']):<6}{str(r['risk']):<6}{' 기권' if r['abstain'] else ''}{mark}")
        print()
    print(json.dumps(m, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])
