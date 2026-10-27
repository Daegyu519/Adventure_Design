"""L3 집계. L0·L1·L2 결과를 계산식으로 합치고, 의견이 갈리거나 자신 없으면 기권한다(ARCHITECTURE 6-3).

경로 구분은 호출자가 한다. 시간 안에 못 온 전문가는 `run_all`이 이미 뺐다. 기권(`abstain`)이면 실시간은 힌트를 내지
않고, 상세는 `verdict.disagreement > max_disagreement`일 때만 심판에 묻는다.
"""
from __future__ import annotations

import math

from harness import korean as K
from harness.schemas import NEGATIVE, READINGS, ContextReading, Conversation, GateResult, ToneReading, Verdict
from harness.store import ProfileStore
from layers.gate import pattern_matches

Tones = list[tuple[ToneReading, float]]   # (읽힘, 전문가 weight)
NEUTRAL = "무난하게"
TERMS = ("prior", "neg", "violation", "pattern")


def unit(x: float) -> float:
    """LLM이 준 confidence는 위에서 범위 검사를 하지 않는다. [0, 1]로 자르고, NaN·무한대는 0(그 전문가를 안 씀)."""
    return min(1.0, max(0.0, x)) if math.isfinite(x) else 0.0


def _used(tones: Tones) -> list[tuple[ToneReading, float]]:
    """(읽힘, α). α = weight × confidence가 0인 전문가는 어디에도 세지 않는다."""
    return [(t, a) for t, w in tones if (a := w * unit(t.confidence)) > 0]


def merged(tones: Tones) -> dict[str, float]:
    """α 가중 평균 읽힘(키 5개). 쓸 전문가가 없으면 무난하게 1."""
    used = _used(tones)
    total = sum(a for _, a in used)
    if not total:
        return {k: float(k == NEUTRAL) for k in READINGS}
    return {k: sum(a * t.readings[k] for t, a in used) / total for k in READINGS}


def negative(readings: dict[str, float]) -> float:
    return sum(readings[k] for k in NEGATIVE)


def top_reading(readings: dict[str, float], alert: bool) -> str:
    """알림이면 부정 셋 중 최대, 아니면 다섯 중 최대."""
    return max(NEGATIVE if alert else READINGS, key=readings.__getitem__)


def missing_points(draft: str, ctx: ContextReading, tones: Tones) -> list[str]:
    """상대가 기대했을 요소 중 문장에 없는 것."""
    s = K.surface(draft)
    has_reason = s["has_reason"] or any(t.has_reason for t, _ in tones)
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


def aggregate(draft: str, gate: GateResult, ctx: ContextReading | None, tones: Tones,
              store: ProfileStore, convo: Conversation, cfg: dict) -> Verdict:
    used = _used(tones)
    if not used:
        return Verdict(risk=0.0, top_reading=NEUTRAL, signals=gate.signals, disagreement=0.0, confidence=0.0,
                       abstain=True, alert=False)

    m = merged(tones)
    negs = [negative(t.readings) for t, _ in used]
    missing = missing_points(draft, ctx, used) if ctx is not None else []
    # 보낸 사람 패턴은 전체 관찰 수가 기준 이상인 신호만 (한 사람 신고만으로 알림 금지)
    pair = store.patterns_for(convo.pair_id)
    matched = pattern_matches(gate.signals, store, convo.pair_id, cfg["global_min_obs"])
    tone_conf = sum(unit(t.confidence) for t, _ in used) / len(used)

    f = {
        "prior": gate.prior,
        "neg": negative(m),   # = Σα·neg_k / Σα
        "violation": len(missing) / len(ctx.expectation_points) if ctx is not None and ctx.expectation_points else 0.0,
        "pattern": min(1.0, sum(pair[s]["strength"] / 3 for s in matched)),
        "disagreement": max(negs) - min(negs),
        "confidence": (unit(ctx.confidence) + tone_conf) / 2 if ctx is not None else tone_conf,
    }
    w = cfg["weights"]
    z = w["bias"] + sum(w[k] * f[k] for k in TERMS)
    risk = 0.5 * (1 + math.tanh(z / 2))   # = sigmoid(z), 넘침 없음
    abstain = f["disagreement"] > cfg["max_disagreement"] or f["confidence"] < cfg["min_confidence"]
    alert = not abstain and risk >= cfg["alert_threshold"]

    return Verdict(
        risk=round(risk, 3), top_reading=top_reading(m, alert),
        signals=list(dict.fromkeys(gate.signals + [f"{p} 없음" for p in missing])),
        disagreement=round(f["disagreement"], 3), confidence=round(f["confidence"], 3),
        abstain=abstain, alert=alert, pattern_used=bool(matched), features=f,
    )
