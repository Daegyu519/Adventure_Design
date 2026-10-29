"""레이어 사이에 오가는 데이터 형태. LLM 출력은 전부 여기서 검사한다."""
from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, Field, field_validator

READINGS = ("차갑게", "성의없게", "화나게", "무난하게", "따뜻하게")
NEGATIVE = ("차갑게", "성의없게", "화나게")
# 패턴 태그: gate 신호 7개 + feedback 프롬프트 태그
TRIGGERS: frozenset[str] = frozenset({
    "이유 없는 거절", "마침표로 끝남", "짧은 답", "감정 표현에 짧은 답", "상대 말에 비해 짧은 답",
    "평소보다 짧음", "존댓말이 갑자기 빠짐",
    "늦은 답에 사과 없음", "반말 전환", "농담에 정색",
})


class Turn(BaseModel):
    speaker: Literal["me", "them"]
    text: str
    label: str = ""                   # 그룹방 화자 표시. 비면 나/상대


def last_them(turns: list[Turn], reply_to: Turn | None) -> str:
    """답장 대상이 상대 말이면 그것, 아니면 마지막 상대 말."""
    if reply_to and reply_to.speaker == "them":
        return reply_to.text
    return next((t.text for t in reversed(turns) if t.speaker == "them"), "")


class Conversation(BaseModel):
    pair_id: str                      # 관계 ID (두 사람 조합)
    relation: str = "친구"            # 친구, 동기, 선배, 팀원 등
    turns: list[Turn] = Field(default_factory=list)
    reply_to: Turn | None = None
    kind: Literal["direct", "group"] = "direct"

    def last_them(self) -> str:
        return last_them(self.turns, self.reply_to)


# ---------- L0 ----------
class GateResult(BaseModel):
    prior: float                      # 0~1, LLM을 부를지 판단하는 사전점수
    signals: list[str]                # 예: "이유 없는 거절", "마침표로 끝남"
    passed: bool


# ---------- L1 ----------
class ContextReading(BaseModel):
    prev_act: Literal["질문", "부탁", "제안", "공유", "감정표현", "사과", "인사", "기타"] = "기타"
    partner_state: Literal["평온", "기대", "서운", "바쁨", "불확실"] = "불확실"
    expectation_points: list[str] = Field(default_factory=list)   # 예: "이유 설명", "공감 한마디"
    shared_context: list[str] = Field(default_factory=list)       # 둘만 아는 맥락 신호
    confidence: float = 0.5


# ---------- L2 ----------
class ToneReading(BaseModel):
    readings: dict[str, float]        # 읽힘 → 확률
    cues: list[str] = Field(default_factory=list)                 # 근거가 된 표현
    has_reason: bool = False
    confidence: float = 0.5
    model: str = ""

    @field_validator("readings")
    @classmethod
    def normalize(cls, v: dict[str, float]) -> dict[str, float]:
        # json.loads는 Infinity·NaN을 받는다. 0으로 바꾸지 않고 떨어뜨려 폴백시킨다(규칙 3)
        if not all(math.isfinite(x) for x in v.values()):
            raise ValueError("readings에 유한하지 않은 값")
        v = {k: max(0.0, float(v.get(k, 0.0))) for k in READINGS}
        s = sum(v.values()) or 1.0
        return {k: round(x / s, 3) for k, x in v.items()}

    @property
    def negative(self) -> float:
        return sum(self.readings[k] for k in NEGATIVE)

    @property
    def top(self) -> str:
        return max(self.readings, key=self.readings.get)


# ---------- 심판 ----------
class JudgeOut(BaseModel):
    alert: bool
    reason: str = ""


# ---------- L3 ----------
class Verdict(BaseModel):
    risk: float
    top_reading: str
    signals: list[str]
    disagreement: float
    confidence: float
    abstain: bool
    alert: bool
    pattern_used: bool = False
    reason: str = ""                  # 기록용. 사용자에게는 안 보임
    features: dict[str, float] = Field(default_factory=dict)  # prior, neg, violation, pattern, disagreement, confidence


# ---------- 고쳐 쓰기 ----------
class RewriteOption(BaseModel):
    label: str                        # "덜 차갑게", "가장 부드럽게"
    text: str
    keep: list[str] = Field(default_factory=list)     # 지킨 것 (의도, 말투)
    change: list[str] = Field(default_factory=list)   # 바꾼 것


class RewriteSet(BaseModel):
    options: list[RewriteOption]


# ---------- L4 ----------
class FeedbackPattern(BaseModel):
    trigger: str                      # 패턴 태그. 예: "이유 없는 거절"
    feeling: str                      # 예: "차갑게"
    strength: int = Field(ge=1, le=3, default=1)


class FeedbackResult(BaseModel):
    usable: bool
    patterns: list[FeedbackPattern] = Field(default_factory=list)
    dropped_reason: str | None = None  # 욕설, 인신공격, 무관한 내용

    @field_validator("patterns")
    @classmethod
    def first_three_unique(cls, v: list[FeedbackPattern]) -> list[FeedbackPattern]:
        """고정 어휘(TRIGGERS)·부정 읽힘만 남긴 뒤 trigger별 첫 것, 앞 3개. 거르기가 먼저라 L4가 앞에 흘린 문장 조각·
        긍정 읽힘이 자리를 먹지 않는다."""
        first: dict[str, FeedbackPattern] = {}
        for p in v:
            if p.trigger in TRIGGERS and p.feeling in NEGATIVE:
                first.setdefault(p.trigger, p)    # trigger가 겹치면 첫 것만
        return list(first.values())[:3]


# ---------- 출력 ----------
class Hint(BaseModel):
    title: str
    detail: str
    action: str = "살펴보기"


class DetailReport(BaseModel):
    verdict: Verdict
    readings: dict[str, str]          # 읽힘 → "자주/가끔/드물어요"
    why: list[str]
    options: list[RewriteOption]
    footnote: str
