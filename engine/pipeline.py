"""판정 파이프라인의 입구. 외부 모델로 가는 문장은 여기서 요청마다 한 번 `Masker`(참여자 이름 + 개인정보 패턴)를
거친다. 레이어·전문가는 가린 문장만 받는다. 대응표는 이 함수의 `Masker` 메모리에만 있고 밖으로 내보내지 않는다."""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Literal

from experts.base import ExpertRequest, ExpertResult
from experts.registry import Registry, run_all
from harness.pii import Masker
from harness.schemas import Conversation, FeedbackResult, GateResult, Hint, Verdict
from harness.store import ProfileStore
from layers import gate
from layers.aggregate import aggregate
from layers.guard import render_hint


@dataclass(frozen=True)
class RealtimeOutcome:
    gate: GateResult
    verdict: Verdict | None
    hint: Hint | None
    results: list[ExpertResult]
    outcome: Literal["gated", "abstain", "alert", "none"]


async def realtime(reg: Registry, draft: str, convo: Conversation, store: ProfileStore, user_id: str,
                   names: list[str], t0: float) -> RealtimeOutcome:
    """t0는 요청이 들어온 time.monotonic(). 전문가는 t0 + expert_deadline_ms 안에 온 것만 쓴다."""
    m = Masker(names)
    draft, convo = m(draft), m.conversation(convo)
    path, agg = reg.cfg["paths"]["realtime"], reg.cfg["aggregate"]

    g = gate.score(draft, convo, store, user_id, path["gate_threshold"], agg["global_min_obs"])
    if not g.passed:
        return RealtimeOutcome(g, None, None, [], "gated")

    experts = reg.for_path("realtime", "context") + reg.for_path("realtime", "tone")
    req = ExpertRequest.from_convo("realtime", draft, convo, g.signals)
    results = await run_all(experts, req, t0 + path["expert_deadline_ms"] / 1000)

    ctx = next((r.output for r in results if r.role == "context"), None)
    tones = [(r.output, reg.weight(r.expert_id)) for r in results if r.role == "tone"]
    v = aggregate(draft, g, ctx, tones, store, convo, agg)
    hint = render_hint(v)
    return RealtimeOutcome(g, v, hint, results, "abstain" if v.abstain else "alert" if v.alert else "none")


def mask_feedback(complaint: str, about: str, names: list[str]) -> tuple[str, str]:
    """털어놓기의 입구 가리기. 라우트가 큐에 넣기 전에 요청마다 한 번 부른다. `Masker` 하나로 하소연과 대상 메시지를
    같이 가려, 한 L4 프롬프트 안에서 같은 사람은 같은 자리표시다. 큐(메모리)에는 가린 두 문장만 들어간다."""
    m = Masker(names)
    return m(complaint), m(about)


async def feedback(reg: Registry, complaint: str, about: str, relation: str) -> FeedbackResult | None:
    """털어놓기(L4). complaint·about은 `mask_feedback`으로 이미 가린 하소연과 대상 메시지다.
    모든 전문가가 실패·시간 초과면 None. 돌려주는 것은 패턴 태그뿐이고, 저장할지는 호출자가 거른다."""
    req = ExpertRequest(path="async", draft=about, relation=relation, extra={"text": complaint, "about": about})
    deadline = time.monotonic() + reg.cfg["paths"]["async"]["deadline_ms"] / 1000
    results = await run_all(reg.for_path("async", "feedback"), req, deadline)
    return next((r.output for r in results), None)
