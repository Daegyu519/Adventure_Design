"""대조 세트 평가. 같은 문장이 맥락에 따라 다르게 판단되는지, 알림이 얼마나 정확한지 본다.
프롬프트나 모델을 바꿀 때마다 돌린다.   python -m eval.run_eval [--mock] [--detail]

보는 숫자
- 정밀도: 알림을 띄운 것 중 실제로 알림이 맞았던 비율 (가장 중요)
- 재현율: 알림이 필요했던 것 중 띄운 비율
- 기권률: 판단이 갈려 말하지 않은 비율
- 맥락 구분: 같은 문장 쌍에서 A는 알림 없음, B는 알림 있음으로 정확히 갈린 쌍의 비율
mock 모드 숫자는 배관 점검용이라 의미가 없다."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from harness.pipeline import TonePipeline
from harness.router import Router
from harness.schemas import Conversation, Turn
from harness.store import ProfileStore

HERE = Path(__file__).parent


async def main(force_mock: bool, detail: bool) -> dict:
    items = [json.loads(l) for l in (HERE / "contrast_set.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    router = Router.from_file(force_mock=force_mock)
    pipe = TonePipeline(router, ProfileStore())
    rows, feats = [], []
    for it in items:
        c = Conversation(pair_id=f"eval-{it['pair']}", relation=it["relation"],
                         turns=[Turn(speaker="them", text=it["them"])])
        if detail:
            d = await pipe.detail(it["draft"], c)
            v = d.verdict if d else None
        else:
            v = (await pipe.realtime(it["draft"], c)).verdict
        pred = bool(v and v.alert)
        abstain = bool(v and v.abstain)
        rows.append({**it, "pred": pred, "abstain": abstain, "risk": v.risk if v else None})
        if v:
            feats.append({"reason": v.reason, "label": it["alert"]})

    tp = sum(r["pred"] and r["alert"] for r in rows)
    fp = sum(r["pred"] and not r["alert"] for r in rows)
    fn = sum((not r["pred"]) and r["alert"] for r in rows)
    pairs = {}
    for r in rows:
        pairs.setdefault(r["pair"], {})[r["side"]] = r["pred"]
    split_ok = sum(1 for p in pairs.values() if p.get("A") is False and p.get("B") is True)

    print(f"{'쌍':<3}{'면':<3}{'상대의 말':<28}{'문장':<10}{'정답':<6}{'예측':<6}{'risk':<6}")
    for r in rows:
        mark = "" if r["pred"] == r["alert"] else "  ← 틀림"
        print(f"{r['pair']:<3}{r['side']:<3}{r['them'][:24]:<28}{r['draft']:<10}"
              f"{str(r['alert']):<6}{str(r['pred']):<6}{str(r['risk']):<6}{' 기권' if r['abstain'] else ''}{mark}")
    m = {
        "precision": round(tp / (tp + fp), 2) if tp + fp else None,
        "recall": round(tp / (tp + fn), 2) if tp + fn else None,
        "abstain_rate": round(sum(r["abstain"] for r in rows) / len(rows), 2),
        "context_split": f"{split_ok}/{len(pairs)}",
        "mode": "mock" if force_mock or not any(t["ok"] and not t["model"].startswith("mock") for t in router.traces) else "live",
    }
    print("\n", json.dumps(m, ensure_ascii=False))
    return m


if __name__ == "__main__":
    asyncio.run(main(force_mock="--mock" in sys.argv, detail="--detail" in sys.argv))
