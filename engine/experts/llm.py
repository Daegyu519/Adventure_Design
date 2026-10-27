"""프롬프트 + 라우터(사슬) + 출력 스키마 검사로 된 전문가."""
from __future__ import annotations

import time
from dataclasses import dataclass

from pydantic import BaseModel

from harness.prompts import render, turns_text
from harness.router import Router
from harness.schemas import ContextReading, FeedbackResult, JudgeOut, RewriteSet, ToneReading

from .base import ExpertRequest, ExpertResult

SCHEMAS: dict[str, type[BaseModel]] = {"context": ContextReading, "tone": ToneReading, "judge": JudgeOut,
                                       "rewrite": RewriteSet, "feedback": FeedbackResult}


@dataclass
class LLMExpert:
    id: str
    role: str
    paths: set[str]
    weight: float
    prompt: str
    router: Router

    async def run(self, req: ExpertRequest, deadline: float) -> ExpertResult:
        # 판정 전문가에는 의도를 넣지 않는다(의도 칩만 바꾼 재호출이 캐시에 걸리게)
        intent = req.intent if self.role == "rewrite" else None
        turns = ([req.reply_to] if req.reply_to else []) + req.turns
        variables = {
            "relation": req.relation,
            "room": "그룹방" if req.room_kind == "group" else "1:1",
            "turns": turns_text([t.model_dump() for t in turns]),
            "last_them": req.last_them(),
            "draft": req.draft,
            "intent": intent or "보낸 뜻 그대로",
            "signals": ", ".join(req.signals) or "없음",
            **req.extra,
        }
        system, user = render(self.prompt, **variables)
        payload = req.model_dump(mode="json", exclude={"path", "extra"}) | req.extra
        payload["intent"] = intent
        t0 = time.monotonic()
        out, model = await self.router.call(self.id, system, user, payload, SCHEMAS[self.role], deadline)
        return ExpertResult(expert_id=self.id, role=self.role, output=out,
                            confidence=getattr(out, "confidence", 1.0),
                            latency_ms=round((time.monotonic() - t0) * 1000), model=model)
