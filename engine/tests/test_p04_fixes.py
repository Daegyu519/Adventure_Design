"""P-04 단계 1 끝 리뷰 반영(엔진): E5~E8, E10~E12. (E1·E3·E4는 test_limits/test_observability/test_errors)"""
import asyncio
import logging
import time

import httpx
import pytest
import yaml

from app.deps import get_registry
from app.main import app, lifespan
from app.settings import DEFAULT_MODELS_PATH, Settings, load_config
from jobs import feedback as job
from jobs import push
from jobs.queue import JobQueue
from tests.fakes import FakeRepo
from tests.test_feedback import COMPLAINT, SECRET, canned, group
from tests.test_push import SETTINGS, _chat, _expo, _run, _sub


# ── E5: 푸시 DB 읽기 제한 시간 ────────────────────────────

class _HangingRepo(FakeRepo):
    async def push_targets(self, *a):
        await asyncio.sleep(3600)


def test_push_db_reads_time_out_and_propagate(monkeypatch):
    monkeypatch.setattr(push, "DB_READ_DEADLINE_S", 0.05)
    repo = _HangingRepo()
    a, b = repo.add_user("민수"), repo.add_user("지수")
    mid = repo.add_message(repo.add_room("direct", "친구", [a, b]), a, "안녕")
    t0 = time.monotonic()
    with pytest.raises(TimeoutError):
        asyncio.run(push.send_push(repo, SETTINGS, mid))
    assert time.monotonic() - t0 < 1   # 큐가 재시도하게 올라간다


# ── E6: 트레이스 작업은 한 번만 ──────────────────────────

def test_trace_jobs_are_single_attempt(client, login, fake, queue):
    from tests.test_traces import HEAVY, _hint, _room
    me, _, room = _room(fake, HEAVY)
    login(me)
    _hint(client, room)
    assert queue.names() == ["trace"] and queue.max_attempts == [1]


# ── E7: 전문가·프롬프트가 틀리면 시작할 때 실패 ───────────

def test_bad_prompt_fails_at_startup(monkeypatch, tmp_path):
    cfg = yaml.safe_load(DEFAULT_MODELS_PATH.read_text(encoding="utf-8"))
    cfg["experts"][0]["prompt"] = "no_such_prompt"
    p = tmp_path / "models.yaml"
    p.write_text(yaml.safe_dump(cfg), encoding="utf-8")
    monkeypatch.setenv("MODELS_PATH", str(p))
    from app import deps
    deps.get_settings.cache_clear()
    deps.get_registry.cache_clear()
    load_config.cache_clear()
    try:
        with pytest.raises(ValueError, match="no_such_prompt"):
            asyncio.run(_enter_lifespan())
    finally:
        monkeypatch.delenv("MODELS_PATH")
        deps.get_settings.cache_clear()
        deps.get_registry.cache_clear()
        load_config.cache_clear()


async def _enter_lifespan():
    async with lifespan(app):
        pass


# ── E8: 거울 역할극은 본인 이름도 가린다 ─────────────────

def test_mirror_roleplay_masks_callers_own_name(client, login, fake, spy):
    from tests.test_mirror import _answer, _by_kind, _room, _today
    me, _, _ = _room(fake)   # 이름 "김지은"
    login(me)
    card = _by_kind(_today(client))["roleplay"]
    assert _answer(client, card["card_id"], reply="저는 김지은인데 안 돼요.").status_code == 200
    assert "김지은" not in spy.seen() and "[이름" in spy.seen()


# ── E10: 웹 푸시 대상이 있는데 VAPID가 없을 때 ───────────

def test_web_targets_without_vapid_warn_once_per_send(fake, caplog):
    _, _, b, mid = _chat(fake)
    fake.add_push_token(b, _sub("https://fcm.googleapis.com/fcm/send/1"), "web")
    caplog.set_level(logging.WARNING)
    _run(fake, mid, settings=Settings())
    assert "web push skipped: vapid not configured (1 targets)" in caplog.text


def test_lifespan_warns_when_hooks_but_no_vapid(monkeypatch, caplog):
    monkeypatch.setenv("HOOK_SECRET", "s")
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "")
    monkeypatch.setenv("SUPABASE_DB_URL", "")
    caplog.set_level(logging.WARNING)
    asyncio.run(_enter_lifespan())
    assert "vapid not configured" in caplog.text


# ── E11: 분류기가 없으면 신고를 소비하지 않는다 ──────────

def test_classifier_unavailable_does_not_consume_report(fake, registry, spy, caplog):
    (_, jieun, _), room, mid = group(fake)
    spy.canned["feedback"] = lambda _p: "not json"   # 모든 전문가가 실패 → None
    caplog.set_level(logging.WARNING)
    with pytest.raises(job.ClassificationUnavailable):
        asyncio.run(job.run(fake, registry, room, jieun, mid, COMPLAINT, "ㅇㅇ"))
    assert fake.feedback_log == []   # apply_feedback 행도 주간 상한 증가도 없다
    assert "feedback classification unavailable" in caplog.text and SECRET not in caplog.text
    assert not asyncio.run(fake.has_feedback(jieun, mid))


def test_classifier_unavailable_drop_log_via_queue(fake, registry, spy, caplog):
    (_, jieun, _), room, mid = group(fake)
    spy.canned["feedback"] = lambda _p: "not json"

    async def main():
        q = JobQueue(backoff_s=0.0)
        q.start()
        assert q.enqueue("feedback", job.run, fake, registry, room, jieun, mid, COMPLAINT, "ㅇㅇ",
                         key=f"feedback:{jieun}:{mid}", max_attempts=1)
        await q.join()
        await q.stop()

    caplog.set_level(logging.WARNING)
    asyncio.run(main())
    assert "dropped after 1 attempts: ClassificationUnavailable" in caplog.text
    assert f"feedback:{jieun}:{mid}" in caplog.text   # E12: 작업 키가 드롭 로그에 남는다
    assert fake.feedback_log == []


# ── E12: Expo 티켓 오류 코드 ─────────────────────────────

def test_expo_ticket_error_codes_logged(fake, caplog):
    _, _, b, mid = _chat(fake)
    fake.add_push_token(b, "ExponentPushToken[x]", "android")
    _, http = _expo(body={"data": [{"status": "error", "message": "비밀 토큰 ExponentPushToken[x]",
                                    "details": {"error": "MessageRateExceeded"}}]})
    caplog.set_level(logging.WARNING)
    _run(fake, mid, http=http)
    assert "expo push ticket error: MessageRateExceeded" in caplog.text
    assert "ExponentPushToken" not in caplog.text and "비밀" not in caplog.text


def test_expo_unknown_error_code_is_not_echoed(fake, caplog):
    _, _, b, mid = _chat(fake)
    fake.add_push_token(b, "ExponentPushToken[x]", "android")
    _, http = _expo(body={"data": [{"status": "error", "details": {"error": "내 토큰 abc"}}]})
    caplog.set_level(logging.WARNING)
    _run(fake, mid, http=http)
    assert "expo push ticket error: other" in caplog.text and "abc" not in caplog.text
