import hmac
import logging
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from app.db import Repo
from app.deps import get_queue, get_repo, get_settings
from app.settings import Settings
from jobs.push import send_push
from jobs.queue import JobQueue

log = logging.getLogger(__name__)
router = APIRouter()


BIGINT = dict(gt=0, lt=2**63)  # messages.id/reply_to는 양수 bigint


class MessageRecord(BaseModel):
    id: int = Field(**BIGINT)
    room_id: UUID
    sender_id: UUID
    text: str = ""
    image_path: str | None = None
    reply_to: int | None = Field(None, **BIGINT)
    created_at: datetime


class HookPayload(BaseModel):
    type: str
    table: str
    schema_name: str = Field(alias="schema")
    record: dict | None = None
    old_record: dict | None = None


def _secret_ok(got: str, want: str) -> bool:
    # bytes로 비교한다: str 비교는 비ASCII 헤더에서 TypeError(500)가 난다. 설정값이 비면 항상 거절.
    return bool(want) and hmac.compare_digest(got.encode(), want.encode())


@router.post("/hooks/message", status_code=202, include_in_schema=False)
async def hook_message(request: Request, settings: Settings = Depends(get_settings), repo: Repo = Depends(get_repo),
                       queue: JobQueue = Depends(get_queue)) -> dict:
    # 비밀값을 본문보다 먼저 본다: 인증 전에는 본문을 읽지도 않는다.
    if not _secret_ok(request.headers.get("x-hook-secret", ""), settings.hook_secret):
        # 헤더 값은 남기지 않는다. 설정이 빈 경우와 값이 틀린 경우만 구분한다.
        log.warning("hook rejected: %s", "bad secret" if settings.hook_secret else "secret not configured")
        raise HTTPException(status_code=401, detail="unauthorized")
    # 검증 오류(ValidationError)는 입력값(메시지 본문)을 담으므로 응답·로그에 싣지 않고 고정 문구만 낸다.
    try:
        payload = HookPayload.model_validate_json(await request.body())
        if (payload.type, payload.table, payload.schema_name) != ("INSERT", "messages", "public"):
            return {}
        rec = MessageRecord.model_validate(payload.record)
    except ValidationError:
        raise HTTPException(status_code=422, detail="invalid_payload") from None
    log.info("hook message id=%s room=%s", rec.id, rec.room_id)  # text는 남기지 않는다
    # 작업 넣기(T-28b 푸시; T-26 기준선도 같은 규칙). 뒤 작업은 아래를 지킨다.
    # - 큐 인자는 `{message_id}`만(멱등 키 f"{kind}:{message_id}"). 본문은 워커가 DB에서 다시 읽고, 큐 인자에는 text를 넣지 않는다.
    # - enqueue가 실패해도 항상 202를 돌려준다(Supabase pg_net은 재시도하지 않는다).
    if not queue.enqueue("push", send_push, repo, settings, rec.id, key=f"push:{rec.id}"):
        log.warning("push enqueue rejected id=%s", rec.id)
    return {}
