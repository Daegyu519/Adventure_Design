"""L2 말투. 문장이 어떻게 읽힐 수 있는지 분포로 낸다. 상세 경로에서는 다른 계열 모델로 두 번 읽는다."""
from __future__ import annotations

from harness import pii, prompts
from harness.router import Router
from harness.schemas import Conversation, ToneReading


async def read(router: Router, draft: str, convo: Conversation, role: str, deadline: float,
               names: list[str] | None = None) -> ToneReading:
    draft_m = pii.mask(draft, names)
    last = pii.mask(convo.last_them(), names)
    system, user = prompts.render("tone", relation=convo.relation, last_them=last, draft=draft_m)
    payload = {"draft": draft_m, "last_them": last}
    obj, _ = await router.call(role, system, user, payload, ToneReading, deadline)
    return obj
