"""앱 ↔ 엔진 요청·응답 모델(ARCHITECTURE 4장). 앱 타입은 여기서 나온 OpenAPI로 생성한다(손으로 복제하지 않는다).
응답에는 내부 점수(risk, 확률, 가중치, signals …)를 넣지 않는다."""
from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, Field, StringConstraints

Draft = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
Reading = Literal["차갑게", "성의없게", "화나게", "무난하게", "따뜻하게"]
Freq = Literal["자주", "가끔", "드물어요"]


class HintIn(BaseModel):
    room_id: UUID
    text: Draft
    seq: int = Field(ge=0)
    reply_to: int | None = Field(None, gt=0, lt=2**63)   # messages.id는 양수 bigint(hooks.py와 같은 범위)


class HintBody(BaseModel):
    title: str
    detail: str


class HintOut(BaseModel):
    seq: int
    hint: HintBody | None
    trace_id: UUID


class FeedbackIn(BaseModel):
    room_id: UUID
    message_id: int = Field(gt=0, lt=2**63)   # messages.id는 양수 bigint
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]


class FeedbackOut(BaseModel):
    ack: str


Intent = Literal["단호하게", "미안하게", "가볍게"]   # 의도 칩. 고쳐 쓰기에만 들어간다(판정에는 넣지 않음)


class Readings(BaseModel):
    """읽힘 키 다섯 개 모두 필수. 값은 자주/가끔/드물어요로만(확률 없음)."""
    차갑게: Freq
    성의없게: Freq
    화나게: Freq
    무난하게: Freq
    따뜻하게: Freq


class DetailIn(BaseModel):
    room_id: UUID
    text: Draft
    intent: Intent | None = None
    reply_to: int | None = Field(None, gt=0, lt=2**63)


class OptionOut(BaseModel):
    label: str
    text: str
    keep: list[str]
    change: list[str]


class DetailOut(BaseModel):
    alert: bool
    top_reading: Reading
    readings: Readings
    why: list[str]
    options: list[OptionOut]
    mismatch: str | None = None   # 엔진이 만든 어긋남 한 줄. 앱은 그대로 보여 준다
    footnote: str
    trace_id: UUID


class WeekCount(BaseModel):
    week: str   # KST ISO 주 시작(월요일) YYYY-MM-DD
    count: int


class WeekGap(BaseModel):
    week: str
    avg_gap: float


class StatsOut(BaseModel):
    hints: int
    details: int
    fixed: int
    fix_rate: float = Field(ge=0, le=1)
    hints_by_week: list[WeekCount]
    predict_gap_trend: list[WeekGap]
