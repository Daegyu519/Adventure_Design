import hmac
import logging
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from app.deps import get_settings
from app.settings import Settings

log = logging.getLogger(__name__)
router = APIRouter()


class MessageRecord(BaseModel):
    id: int
    room_id: UUID
    sender_id: UUID
    text: str = ""
    image_path: str | None = None
    reply_to: int | None = None
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
async def hook_message(request: Request, settings: Settings = Depends(get_settings)) -> dict:
    # 비밀값을 본문보다 먼저 본다: 인증 전에는 본문을 읽지도 않는다.
    if not _secret_ok(request.headers.get("x-hook-secret", ""), settings.hook_secret):
        log.warning("hook rejected: bad secret")
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
    # 작업 넣기: T-26 기준선, T-28b 푸시
    return {}
