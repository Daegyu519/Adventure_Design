"""세 경로를 묶는 오케스트레이터.
- realtime: 입력 중. L0 → (통과 시) L1·L2 병렬 → L3 계산식 → 힌트. 1.5초 넘으면 조용히 포기.
- detail:   '살펴보기'를 눌렀을 때. 큰 모델 + 두 번째 의견 + (갈리면) 심판 + 고쳐 쓰기.
- feedback: 상대의 하소연. 비동기로 패턴만 남기고 원문은 버린다."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

from layers import context as context_layer
from layers import feedback as feedback_layer
from layers import gate as gate_layer
from layers import hint as hint_layer
from layers import judge as judge_layer
from layers import rewrite as rewrite_layer
from layers import tone as tone_layer

from . import korean as K
from .router import NoResult, Router
from .schemas import Conversation, DetailReport, FeedbackResult, GateResult, Hint, Verdict
from .store import ProfileStore


@dataclass
class RealtimeResult:
    gate: GateResult
    verdict: Verdict | None
    hint: Hint | None
    ms: int
    note: str = ""


@dataclass
class TonePipeline:
    router: Router
    store: ProfileStore
    user_id: str = "me"

    async def realtime(self, draft: str, convo: Conversation, user_id: str | None = None) -> RealtimeResult:
        t0 = time.monotonic()
        cfg = self.router.config
        gate = gate_layer.score(draft, convo, self.store, user_id or self.user_id, cfg["gate"]["threshold"])
        if not gate.passed:
            return RealtimeResult(gate, None, None, _ms(t0), "거르기에서 끝남 (LLM 호출 없음)")

        deadline = t0 + self.router.timeout("realtime")
        try:
            ctx, tone = await asyncio.gather(
                context_layer.read(self.router, convo, deep=False, deadline=deadline),
                tone_layer.read(self.router, draft, convo, "tone_fast", deadline),
            )
        except NoResult as e:
            return RealtimeResult(gate, None, None, _ms(t0), f"시간·한도 초과로 기권: {e}")

        verdict = judge_layer.aggregate(draft, gate, ctx, [tone], self.store, convo, cfg["judge"])
        return RealtimeResult(gate, verdict, hint_layer.render_hint(verdict), _ms(t0))

    async def detail(self, draft: str, convo: Conversation, intent: str = "",
                     user_id: str | None = None) -> DetailReport | None:
        t0 = time.monotonic()
        cfg = self.router.config
        deadline = t0 + self.router.timeout("detail")
        gate = gate_layer.score(draft, convo, self.store, user_id or self.user_id, 0.0)
        try:
            ctx, tone_a, tone_b = await asyncio.gather(
                context_layer.read(self.router, convo, deep=True, deadline=deadline),
                tone_layer.read(self.router, draft, convo, "tone_deep", deadline),
                tone_layer.read(self.router, draft, convo, "tone_second", deadline),
            )
        except NoResult:
            return None
        tones = [tone_a, tone_b]
        verdict = judge_layer.aggregate(draft, gate, ctx, tones, self.store, convo, cfg["judge"])
        if verdict.abstain and verdict.disagreement > cfg["judge"]["max_disagreement"]:
            verdict = await judge_layer.arbitrate(self.router, verdict, draft, convo, ctx, tones, deadline)

        readings = {k: (tone_a.readings[k] + tone_b.readings[k]) / 2 for k in tone_a.readings}
        options = []
        if verdict.alert:
            neg = (tone_a.negative + tone_b.negative) / 2
            options = await rewrite_layer.suggest(self.router, draft, convo, intent or "보낸 뜻 그대로",
                                                  verdict, neg, deadline)
        return hint_layer.render_detail(verdict, readings, options)

    async def feedback(self, text: str, pair_id: str, about_text: str = "") -> tuple[FeedbackResult, str]:
        deadline = time.monotonic() + self.router.timeout("async")
        return await feedback_layer.ingest(self.router, text, pair_id, self.store, deadline, about_text=about_text)

    def sent(self, text: str, user_id: str | None = None) -> None:
        """실제로 보낸 내 문장으로 기준선을 갱신한다(통계만, 원문 저장 없음)."""
        s = K.surface(text)
        self.store.update_baseline(user_id or self.user_id, s["length"], s["polite"], s["softener"])


def _ms(t0: float) -> int:
    return round((time.monotonic() - t0) * 1000)
