import asyncio
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.context import load_context

NOW = datetime(2026, 10, 27, 12, 0, tzinfo=timezone.utc)


def _at(i: int) -> datetime:
    """i번째 메시지 시각(오래된 것부터)."""
    return NOW - timedelta(minutes=100 - i)


def _load(fake, room, user, reply_to=None, now=NOW):
    return asyncio.run(load_context(fake, room, user, reply_to, now))


def test_group_labels_and_reply_first(fake):
    a, b, c, d = (fake.add_user(n) for n in ("김에이", "이비비", "박씨씨", "최디디"))
    room = fake.add_room("group", "팀원", [a, b, c, d])
    old = fake.add_message(room, d, "회의록 누가 올려요?", at=_at(0))   # 최근 8개 밖(9개 전)
    for i in range(1, 5):
        fake.add_message(room, a, f"메모 {i}", at=_at(i))
    for i, sender in enumerate((b, c, a, b), start=5):
        fake.add_message(room, sender, f"말 {i}", at=_at(i))

    ctx = _load(fake, room, a, reply_to=old)

    assert [t.label for t in ctx.convo.turns] == ["나"] * 4 + ["상대1", "상대2", "나", "상대1"]
    assert [t.speaker for t in ctx.convo.turns][-4:] == ["them", "them", "me", "them"]
    assert ctx.convo.reply_to.label == "답장 대상 · 상대3"
    assert ctx.convo.reply_to.speaker == "them"
    assert ctx.convo.last_them() == "회의록 누가 올려요?"


def test_direct_labels_plain(fake):
    me, you = fake.add_user("김지은"), fake.add_user("박민수")
    room = fake.add_room("direct", "친구", [me, you])
    first = fake.add_message(room, you, "뭐 해?", at=_at(1))
    mine = fake.add_message(room, me, "그냥 있어", at=_at(2))
    fake.add_message(room, you, "저녁 먹을래?", at=_at(3))

    ctx = _load(fake, room, me, reply_to=first)
    assert [t.label for t in ctx.convo.turns] == ["상대", "나", "상대"]
    assert ctx.convo.reply_to.label == "답장 대상 · 상대"
    ctx = _load(fake, room, me, reply_to=mine)   # 내 메시지에 답장
    assert (ctx.convo.reply_to.speaker, ctx.convo.reply_to.label) == ("me", "답장 대상 · 나")
    assert ctx.convo.last_them() == "저녁 먹을래?"


def test_reply_to_unknown_or_other_room_422(fake):
    me, you = fake.add_user("김지은"), fake.add_user("박민수")
    room = fake.add_room("direct", "친구", [me, you])
    other = fake.add_room("direct", "친구", [me, fake.add_user("최수아")])   # 내가 멤버인 다른 방이어도
    elsewhere = fake.add_message(other, me, "다른 방 말")
    for bad in (9999, elsewhere):
        with pytest.raises(HTTPException) as e:
            _load(fake, room, me, reply_to=bad)
        assert e.value.status_code == 422


def test_image_only_becomes_placeholder(fake):
    me, you = fake.add_user("김지은"), fake.add_user("박민수")
    room = fake.add_room("direct", "친구", [me, you])
    pic = fake.add_message(room, you, "", image_path=f"{room}/a.jpg")
    ctx = _load(fake, room, me, reply_to=pic)
    assert ctx.convo.turns[0].text == "(사진)"
    assert ctx.convo.reply_to.text == "(사진)"


def test_patterns_respect_active_from(fake):
    me, you = fake.add_user("김지은"), fake.add_user("박민수")
    room = fake.add_room("group", "친구", [me, you, fake.add_user("최수아")])
    pair = f"{me}:친구"
    fake.add_sender_pattern(me, "친구", "짧은 답", active_from=NOW + timedelta(days=1))
    assert _load(fake, room, me).store.patterns_for(pair) == {}
    fake.add_sender_pattern(me, "친구", "짧은 답", strength=2.0, active_from=NOW - timedelta(days=1))
    fake.add_sender_pattern(you, "친구", "마침표로 끝남", active_from=NOW - timedelta(days=1))   # 남의 패턴
    fake.add_sender_pattern(me, "팀원", "마침표로 끝남", active_from=NOW - timedelta(days=1))   # 다른 관계
    fake.set_global("짧은 답", 7)
    store = _load(fake, room, me).store
    assert store.patterns_for(pair) == {"짧은 답": {"count": 1, "strength": 2.0, "feeling": "차갑게"}}
    assert store.global_patterns == {"짧은 답": 7}


def test_relation_and_kind_from_room(fake):
    a, b, c = fake.add_user("김지은"), fake.add_user("박민수"), fake.add_user("최수아")
    room = fake.add_room("group", "선후배", [a, b, c], title="동아리")
    fake.baselines[a] = {"avg_len": 12.0, "polite_rate": 0.9, "softener_rate": 0.3, "n": 15}
    ctx = _load(fake, room, a)
    assert (ctx.convo.relation, ctx.convo.kind, ctx.convo.pair_id) == ("선후배", "group", f"{a}:선후배")
    assert ctx.room.id == room and ctx.room.member_count == 3
    assert sorted(ctx.names) == sorted(["김지은", "박민수", "최수아"])
    assert ctx.store.baseline(str(a)) == fake.baselines[a]
    assert _load(fake, room, b).store.baselines == {}   # 기준선 없는 사람


def test_reads_run_concurrently(fake):
    """독립적인 읽기는 동시에 간다: 0.2초씩 자는 읽기 여러 개가 합쳐서 0.2초 남짓."""
    me, you = fake.add_user("김지은"), fake.add_user("박민수")
    room = fake.add_room("direct", "친구", [me, you])
    for name in ("room", "recent_messages", "member_names", "baseline", "global_patterns"):
        real = getattr(fake, name)

        async def slow(*a, _real=real, **k):
            await asyncio.sleep(0.2)
            return await _real(*a, **k)
        setattr(fake, name, slow)
    start = time.monotonic()
    _load(fake, room, me)
    assert time.monotonic() - start < 0.5   # 차례로 읽으면 1초


def test_unknown_room_after_membership_is_403(fake):
    """멤버 확인 뒤 방이 사라진 경우(경합): 방 존재를 알리지 않는 같은 403."""
    with pytest.raises(HTTPException) as e:
        _load(fake, uuid.uuid4(), fake.add_user("김지은"))
    assert e.value.status_code == 403
