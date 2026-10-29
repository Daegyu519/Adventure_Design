"""`public.tone_events` 기록 작업. 큐 인자는 id·읽힘 키·신호 태그뿐이다(문장 없음).
작업이 스스로 제한 시간을 둔다: DB 풀 acquire이 멈춰도 공유 워커를 `EVENT_DEADLINE_S`보다 오래 붙들지 않는다.
시간 초과는 올려서 큐가 재시도하게 한다."""
from __future__ import annotations

import asyncio
from typing import Any

from app.db import Repo

EVENT_DEADLINE_S = 5.0


async def record(repo: Repo, *args: Any) -> None:
    async with asyncio.timeout(EVENT_DEADLINE_S):
        await repo.insert_event(*args)
