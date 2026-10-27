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
