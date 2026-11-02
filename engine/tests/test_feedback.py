"""T-24 털어놓기: POST /v1/feedback → 가린 하소연을 메모리 큐에 → 202 → 작업이 L4 → sender_patterns·global_patterns.
하소연은 DB·로그·trace 어디에도 남지 않고, 큐에는 가린 문장만 메모리에 잠깐 있다(규칙 5). 1:1·2명 방도 sender·global 모두(규칙 14).
보낸 사람 패턴의 count는 서로 다른 신고자 수다(규칙 7)."""
import ast
import asyncio
import inspect
import logging
import time
from datetime import date, datetime, timedelta, timezone

import asyncpg
import pytest

from app.db import KST, FeedbackWrite, PgRepo, week_start
from harness.schemas import TRIGGERS, FeedbackPattern
from jobs import feedback as job
from jobs.queue import JobQueue, _Job
from layers import gate, guard
from tests.fakes import FakeQueue
from tests.pg import PgSeeder, w

COMPLAINT = "너무 단답이라 성의 없어 보였어"
SECRET = "보라색코끼리하소연"
D = datetime(2026, 10, 27, 10, 0, tzinfo=KST)          # 날짜 D 10:00 KST
PATTERN_TABLES = ("tone.sender_patterns", "tone.global_patterns", "tone.pattern_reporters",
                  "tone.sender_pattern_reporters")
TABLES = ("tone.feedback_log", *PATTERN_TABLES)


def group(fake, n=3, kind="group", relation="팀원"):
    """민수(보낸 사람)·지은·하늘 중 앞 n명. 민수의 메시지 "ㅇㅇ"."""
    users = [fake.add_user(name) for name in ("민수", "지은", "하늘")[:n]]
    room = fake.add_room(kind, relation, users)
    return users, room, fake.add_message(room, users[0], "ㅇㅇ")


def report(repo, reg, room, reporter, mid, text=COMPLAINT, now=D):
    """큐 작업을 직접 돈다(라우트가 가린 하소연·대상 메시지를 넘기는 자리)."""
    asyncio.run(job.run(repo, reg, room, reporter, mid, text, repo.messages[mid].text, now))


def feedback_calls(spy):
    return [c for c in spy.calls if c["model"] == "feedback"]


def canned(spy, *patterns):
    spy.canned["feedback"] = lambda _p: {"usable": True, "patterns": list(patterns), "dropped_reason": None}


def post(client, room, mid, text=COMPLAINT):
    return client.post("/v1/feedback", json={"room_id": str(room), "message_id": mid, "text": text})


# ── 라우트 ───────────────────────────────────────────

def test_feedback_202_ack(client, login, fake, queue, spy):
    (_, jieun, _), room, mid = group(fake)
    login(jieun)
    r = post(client, room, mid)
    assert r.status_code == 202 and r.json() == {"ack": guard.ACK}
    assert queue.names() == ["feedback"]
    assert spy.calls == [] and fake.feedback_log == []        # 202는 전문가가 돌기 전에 나간다
    asyncio.run(queue.run_all())
    assert len(feedback_calls(spy)) == 1
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


def test_same_report_twice_is_one_job(client, login, fake, queue):
    (_, jieun, _), room, mid = group(fake)
    login(jieun)
    first, second = post(client, room, mid), post(client, room, mid)
    assert (first.status_code, first.json()) == (second.status_code, second.json()) == (202, {"ack": guard.ACK})
    assert queue.names() == ["feedback"] and queue.keys == [f"feedback:{jieun}:{mid}"]
    assert queue.max_attempts == [1]          # 느린 모델에 재시도 폭주를 만들지 않는다


def test_already_reported_or_capped_acks_without_enqueue(client, login, fake, queue, registry, spy):
    """이미 남긴 신고, 또는 이번 주 상한에 걸린 (보낸 사람, 관계): 같은 202를 주고 큐에 넣지 않는다(어느 쪽인지 안 알림)."""
    (minsu, jieun, haneul), room, mid = group(fake)
    now = datetime.now(timezone.utc)                    # 라우트는 벽시계로 주간 상한을 본다: 신고도 같은 시계로
    report(fake, registry, room, jieun, mid, now=now)   # 키 기억 밖에서 이미 남긴 신고(예: 재시작 뒤)
    login(jieun)
    r = post(client, room, mid)
    assert (r.status_code, r.json()) == (202, {"ack": guard.ACK}) and queue.jobs == []
    for _ in range(job.WEEKLY_CAP - 1):
        report(fake, registry, room, haneul, fake.add_message(room, minsu, "ㅇㅇ"), now=now)
    calls = len(feedback_calls(spy))
    r = post(client, room, fake.add_message(room, minsu, "ㅇㅇ"))
    assert (r.status_code, r.json()) == (202, {"ack": guard.ACK}) and queue.jobs == []
    assert len(feedback_calls(spy)) == calls            # L4도 부르지 않는다
    other = fake.add_message(room, haneul, "ㅇㅇ")       # 다른 보낸 사람은 그대로 받는다
    assert post(client, room, other).status_code == 202 and queue.names() == ["feedback"]


def test_feedback_uses_its_own_queue(client, login, fake, queue):
    """털어놓기는 push·baseline이 쓰는 공유 큐가 아니라 자기 큐에 넣는다(몰아쳐도 공유 큐를 채우지 않게)."""
    from app.deps import get_queue
    from app.main import app
    shared = FakeQueue()
    app.dependency_overrides[get_queue] = lambda: shared
    (_, jieun, _), room, mid = group(fake)
    login(jieun)
    assert post(client, room, mid).status_code == 202
    assert queue.names() == ["feedback"] and shared.jobs == []


@pytest.mark.parametrize("failure", ["rejected", "failed"])
def test_enqueue_failure_still_acks(client, login, fake, queue, caplog, monkeypatch, failure):
    """큐가 받지 않아도(가득 참·종료 중) enqueue가 터져도 같은 202 {ack}다(어느 경로인지 응답으로 알 수 없다).
    로그에는 고정 문구와 예외 종류만: 하소연·예외 메시지·id는 남기지 않는다."""
    (_, jieun, _), room, mid = group(fake)
    if failure == "rejected":
        queue.accepting = False
    else:
        def boom(*_a, **_k):
            raise RuntimeError(f"{SECRET} {jieun}")
        monkeypatch.setattr(queue, "enqueue", boom)
    login(jieun)
    with caplog.at_level(logging.DEBUG):
        r = post(client, room, mid, f"{SECRET} 단답")
    assert (r.status_code, r.json()) == (202, {"ack": guard.ACK})
    assert fake.feedback_log == []
    expected = "feedback enqueue rejected" if failure == "rejected" else "feedback enqueue failed: RuntimeError"
    assert expected in caplog.text
    assert SECRET not in caplog.text and str(jieun) not in caplog.text and str(room) not in caplog.text


def test_job_failure_logs_type_only(fake, registry, monkeypatch, caplog):
    """실제 JobQueue로: 작업이 터져도 로그에는 작업 이름과 예외 종류만 남는다(하소연·예외 메시지 없음)."""
    (_, jieun, _), room, mid = group(fake)

    async def boom(*_a, **_k):
        raise RuntimeError(f"민수 {SECRET}")
    monkeypatch.setattr(fake, "room", boom)

    async def go():
        q = JobQueue(workers=1, max_attempts=1)
        q.start()
        assert q.enqueue("feedback", job.run, fake, registry, room, jieun, mid, f"{SECRET} 단답", "ㅇㅇ")
        await q.join()
        await q.stop()
    with caplog.at_level(logging.DEBUG):
        asyncio.run(go())
    assert "job feedback dropped after 1 attempts: RuntimeError" in caplog.text and SECRET not in caplog.text
    assert fake.feedback_log == []


def test_job_has_own_timeout(fake, registry, monkeypatch):
    """작업은 스스로 시간 제한을 둔다: DB가 멈춰도 공유 워커를 paths.async.deadline_ms보다 오래 붙들지 않는다."""
    (_, jieun, _), room, mid = group(fake)

    async def stuck(*_a, **_k):
        await asyncio.sleep(5)
    monkeypatch.setattr(fake, "room", stuck)
    monkeypatch.setattr(job, "DB_SLACK_S", 0.0)
    registry.cfg["paths"]["async"]["deadline_ms"] = 100
    start = time.monotonic()
    with pytest.raises(TimeoutError):
        asyncio.run(asyncio.wait_for(job.run(fake, registry, room, jieun, mid, COMPLAINT, "ㅇㅇ"), 2))
    assert time.monotonic() - start < 1.0          # 바깥 2초 보호막이 아니라 작업 자신의 제한에 걸렸다


def test_l4_failure_does_not_consume_report(fake, registry, spy):
    """모든 모델이 실패하면(스키마 검사 탈락) 기권: 패턴도 feedback_log도 남기지 않는다(P-04 E11: 신고를 소비하지 않음)."""
    (_, jieun, _), room, mid = group(fake)
    spy.canned["feedback"] = lambda _p: "not json"
    with pytest.raises(job.ClassificationUnavailable):
        report(fake, registry, room, jieun, mid)
    assert fake.sender_pats == {} and fake.global_pats == {} and fake.feedback_log == []


def test_identical_complaint_calls_expert_again(fake, registry, spy):
    """털어놓기는 라우터 캐시를 쓰지 않는다(하소연에서 나온 결과를 작업 뒤까지 메모리에 두지 않게)."""
    (_, jieun, haneul), room, mid = group(fake)
    report(fake, registry, room, jieun, mid)
    report(fake, registry, room, haneul, mid)
    assert len(feedback_calls(spy)) == 2
    assert registry.router.cache == {}


# ── 반영 규칙 ─────────────────────────────────────────

def test_group_feedback_to_sender_immediately(fake, registry):
    (minsu, jieun, _), room, mid = group(fake)
    report(fake, registry, room, jieun, mid)
    assert set(fake.sender_pats) == {(minsu, "팀원", "짧은 답", D)}
    assert not any(k[0] == jieun for k in fake.sender_pats)            # 신고자 키는 없다
    assert fake.global_pats == {"짧은 답": 1}
    assert asyncio.run(fake.sender_patterns(minsu, "팀원", D))["짧은 답"]["count"] == 1    # 남긴 직후부터
    assert asyncio.run(fake.sender_patterns(minsu, "팀원", D - timedelta(seconds=1))) == {}


def test_direct_feedback_reaches_sender_and_global(fake, registry):
    (minsu, jieun), room, mid = group(fake, 2, kind="direct", relation="친구")
    report(fake, registry, room, jieun, mid)
    assert set(fake.sender_pats) == {(minsu, "친구", "짧은 답", D)} and fake.global_pats == {"짧은 답": 1}


def test_two_member_group_reaches_sender_and_global(fake, registry):
    (minsu, jieun), room, mid = group(fake, 2)
    report(fake, registry, room, jieun, mid)
    assert set(fake.sender_pats) == {(minsu, "팀원", "짧은 답", D)} and fake.global_pats == {"짧은 답": 1}


def test_weekly_cap(fake, registry, spy):
    (minsu, jieun, haneul), room, _ = group(fake)
    mids = [fake.add_message(room, minsu, "ㅇㅇ") for _ in range(job.WEEKLY_CAP + 1)]
    for i, mid in enumerate(mids[:-1]):
        report(fake, registry, room, (jieun, haneul)[i % 2], mid)
    assert [f["usable"] for f in fake.feedback_log] == [True] * job.WEEKLY_CAP
    before = {t: fake.rows(t) for t in PATTERN_TABLES}
    calls = len(feedback_calls(spy))
    report(fake, registry, room, jieun, mids[-1])                      # 같은 보낸 사람·관계로 6번째
    last = fake.feedback_log[-1]
    assert (last["message_id"], last["usable"], last["pattern_count"]) == (mids[-1], False, 0)
    assert {t: fake.rows(t) for t in PATTERN_TABLES} == before
    assert len(feedback_calls(spy)) == calls                           # 상한이면 작업이 L4를 부르지 않는다


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
    assert [p.count for p in fake.sender_pats.values()] == [1]           # 보낸 사람 패턴도(규칙 7)


def test_sender_count_is_distinct_reporters(fake, registry):
    """한 사람이 다섯 번 털어놓아도 count 1(다음 날 다시 해도 그대로). 세 사람이면 3."""
    minsu, *others = (fake.add_user(n) for n in ("민수", "지은", "하늘", "소연"))
    room = fake.add_room("group", "팀원", [minsu, *others])
    for day in range(5):
        report(fake, registry, room, others[0], fake.add_message(room, minsu, "ㅇㅇ"), now=D + timedelta(days=day))
    read = lambda: asyncio.run(fake.sender_patterns(minsu, "팀원", D + timedelta(days=9)))["짧은 답"]["count"]  # noqa: E731
    assert read() == 1
    for who in others[1:]:
        report(fake, registry, room, who, fake.add_message(room, minsu, "ㅇㅇ"), now=D + timedelta(days=7))
    assert read() == 3


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


def test_valid_pattern_after_three_junk_is_kept(fake, registry, spy):
    """고정 어휘·부정 읽힘으로 먼저 거른 뒤 앞 3개를 고른다: 앞에 온 쓸모없는 태그 3개가 자리를 먹지 않는다."""
    (minsu, jieun, _), room, mid = group(fake)
    canned(spy, {"trigger": "민수가 안 된다고만 함", "feeling": "차갑게", "strength": 2},
           {"trigger": "마침표로 끝남", "feeling": "따뜻하게", "strength": 2},
           {"trigger": "그냥 싫음", "feeling": "화나게", "strength": 2},
           {"trigger": "짧은 답", "feeling": "성의없게", "strength": 2})
    report(fake, registry, room, jieun, mid)
    assert fake.global_pats == {"짧은 답": 1}
    assert [(f["usable"], f["pattern_count"]) for f in fake.feedback_log] == [(True, 1)]


def test_not_usable_result_logs_only(fake, registry, spy):
    (minsu, jieun, _), room, mid = group(fake)
    spy.canned["feedback"] = lambda _p: {"usable": False, "patterns": [], "dropped_reason": f"{SECRET} 욕설"}
    report(fake, registry, room, jieun, mid)
    assert fake.sender_pats == {} and fake.global_pats == {}
    assert [(f["usable"], f["pattern_count"]) for f in fake.feedback_log] == [(False, 0)]
    assert SECRET not in repr(fake.__dict__)                            # dropped_reason도 남기지 않는다


def test_rereport_keeps_active_pattern_and_adds(fake, registry):
    (minsu, jieun, haneul), room, mid = group(fake)
    report(fake, registry, room, jieun, mid, now=D)
    report(fake, registry, room, haneul, mid, now=D + timedelta(days=1))
    read = lambda now: asyncio.run(fake.sender_patterns(minsu, "팀원", now))["짧은 답"]["count"]  # noqa: E731
    assert read(D) == 1                              # 먼저 켜진 패턴이 그대로 켜져 있다
    assert read(D + timedelta(days=1)) == 2          # 재신고는 바로 더해진다(신고마다 자기 시각 행, 합으로 읽는다)
    assert sorted(k[3] for k in fake.sender_pats) == [D, D + timedelta(days=1)]


def test_same_instant_rereport_stacks_in_one_row(fake, registry):
    (minsu, jieun, haneul), room, mid = group(fake)
    report(fake, registry, room, jieun, mid, now=D)
    report(fake, registry, room, haneul, mid, now=D)   # 같은 시각이면 한 행에 쌓인다
    [(key, row)] = fake.sender_pats.items()
    assert key == (minsu, "팀원", "짧은 답", D) and row.count == 2


def test_every_room_kind_feeds_sender_pattern_direct_call(fake):
    """run()을 거치지 않고 apply_feedback을 직접 불러도 1:1·2명 방이 sender·global 모두에 들어간다(fake 경로)."""
    minsu, jieun, haneul = (fake.add_user(n) for n in ("민수", "지은", "하늘"))
    direct = fake.add_room("direct", "친구", [minsu, jieun])
    pair_group = fake.add_room("group", "팀원", [minsu, haneul])
    pat = [FeedbackPattern(trigger="짧은 답", feeling="차갑게", strength=2)]
    for n, (room, reporter) in enumerate([(direct, jieun), (pair_group, haneul)], start=1):
        mid = fake.add_message(room, minsu, "ㅇㅇ")
        assert asyncio.run(fake.apply_feedback(FeedbackWrite(room, reporter, mid, True, pat, D)))
        assert len(fake.sender_pats) == n and fake.global_pats == {"짧은 답": n}


def test_bad_pattern_error_has_no_value(world, caplog):
    async def body(repo, seed):
        minsu, jieun, haneul = [await w(seed.add_user(n)) for n in ("민수", "지은", "하늘")]
        room = await w(seed.add_room("group", "팀원", [minsu, jieun, haneul]))
        mid = await w(seed.add_message(room, minsu, "ㅇㅇ"))
        before = [await w(seed.rows(t)) for t in TABLES]
        for bad in (FeedbackPattern.model_construct(trigger=SECRET, feeling="차갑게", strength=1),
                    FeedbackPattern.model_construct(trigger="짧은 답", feeling=SECRET, strength=1)):
            with pytest.raises(ValueError) as exc:
                await repo.apply_feedback(FeedbackWrite(room, jieun, mid, True, [bad], D))
            assert SECRET not in str(exc.value) and SECRET not in repr(exc.value)
            assert exc.value.__context__ is None and exc.value.__cause__ is None
        assert [await w(seed.rows(t)) for t in TABLES] == before
    with caplog.at_level(logging.DEBUG):
        world(body)
    assert SECRET not in caplog.text


def test_known_triggers_all_storable():
    """gate의 신호 이름 10개가 모두 TRIGGERS에 있다(어휘가 gate와 어긋나지 않음)."""
    src = ast.parse(inspect.getsource(gate.score))
    names = {c.value for call in ast.walk(src) if isinstance(call, ast.Call)
             and ast.unparse(call.func) == "signals.append"
             for c in ast.walk(call.args[0]) if isinstance(c, ast.Constant) and isinstance(c.value, str)}
    assert len(names) == 10 and names <= TRIGGERS


def test_week_start_kst():
    assert week_start(datetime(2027, 1, 1, 1, 0, tzinfo=KST)) == date(2026, 12, 28)


# ── 원문 미저장 ───────────────────────────────────────

def test_complaint_never_stored_or_logged(client, login, fake, queue, caplog, spy, registry):
    (minsu, jieun, _), room, mid = group(fake)
    complaint = f"민수가 {SECRET} 너무 단답이야 010-1234-5678"
    login(jieun)
    with caplog.at_level(logging.DEBUG):
        assert post(client, room, mid, complaint).status_code == 202
        [(name, fn, args)] = queue.jobs
        masked, about = args[-2:]
        assert SECRET in masked and "민수" not in masked and "010-1234" not in masked   # 큐에는 가린 문장만
        assert about == "ㅇㅇ"                                                           # 대상 메시지(가린 것)
        assert SECRET not in repr(_Job(name, fn, args))   # 작업을 문자열로 찍어도 인자는 안 보인다
        asyncio.run(queue.run_all())
    assert fake.global_pats == {"짧은 답": 1}             # 실제로 반영됐다(빈 검사가 아니다)
    assert SECRET not in repr(fake.__dict__)
    assert SECRET not in caplog.text and masked not in caplog.text and complaint not in caplog.text
    assert SECRET not in str(list(registry.router.traces)) and registry.router.cache == {}
    seen = spy.seen()
    assert SECRET in seen and "민수" not in seen and "010-1234" not in seen and "5678" not in seen   # 가린 하소연만


def test_one_masker_for_complaint_and_message(client, login, fake, queue, spy):
    """하소연과 대상 메시지를 Masker 하나로 가린다: 한 L4 프롬프트 안에서 같은 사람은 같은 자리표시, 다른 사람은 다른
    자리표시다(규칙 16). Masker가 둘이면 하소연의 [이름1](민수)과 메시지의 [이름1](지은)이 다른 사람이 된다."""
    minsu, jieun, haneul = (fake.add_user(n) for n in ("민수", "지은", "하늘"))
    room = fake.add_room("group", "팀원", [minsu, jieun, haneul])
    mid = fake.add_message(room, minsu, "지은 ㅇㅇ")
    login(haneul)
    assert post(client, room, mid, "민수가 지은한테 너무 단답이야").status_code == 202
    asyncio.run(queue.run_all())
    [call] = feedback_calls(spy)
    assert call["payload"]["text"] == "[이름1]가 [이름2]한테 너무 단답이야"
    assert call["payload"]["about"] == call["payload"]["draft"] == "[이름2] ㅇㅇ"


def test_complaint_never_persisted_pg(pg_dsn, registry):
    async def go():
        repo = await PgRepo.connect(pg_dsn)
        conn = await asyncpg.connect(pg_dsn)
        try:
            seed = PgSeeder(conn)
            minsu, jieun, haneul = [await seed.add_user(n) for n in ("민수", "지은", "하늘")]
            room = await seed.add_room("group", "팀원", [minsu, jieun, haneul])
            mid = await seed.add_message(room, minsu, "ㅇㅇ")
            await job.run(repo, registry, room, jieun, mid, f"민수가 {SECRET} 너무 단답이야", "ㅇㅇ", D)
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
