"""`tone.analysis_traces` 한 행 만들기와 쓰기(ARCHITECTURE 5장, 나중에 가중치 학습 T-20이 읽는다).

trace에는 겉 신호(L0 태그·점수)와 전문가가 낸 수치·분류만 남긴다. 초안, 최근 대화, 답장 대상, 의도, 이름, 자리표시 대응표,
전문가가 쓴 문장(cues, expectation_points, shared_context, reason, 후보 문장)은 어디에도 넣지 않는다(규칙 5·16).
전문가 출력은 `expert_summary`의 허용 목록으로만 옮긴다: 모르는 칸이 생겨도 새지 않는다.
쓰기는 작업 큐로 한다. 사용자 응답은 trace 때문에 막히거나 실패하지 않는다."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Literal
from uuid import UUID

import pipeline
from app.db import Repo, TraceRow
from experts.base import ExpertResult
from jobs.queue import JobQueue
from layers.aggregate import unit

log = logging.getLogger(__name__)
TRACE_DEADLINE_S = 5.0


def expert_summary(r: ExpertResult) -> dict:
    s = {"expert_id": r.expert_id, "role": r.role, "model": r.model, "latency_ms": r.latency_ms}
    o = r.output
    # confidence는 집계가 본 값(0~1로 자름, NaN은 0)으로 적는다. 모델이 준 NaN은 jsonb를 깨뜨린다.
    if r.role == "context":
        s |= {"prev_act": o.prev_act, "partner_state": o.partner_state, "n_expect": len(o.expectation_points),
              "confidence": unit(o.confidence)}
    elif r.role == "tone":
        s |= {"readings": dict(o.readings), "has_reason": o.has_reason, "confidence": unit(o.confidence)}
    elif r.role == "judge":
        s["alert"] = o.alert
    elif r.role == "rewrite":
        s["n_options"] = len(o.options)
    return s   # feedback 등 그 밖의 역할은 공통 칸만


def build_trace(trace_id: UUID, path: Literal["realtime", "detail"], user_id: UUID, room_id: UUID, status: str,
                latency_ms: int, outcome: pipeline.RealtimeOutcome | pipeline.DetailOutcome | None = None) -> TraceRow:
    """status: 힌트는 gated|abstain|alert|none|timeout|error, 상세는 ok|no_result|timeout|error.
    outcome이 없으면(시간 초과·오류) gate·features·results는 비어 있다. 일찍 기권한 판정은 features가 {}다."""
    g, v = (outcome.gate, outcome.verdict) if outcome else (None, None)
    experts = {"status": status,
               "gate": {"prior": g.prior, "signals": list(g.signals)} if g else None,   # verdict.signals가 아니라 L0 고정 태그
               "features": dict(v.features) if v else {},
               "results": [expert_summary(r) for r in outcome.results] if outcome else []}
    if outcome and outcome.clf is not None:
        experts["clf"] = round(outcome.clf, 3)   # 판별기 cold_score, 숫자만(P-28)
    if isinstance(outcome, pipeline.RealtimeOutcome) and v is not None and v.alert:
        experts["level"] = outcome.level   # 알림 단계 card·soft·none(P-46, 고정 어휘)
    # DB check는 hint|detail|mirror다: 엔진 안의 realtime 경로 이름은 hint로 적는다.
    return TraceRow(trace_id, "hint" if path == "realtime" else path, user_id, room_id, experts,
                    v.risk if v else None, bool(v and v.alert), latency_ms)


async def record(repo: Repo, row: TraceRow) -> None:
    """작업이 스스로 제한 시간을 둔다: DB가 멈춰도 공유 워커를 오래 붙들지 않는다. 시간 초과는 올려서 큐가 재시도한다."""
    async with asyncio.timeout(TRACE_DEADLINE_S):
        await repo.insert_trace(row)


def submit(queue: JobQueue, repo: Repo, trace_id: UUID, path: Literal["realtime", "detail"], user_id: UUID,
           room_id: UUID, status: str, t0: float, outcome: pipeline.RealtimeOutcome | pipeline.DetailOutcome | None = None
           ) -> None:
    """응답을 돌려주기 직전에 부른다(t0는 요청이 들어온 time.monotonic()). 어떤 오류도 올리지 않는다.
    큐 인자는 완성된 행(id·수치·분류뿐)이다. 로그에는 종류만 남긴다."""
    try:
        row = build_trace(trace_id, path, user_id, room_id, status, round((time.monotonic() - t0) * 1000), outcome)
        if not queue.enqueue("trace", record, repo, row, max_attempts=1):   # 재시도하면 느린 DB에서 푸시·기준선 작업을 밀어낸다
            log.warning("trace enqueue rejected")
    except Exception as e:  # noqa: BLE001 - 행을 못 만들어도 응답은 나간다. 예외 메시지에 문장이 섞일 수 있어 종류만 남긴다
        log.warning("trace failed: %s", type(e).__name__)
