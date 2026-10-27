"""전문가 인터페이스. 모델·분류기는 모두 이 규격으로 꽂는다(ARCHITECTURE 6-2)."""
from __future__ import annotations

from typing import Any, Literal, Protocol

from pydantic import BaseModel

from harness.schemas import (ContextReading, Conversation, FeedbackResult, JudgeOut, RewriteSet, ToneReading, Turn,
                             last_them)

ExpertPath = Literal["realtime", "detail", "mirror", "async"]


class ExpertRequest(BaseModel):
    path: ExpertPath
    draft: str                        # 가린 상태
    turns: list[Turn] = []            # 가린 상태, 오래된 것 → 최신
    relation: str
    signals: list[str] = []
    reply_to: Turn | None = None      # 답장 대상(가린 상태). 프롬프트 맥락 맨 앞 줄
    room_kind: Literal["direct", "group"] = "direct"
    intent: str | None = None         # rewrite 전문가에게만 전달된다
    extra: dict[str, Any] = {}        # judge: context/tone_a/tone_b/risk, feedback: text/about

    @classmethod
    def from_convo(cls, path: ExpertPath, draft: str, convo: Conversation, signals: list[str]) -> "ExpertRequest":
        return cls(path=path, draft=draft, turns=convo.turns, relation=convo.relation, signals=signals,
                   reply_to=convo.reply_to, room_kind=convo.kind)

    def last_them(self) -> str:
        return last_them(self.turns, self.reply_to)


class ExpertResult(BaseModel):
    expert_id: str
    role: Literal["context", "tone", "judge", "rewrite", "feedback"]
    output: ContextReading | ToneReading | JudgeOut | RewriteSet | FeedbackResult
    confidence: float
    latency_ms: int
    model: str                        # 실제로 응답한 provider:model


class Expert(Protocol):
    id: str
    role: str
    paths: set[str]
    weight: float

    async def run(self, req: ExpertRequest, deadline: float) -> ExpertResult: ...
