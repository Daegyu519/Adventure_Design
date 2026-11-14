"""L0 거르기. LLM 없이 겉 신호만 보고 위험 사전점수를 낸다. 대부분의 메시지는 여기서 끝난다."""
from __future__ import annotations

from harness import korean as K
from harness.schemas import Conversation, GateResult
from harness.store import ProfileStore


def pattern_matches(signals: list[str], store: ProfileStore, pair_id: str, global_min_obs: int) -> list[str]:
    """보낸 사람 패턴과 겹치는 신호 중 전체 관찰 수가 global_min_obs 이상인 것만. L0·L3가 같이 쓴다(규칙 7)."""
    pair = store.patterns_for(pair_id)
    return [s for s in signals if s in pair and store.global_patterns.get(s, 0) >= global_min_obs]


def score(draft: str, convo: Conversation, store: ProfileStore, user_id: str, threshold: float,
          global_min_obs: int) -> GateResult:
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
    if s["profanity"]:
        prior += 0.35
        signals.append("비속어")
    if s["blame"]:
        prior += 0.2
        signals.append("따지는 말투")
    if s["consonants"]:   # 읽힘 고르기용 표시(짧은 답이 이미 사전점수를 올렸다)
        signals.append("자음만 쓴 답")
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

    # 한 사람의 신고만으로는 오르지 않는다
    matched = pattern_matches(signals, store, convo.pair_id, global_min_obs)
    prior += min(0.3, 0.15 * len(matched))

    # 욕·따지는 말에 붙은 "!", "~", "좀"은 누그러뜨리는 말이 아니다("꺼져!", "좀 닥쳐"). 사과만 그대로 본다(P-42)
    rough = s["profanity"] or s["blame"]
    for k in ("softener", "hedge", "apology"):
        if s[k] and not (rough and k != "apology"):
            prior -= 0.1
    if s["has_reason"]:
        prior -= 0.1

    prior = round(max(0.0, min(1.0, prior)), 3)
    return GateResult(prior=prior, signals=signals, passed=prior >= threshold)
