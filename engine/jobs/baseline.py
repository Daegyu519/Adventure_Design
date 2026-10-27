"""T-26 기준선 갱신 작업. 웹훅이 `update(repo, message_id)`를 큐에 넣는다.

- 큐 인자는 message_id뿐이다. 본문은 여기서 DB에서 다시 읽고, `surface()` 특징 숫자(길이·존댓말·완화 표현)만 저장한다.
  본문은 어디에도 남기지 않고 로그도 찍지 않는다.
- 사진만 있는 메시지(본문이 비었거나 공백뿐)와 그 사이 지워진 메시지는 건너뛴다.
- 작업이 스스로 제한 시간을 둔다: DB 풀 acquire이 멈춰도 공유 워커(2개) 하나를 `BASELINE_DEADLINE_S`보다 오래 붙들지 않는다.
- DB 오류와 시간 초과는 올려서 큐가 재시도하게 한다. `update_baseline`은 한 문장 upsert라 실패하면 보통 아무것도 안 더해진다.
  다만 커밋 뒤에 시간이 초과되면 재시도가 표본 하나를 한 번 더 더할 수 있다(재시작 때 멱등 키가 사라지는 경우와 같은 한도, 평균이라 영향 작음).
"""
from __future__ import annotations

import asyncio

from app.db import Repo
from harness.korean import surface

BASELINE_DEADLINE_S = 10.0   # 읽기 + 쓰기 전체


async def update(repo: Repo, message_id: int) -> None:
    async with asyncio.timeout(BASELINE_DEADLINE_S):
        msg = await repo.message(message_id)
        if msg is None or not msg.text.strip():
            return
        s = surface(msg.text)
        # ponytail: n에 상한이 없어 평생 평균이다. 말투가 바뀌어도 천천히 따라온다 -> 너무 느리면 EWMA나 최근 N개 창으로 바꾼다.
        await repo.update_baseline(msg.sender_id, s["length"], s["polite"], s["softener"])
