"""고쳐 쓰기. 후보를 만든 뒤 세 가지를 확인해서 통과한 것만 보여 준다.
1) 의도가 그대로인가  2) 내 말투(존댓말/반말)가 그대로인가  3) 오해 가능성이 실제로 줄었나"""
from __future__ import annotations

import asyncio
import re

from harness import korean as K
from harness import prompts
from harness.router import NoResult, Router
from harness.schemas import Conversation, RewriteOption, RewriteSet, Verdict
from layers import tone as tone_layer


async def suggest(router: Router, draft: str, convo: Conversation, intent: str, verdict: Verdict,
                  original_neg: float, deadline: float) -> list[RewriteOption]:
    system, user = prompts.render("rewrite", relation=convo.relation, last_them=convo.last_them(),
                                  draft=draft, intent=intent, signals=", ".join(verdict.signals))
    try:
        cands, _ = await router.call("rewrite", system, user,
                                     {"draft": draft, "intent": intent, "signals": verdict.signals},
                                     RewriteSet, deadline)
    except NoResult:
        return []

    src = K.surface(draft)

    async def check(opt: RewriteOption) -> RewriteOption | None:
        s = K.surface(re.sub(r"\(.*?\)", "", opt.text).strip())   # "(이유)" 같은 빈칸은 빼고 본다
        if src["refusal"] and not s["refusal"]:
            return None                                   # 거절이 승낙으로 바뀌면 탈락
        if src["polite"] != s["polite"]:
            return None                                   # 존댓말/반말이 바뀌면 탈락
        try:
            t = await tone_layer.read(router, opt.text, convo, "tone_fast", deadline)
        except NoResult:
            return None
        return opt if t.negative <= original_neg - 0.1 else None   # 덜 부정적으로 읽혀야 통과

    checked = await asyncio.gather(*(check(o) for o in cands.options))
    return [o for o in checked if o]
