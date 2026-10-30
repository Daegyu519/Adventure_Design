"""/v1/* 사용자별 분당 요청 한도(T-38). 인증(401/503) 다음, 방 멤버·DB 확인 앞에서 막는다.

한도 값은 models.yaml의 `limits:`(kind별 분당 요청 수)다. 요청 본문·토큰은 보지도 남기지도 않는다.
"""
from __future__ import annotations

import math
import time
from collections import deque
from collections.abc import Callable
from functools import lru_cache
from uuid import UUID

from fastapi import Depends, HTTPException

from app.auth import current_user
from app.settings import load_config

WINDOW_S = 60.0
RATE_LIMITED = {429: {"description": "rate_limited: 분당 요청 한도를 넘었다. Retry-After(초) 뒤에 다시 시도한다."}}


class RateLimiter:
    # ponytail: 프로세스마다 따로 센다(파일럿은 프로세스 1개). 여러 개로 늘리면 Redis로 옮긴다.
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._hits: dict[tuple[UUID, str], deque[float]] = {}
        self._swept = clock()

    def hit(self, user: UUID, kind: str, limit: int) -> int | None:
        """요청 하나를 센다. 한도 안이면 None, 넘으면 슬롯이 비기까지 남은 초(≥1). 거절된 요청은 세지 않는다."""
        now = self._clock()
        if now - self._swept >= WINDOW_S:  # 안 오는 사용자의 빈 칸이 쌓이지 않게 1분에 한 번 쓸어 낸다
            self._swept = now
            for key in [k for k, q in self._hits.items() if not self._prune(q, now)]:
                del self._hits[key]
        q = self._hits.setdefault((user, kind), deque())
        if self._prune(q, now) >= limit:
            return max(1, math.ceil(q[0] + WINDOW_S - now))
        q.append(now)
        return None

    @staticmethod
    def _prune(q: deque[float], now: float) -> int:
        while q and q[0] <= now - WINDOW_S:
            q.popleft()
        return len(q)


@lru_cache
def get_limiter() -> RateLimiter:
    return RateLimiter()


def get_limits() -> dict[str, int]:
    limits = load_config().get("limits") or {}
    if not isinstance(limits.get("default"), int) or any(not isinstance(v, int) or v < 1 for v in limits.values()):
        raise ValueError("models.yaml limits: default와 각 값은 1 이상의 정수여야 한다")
    return limits


def limited(kind: str) -> Callable:
    """라우트 의존성 만들기: `dependencies=[Depends(limited("hint"))]`. 인증 뒤, 라우트 본문 앞에서 돈다."""
    async def check(user: UUID = Depends(current_user), limiter: RateLimiter = Depends(get_limiter)) -> None:
        limits = get_limits()
        wait = limiter.hit(user, kind, limits.get(kind, limits["default"]))
        if wait is not None:
            raise HTTPException(status_code=429, detail="rate_limited", headers={"Retry-After": str(wait)})

    check.rate_kind = kind  # type: ignore[attr-defined]  # 라우트 순회 테스트가 찾는 표시
    return check
