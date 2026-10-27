"""T-23 작업 큐. 이 큐는 T-24에서 하소연(피드백) 작업을 나른다: 인자와 예외 메시지는 로그에 나오면 안 된다(CLAUDE.md 5)."""
import asyncio
import logging
import time

import pytest
from fastapi.testclient import TestClient

from app.main import app
from jobs.queue import JobQueue
from tests.fakes import FakeQueue

SECRET = "비밀하소연"


def test_enqueued_job_runs():
    got = []

    async def job(x):
        got.append(x)

    async def main():
        q = JobQueue(workers=1)
        q.start()
        assert q.enqueue("t", job, 1) is True
        await q.join()
        await q.stop()

    asyncio.run(main())
    assert got == [1]


def test_retry_then_success():
    calls = []

    async def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise RuntimeError("fail")

    async def main():
        q = JobQueue(workers=1, max_attempts=3, backoff_s=0.01)
        q.start()
        q.enqueue("t", flaky)
        await q.join()
        await q.stop()

    asyncio.run(main())
    assert len(calls) == 3


def test_retry_waits_backoff_doubling():
    stamps = []

    async def always_fails():
        stamps.append(time.monotonic())
        raise RuntimeError("fail")

    async def main():
        q = JobQueue(workers=1, max_attempts=3, backoff_s=0.05)
        q.start()
        q.enqueue("t", always_fails)
        await q.join()
        await q.stop()

    asyncio.run(main())
    assert len(stamps) == 3
    assert stamps[1] - stamps[0] >= 0.045   # backoff_s * 2**0
    assert stamps[2] - stamps[1] >= 0.09    # backoff_s * 2**1


def test_drop_logs_no_args(caplog):
    caplog.set_level(logging.DEBUG)
    calls = []

    async def fail(text):
        calls.append(text)
        raise ValueError(text)

    async def main():
        q = JobQueue(workers=1, max_attempts=2, backoff_s=0.001)
        q.start()
        q.enqueue("feedback", fail, SECRET)
        await q.join()
        await q.stop()

    asyncio.run(main())
    assert calls == [SECRET, SECRET]  # 재시도에도 같은 인자가 전달됐다
    assert SECRET not in caplog.text
    assert "ValueError" in caplog.text
    assert "job feedback dropped after 2 attempts" in caplog.text
    # 로그 레코드에 인자·traceback이 붙어 있지 않다
    assert all(r.exc_info is None and SECRET not in str(r.args) for r in caplog.records)


def test_full_queue_rejects():
    async def noop():
        pass

    q = JobQueue(maxsize=1)  # start 전: 아무도 꺼내지 않는다
    assert q.enqueue("a", noop) is True
    assert q.enqueue("b", noop) is False


def test_stop_drains_pending():
    got = []

    async def job(i):
        await asyncio.sleep(0)
        got.append(i)

    async def main():
        q = JobQueue(workers=2)
        q.start()
        for i in range(5):
            assert q.enqueue("t", job, i)
        await q.stop()  # join 없이 바로 종료: 대기 작업을 비우고 끝난다

    asyncio.run(main())
    assert sorted(got) == [0, 1, 2, 3, 4]


def test_stop_gives_up_after_drain_and_refuses_new_jobs(caplog):
    caplog.set_level(logging.DEBUG)
    done = []

    async def never_ends(text):
        done.append("started")
        await asyncio.sleep(60)

    async def failing(text):
        raise ValueError(text)

    async def main():
        q = JobQueue(workers=1, max_attempts=3, backoff_s=30)
        q.start()
        q.enqueue("slow", never_ends, SECRET)
        q.enqueue("flaky", failing, SECRET)  # 워커가 느린 작업에 묶여 큐에 남는다
        await asyncio.sleep(0.01)
        t0 = time.monotonic()
        await q.stop(drain_s=0.05)
        assert time.monotonic() - t0 < 2  # 60초 작업·30초 백오프를 기다리지 않는다
        assert q.enqueue("late", never_ends, SECRET) is False  # 종료 뒤엔 받지 않는다
        await asyncio.sleep(0)  # 취소된 워커가 정리될 틈

    asyncio.run(main())
    assert done == ["started"]
    assert "unfinished" in caplog.text
    assert SECRET not in caplog.text


def test_lifespan_starts_queue(monkeypatch):
    monkeypatch.delenv("SUPABASE_DB_URL", raising=False)
    with TestClient(app):
        assert isinstance(app.state.queue, JobQueue)
        assert app.state.queue.enqueue("t", _noop) is True


async def _noop():
    pass


def test_fake_queue_runs_in_order_including_new_jobs():
    order = []
    fq = FakeQueue()

    async def first():
        order.append("first")
        assert fq.enqueue("third", third)  # 실행 중 들어온 것도 돈다

    async def second(x):
        order.append(f"second:{x}")

    async def third():
        order.append("third")

    assert fq.enqueue("first", first) and fq.enqueue("second", second, 7)
    assert fq.names() == ["first", "second"]
    asyncio.run(fq.run_all())
    assert order == ["first", "second:7", "third"]
    assert fq.names() == ["first", "second", "third"]
    asyncio.run(fq.run_all())  # 이미 돈 작업은 다시 돌지 않는다
    assert order == ["first", "second:7", "third"]


def test_fake_queue_reraises_job_error():
    fq = FakeQueue()

    async def boom():
        raise KeyError("x")

    fq.enqueue("boom", boom)
    with pytest.raises(KeyError):
        asyncio.run(fq.run_all())
