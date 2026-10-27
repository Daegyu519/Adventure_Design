"""POST /v1/hint: 토큰 → 방 확인 → 최근 대화 → 실시간 경로 → 문구 검사(ARCHITECTURE 3-2).
`paths.realtime.deadline_ms`를 넘기거나 엔진 쪽 오류가 나면 hint=null이다. 인증(401·503)·방(403)·형식(422) 오류만 그대로 올린다."""
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
from app.contracts import HintBody, HintIn, HintOut
from app.db import Repo
from app.deps import get_registry, get_repo
from experts.registry import Registry

log = logging.getLogger(__name__)
router = APIRouter()


@router.post("/v1/hint")
async def hint(body: HintIn, user: UUID = Depends(current_user), repo: Repo = Depends(get_repo),
               reg: Registry = Depends(get_registry)) -> HintOut:
    t0 = time.monotonic()
    trace_id = uuid4()

    async def run() -> HintBody | None:
        await ensure_member(repo, body.room_id, user)   # 방을 읽기 전에(Repo는 접근 검사를 하지 않는다)
        ctx = await load_context(repo, body.room_id, user, body.reply_to, datetime.now(timezone.utc))
        out = await pipeline.realtime(reg, body.text, ctx.convo, ctx.store, str(user), ctx.names, t0)
        return HintBody(title=out.hint.title, detail=out.hint.detail) if out.hint else None

    budget = reg.cfg["paths"]["realtime"]["deadline_ms"] / 1000 - (time.monotonic() - t0)
    try:
        shown = await asyncio.wait_for(run(), budget)
    except TimeoutError:
        shown = None
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 - 엔진 장애는 힌트 없음으로. 메시지에 문장이 섞일 수 있어 종류만 남긴다
        log.warning("hint failed: %s", type(e).__name__)
        shown = None
    return HintOut(seq=body.seq, hint=shown, trace_id=trace_id)
