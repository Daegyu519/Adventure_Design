"""POST /v1/feedback: 토큰 → 방 확인 → 받은 메시지인지 확인 → L4 분류(요청 안) → 큐 → 202 안내(ARCHITECTURE 3-4).
하소연 원문은 이 요청의 메모리에서만 쓴다. 큐에는 id와 분류 결과만 넣는다(원문·대응표 금지). 로그에는 예외 종류만."""
from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from app.auth import current_user, ensure_member
from app.contracts import FeedbackIn, FeedbackOut
from app.db import Repo
from app.deps import get_queue, get_registry, get_repo
from experts.registry import Registry
from jobs import feedback as job
from jobs.queue import JobQueue
from layers.guard import ACK

log = logging.getLogger(__name__)
router = APIRouter()


@router.post("/v1/feedback", status_code=202)
async def feedback(body: FeedbackIn, user: UUID = Depends(current_user), repo: Repo = Depends(get_repo),
                   reg: Registry = Depends(get_registry), queue: JobQueue = Depends(get_queue)) -> FeedbackOut:
    await ensure_member(repo, body.room_id, user)   # 방을 읽기 전에(Repo는 접근 검사를 하지 않는다)
    msg = await repo.message(body.message_id)
    if msg is None or msg.room_id != body.room_id or msg.sender_id == user:   # 이 방에서 받은 메시지만
        raise HTTPException(status_code=403, detail="not_received")
    try:
        patterns = await job.classify(repo, reg, msg, body.text)
    except Exception as e:  # noqa: BLE001 - 분류 실패도 털어놓기는 받는다(패턴 없음). 예외 메시지엔 문장이 섞일 수 있다
        log.warning("feedback classify failed: %s", type(e).__name__)
        patterns = []
    if not queue.enqueue("feedback", job.run, repo, body.room_id, user, body.message_id, patterns):
        raise HTTPException(status_code=503, detail="queue_full")
    return FeedbackOut(ack=ACK)
