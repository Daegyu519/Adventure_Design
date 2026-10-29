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


def test_lifespan_feedback_queue_is_separate(monkeypatch):
    """털어놓기는 자기 큐(워커 1개, maxsize QUEUE_MAXSIZE)에서만 돈다: 몰아쳐 꽉 차도 push·baseline의 공유 큐는 그대로 받는다."""
    from jobs import feedback as fjob
    monkeypatch.delenv("SUPABASE_DB_URL", raising=False)
    started, ran, release = [], [], asyncio.Event()

    async def hold():
        started.append(1)
        await release.wait()

    async def push():
        ran.append(1)

    with TestClient(app) as c:
        fq, shared = app.state.feedback_queue, app.state.queue
        assert isinstance(fq, JobQueue) and fq is not shared
        assert c.portal.call(fq.enqueue, "feedback", hold)
        for _ in range(200):                       # 첫 작업이 워커에 잡힐 때까지
            if started:
                break
            c.portal.call(asyncio.sleep, 0.01)
        assert all(c.portal.call(fq.enqueue, "feedback", hold) for _ in range(fjob.QUEUE_MAXSIZE))
        assert c.portal.call(fq.enqueue, "feedback", hold) is False   # 털어놓기 큐만 찼다
        c.portal.call(asyncio.sleep, 0.05)
        assert started == [1]                                          # 워커 1개: 차례로 돈다
        assert c.portal.call(shared.enqueue, "push", push) is True     # 공유 큐는 그대로 받고 돈다
        c.portal.call(shared.join)
        assert ran == [1]
        c.portal.call(release.set)
        c.portal.call(fq.join)
        assert len(started) == fjob.QUEUE_MAXSIZE + 1
    assert fq.enqueue("feedback", hold) is False   # 종료하면서 털어놓기 큐도 멈췄다


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


def test_retried_job_args_are_released_without_cyclic_gc():
    """재시도 타이머가 울린 뒤에는 핸들↔콜백 순환이 없어서, gc 없이도 인자가 풀린다."""
    attempts = []

    async def flaky(p):
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("fail")

    async def main():
        q = JobQueue(workers=1, max_attempts=3, backoff_s=0.01)
        q.start()
        p = _Payload()
        ref = weakref.ref(p)
        q.enqueue("t", flaky, p)
        del p
        await q.join()
        alive = ref() is not None  # gc.collect() 없이 본다
        await q.stop()
        return alive

    gc.collect()  # 앞선 테스트의 쓰레기를 치운 뒤에 끈다
    gc.disable()
    try:
        alive = asyncio.run(main())
    finally:
        gc.enable()
    assert len(attempts) == 2  # 실제로 재시도를 거쳤다
    assert alive is False


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


def test_same_key_is_enqueued_once():
    got = []

    async def job(x):
        got.append(x)

    async def main():
        q = JobQueue(workers=1)
        q.start()
        assert q.enqueue("push", job, 1, key="push:1") is True
        assert q.enqueue("push", job, 1, key="push:1") is True  # 이미 받은 작업: 거절(False)이 아니다
        assert q.enqueue("push", job, 2, key="push:2") is True
        await q.join()
        assert q.enqueue("push", job, 1, key="push:1") is True  # 끝난 뒤에 와도 다시 안 돈다
        await q.join()
        await q.stop()

    asyncio.run(main())
    assert got == [1, 2]


def test_jobs_without_key_are_never_deduped():
    got = []

    async def job():
        got.append(1)

    async def main():
        q = JobQueue(workers=1)
        q.start()
        assert q.enqueue("t", job) and q.enqueue("t", job)
        await q.join()
        await q.stop()

    asyncio.run(main())
    assert got == [1, 1]


def test_key_memory_is_bounded():
    got = []

    async def job(x):
        got.append(x)

    async def main():
        q = JobQueue(workers=1, max_keys=2)
        q.start()
        for k in ("a", "b", "c", "a"):  # c가 들어오며 가장 오래된 a를 잊는다 → 마지막 a는 다시 돈다
            assert q.enqueue("t", job, k, key=k) is True
        await q.join()
        await q.stop()

    asyncio.run(main())
    assert got == ["a", "b", "c", "a"]


def test_rejected_job_key_is_not_remembered():
    got = []

    async def job(x):
        got.append(x)

    async def main():
        q = JobQueue(workers=1, maxsize=1)  # start 전: 아무도 꺼내지 않는다
        assert q.enqueue("t", job, 1, key="k1") is True
        assert q.enqueue("t", job, 2, key="k2") is False  # 가득 참: 받지 않았으니 키도 남기지 않는다
        q.start()
        await q.join()
        assert q.enqueue("t", job, 2, key="k2") is True
        await q.join()
        await q.stop()

    asyncio.run(main())
    assert got == [1, 2]


def test_fake_queue_dedupes_same_key():
    fq = FakeQueue()
    assert fq.enqueue("push", _noop, 1, key="push:1") is True
    assert fq.enqueue("push", _noop, 1, key="push:1") is True
    assert fq.enqueue("push", _noop, 2, key="push:2") is True
    assert fq.enqueue("t", _noop) and fq.enqueue("t", _noop)  # 키 없는 작업은 그대로
    assert fq.names() == ["push", "push", "t", "t"]
    assert fq.keys == ["push:1", "push:2"]


def test_per_job_max_attempts_override(caplog):
    """작업마다 시도 횟수를 줄일 수 있다(털어놓기: 느린 모델에 재시도 폭주를 만들지 않게 1번)."""
    calls = []

    async def boom():
        calls.append(1)
        raise RuntimeError(SECRET)

    async def main():
        q = JobQueue(workers=1, max_attempts=3, backoff_s=0.001)
        q.start()
        assert q.enqueue("feedback", boom, max_attempts=1) is True
        await q.join()
        await q.stop()

    with caplog.at_level(logging.WARNING):
        asyncio.run(main())
    assert calls == [1]
    assert "job feedback dropped after 1 attempts: RuntimeError" in caplog.text and SECRET not in caplog.text


def test_fake_queue_records_max_attempts():
    q = FakeQueue()

    async def job():
        pass
    q.enqueue("a", job)
    q.enqueue("b", job, max_attempts=1)
    assert q.max_attempts == [None, 1]
