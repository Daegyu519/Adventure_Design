"""고쳐 쓰기 후보의 세 가지 확인(ARCHITECTURE 3-3): 의도 유지(거절은 거절), 존댓말·반말 유지, 실제로 덜 부정적.
후보·초안은 가린 상태로 들어온다(자리표시 되돌리기는 pipeline이 응답 직전에)."""
from __future__ import annotations

import asyncio
import re

from experts.base import Expert, ExpertRequest
from experts.registry import run_all
from harness import korean as K
from harness.schemas import RewriteOption

BLANK = re.compile(r"\([^()]*\)")   # "(이유)" 같은 빈칸


def surface_ok(draft: str, cand: str) -> bool:
    """괄호 빈칸을 빼고 본다. 거절이 거절로 남고 존댓말·반말이 같아야 한다."""
    src, s = K.surface(BLANK.sub("", draft)), K.surface(BLANK.sub("", cand))
    return (s["refusal"] or not src["refusal"]) and s["polite"] == src["polite"]


async def check(checker: Expert, req: ExpertRequest, options: list[RewriteOption], original_neg: float,
                deadline: float) -> list[tuple[int, RewriteOption]]:
    """surface_ok이고, 같은 checker로 읽은 neg가 original_neg - 0.1 이하인 후보만 원래 순번과 함께. checker가 실패하면 탈락."""
    async def neg(o: RewriteOption) -> float | None:
        res = await run_all([checker], req.model_copy(update={"draft": o.text}), deadline)
        return res[0].output.negative if res else None

    ok = [(i, o) for i, o in enumerate(options) if surface_ok(req.draft, o.text)]
    negs = await asyncio.gather(*(neg(o) for _, o in ok))
    return [(i, o) for (i, o), n in zip(ok, negs) if n is not None and n <= original_neg - 0.1]
