"""엔진 안 메모리 작업 큐(ARCHITECTURE 10장). 나중에 Redis로 바꿀 수 있게 JobQueue의 메서드만 밖에 보인다.

이 큐는 하소연(피드백) 작업을 나른다(T-24). 그래서 작업 인자와 예외 메시지는 어디에도 남기지 않는다:
로그에는 작업 이름(종류)과 예외 타입 이름만 쓴다. 이름에는 종류만 넣는다(사용자 입력 금지).
`enqueue`는 이벤트 루프 안에서 부른다(asyncio.Queue는 스레드 안전하지 않다).
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)

# ponytail: 메모리 큐라 재시작하면 대기 작업이 사라짐(ARCHITECTURE 10장). Redis로 바꿀 때 feedback 작업 인자(하소연 원문)는 Redis에 넣지 않는다.


@dataclass
class _Job:
    name: str
    # repr=False: 누가 job을 문자열로 찍어도 인자(하소연 원문)가 새지 않는다.
    fn: Callable[..., Awaitable[None]] = field(repr=False)
    args: tuple[Any, ...] = field(repr=False)
    attempt: int = 1


class JobQueue:
    def __init__(self, workers: int = 2, max_attempts: int = 3, backoff_s: float = 1.0, maxsize: int = 1000) -> None:
        if workers < 1:  # 워커가 없으면 받은 작업이 영원히 안 돈다
            raise ValueError("workers must be >= 1")
        self._q: asyncio.Queue[_Job] = asyncio.Queue(maxsize)
        self._n_workers = workers
        self._max_attempts = max_attempts
        self._backoff_s = backoff_s
        self._workers: list[asyncio.Task[None]] = []
        self._timers: set[asyncio.TimerHandle] = set()  # 백오프 중인 재시도
        self._open = 0  # 받았고 아직 끝나지(성공·버림) 않은 작업 수
        self._closed = False

    def start(self) -> None:
        """워커를 띄운다. 실행 중인 이벤트 루프 안에서 부른다."""
        if not self._workers:
            self._workers = [asyncio.create_task(self._work()) for _ in range(self._n_workers)]

    def enqueue(self, name: str, fn: Callable[..., Awaitable[None]], *args: Any) -> bool:
        """큐가 가득 찼거나 종료 중이면 False(받지 않았다)."""
        if self._closed:
            return False
        try:
            self._q.put_nowait(_Job(name, fn, args))
        except asyncio.QueueFull:
            return False
        self._open += 1
        return True

    async def join(self) -> None:
        """받은 작업이 모두 성공하거나 버려질 때까지(백오프 대기 중인 재시도 포함) 기다린다."""
        await self._q.join()

    async def stop(self, drain_s: float = 5.0) -> None:
        """새 작업을 막고 `drain_s`초까지 남은 작업(재시도 포함)을 비운다. 그래도 남으면 버리고 개수만 로그에 남긴다."""
        self._closed = True
        try:
            if self._workers:
                try:
                    await asyncio.wait_for(self._q.join(), drain_s)
                except TimeoutError:
                    pass
            if self._open:
                log.warning("queue stopped with %d unfinished jobs", self._open)
        finally:  # drain을 기다리다 취소돼도 정리는 한다
            for h in self._timers:
                h.cancel()
            self._timers.clear()
            for t in self._workers:
                t.cancel()
            await asyncio.gather(*self._workers, return_exceptions=True)
            self._workers = []

    async def _work(self) -> None:
        while True:
            # job을 지역 변수로 두지 않는다: 끝난 작업의 인자(하소연 원문)를 다음 get을 기다리는 동안 붙들지 않게.
            await self._run(await self._q.get())

    async def _run(self, job: _Job) -> None:
        try:
            await job.fn(*job.args)
        except Exception as e:  # 예외 객체·메시지·traceback은 로그에 넣지 않는다
            if job.attempt < self._max_attempts:
                self._retry_later(job, self._backoff_s * 2 ** (job.attempt - 1))
                job.attempt += 1
                return  # task_done은 다시 넣을 때 한다: 백오프 동안에도 join이 끝나지 않는다
            log.warning("job %s dropped after %d attempts: %s", job.name, job.attempt, type(e).__name__)
        self._open -= 1
        self._q.task_done()

    def _retry_later(self, job: _Job, delay: float) -> None:
        def fire() -> None:
            self._timers.discard(handle)
            try:
                self._q.put_nowait(job)
            except asyncio.QueueFull:  # 받아 둔 작업이니 버리지 않고 한 번 더 기다린다
                self._retry_later(job, self._backoff_s)
                return
            self._q.task_done()  # 처음 get한 몫

        handle = asyncio.get_running_loop().call_later(delay, fire)
        self._timers.add(handle)
