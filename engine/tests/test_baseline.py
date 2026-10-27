"""T-26 기준선. 웹훅이 `baseline` 작업을 넣고(인자는 id만, 키 `baseline:<id>`), 워커가 DB에서 메시지를 다시 읽어
surface() 특징 숫자만 `tone.baselines`에 더한다. 본문은 어디에도 남지 않는다. 사진만 있는 메시지는 건너뛴다."""
import asyncio
import logging
import time
from datetime import datetime, timezone

import pytest

from app.context import load_context
from jobs import baseline
from layers import gate
from tests.fakes import FakeQueue, FakeRepo

HOOK = {"X-Hook-Secret": "test-secret"}
ROOM = "6f1c2c9e-7a54-4a0e-9d57-0a3b1f7e2c11"
SENDER = "0b9d1a3e-52c7-4f6a-8c1e-9d2f4a6b8c10"
USUAL = "회의 자료는 내일 오전까지 정리해서 올릴게요"   # 평소 말투: 길고, 존댓말
NOW = datetime(2026, 10, 27, 12, 0, tzinfo=timezone.utc)


def _hook(client, mid):
    body = {"type": "INSERT", "table": "messages", "schema": "public",
            "record": {"id": mid, "room_id": ROOM, "sender_id": SENDER, "text": "비밀문장",
                       "created_at": "2026-10-27T09:00:00+00:00"}}
    return client.post("/hooks/message", json=body, headers=HOOK)


def _update(fake, mid):
    asyncio.run(baseline.update(fake, mid))


def _talk(fake, n, text=USUAL):
    """나(me)와 상대가 있는 1:1 방에서 내가 같은 말을 n번 한 메시지 id들."""
    me, you = fake.add_user("김지은"), fake.add_user("박민수")
    room = fake.add_room("direct", "친구", [me, you])
    fake.add_message(room, you, "내일 회의 자료 언제 올라와요?")
    return room, me, [fake.add_message(room, me, text) for _ in range(n)]


# ── 웹훅 ───────────────────────────────────────────────

def test_webhook_enqueues_baseline(client, queue, fake):
    assert _hook(client, 42).status_code == 202
    assert "baseline" in queue.names()
    _, fn, args = queue.jobs[queue.names().index("baseline")]
    assert fn is baseline.update
    assert args[0] is fake and args[1:] == (42,)   # 큐 인자는 message_id뿐: 본문은 워커가 DB에서 읽는다
    assert "비밀문장" not in repr(args[1:])
    assert "baseline:42" in queue.keys


def test_same_message_id_webhook_twice_is_one_baseline_job(client, queue):
    assert _hook(client, 7).status_code == 202
    assert _hook(client, 7).status_code == 202
    assert queue.names().count("baseline") == 1
    assert _hook(client, 8).status_code == 202
    assert queue.names().count("baseline") == 2


def test_webhook_202_even_if_baseline_enqueue_rejected(client, queue, caplog):
    queue.accepting = False
    caplog.set_level(logging.DEBUG)
    assert _hook(client, 9).status_code == 202
    assert queue.names() == []
    assert "baseline enqueue rejected" in caplog.text
    assert "push enqueue rejected" in caplog.text   # 둘 다 시도했다


class _Exploding(FakeQueue):
    """`boom` 이름의 작업을 넣을 때만 예외를 던진다."""

    def __init__(self, boom: str) -> None:
        super().__init__()
        self.boom = boom

    def enqueue(self, name, fn, *args, key=None):
        if name == self.boom:
            raise RuntimeError("secret-detail")
        return super().enqueue(name, fn, *args, key=key)


@pytest.mark.parametrize("boom, other", [("push", "baseline"), ("baseline", "push")])
def test_one_enqueue_raising_does_not_block_the_other(client, fake, registry, boom, other, caplog):
    from app.deps import get_queue
    from app.main import app
    q = _Exploding(boom)
    app.dependency_overrides[get_queue] = lambda: q
    caplog.set_level(logging.DEBUG)
    assert _hook(client, 5).status_code == 202
    assert q.names() == [other]
    assert f"{boom} enqueue failed: RuntimeError" in caplog.text
    assert "secret-detail" not in caplog.text   # 예외 메시지는 남기지 않는다


def test_webhook_feeds_baseline_end_to_end(client, queue, fake):
    room, me, mids = _talk(fake, 3)
    for mid in mids:
        body = {"type": "INSERT", "table": "messages", "schema": "public",
                "record": {"id": mid, "room_id": str(room), "sender_id": str(me), "text": USUAL,
                           "created_at": "2026-10-27T09:00:00+00:00"}}
        assert client.post("/hooks/message", json=body, headers=HOOK).status_code == 202
    asyncio.run(queue.run_all())
    b = fake.baselines[me]
    assert b["n"] == 3 and b["avg_len"] == len(USUAL) and b["polite_rate"] == 1.0


# ── 작업 ───────────────────────────────────────────────

@pytest.mark.parametrize("text", ["", "   "], ids=["empty", "blank"])
def test_image_only_skipped(fake, text):
    room, me, _ = _talk(fake, 0)
    mid = fake.add_message(room, me, text, image_path="rooms/x/photo.jpg")
    _update(fake, mid)
    assert fake.baselines == {}


def test_deleted_message_skipped(fake):
    _update(fake, 999)   # 그 사이 지워졌다
    assert fake.baselines == {}


def test_deviation_after_ten_messages(fake):
    room, me, mids = _talk(fake, 10)
    draft = "ㅇㅇ"

    def signals():
        ctx = asyncio.run(load_context(fake, room, me, None, NOW))
        return gate.score(draft, ctx.convo, ctx.store, str(me), 0.3, 5).signals

    for mid in mids[:9]:
        _update(fake, mid)
    assert "평소보다 짧음" not in signals()   # 9개: 아직 기준선이 아니다(ProfileStore가 n>=10을 본다)
    _update(fake, mids[9])
    got = signals()
    assert "평소보다 짧음" in got and "존댓말이 갑자기 빠짐" in got


class _Hanging(FakeRepo):
    """`hang`으로 고른 DB 호출이 끝나지 않는 저장소(풀 acquire이 영원히 기다리는 경우)."""

    def __init__(self, hang: str) -> None:
        super().__init__()
        self.hang = hang

    async def message(self, message_id):
        if self.hang == "message":
            await asyncio.sleep(3600)
        return await super().message(message_id)

    async def update_baseline(self, *a):
        if self.hang == "update_baseline":
            await asyncio.sleep(3600)
        await super().update_baseline(*a)


@pytest.mark.parametrize("hang", ["message", "update_baseline"])
def test_hanging_db_times_out(monkeypatch, hang):
    # 작업은 스스로 제한 시간을 둔다: 멈춘 DB 호출이 공유 워커 2개 중 하나를 붙들지 않게
    monkeypatch.setattr(baseline, "BASELINE_DEADLINE_S", 0.05)
    repo = _Hanging(hang)
    room, me, mids = _talk(repo, 1)
    t0 = time.monotonic()
    with pytest.raises(TimeoutError):
        asyncio.run(baseline.update(repo, mids[0]))
    assert time.monotonic() - t0 < 1
