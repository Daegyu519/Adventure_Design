"""L0 거르기. LLM 없이 겉 신호만 보고 위험 사전점수를 낸다. 대부분의 메시지는 여기서 끝난다."""
from __future__ import annotations

from harness import korean as K
from harness.schemas import Conversation, GateResult
from harness.store import ProfileStore


def score(draft: str, convo: Conversation, store: ProfileStore, user_id: str, threshold: float) -> GateResult:
    s = K.surface(draft)
    last = convo.last_them()
    signals: list[str] = []
    prior = 0.0

    if s["refusal"] and not s["has_reason"]:
        prior += 0.35
        signals.append("이유 없는 거절")
    if s["period_end"]:
        prior += 0.1
        signals.append("마침표로 끝남")
    if s["short"]:
        prior += 0.15
        signals.append("짧은 답")
    # 겉 신호만 보면 맥락이 중요한 경우를 놓친다. 상대 말이 무거우면 짧은 답도 LLM에 넘긴다.
    if K.high_stakes(last) and (s["short"] or s["length"] < 10):
        prior += 0.25
        signals.append("감정 표현에 짧은 답" if K.emotional(last) else "상대 말에 비해 짧은 답")
    if K.emotional(last) and not (s["softener"] or s["apology"]):
        prior += 0.1

    base = store.baseline(user_id)
    if base:
        if s["length"] < 0.4 * base["avg_len"]:
            prior += 0.1
            signals.append("평소보다 짧음")
        if base["polite_rate"] > 0.8 and not s["polite"]:
            prior += 0.15
            signals.append("존댓말이 갑자기 빠짐")

    pair = store.patterns_for(convo.pair_id)
    matched = [sig for sig in signals if sig in pair]
    prior += min(0.3, 0.15 * len(matched))

    for k in ("softener", "hedge", "apology"):
        if s[k]:
            prior -= 0.1
    if s["has_reason"]:
        prior -= 0.1

    prior = round(max(0.0, min(1.0, prior)), 3)
    return GateResult(prior=prior, signals=signals, passed=prior >= threshold)
