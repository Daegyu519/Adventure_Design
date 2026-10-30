"""POST /v1/feedback: 토큰 → 방 확인 → 받은 메시지인지 확인 → 하소연 가리기 → 큐 → 202 안내(ARCHITECTURE 3-4).
L4는 큐 작업(jobs/feedback.py)이 돈다. 큐 인자는 id와 (Masker 하나로) 가린 하소연·대상 메시지뿐이고, 메모리 큐에만 있다(_Job은 인자를 repr에
싣지 않고, 실패 로그도 예외 종류만). 하소연은 로그·trace·DB 어디에도 남기지 않는다."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

import pipeline
from app.auth import current_user, ensure_member
from app.contracts import FeedbackIn, FeedbackOut
from app.db import Repo
from app.ratelimit import RATE_LIMITED, limited
from app.deps import get_feedback_queue, get_registry, get_repo
from experts.registry import Registry
from jobs import feedback as job
from jobs.queue import JobQueue
from layers.guard import ACK

log = logging.getLogger(__name__)
router = APIRouter()


@router.post("/v1/feedback", status_code=202, dependencies=[Depends(limited("default"))], responses=RATE_LIMITED)
async def feedback(body: FeedbackIn, user: UUID = Depends(current_user), repo: Repo = Depends(get_repo),
                   reg: Registry = Depends(get_registry), queue: JobQueue = Depends(get_feedback_queue)) -> FeedbackOut:
    await ensure_member(repo, body.room_id, user)   # 방을 읽기 전에(Repo는 접근 검사를 하지 않는다)
    msg = await repo.message(body.message_id)
    if msg is None or msg.room_id != body.room_id or msg.sender_id == user:   # 이 방에서 받은 메시지만
        raise HTTPException(status_code=403, detail="not_received")
    done, room, names = await asyncio.gather(repo.has_feedback(user, msg.id), repo.room(body.room_id),
                                             repo.member_names(body.room_id))
    # 이미 남긴 신고이거나 이번 주 상한에 걸린 (보낸 사람, 관계)면 큐(공유 워커·L4)를 쓰지 않는다. 어느 쪽인지 알리지 않는다
    if done or room is None or await job.at_weekly_cap(repo, msg.sender_id, room.relation, datetime.now(timezone.utc)):
        return FeedbackOut(ack=ACK)
    complaint, about = pipeline.mask_feedback(body.text, msg.text, list(names.values()))   # Masker 하나로 둘 다
    # ponytail: 메모리 큐라 가린 하소연을 인자로 넘긴다. 큐가 Redis 같은 저장형으로 바뀌면 여기서(요청 안에서) 분류하고
    #   id와 분류 결과만 넣는다.
    # 큐가 받지 않거나 터져도 같은 202: 응답으로 어느 경로인지 알 수 없게. 로그는 고정 문구·예외 종류만(하소연·id 없음)
    try:
        if not queue.enqueue("feedback", job.run, repo, reg, body.room_id, user, msg.id, complaint, about,
                             key=f"feedback:{user}:{msg.id}", max_attempts=1):   # 재시도 없음: 느린 모델에 폭주하지 않게
            log.warning("feedback enqueue rejected")
    except Exception as e:
        log.warning("feedback enqueue failed: %s", type(e).__name__)
    return FeedbackOut(ack=ACK)
