"""Repo 계약 테스트. 같은 본문이 FakeRepo와 임시 Postgres(PgRepo) 둘 다에서 돈다(`world` 픽스처)."""
import json
from datetime import date, datetime, timedelta, timezone
from uuid import uuid4

from app.db import FeedbackWrite, TraceRow, week_start
from harness.schemas import FeedbackPattern
from tests.pg import w

NOW = datetime.now(timezone.utc)
UTC = timezone.utc


async def trio(seed, relation="팀원"):
    """민수(a)·지은(b)·현우(c)가 있는 그룹방."""
    a = await w(seed.add_user("민수"))
    b = await w(seed.add_user("지은"))
    c = await w(seed.add_user("현우"))
    room = await w(seed.add_room("group", relation, [a, b, c], title="팀플"))
    return a, b, c, room


def test_membership_and_room(world):
    async def body(repo, seed):
        a, b, c, room = await trio(seed)
        outsider = await w(seed.add_user("외부"))
        assert await repo.is_member(room, a) is True
        assert await repo.is_member(room, outsider) is False
        r = await repo.room(room)
        assert (r.id, r.kind, r.relation, r.title, r.member_count) == (room, "group", "팀원", "팀플", 3)
        assert await repo.room(uuid4()) is None
    world(body)


def test_recent_messages(world):
    async def body(repo, seed):
        a, b, c, room = await trio(seed)
        other = await w(seed.add_room("direct", "친구", [a, b]))
        base = NOW - timedelta(hours=1)
        for i in range(9):
            await w(seed.add_message(room, a if i % 2 else b, f"m{i}", at=base + timedelta(minutes=i)))
        photo = await w(seed.add_message(room, a, "", image_path=f"{room}/p.jpg", at=base + timedelta(minutes=9)))
        await w(seed.add_message(other, a, "다른 방", at=base + timedelta(minutes=10)))

        got = await repo.recent_messages(room)
        assert [m.text for m in got] == [f"m{i}" for i in range(2, 9)] + [""]
        assert [m.created_at for m in got] == sorted(m.created_at for m in got)
        assert (got[-1].id, got[-1].image_path, got[-1].sender_id) == (photo, f"{room}/p.jpg", a)
        assert len(await repo.recent_messages(room, limit=3)) == 3
    world(body)


def test_message_and_names(world):
    async def body(repo, seed):
        a, b, c, room = await trio(seed)
        first = await w(seed.add_message(room, b, "내일 회의 몇 시야?"))
        reply = await w(seed.add_message(room, a, "3시", reply_to=first))
        m = await repo.message(reply)
        assert (m.id, m.room_id, m.sender_id, m.text, m.reply_to) == (reply, room, a, "3시", first)
        assert await repo.message(10**12) is None
        assert await repo.member_names(room) == {a: "민수", b: "지은", c: "현우"}
    world(body)


def test_sender_patterns_active_from(world):
    async def body(repo, seed):
        a, b, c, room = await trio(seed)
        kw = dict(count=2, strength=1.5, feeling="성의없게")
        await w(seed.add_sender_pattern(a, "팀원", "짧은 답", active_from=NOW + timedelta(days=1), **kw))
        await w(seed.add_sender_pattern(b, "팀원", "짧은 답", active_from=NOW - timedelta(days=1), **kw))
        assert await repo.sender_patterns(a, "팀원", NOW) == {}
        assert await repo.sender_patterns(b, "팀원", NOW) == {
            "짧은 답": {"count": 2, "strength": 1.5, "feeling": "성의없게"}}
        assert await repo.sender_patterns(b, "친구", NOW) == {}
        assert await repo.sender_patterns(b, "팀원' or '1'='1", NOW) == {}  # 값은 파라미터로만 간다
        await w(seed.set_global("짧은 답", 4))
        assert await repo.global_patterns() == {"짧은 답": 4}
    world(body)


def test_baseline_running_average(world):
    async def body(repo, seed):
        a = await w(seed.add_user("민수"))
        assert await repo.baseline(a) is None
        await repo.update_baseline(a, 10, True, False)
        await repo.update_baseline(a, 20, False, False)
        assert await repo.baseline(a) == {"avg_len": 15.0, "polite_rate": 0.5, "softener_rate": 0.0, "n": 2}
    world(body)


def test_apply_feedback(world):
    async def body(repo, seed):
        a, b, c, room = await trio(seed)          # a가 보낸 사람, b·c·d가 신고자
        d = await w(seed.add_user("소연"))
        room = await w(seed.add_room("group", "팀원", [a, b, c, d]))
        m = [await w(seed.add_message(room, a, f"응{i}")) for i in range(5)]
        tomorrow = NOW + timedelta(days=1)

        def fb(reporter, message_id, *, usable=True, to_sender=True, strength=2, feeling="성의없게"):
            pats = [FeedbackPattern(trigger="짧은 답", feeling=feeling, strength=strength)] if usable else []
            return FeedbackWrite(room_id=room, reporter_id=reporter, message_id=message_id, sender_id=a,
                                 relation="팀원", usable=usable, patterns=pats, to_sender=to_sender,
                                 active_from=tomorrow)

        async def rows(*tables):
            return [await w(seed.rows(t)) for t in tables]

        TABLES = ("tone.feedback_log", "tone.sender_patterns", "tone.global_patterns", "tone.pattern_reporters")
        PATTERNS = TABLES[1:]

        assert await repo.apply_feedback(fb(b, m[0])) is True
        [log] = await w(seed.rows("tone.feedback_log"))
        assert (log["room_id"], log["reporter_id"], log["message_id"], log["usable"], log["pattern_count"]) \
            == (room, b, m[0], True, 1)
        [sp] = await w(seed.rows("tone.sender_patterns"))
        assert (sp["sender_id"], sp["relation"], sp["trigger"], sp["count"], sp["strength"], sp["feeling"],
                sp["active_from"]) == (a, "팀원", "짧은 답", 1, 2.0, "성의없게", tomorrow)
        assert await repo.sender_patterns(a, "팀원", NOW) == {}          # 다음 날부터
        assert await repo.global_patterns() == {"짧은 답": 1}

        # 같은 (신고자, 메시지)를 다시 → False, 아무것도 안 바뀜
        before = await rows(*TABLES)
        assert await repo.apply_feedback(fb(b, m[0])) is False
        assert await rows(*TABLES) == before

        # 같은 신고자가 다른 메시지로 되풀이해도 전체 수는 서로 다른 신고자 수
        for mid in m[1:]:
            assert await repo.apply_feedback(fb(b, mid, to_sender=False)) is True
        assert await repo.global_patterns() == {"짧은 답": 1}

        # 다른 신고자, to_sender=False → 전체만 +1, 보낸 사람 패턴은 그대로
        sp_before = await w(seed.rows("tone.sender_patterns"))
        assert await repo.apply_feedback(fb(c, m[0], to_sender=False)) is True
        assert await repo.global_patterns() == {"짧은 답": 2}
        assert await w(seed.rows("tone.sender_patterns")) == sp_before

        # 또 다른 신고자, to_sender=True → count + 1, strength 누적 평균, feeling은 새 값
        assert await repo.apply_feedback(fb(d, m[1], strength=3, feeling="차갑게")) is True
        assert await repo.sender_patterns(a, "팀원", tomorrow) == {
            "짧은 답": {"count": 2, "strength": 2.5, "feeling": "차갑게"}}
        assert await repo.global_patterns() == {"짧은 답": 3}

        # usable=False → feedback_log만(pattern_count 0), 패턴 표는 그대로
        pat_before = await rows(*PATTERNS)
        assert await repo.apply_feedback(fb(d, m[2], usable=False)) is True
        assert await rows(*PATTERNS) == pat_before
        [last] = [r for r in await w(seed.rows("tone.feedback_log")) if (r["reporter_id"], r["message_id"]) == (d, m[2])]
        assert (last["usable"], last["pattern_count"]) == (False, 0)
    world(body)


def test_weekly_feedback_count(world):
    async def body(repo, seed):
        a, b, c, room = await trio(seed, "팀원")
        friends = await w(seed.add_room("group", "친구", [a, b, c]))
        m1, m2 = [await w(seed.add_message(room, a, t)) for t in ("응", "ㅇㅇ")]
        by_b = await w(seed.add_message(room, b, "그래"))
        in_friends = await w(seed.add_message(friends, a, "응"))

        def fb(room_id, reporter, message_id, sender, relation, usable=True):
            pats = [FeedbackPattern(trigger="짧은 답", feeling="차갑게")] if usable else []
            return FeedbackWrite(room_id=room_id, reporter_id=reporter, message_id=message_id, sender_id=sender,
                                 relation=relation, usable=usable, patterns=pats, to_sender=True, active_from=NOW)

        await repo.apply_feedback(fb(room, b, m1, a, "팀원"))
        await repo.apply_feedback(fb(room, c, m1, a, "팀원"))
        await repo.apply_feedback(fb(room, b, m2, a, "팀원", usable=False))   # usable 아님
        await repo.apply_feedback(fb(room, c, by_b, b, "팀원"))               # 다른 보낸 사람
        await repo.apply_feedback(fb(friends, b, in_friends, a, "친구"))      # 다른 관계
        hour = timedelta(hours=1)
        assert await repo.weekly_feedback_count(a, "팀원", NOW - hour) == 2
        assert await repo.weekly_feedback_count(a, "친구", NOW - hour) == 1
        assert await repo.weekly_feedback_count(a, "팀원", NOW + hour) == 0   # since 이전 것은 빠짐
    world(body)


def test_push_targets(world):
    async def body(repo, seed):
        a, b, c, room = await trio(seed)
        web = json.dumps({"endpoint": "https://fcm.googleapis.com/fcm/send/x", "keys": {"p256dh": "k", "auth": "a"}})
        await w(seed.add_push_token(a, "ExponentPushToken[a]", "android"))
        await w(seed.add_push_token(b, "ExponentPushToken[b]", "android"))
        await w(seed.add_push_token(b, web, "web"))
        await w(seed.add_push_token(c, "ExponentPushToken[c]", "android"))
        await w(seed.set_muted(room, c))

        got = await repo.push_targets(room, a)
        assert sorted((t.user_id, t.token, t.platform) for t in got) == sorted(
            [(b, "ExponentPushToken[b]", "android"), (b, web, "web")])

        await repo.delete_push_token(b, "ExponentPushToken[b]")
        await repo.delete_push_token(b, "없는 토큰")            # 조용히 지나감
        await repo.delete_push_token(c, web)                   # 남의 (user, token)은 지우지 않는다
        assert [(t.user_id, t.token) for t in await repo.push_targets(room, a)] == [(b, web)]
    world(body)


def test_sent_messages(world):
    async def body(repo, seed):
        a, b, c, room = await trio(seed, "팀원")
        dm = await w(seed.add_room("direct", "친구", [a, b]))
        await w(seed.add_message(room, a, "옛날", at=NOW - timedelta(days=2)))
        m1 = await w(seed.add_message(room, a, "하나", at=NOW - timedelta(hours=3)))
        await w(seed.add_message(room, b, "남의 것", at=NOW - timedelta(hours=2)))
        await w(seed.add_message(room, a, "", image_path=f"{room}/x.png", at=NOW - timedelta(hours=2)))
        m2 = await w(seed.add_message(dm, a, "둘", at=NOW - timedelta(hours=1)))
        m3 = await w(seed.add_message(room, a, "셋", at=NOW - timedelta(minutes=30)))

        got = await repo.sent_messages(a, NOW - timedelta(days=1))
        assert [(s.id, s.room_id, s.text, s.relation) for s in got] == [
            (m3, room, "셋", "팀원"), (m2, dm, "둘", "친구"), (m1, room, "하나", "팀원")]
        assert [s.id for s in await repo.sent_messages(a, NOW - timedelta(days=1), limit=2)] == [m3, m2]
    world(body)


def test_mirror_and_stats(world):
    async def body(repo, seed):
        a, b, c, room = await trio(seed)
        since = datetime(2026, 10, 1, tzinfo=UTC)
        sunday_utc = datetime(2026, 10, 25, 15, 30, tzinfo=UTC)   # KST로는 10-26(월) 00:30
        assert week_start(sunday_utc) == date(2026, 10, 26)

        await w(seed.add_event(a, room, "hint_shown", at=sunday_utc))
        await w(seed.add_event(a, room, "hint_shown", at=datetime(2026, 9, 20, tzinfo=UTC)))  # since 이전
        await w(seed.add_event(a, room, "detail_opened", at=sunday_utc))
        await w(seed.add_event(b, room, "hint_shown", at=sunday_utc))                       # 남의 것
        assert await repo.event_counts(a) == {"hint_shown": 2, "detail_opened": 1}
        assert await repo.hints_by_week(a, since) == {date(2026, 10, 26): 1}

        for gap, at in [(1, datetime(2026, 10, 26, 1, tzinfo=UTC)), (3, datetime(2026, 10, 28, 1, tzinfo=UTC)),
                        (None, datetime(2026, 10, 27, tzinfo=UTC)), (4, datetime(2026, 9, 1, tzinfo=UTC))]:
            await w(seed.add_mirror_attempt(a, "predict", "msg:7", gap=gap, at=at))
        await w(seed.add_mirror_attempt(b, "roleplay", "card:1", at=sunday_utc))
        assert await repo.mirror_refs(a) == {"predict|msg:7"}
        assert await repo.predict_gap_by_week(a, since) == {date(2026, 10, 26): 2.0}

        await repo.insert_mirror_attempt(a, "receive", "card:3", 4, None, None, None)
        assert await repo.mirror_refs(a) == {"predict|msg:7", "receive|card:3"}
    world(body)


def test_insert_trace_and_event(world):
    async def body(repo, seed):
        a, b, c, room = await trio(seed)
        tid = uuid4()
        experts = {"status": "alert", "experts": [{"id": "tone_a", "neg": 0.7}]}
        await repo.insert_trace(TraceRow(trace_id=tid, path="hint", user_id=a, room_id=room, experts=experts,
                                         risk=0.62, alert=True, latency_ms=840))
        [t] = await w(seed.rows("tone.analysis_traces"))
        assert (t["trace_id"], t["path"], t["user_id"], t["room_id"], t["experts"], t["alert"], t["latency_ms"]) \
            == (tid, "hint", a, room, experts, True, 840)

        signals = {"signals": ["짧은 답"], "trace_id": str(tid)}
        await repo.insert_event(a, room, "detail_opened", "차갑게", signals)
        [e] = await w(seed.rows("public.tone_events"))
        assert (e["user_id"], e["room_id"], e["kind"], e["top_reading"]) == (a, room, "detail_opened", "차갑게")
        assert e["risk"] is None
        assert e["signals"] == signals   # 문자열이 아니라 jsonb 객체
    world(body)
