"""mock 모델의 판단 규칙. 실제 LLM이 돌려줄 JSON과 같은 모양을 만든다.
배관(라우팅, 스키마, 판단식)이 도는지 보기 위한 것이라 정확도 숫자에는 의미가 없다."""
from __future__ import annotations

import re

from . import korean as K


def context(p: dict) -> dict:
    last = next((t["text"] for t in reversed(p.get("turns", [])) if t["speaker"] == "them"), "")
    if K.APOLOGY.search(last):
        return {"prev_act": "사과", "partner_state": "서운", "expectation_points": ["받아 주는 말"],
                "shared_context": [], "confidence": 0.7}
    if K.shares_news(last):
        return {"prev_act": "공유", "partner_state": "기대", "expectation_points": ["반응", "축하"],
                "shared_context": [], "confidence": 0.75}
    if K.emotional(last):
        return {"prev_act": "감정표현", "partner_state": "서운", "expectation_points": ["공감 한마디", "성의 있는 길이"],
                "shared_context": [], "confidence": 0.7}
    if K.invites(last):
        return {"prev_act": "제안", "partner_state": "기대", "expectation_points": ["반응"],
                "shared_context": [], "confidence": 0.65}
    if K.asks_favor(last):
        pts = ["이유 설명", "대안 제시"] if K.has_reason(last) else ["이유 설명"]
        return {"prev_act": "부탁", "partner_state": "기대", "expectation_points": pts,
                "shared_context": [], "confidence": 0.7}
    if last.endswith("?") or re.search(r"(맞지|맞죠|할래|어때)", last):
        return {"prev_act": "질문", "partner_state": "평온", "expectation_points": ["확인"],
                "shared_context": [], "confidence": 0.7}
    return {"prev_act": "기타", "partner_state": "평온", "expectation_points": [],
            "shared_context": [], "confidence": 0.5}


def _tone(draft: str, w: dict) -> dict:
    s = K.surface(draft)
    cold = 0.15 + w["period"] * s["period_end"] + w["refusal"] * (s["refusal"] and not s["has_reason"])
    lazy = 0.1 + w["short"] * s["short"]
    angry = 0.05 + 0.2 * (s["refusal"] and s["period_end"] and not s["polite"])
    plain = 0.5 - 0.2 * s["short"]
    warm = 0.1 + 0.35 * s["softener"] + 0.2 * s["hedge"] + 0.2 * s["has_reason"] + 0.2 * s["apology"]
    cues = [k for k in ("period_end", "short", "refusal") if s[k]]
    return {"readings": {"차갑게": cold, "성의없게": lazy, "화나게": angry, "무난하게": max(plain, 0.05), "따뜻하게": warm},
            "cues": cues, "has_reason": s["has_reason"], "confidence": 0.6}


def tone(p: dict) -> dict:
    return _tone(p["draft"], {"period": 0.25, "refusal": 0.45, "short": 0.45})


def tone_alt(p: dict) -> dict:
    # 일부러 조금 다르게 반응하는 두 번째 모델 흉내 (의견 차이 계산 시연용)
    return _tone(p["draft"], {"period": 0.15, "refusal": 0.55, "short": 0.3})


def judge(p: dict) -> dict:
    return {"alert": p.get("risk", 0) >= 0.55, "reason": "mock 심판: 계산식 위험도를 그대로 따름"}


def rewrite(p: dict) -> dict:
    d = re.sub(r"[.\s]+$", "", p["draft"])
    if K.surface(d)["refusal"]:
        rest = re.sub(r"^(안\s?돼요|안돼요)[.\s]*", "", d)
        a = "지금은 어려울 것 같아요" + (f"! {rest}" if rest else ". (이유 한 줄)")
        b = "미안하지만 이번엔 어려울 것 같아요" + (f". {rest}" if rest else ". (이유)") + " 대신 (대안)은 어때요?"
    elif K.surface(d)["short"]:
        a, b = f"{d}! 알려 줘서 고마워", f"{d} ㅎㅎ 그럼 그때 봐"
    else:
        a, b = f"{d}~", f"{d} ㅎㅎ"
    return {"options": [
        {"label": "덜 차갑게 읽힐 수 있어요", "text": a, "keep": ["거절 의도", "존댓말"], "change": ["마침표", "이유 자리"]},
        {"label": "가장 부드럽게 읽힐 수 있어요", "text": b, "keep": ["거절 의도"], "change": ["사과 한마디", "대안"]},
    ]}


def feedback(p: dict) -> dict:
    t = p["text"]
    if re.search(r"(시발|씨발|병신|꺼져|미친놈)", t):
        return {"usable": False, "patterns": [], "dropped_reason": "욕설·인신공격"}
    pats = []
    # 길게 눌러 고른 메시지가 있으면 그 메시지의 겉 신호와 하소연의 느낌을 연결한다
    about = p.get("about") or ""
    if about and re.search(r"(차갑|딱딱|정색|서운|기분|상처|성의|대충|무시)", t):
        feeling = "성의없게" if re.search(r"(성의|대충|무시|단답)", t) else "차갑게"
        s = K.surface(about)
        if s["refusal"] and not s["has_reason"]:
            pats.append({"trigger": "이유 없는 거절", "feeling": "차갑게", "strength": 2})
        if s["short"]:
            pats.append({"trigger": "짧은 답", "feeling": feeling, "strength": 2})
        if s["period_end"]:
            pats.append({"trigger": "마침표로 끝남", "feeling": "차갑게", "strength": 1})
    if re.search(r"(이유|설명)", t) and re.search(r"(거절|안 돼|안돼|못 해)", t):
        pats.append({"trigger": "이유 없는 거절", "feeling": "차갑게", "strength": 2})
    if re.search(r"(단답|ㅇㅇ|짧게|짧은)", t):
        pats.append({"trigger": "짧은 답", "feeling": "성의없게", "strength": 2})
    if re.search(r"(마침표|딱딱|정색)", t):
        pats.append({"trigger": "마침표로 끝남", "feeling": "차갑게", "strength": 1})
    if re.search(r"(공감|들어주|반응)", t):
        pats.append({"trigger": "감정 표현에 짧은 답", "feeling": "성의없게", "strength": 2})
    pats = list({p_["trigger"]: p_ for p_ in pats}.values())   # 같은 태그는 하나로
    if not pats:
        return {"usable": False, "patterns": [], "dropped_reason": "말투 패턴을 찾지 못함"}
    return {"usable": True, "patterns": pats, "dropped_reason": None}
