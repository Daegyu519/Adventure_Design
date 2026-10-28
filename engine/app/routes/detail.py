"""POST /v1/detail(살펴보기, ARCHITECTURE 3-3): 토큰 → 방 확인 → 맥락 → 상세 경로 → 문구 검사.
`paths.detail.deadline_ms`를 넘기거나 말투 결과가 없거나 엔진 쪽 오류가 나면 503이다. 인증·방(403)·형식(422) 오류는 그대로 올린다.
`detail_opened`는 시트를 처음 열 때(intent 없음)만 기록한다. 칩을 바꾼 재호출은 기록하지 않는다."""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException

import pipeline
from app.auth import current_user, ensure_member
from app.context import load_context
from app.contracts import DetailIn, DetailOut, OptionOut, Readings
from app.db import Repo
from app.deps import get_queue, get_registry, get_repo
from experts.registry import Registry
from jobs import events
from jobs.queue import JobQueue

log = logging.getLogger(__name__)
router = APIRouter()
UNAVAILABLE = "engine_unavailable"


@router.post("/v1/detail")
async def detail(body: DetailIn, user: UUID = Depends(current_user), repo: Repo = Depends(get_repo),
                 reg: Registry = Depends(get_registry), queue: JobQueue = Depends(get_queue)) -> DetailOut:
    t0 = time.monotonic()
    trace_id = uuid4()

    async def run() -> pipeline.DetailOutcome:
        await ensure_member(repo, body.room_id, user)   # 방을 읽기 전에(Repo는 접근 검사를 하지 않는다)
        ctx = await load_context(repo, body.room_id, user, body.reply_to, datetime.now(timezone.utc))
        return await pipeline.detail(reg, body.text, ctx.convo, ctx.store, str(user), ctx.names, body.intent, t0)

    try:
        out = await asyncio.wait_for(run(), reg.cfg["paths"]["detail"]["deadline_ms"] / 1000)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 - 시간 초과·엔진 오류는 503. 메시지에 문장이 섞일 수 있어 종류만 남긴다
        log.warning("detail failed: %s", type(e).__name__)
        raise HTTPException(status_code=503, detail=UNAVAILABLE) from None
    if out.outcome == "no_result" or out.report is None:
        raise HTTPException(status_code=503, detail=UNAVAILABLE)

    r, v = out.report, out.report.verdict
    # 큐 인자: id·읽힘 키·L0 신호 태그만(문장 없음). risk는 남기지 않는다.
    signals = {"signals": out.gate.signals, "trace_id": str(trace_id)}
    if body.intent is None and not queue.enqueue("event", events.record, repo, user, body.room_id, "detail_opened",
                                                 v.top_reading, signals):
        log.warning("detail_opened enqueue rejected")
    return DetailOut(alert=v.alert, top_reading=v.top_reading, readings=Readings(**r.readings), why=r.why,
                     options=[OptionOut(**o.model_dump()) for o in r.options], mismatch=out.mismatch,
                     footnote=r.footnote, trace_id=trace_id)
