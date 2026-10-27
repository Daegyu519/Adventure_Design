"""POST /v1/feedback: 토큰 → 방 확인 → 받은 메시지인지 확인 → 하소연 가리기 → 큐 → 202 안내(ARCHITECTURE 3-4).
L4는 큐 작업(jobs/feedback.py)이 돈다. 큐 인자는 id와 가린 하소연뿐이고, 메모리 큐에만 있다(_Job은 인자를 repr에
싣지 않고, 실패 로그도 예외 종류만). 하소연은 로그·trace·DB 어디에도 남기지 않는다."""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

import pipeline
from app.auth import current_user, ensure_member
from app.contracts import FeedbackIn, FeedbackOut
from app.db import Repo
from app.deps import get_queue, get_registry, get_repo
from experts.registry import Registry
from jobs import feedback as job
from jobs.queue import JobQueue
from layers.guard import ACK

router = APIRouter()


@router.post("/v1/feedback", status_code=202)
async def feedback(body: FeedbackIn, user: UUID = Depends(current_user), repo: Repo = Depends(get_repo),
                   reg: Registry = Depends(get_registry), queue: JobQueue = Depends(get_queue)) -> FeedbackOut:
    await ensure_member(repo, body.room_id, user)   # 방을 읽기 전에(Repo는 접근 검사를 하지 않는다)
    msg = await repo.message(body.message_id)
    if msg is None or msg.room_id != body.room_id or msg.sender_id == user:   # 이 방에서 받은 메시지만
        raise HTTPException(status_code=403, detail="not_received")
    masked = pipeline.mask_complaint(body.text, list((await repo.member_names(body.room_id)).values()))
    # ponytail: 메모리 큐라 가린 하소연을 인자로 넘긴다. 큐가 Redis 같은 저장형으로 바뀌면 여기서(요청 안에서) 분류하고
    #   id와 분류 결과만 넣는다.
    if not queue.enqueue("feedback", job.run, repo, reg, body.room_id, user, body.message_id, masked):
        raise HTTPException(status_code=503, detail="queue_full")
    return FeedbackOut(ack=ACK)
