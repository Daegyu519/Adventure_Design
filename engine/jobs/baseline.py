"""T-26 기준선 갱신 작업. 웹훅이 `update(repo, message_id)`를 큐에 넣는다.

- 큐 인자는 message_id뿐이다. 본문은 여기서 DB에서 다시 읽고, `surface()` 특징 숫자(길이·존댓말·완화 표현)만 저장한다.
  본문은 어디에도 남기지 않고 로그도 찍지 않는다.
- 사진만 있는 메시지(본문이 비었거나 공백뿐)와 그 사이 지워진 메시지는 건너뛴다.
- DB 오류는 올려서 큐가 재시도하게 한다. `update_baseline`은 한 문장 upsert라 실패하면 아무것도 안 더해져서 재시도가 안전하다.
"""
from __future__ import annotations

from app.db import Repo
from harness.korean import surface


async def update(repo: Repo, message_id: int) -> None:
    msg = await repo.message(message_id)
    if msg is None or not msg.text.strip():
        return
    s = surface(msg.text)
    await repo.update_baseline(msg.sender_id, s["length"], s["polite"], s["softener"])
