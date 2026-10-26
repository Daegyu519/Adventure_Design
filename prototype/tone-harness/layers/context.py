"""L1 맥락. 상대 직전 말의 의도, 상대 상태, 상대가 기대할 답의 모양을 읽는다."""
from __future__ import annotations

from harness import pii, prompts
from harness.router import Router
from harness.schemas import ContextReading, Conversation


async def read(router: Router, convo: Conversation, deep: bool, deadline: float,
               names: list[str] | None = None) -> ContextReading:
    turns = [{"speaker": t.speaker, "text": pii.mask(t.text, names)} for t in convo.turns]
    system, user = prompts.render("context", relation=convo.relation, turns=prompts.turns_text(turns))
    payload = {"relation": convo.relation, "turns": turns}
    role = "context_deep" if deep else "context_fast"
    obj, _ = await router.call(role, system, user, payload, ContextReading, deadline)
    return obj
