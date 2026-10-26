"""L3 판단. L0·L1·L2 결과를 계산식으로 합치고, 의견이 갈리면 기권하거나 심판 모델에 묻는다."""
from __future__ import annotations

import math

from pydantic import BaseModel

from harness import korean as K
from harness import prompts
from harness.router import NoResult, Router
from harness.schemas import ContextReading, Conversation, GateResult, ToneReading, Verdict
from harness.store import ProfileStore


def missing_points(draft: str, ctx: ContextReading, tones: list[ToneReading]) -> list[str]:
    """상대가 기대했을 요소 중 문장에 없는 것."""
    s = K.surface(draft)
    has_reason = s["has_reason"] or any(t.has_reason for t in tones)
    warm = s["softener"] or s["apology"] or s["hedge"]
    checks = {
        "이유 설명": not has_reason,
        "대안 제시": s["refusal"] and "대신" not in draft,
        "공감 한마디": not (warm or s["question_back"]) and s["length"] < 15,
        "성의 있는 길이": s["short"] or s["length"] < 8,
        "축하": "축하" not in draft and "ㅊㅋ" not in draft,
        "반응": not warm and s["length"] < 10,
        "받아 주는 말": s["short"] or (s["period_end"] and not warm),
        "확인": False,
    }
    return [p for p in ctx.expectation_points if checks.get(p, False)]


def aggregate(draft: str, gate: GateResult, ctx: ContextReading, tones: list[ToneReading],
              store: ProfileStore, convo: Conversation, cfg: dict) -> Verdict:
    w = cfg["weights"]
    negs = [t.negative for t in tones]
    confs = [t.confidence for t in tones]
    neg = sum(n * c for n, c in zip(negs, confs)) / (sum(confs) or 1)
    disagreement = (max(negs) - min(negs)) if len(negs) > 1 else 0.0

    missing = missing_points(draft, ctx, tones)
    violation = len(missing) / len(ctx.expectation_points) if ctx.expectation_points else 0.0

    # 관계 패턴은 전체 패턴에도 충분히 쌓인 신호일 때만 반영 (한 사람 하소연만으로 알림 금지)
    pair = store.patterns_for(convo.pair_id)
    usable = [sig for sig in gate.signals
              if sig in pair and store.global_patterns.get(sig, 0) >= cfg["global_min_obs"]]
    pattern = min(1.0, sum(pair[s]["strength"] / 3 for s in usable))

    z = w["bias"] + w["prior"] * gate.prior + w["neg"] * neg + w["violation"] * violation + w["pattern"] * pattern
    risk = 1 / (1 + math.exp(-z))
    confidence = (ctx.confidence + sum(confs) / len(confs)) / 2

    abstain = disagreement > cfg["max_disagreement"] or confidence < cfg["min_confidence"]
    alert = (not abstain) and risk >= cfg["alert_threshold"]

    merged = {k: sum(t.readings[k] for t in tones) / len(tones) for k in tones[0].readings}
    negative_top = max(("차갑게", "성의없게", "화나게"), key=lambda k: merged[k])
    signals = list(dict.fromkeys(gate.signals + [f"{p} 없음" for p in missing]))

    return Verdict(
        risk=round(risk, 3), top_reading=negative_top if alert else max(merged, key=merged.get),
        signals=signals, disagreement=round(disagreement, 3), confidence=round(confidence, 3),
        abstain=abstain, alert=alert, pattern_used=bool(usable),
        reason=f"prior={gate.prior} neg={neg:.2f} violation={violation:.2f} pattern={pattern:.2f}",
    )


class JudgeOut(BaseModel):
    alert: bool
    reason: str = ""


async def arbitrate(router: Router, verdict: Verdict, draft: str, convo: Conversation,
                    ctx: ContextReading, tones: list[ToneReading], deadline: float) -> Verdict:
    """두 말투 판단이 크게 갈렸을 때만 심판 모델에 묻는다. 실패하면 기권 그대로 둔다."""
    turns = [t.model_dump() for t in convo.turns]
    system, user = prompts.render(
        "judge", relation=convo.relation, turns=prompts.turns_text(turns), draft=draft,
        context=ctx.model_dump_json(), tone_a=tones[0].model_dump_json(), tone_b=tones[-1].model_dump_json())
    payload = {"risk": verdict.risk, "draft": draft}
    try:
        out, model = await router.call("judge", system, user, payload, JudgeOut, deadline)
    except NoResult:
        return verdict
    return verdict.model_copy(update={"abstain": False, "alert": out.alert,
                                      "reason": verdict.reason + f" | 심판({model}): {out.reason}"})
