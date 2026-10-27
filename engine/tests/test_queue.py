"""T-23 작업 큐. 이 큐는 T-24에서 하소연(피드백) 작업을 나른다: 인자와 예외 메시지는 로그에 나오면 안 된다(CLAUDE.md 5)."""
import asyncio
import gc
import logging
import time
import weakref

import pytest
from fastapi.testclient import TestClient

from app.db import PgRepo
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
    ran = []

    async def job():
        ran.append(1)

    with TestClient(app) as c:
        assert isinstance(app.state.queue, JobQueue)
        # 루프는 TestClient의 portal 스레드에 있다: enqueue·join은 그 스레드에서 부른다.
        assert c.portal.call(app.state.queue.enqueue, "t", job) is True
        c.portal.call(app.state.queue.join)
        assert ran == [1]  # 살아 있는 큐가 실제로 돌렸다
    assert app.state.queue.enqueue("t", job) is False  # 종료하면서 큐도 멈췄다


def test_lifespan_closes_repo_even_if_queue_stop_raises(monkeypatch):
    closed = []

    class FakePool:
        async def close(self):
            closed.append(1)

    async def connect(dsn):
        return FakePool()

    real_stop = JobQueue.stop

    async def stop_then_raise(self, drain_s=5.0):
        await real_stop(self, drain_s)
        raise RuntimeError("stop failed")

    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://unused")
    monkeypatch.setattr(PgRepo, "connect", connect)
    monkeypatch.setattr(JobQueue, "stop", stop_then_raise)
    with pytest.raises(RuntimeError, match="stop failed"):
        with TestClient(app):
            pass
    assert closed == [1]


async def _noop():
    pass


def test_workers_must_be_positive():
    with pytest.raises(ValueError):
        JobQueue(workers=0)


class _Payload:  # weakref를 걸 수 있는 인자
    pass


def test_finished_job_args_are_released():
    """끝난(성공·버림) 작업의 인자를 워커가 다음 작업을 기다리는 동안 붙들고 있지 않는다."""
    async def ok(p):
        pass

    async def bad(p):
        raise ValueError

    async def main():
        q = JobQueue(workers=1, max_attempts=1)
        q.start()
        refs = []
        for fn in (ok, bad):
            p = _Payload()
            refs.append(weakref.ref(p))
            q.enqueue("t", fn, p)
            del p
        await q.join()
        gc.collect()
        alive = [r() is not None for r in refs]
        await q.stop()
        return alive

    assert asyncio.run(main()) == [False, False]


def test_stop_cancels_pending_retry_timer():
    # 내부(_timers, _q)를 일부러 본다: 취소된 타이머가 남았는지는 겉으로 보이지 않는다.
    calls = []

    async def main():
        failed = asyncio.Event()

        async def fails():
            calls.append(1)
            failed.set()
            raise RuntimeError("fail")

        q = JobQueue(workers=1, maxsize=1, max_attempts=3, backoff_s=0.05)
        q.start()
        q.enqueue("t", fails)
        await failed.wait()
        timers = list(q._timers)
        assert len(timers) == 1
        await q.stop(drain_s=0.01)
        assert not q._timers and all(h.cancelled() for h in timers)
        await asyncio.sleep(0.15)  # 취소하지 않았다면 백오프 0.05초가 지나 다시 들어갔을 시간
        assert q._q.qsize() == 0

    asyncio.run(main())
    assert calls == [1]


def test_cancelled_stop_still_cancels_workers_and_timers():
    async def slow():
        await asyncio.sleep(60)

    async def fails():
        raise RuntimeError("fail")

    async def main():
        q = JobQueue(workers=2, backoff_s=30)
        q.start()
        workers = list(q._workers)
        q.enqueue("slow", slow)
        q.enqueue("fails", fails)
        await asyncio.sleep(0.01)  # 한쪽은 느린 작업 중, 다른 쪽은 실패해 30초 백오프 중
        timers = list(q._timers)
        assert len(timers) == 1
        stopping = asyncio.create_task(q.stop(drain_s=60))
        await asyncio.sleep(0.01)
        stopping.cancel()  # drain을 기다리다 취소돼도 정리는 끝까지 한다
        with pytest.raises(asyncio.CancelledError):
            await stopping
        assert all(w.done() for w in workers)
        assert all(h.cancelled() for h in timers)

    asyncio.run(main())


def test_retry_hitting_full_queue_waits_again_without_loss():
    ran = []

    async def main():
        gate = asyncio.Event()

        async def flaky():
            ran.append("A")
            if ran.count("A") == 1:
                raise RuntimeError("fail")

        async def blocker():
            await gate.wait()
            ran.append("B")

        async def filler():
            ran.append("C")

        q = JobQueue(workers=1, maxsize=1, max_attempts=2, backoff_s=0.05)
        q.start()
        q.enqueue("A", flaky)
        await asyncio.sleep(0.01)             # A 첫 시도 실패, 백오프 중
        assert q.enqueue("B", blocker)        # 유일한 워커가 B에 묶인다
        await asyncio.sleep(0.01)
        assert q.enqueue("C", filler)         # 큐(maxsize 1)가 찬다
        await asyncio.sleep(0.12)             # A의 타이머가 찬 큐를 만난다
        assert ran == ["A"] and len(q._timers) == 1  # 버려지지 않고 다시 대기 중
        gate.set()
        await q.join()
        await q.stop()

    asyncio.run(main())
    assert sorted(ran) == ["A", "A", "B", "C"]


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


def test_fake_queue_can_refuse_jobs():
    fq = FakeQueue(accepting=False)
    assert fq.enqueue("t", _noop) is False
    assert fq.jobs == []
