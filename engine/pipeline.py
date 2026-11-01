"""판정 파이프라인의 입구. 외부 모델로 가는 문장은 여기서 요청마다 한 번 `Masker`(참여자 이름 + 개인정보 패턴)를
거친다. 레이어·전문가는 가린 문장만 받는다. 대응표는 이 함수의 `Masker` 메모리에만 있고 밖으로 내보내지 않는다."""
from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass
from typing import Literal

from experts.base import ExpertRequest, ExpertResult
from experts.classifier import run_classifiers
from experts.registry import Registry, run_all
from harness.pii import TOKEN, Masker
from harness.schemas import Conversation, DetailReport, FeedbackResult, GateResult, Hint, RewriteOption, Turn, Verdict
from harness.store import ProfileStore
from layers import gate, rewrite
from layers.aggregate import aggregate, merged, top_reading
from layers.guard import OPTION_LABELS, guard, render_detail, render_hint, render_mismatch

# 자리표시 모양([이름1], [전화번호], [긴 숫자] …). 번호가 없어도 모델이 지어낸 것으로 보고 그 후보를 버린다.
# TOKEN도 같이 본다: [이름_7]·[Name:2]처럼 번호 앞에 기호가 붙은 것은 restore가 되돌리지 못한다.
PLACEHOLDER = re.compile(r"\[[가-힣A-Za-z ]+\d*\]")


@dataclass(frozen=True)
class RealtimeOutcome:
    gate: GateResult
    verdict: Verdict | None
    hint: Hint | None
    results: list[ExpertResult]
    outcome: Literal["gated", "abstain", "alert", "none"]
    clf: float | None = None   # 판별기 cold_score(숫자만). 못 왔으면 None


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
    end = t0 + path["expert_deadline_ms"] / 1000
    results, clf = await asyncio.gather(run_all(experts, req, end), run_classifiers(reg.classifiers_for("realtime"), req, end))

    ctx = next((r.output for r in results if r.role == "context"), None)
    tones = [(r.output, reg.weight(r.expert_id)) for r in results if r.role == "tone"]
    v = aggregate(draft, g, ctx, tones, store, convo, agg, clf)
    hint = render_hint(v)
    return RealtimeOutcome(g, v, hint, results, "abstain" if v.abstain else "alert" if v.alert else "none", clf)


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


@dataclass(frozen=True)
class DetailOutcome:
    gate: GateResult
    verdict: Verdict | None
    readings: dict[str, float] | None
    report: DetailReport | None
    mismatch: str | None
    results: list[ExpertResult]
    outcome: Literal["ok", "no_result"]
    clf: float | None = None


async def detail(reg: Registry, draft: str, convo: Conversation, store: ProfileStore, user_id: str, names: list[str],
                 intent: str | None, t0: float, path: Literal["detail", "mirror"] = "detail") -> DetailOutcome:
    """판정(맥락 + 말투 여럿, 갈리면 심판)에는 의도를 넣지 않는다: 칩만 바꾼 재호출은 판정이 라우터 캐시에 걸리고
    고쳐 쓰기만 새로 돈다. 모든 전문가 호출은 t0 + deadline_ms - 0.3초 안에서만 한다."""
    m, raw = Masker(names), draft
    draft, convo = m(draft), m.conversation(convo)
    masked_intent = m(intent) if intent else None   # 모델로 가는 의도는 가린다(규칙 16). 어긋남은 칩 원래 값으로 본다
    agg = reg.cfg["aggregate"]
    end = t0 + reg.cfg["paths"][path]["deadline_ms"] / 1000 - 0.3
    g = gate.score(draft, convo, store, user_id, 0.0, agg["global_min_obs"])

    req = ExpertRequest.from_convo(path, draft, convo, g.signals)
    results, clf = await asyncio.gather(run_all(reg.for_path(path, "context") + reg.for_path(path, "tone"), req, end),
                                        run_classifiers(reg.classifiers_for(path), req, end))
    tone_results = [r for r in results if r.role == "tone"]
    if not tone_results:
        return DetailOutcome(g, None, None, None, None, results, "no_result", clf)
    ctx = next((r.output for r in results if r.role == "context"), None)
    tones = [(r.output, reg.weight(r.expert_id)) for r in tone_results]
    v = aggregate(draft, g, ctx, tones, store, convo, agg, clf)
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
            options = [o for i, c in passed if (o := _restored(m, i, c, raw))]
    return DetailOutcome(g, v, readings, render_detail(v, readings, options), mismatch, results, "ok", clf)


def _restored(m: Masker, i: int, c: RewriteOption, raw: str) -> RewriteOption | None:
    """응답 직전에 자리표시를 되돌린다. 되돌리지 못한 자리표시 모양(모델이 지어냄, 번호 없는 것 포함)이 남거나
    keep·change가 문구 검사에 걸리면 그 후보를 버린다. 사용자가 원문에 직접 쓴 대괄호 말([사진] 등)은 자리표시로 보지 않는다."""
    try:
        o = RewriteOption(label=OPTION_LABELS[i], text=m.restore(c.text),
                          keep=[guard(m.restore(s)) for s in c.keep], change=[guard(m.restore(s)) for s in c.change])
    except ValueError:
        return None
    strays = {x.group(0) for s in (o.text, *o.keep, *o.change) for pat in (TOKEN, PLACEHOLDER) for x in pat.finditer(s)}
    return None if any(t not in raw for t in strays) else o


async def panel(reg: Registry, draft: str, relation: str, names: list[str], t0: float,
                context: Turn | None = None) -> dict[str, float] | None:
    """거울 경로의 말투 전문가만, 읽힘(키 5개). context가 있으면 문장 앞의 한 턴으로 같은 Masker를 거쳐 넣는다.
    아무도 답하지 못하면 None."""
    m = Masker(names)
    req = ExpertRequest(path="mirror", draft=m(draft), turns=m.turns([context]) if context else [], relation=relation)
    end = t0 + reg.cfg["paths"]["mirror"]["deadline_ms"] / 1000 - 0.3
    results = await run_all(reg.for_path("mirror", "tone"), req, end)
    return merged([(r.output, reg.weight(r.expert_id)) for r in results]) if results else None
