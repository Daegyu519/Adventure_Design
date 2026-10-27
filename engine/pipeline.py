"""판정 파이프라인의 입구. 외부 모델로 가는 문장은 여기서 요청마다 한 번 `Masker`(참여자 이름 + 개인정보 패턴)를
거친다. 레이어·전문가는 가린 문장만 받는다. 대응표는 이 함수의 `Masker` 메모리에만 있고 밖으로 내보내지 않는다."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from experts.base import ExpertRequest, ExpertResult
from experts.registry import Registry, run_all
from harness.pii import Masker
from harness.schemas import Conversation, DetailReport, GateResult, Hint, RewriteOption, Verdict
from harness.store import ProfileStore
from layers import gate, rewrite
from layers.aggregate import aggregate, merged, top_reading
from layers.guard import OPTION_LABELS, guard, render_detail, render_hint, render_mismatch

# 자리표시 모양([이름1], [전화번호], [긴 숫자] …). 번호가 없어도 모델이 지어낸 것으로 보고 그 후보를 버린다.
PLACEHOLDER = re.compile(r"\[[가-힣A-Za-z ]+\d*\]")


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


@dataclass(frozen=True)
class DetailOutcome:
    gate: GateResult
    verdict: Verdict | None
    readings: dict[str, float] | None
    report: DetailReport | None
    mismatch: str | None
    results: list[ExpertResult]
    outcome: Literal["ok", "no_result"]


async def detail(reg: Registry, draft: str, convo: Conversation, store: ProfileStore, user_id: str, names: list[str],
                 intent: str | None, t0: float, path: Literal["detail", "mirror"] = "detail") -> DetailOutcome:
    """판정(맥락 + 말투 여럿, 갈리면 심판)에는 의도를 넣지 않는다: 칩만 바꾼 재호출은 판정이 라우터 캐시에 걸리고
    고쳐 쓰기만 새로 돈다. 모든 전문가 호출은 t0 + deadline_ms - 0.3초 안에서만 한다."""
    m = Masker(names)
    draft, convo = m(draft), m.conversation(convo)
    masked_intent = m(intent) if intent else None   # 모델로 가는 의도는 가린다(규칙 16). 어긋남은 칩 원래 값으로 본다
    agg = reg.cfg["aggregate"]
    end = t0 + reg.cfg["paths"][path]["deadline_ms"] / 1000 - 0.3
    g = gate.score(draft, convo, store, user_id, 0.0, agg["global_min_obs"])

    req = ExpertRequest.from_convo(path, draft, convo, g.signals)
    results = await run_all(reg.for_path(path, "context") + reg.for_path(path, "tone"), req, end)
    tone_results = [r for r in results if r.role == "tone"]
    if not tone_results:
        return DetailOutcome(g, None, None, None, None, results, "no_result")
    ctx = next((r.output for r in results if r.role == "context"), None)
    tones = [(r.output, reg.weight(r.expert_id)) for r in tone_results]
    v = aggregate(draft, g, ctx, tones, store, convo, agg)
    readings = merged(tones)

    # 심판은 의견이 갈린 기권만 푼다. 자신 없는 기권(confidence < min_confidence)은 그대로 둔다.
    # 집계가 기권을 정한 반올림 전 값(features)으로 본다.
    split = v.features.get("disagreement", 0.0) > agg["max_disagreement"]
    if v.abstain and split and v.features.get("confidence", 0.0) >= agg["min_confidence"]:
        extra = {"context": ctx.model_dump_json() if ctx else "{}", "risk": v.risk,
                 "tone_a": tones[0][0].model_dump_json(exclude={"model"}),
                 "tone_b": tones[-1][0].model_dump_json(exclude={"model"})}
        judged = await run_all(reg.for_path(path, "judge")[:1], req.model_copy(update={"extra": extra}), end)
        if judged:   # 실패하면 기권 그대로
            alert = judged[0].output.alert
            v = v.model_copy(update={"abstain": False, "alert": alert, "top_reading": top_reading(readings, alert)})
            results = results + judged

    mismatch = render_mismatch(intent, readings)
    options: list[RewriteOption] = []
    if v.alert or mismatch:
        rw_req = req.model_copy(update={"intent": masked_intent})
        written = await run_all(reg.for_path(path, "rewrite")[:1], rw_req, end)
        if written:
            results = results + written
            # 후보는 원문을 읽은 첫 말투 전문가로 다시 읽는다(경로의 첫 tone이 답하지 못했으면 다음으로 답한 것)
            first = tone_results[0]
            checker = next(e for e in reg.for_path(path, "tone") if e.id == first.expert_id)
            passed = await rewrite.check(checker, req, written[0].output.options[:2], first.output.negative, end)
            options = [o for i, c in passed if (o := _restored(m, i, c))]
    return DetailOutcome(g, v, readings, render_detail(v, readings, options), mismatch, results, "ok")


def _restored(m: Masker, i: int, c: RewriteOption) -> RewriteOption | None:
    """응답 직전에 자리표시를 되돌린다. 되돌리지 못한 자리표시 모양(모델이 지어냄, 번호 없는 것 포함)이 남거나
    keep·change가 문구 검사에 걸리면 그 후보를 버린다."""
    try:
        o = RewriteOption(label=OPTION_LABELS[i], text=m.restore(c.text),
                          keep=[guard(m.restore(s)) for s in c.keep], change=[guard(m.restore(s)) for s in c.change])
    except ValueError:
        return None
    return None if any(PLACEHOLDER.search(s) for s in (o.text, *o.keep, *o.change)) else o


async def panel(reg: Registry, draft: str, relation: str, names: list[str], t0: float) -> dict[str, float] | None:
    """거울 경로의 말투 전문가만, 대화 없이 읽은 읽힘(키 5개). 아무도 답하지 못하면 None."""
    req = ExpertRequest(path="mirror", draft=Masker(names)(draft), relation=relation)
    end = t0 + reg.cfg["paths"]["mirror"]["deadline_ms"] / 1000 - 0.3
    results = await run_all(reg.for_path("mirror", "tone"), req, end)
    return merged([(r.output, reg.weight(r.expert_id)) for r in results]) if results else None
