"""T-24 털어놓기: POST /v1/feedback → L4(요청 안) → 큐(분류 결과만) → sender_patterns·global_patterns.
하소연 원문은 DB·로그·trace·큐 인자 어디에도 남지 않는다(규칙 5). 1:1·2명 방은 global_patterns에만(규칙 14)."""
import ast
import asyncio
import inspect
import logging
from datetime import date, datetime, timedelta, timezone

import asyncpg
import pytest

from app.db import GROUP_MIN_MEMBERS, KST, FeedbackWrite, PgRepo, week_start
from harness.schemas import TRIGGERS, FeedbackPattern
from jobs import feedback as job
from layers import gate, guard
from tests.pg import PgSeeder, w

COMPLAINT = "너무 단답이라 성의 없어 보였어"
SECRET = "보라색코끼리하소연"
D = datetime(2026, 10, 27, 10, 0, tzinfo=KST)          # 날짜 D 10:00 KST
MIDNIGHT = datetime(2026, 10, 28, tzinfo=KST)          # D+1 0:00 KST
PATTERN_TABLES = ("tone.sender_patterns", "tone.global_patterns", "tone.pattern_reporters")
TABLES = ("tone.feedback_log", *PATTERN_TABLES)


def group(fake, n=3, kind="group", relation="팀원"):
    """민수(보낸 사람)·지은·하늘 중 앞 n명. 민수의 메시지 "ㅇㅇ"."""
    users = [fake.add_user(name) for name in ("민수", "지은", "하늘")[:n]]
    room = fake.add_room(kind, relation, users)
    return users, room, fake.add_message(room, users[0], "ㅇㅇ")


def report(repo, reg, room, reporter, mid, text=COMPLAINT, now=D):
    """라우트가 하는 일 그대로: 요청 안에서 분류 → 큐 작업이 분류 결과만 받아 쓴다."""
    async def go():
        pats = await job.classify(repo, reg, await repo.message(mid), text)
        await job.run(repo, room, reporter, mid, pats, now)
    asyncio.run(go())


def canned(spy, *patterns):
    spy.canned["feedback"] = lambda _p: {"usable": True, "patterns": list(patterns), "dropped_reason": None}


def post(client, room, mid, text=COMPLAINT):
    return client.post("/v1/feedback", json={"room_id": str(room), "message_id": mid, "text": text})


# ── 라우트 ───────────────────────────────────────────

def test_feedback_202_ack(client, login, fake, queue):
    (_, jieun, _), room, mid = group(fake)
    login(jieun)
    r = post(client, room, mid)
    assert r.status_code == 202 and r.json() == {"ack": guard.ACK}
    assert queue.names() == ["feedback"]
    asyncio.run(queue.run_all())
    assert [(f["reporter_id"], f["message_id"], f["usable"]) for f in fake.feedback_log] == [(jieun, mid, True)]


def test_ack_passes_guard():
    assert guard.guard(guard.ACK) == guard.ACK and "수도 있어요" in guard.ACK


def test_own_message_403(client, login, fake, queue, spy):
    (minsu, _, _), room, mid = group(fake)
    login(minsu)
    r = post(client, room, mid)
    assert r.status_code == 403 and r.json() == {"detail": "not_received"}
    assert queue.jobs == [] and spy.calls == []


def test_other_room_message_403(client, login, fake, queue, spy):
    (minsu, jieun, haneul), room, _ = group(fake)
    other = fake.add_room("direct", "친구", [minsu, haneul])
    elsewhere = fake.add_message(other, minsu, "다른 방")
    login(jieun)
    assert post(client, room, elsewhere).status_code == 403
    assert post(client, room, 10**9).status_code == 403          # 없는 메시지도 같은 403
    assert queue.jobs == [] and spy.calls == []


def test_non_member_403(client, login, fake, queue, spy):
    _, room, mid = group(fake)
    login(fake.add_user("외부"))
    r = post(client, room, mid)
    assert r.status_code == 403 and r.json() == {"detail": "not_a_member"}
    assert queue.jobs == [] and spy.calls == []


@pytest.mark.parametrize("bad", [{"text": "가" * 1001}, {"text": ""}, {"text": "   "}, {"message_id": 0},
                                 {"message_id": 2**63}, {"room_id": "nope"}])
def test_text_1001_422(client, login, fake, queue, bad):
    (_, jieun, _), room, mid = group(fake)
    login(jieun)
    body = {"room_id": str(room), "message_id": mid, "text": COMPLAINT} | bad
    assert client.post("/v1/feedback", json=body).status_code == 422
    assert queue.jobs == []
    assert post(client, room, mid, "가" * 1000).status_code == 202   # 1000자는 받는다


def test_queue_full_503(client, login, fake, queue):
    (_, jieun, _), room, mid = group(fake)
    queue.accepting = False
    login(jieun)
    assert post(client, room, mid).status_code == 503
    assert fake.feedback_log == []


def test_classify_failure_still_acks_and_logs_type_only(client, login, fake, queue, monkeypatch, caplog):
    """분류가 터져도 하소연은 받았다고 답하고(패턴 없음), 로그에는 예외 종류만 남는다."""
    (_, jieun, _), room, mid = group(fake)

    async def boom(*_a, **_k):
        raise RuntimeError(f"민수 {SECRET}")
    monkeypatch.setattr(fake, "member_names", boom)
    login(jieun)
    with caplog.at_level(logging.DEBUG):
        r = post(client, room, mid, f"민수 {SECRET}")
        asyncio.run(queue.run_all())
    assert r.status_code == 202
    assert "feedback classify failed: RuntimeError" in caplog.text and SECRET not in caplog.text
    assert [(f["usable"], f["pattern_count"]) for f in fake.feedback_log] == [(False, 0)]


# ── 반영 규칙 ─────────────────────────────────────────

def test_group_feedback_to_sender_from_next_day(fake, registry):
    (minsu, jieun, _), room, mid = group(fake)
    report(fake, registry, room, jieun, mid)
    assert job.next_midnight_kst(D) == MIDNIGHT
    assert set(fake.sender_pats) == {(minsu, "팀원", "짧은 답", MIDNIGHT)}
    assert not any(k[0] == jieun for k in fake.sender_pats)            # 신고자 키는 없다
    assert fake.global_pats == {"짧은 답": 1}
    assert asyncio.run(fake.sender_patterns(minsu, "팀원", D)) == {}    # 다음 날 0시부터
    assert asyncio.run(fake.sender_patterns(minsu, "팀원", MIDNIGHT))["짧은 답"]["count"] == 1


def test_direct_feedback_global_only(fake, registry):
    (minsu, jieun), room, mid = group(fake, 2, kind="direct", relation="친구")
    report(fake, registry, room, jieun, mid)
    assert fake.sender_pats == {} and fake.global_pats == {"짧은 답": 1}


def test_two_member_group_counts_as_direct(fake, registry):
    assert GROUP_MIN_MEMBERS == 3
    (minsu, jieun), room, mid = group(fake, 2)
    report(fake, registry, room, jieun, mid)
    assert fake.sender_pats == {} and fake.global_pats == {"짧은 답": 1}


def test_weekly_cap(fake, registry):
    (minsu, jieun, haneul), room, _ = group(fake)
    mids = [fake.add_message(room, minsu, "ㅇㅇ") for _ in range(job.WEEKLY_CAP + 1)]
    for i, mid in enumerate(mids[:-1]):
        report(fake, registry, room, (jieun, haneul)[i % 2], mid)
    assert [f["usable"] for f in fake.feedback_log] == [True] * job.WEEKLY_CAP
    before = {t: fake.rows(t) for t in PATTERN_TABLES}
    report(fake, registry, room, jieun, mids[-1])                      # 같은 보낸 사람·관계로 6번째
    last = fake.feedback_log[-1]
    assert (last["message_id"], last["usable"], last["pattern_count"]) == (mids[-1], False, 0)
    assert {t: fake.rows(t) for t in PATTERN_TABLES} == before


def test_weekly_cap_counts_from_kst_week_start(fake, registry):
    """주간 상한은 ISO 주의 KST 월요일 0시부터 센다: 그 전 주의 신고는 세지 않는다."""
    (minsu, jieun, _), room, _ = group(fake)
    sunday_late = datetime(2026, 10, 25, 23, 0, tzinfo=KST)
    for _ in range(job.WEEKLY_CAP):
        report(fake, registry, room, jieun, fake.add_message(room, minsu, "ㅇㅇ"), now=sunday_late)
    for f in fake.feedback_log:                                        # DB의 created_at은 신고 시각
        f["created_at"] = sunday_late
    report(fake, registry, room, jieun, fake.add_message(room, minsu, "ㅇㅇ"), now=sunday_late + timedelta(hours=2))
    assert fake.feedback_log[-1]["usable"] is True


def test_same_reporter_repeats_count_once(fake, registry):
    (minsu, jieun, _), room, mid = group(fake)
    report(fake, registry, room, jieun, mid)
    report(fake, registry, room, jieun, mid)
    assert len(fake.feedback_log) == 1
    for _ in range(5):
        report(fake, registry, room, jieun, fake.add_message(room, minsu, "ㅇㅇ"))
    assert fake.global_pats == {"짧은 답": 1}                           # 서로 다른 신고자 수


def test_duplicate_triggers_in_one_report(fake, registry, spy):
    (minsu, jieun, _), room, mid = group(fake)
    canned(spy, *({"trigger": t, "feeling": "차갑게", "strength": 2}
                  for t in ["짧은 답", "짧은 답", "마침표로 끝남", "이유 없는 거절", "짧은 답"]))
    report(fake, registry, room, jieun, mid)
    assert fake.global_pats == {"짧은 답": 1, "마침표로 끝남": 1, "이유 없는 거절": 1}
    assert sorted(k[2] for k in fake.sender_pats) == ["마침표로 끝남", "이유 없는 거절", "짧은 답"]
    assert fake.feedback_log[0]["pattern_count"] == 3


def test_unknown_trigger_or_feeling_not_stored(fake, registry, spy):
    (minsu, jieun, _), room, mid = group(fake)
    canned(spy, {"trigger": "민수가 안 된다고만 함", "feeling": "차갑게", "strength": 2},
           {"trigger": "짧은 답", "feeling": "짜증", "strength": 2},
           {"trigger": "마침표로 끝남", "feeling": "따뜻하게", "strength": 2})    # 부정 읽힘이 아님
    report(fake, registry, room, jieun, mid)
    assert fake.sender_pats == {} and fake.global_pats == {} and fake.pattern_reporters == set()
    assert [(f["usable"], f["pattern_count"]) for f in fake.feedback_log] == [(False, 0)]
    assert "민수가 안 된다고만 함" not in repr(fake.__dict__)


def test_not_usable_result_logs_only(fake, registry, spy):
    (minsu, jieun, _), room, mid = group(fake)
    spy.canned["feedback"] = lambda _p: {"usable": False, "patterns": [], "dropped_reason": f"{SECRET} 욕설"}
    report(fake, registry, room, jieun, mid)
    assert fake.sender_pats == {} and fake.global_pats == {}
    assert [(f["usable"], f["pattern_count"]) for f in fake.feedback_log] == [(False, 0)]
    assert SECRET not in repr(fake.__dict__)                            # dropped_reason도 남기지 않는다


def test_rereport_next_day_keeps_yesterdays_pattern(fake, registry):
    (minsu, jieun, haneul), room, mid = group(fake)
    report(fake, registry, room, jieun, mid, now=D)
    report(fake, registry, room, haneul, mid, now=D + timedelta(days=1))
    read = lambda now: asyncio.run(fake.sender_patterns(minsu, "팀원", now))["짧은 답"]["count"]  # noqa: E731
    assert read(D + timedelta(days=1)) == 1          # 어제 신고가 켠 패턴이 그대로 켜져 있다
    assert read(MIDNIGHT + timedelta(days=1)) == 2   # 오늘 신고는 내일 0시부터
    assert sorted(k[3] for k in fake.sender_pats) == [MIDNIGHT, MIDNIGHT + timedelta(days=1)]


def test_same_day_rereport_stacks_in_one_row(fake, registry):
    (minsu, jieun, haneul), room, mid = group(fake)
    report(fake, registry, room, jieun, mid, now=D)
    report(fake, registry, room, haneul, mid, now=D + timedelta(hours=13))   # 같은 KST 날 23:00
    [(key, row)] = fake.sender_pats.items()
    assert key == (minsu, "팀원", "짧은 답", MIDNIGHT) and row.count == 2


def test_caller_cannot_force_sender_pattern(fake):
    """run()을 거치지 않고 to_sender=True를 직접 넘겨도 1:1·2명 방이면 sender_patterns는 그대로다(fake 경로)."""
    minsu, jieun, haneul = (fake.add_user(n) for n in ("민수", "지은", "하늘"))
    direct = fake.add_room("direct", "친구", [minsu, jieun])
    pair_group = fake.add_room("group", "팀원", [minsu, haneul])
    pat = [FeedbackPattern(trigger="짧은 답", feeling="차갑게", strength=2)]
    for n, (room, reporter) in enumerate([(direct, jieun), (pair_group, haneul)], start=1):
        mid = fake.add_message(room, minsu, "ㅇㅇ")
        assert asyncio.run(fake.apply_feedback(FeedbackWrite(room, reporter, mid, True, pat, True, MIDNIGHT)))
        assert fake.sender_pats == {} and fake.global_pats == {"짧은 답": n}


def test_bad_pattern_error_has_no_value(world, caplog):
    async def body(repo, seed):
        minsu, jieun, haneul = [await w(seed.add_user(n)) for n in ("민수", "지은", "하늘")]
        room = await w(seed.add_room("group", "팀원", [minsu, jieun, haneul]))
        mid = await w(seed.add_message(room, minsu, "ㅇㅇ"))
        before = [await w(seed.rows(t)) for t in TABLES]
        for bad in (FeedbackPattern.model_construct(trigger=SECRET, feeling="차갑게", strength=1),
                    FeedbackPattern.model_construct(trigger="짧은 답", feeling=SECRET, strength=1)):
            with pytest.raises(ValueError) as exc:
                await repo.apply_feedback(FeedbackWrite(room, jieun, mid, True, [bad], True, MIDNIGHT))
            assert SECRET not in str(exc.value) and SECRET not in repr(exc.value)
            assert exc.value.__context__ is None and exc.value.__cause__ is None
        assert [await w(seed.rows(t)) for t in TABLES] == before
    with caplog.at_level(logging.DEBUG):
        world(body)
    assert SECRET not in caplog.text


def test_known_triggers_all_storable():
    """gate의 신호 이름 7개가 모두 TRIGGERS에 있다(어휘가 gate와 어긋나지 않음)."""
    src = ast.parse(inspect.getsource(gate.score))
    names = {c.value for call in ast.walk(src) if isinstance(call, ast.Call)
             and ast.unparse(call.func) == "signals.append"
             for c in ast.walk(call.args[0]) if isinstance(c, ast.Constant) and isinstance(c.value, str)}
    assert len(names) == 7 and names <= TRIGGERS


def test_kst_boundaries():
    utc = timezone.utc
    assert job.next_midnight_kst(datetime(2026, 10, 27, 14, 59, tzinfo=utc)) == datetime(2026, 10, 28, tzinfo=KST)
    assert job.next_midnight_kst(datetime(2026, 10, 27, 15, 1, tzinfo=utc)) == datetime(2026, 10, 29, tzinfo=KST)
    assert week_start(datetime(2027, 1, 1, 1, 0, tzinfo=KST)) == date(2026, 12, 28)


# ── 원문 미저장 ───────────────────────────────────────

def test_complaint_never_stored_or_logged(client, login, fake, queue, caplog, spy, registry):
    (minsu, jieun, _), room, mid = group(fake)
    complaint = f"민수가 {SECRET} 너무 단답이야"
    login(jieun)
    with caplog.at_level(logging.DEBUG):
        assert post(client, room, mid, complaint).status_code == 202
        assert SECRET not in repr(queue.jobs)            # 큐 인자는 id와 분류 결과뿐(원문 없음)
        asyncio.run(queue.run_all())
    assert fake.global_pats == {"짧은 답": 1}             # 실제로 반영됐다(빈 검사가 아니다)
    assert SECRET not in repr(fake.__dict__)
    assert SECRET not in caplog.text
    assert SECRET not in str(list(registry.router.traces))
    assert SECRET in spy.seen() and "민수" not in spy.seen()   # 모델에는 가린 하소연만 간다


def test_complaint_never_persisted_pg(pg_dsn, registry):
    async def go():
        repo = await PgRepo.connect(pg_dsn)
        conn = await asyncpg.connect(pg_dsn)
        try:
            seed = PgSeeder(conn)
            minsu, jieun, haneul = [await seed.add_user(n) for n in ("민수", "지은", "하늘")]
            room = await seed.add_room("group", "팀원", [minsu, jieun, haneul])
            mid = await seed.add_message(room, minsu, "ㅇㅇ")
            msg = await repo.message(mid)
            pats = await job.classify(repo, registry, msg, f"민수가 {SECRET} 너무 단답이야")
            await job.run(repo, room, jieun, mid, pats, D)
            assert len(await seed.rows("tone.sender_patterns")) == 1
            tables = await conn.fetch(
                """select table_schema, table_name from information_schema.tables
                   where table_schema in ('public', 'tone', 'auth') and table_type = 'BASE TABLE'""")
            assert len(tables) > 10
            hits = []
            for t in tables:
                ident = '"{}"."{}"'.format(t["table_schema"], t["table_name"])   # 이름은 카탈로그에서 온 것만
                if await conn.fetchval(f"select count(*) from {ident} r where r::text like $1", f"%{SECRET}%"):
                    hits.append(ident)
            assert hits == []
        finally:
            await conn.close()
            await repo.close()
    asyncio.run(go())
