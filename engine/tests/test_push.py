"""T-28b 푸시 발송. 네트워크 없음: Expo는 httpx.MockTransport, 웹 푸시는 `jobs.push.webpush`를 바꿔 끼운다.
메시지 본문·토큰·endpoint는 큐 인자와 로그에 나오면 안 된다(CLAUDE.md 5, 보안)."""
import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import httpx
import pytest
import requests
from pywebpush import WebPushException

from app.db import Msg
from app.settings import Settings
from jobs import push
from jobs.push import build_notice, push_host_allowed, send_push

SETTINGS = Settings(expo_access_token="expo-secret", vapid_private_key="vapid-secret", vapid_subject="mailto:a@b.c")
HOOK = {"X-Hook-Secret": "test-secret"}
FCM = "https://fcm.googleapis.com/fcm/send/"


def _sub(endpoint: str) -> str:
    return json.dumps({"endpoint": endpoint, "keys": {"p256dh": "k", "auth": "a"}})


def _chat(fake, *, group=False, text="안녕하세요", image_path=None):
    """보낸 사람 a, 받는 사람 b. 방과 메시지 id를 돌려준다."""
    a, b = fake.add_user("민수"), fake.add_user("지수")
    room = fake.add_room("group" if group else "direct", "친구", [a, b], title="팀플방" if group else None)
    return room, a, b, fake.add_message(room, a, text, image_path=image_path)


def _expo(status=200, body=None, error=None):
    """(요청 목록, AsyncClient). 기본 응답은 요청 항목마다 ok."""
    calls: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        if error:
            raise error
        n = len(json.loads(req.content))
        return httpx.Response(status, json=body if body is not None else {"data": [{"status": "ok"}] * n})

    return calls, httpx.AsyncClient(transport=httpx.MockTransport(handler))


class FakeWebpush:
    """`outcomes[i]`가 예외면 i번째 호출에서 던진다. 모자라면 성공."""

    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.calls: list[dict] = []

    def __call__(self, **kw):
        self.calls.append(kw)
        out = self.outcomes[len(self.calls) - 1] if len(self.calls) <= len(self.outcomes) else None
        if isinstance(out, Exception):
            raise out
        return SimpleNamespace(status_code=201)


def _gone(code):
    return WebPushException("gone", response=SimpleNamespace(status_code=code))


def _run(fake, mid, settings=SETTINGS, http=None):
    asyncio.run(send_push(fake, settings, mid, http))


def _tokens(fake):
    return {(r["token"]) for r in fake.rows("public.push_tokens")}


# ── 웹훅 ───────────────────────────────────────────────

def test_webhook_enqueues_push(client, queue, fake):
    body = {"type": "INSERT", "table": "messages", "schema": "public",
            "record": {"id": 42, "room_id": "6f1c2c9e-7a54-4a0e-9d57-0a3b1f7e2c11",
                       "sender_id": "0b9d1a3e-52c7-4f6a-8c1e-9d2f4a6b8c10", "text": "비밀문장",
                       "created_at": "2026-10-27T09:00:00+00:00"}}
    assert client.post("/hooks/message", json=body, headers=HOOK).status_code == 202
    assert queue.names() == ["push", "baseline"]   # 기준선(T-26)도 같이 들어간다
    _, fn, args = queue.jobs[0]
    assert fn is send_push
    assert args[0] is fake and args[2] == 42  # 큐 인자에는 message_id만: 본문은 워커가 DB에서 읽는다
    assert "비밀문장" not in repr(args[2:])
    assert queue.keys == ["push:42", "baseline:42"]


def _hook(client, mid):
    body = {"type": "INSERT", "table": "messages", "schema": "public",
            "record": {"id": mid, "room_id": "6f1c2c9e-7a54-4a0e-9d57-0a3b1f7e2c11",
                       "sender_id": "0b9d1a3e-52c7-4f6a-8c1e-9d2f4a6b8c10", "created_at": "2026-10-27T09:00:00+00:00"}}
    return client.post("/hooks/message", json=body, headers=HOOK)


def test_same_message_id_webhook_twice_is_one_job(client, queue):
    assert _hook(client, 7).status_code == 202
    assert _hook(client, 7).status_code == 202
    assert queue.names().count("push") == 1
    assert _hook(client, 8).status_code == 202
    assert queue.names().count("push") == 2


def test_webhook_202_even_if_enqueue_rejected(client, queue, caplog):
    queue.accepting = False
    caplog.set_level(logging.DEBUG)
    assert _hook(client, 9).status_code == 202
    assert queue.names() == []
    assert "push enqueue rejected" in caplog.text


# ── 대상·본문 ──────────────────────────────────────────

def test_expo_request_shape(fake, monkeypatch):
    room, a, b, mid = _chat(fake)
    fake.add_push_token(b, "ExponentPushToken[and]", "android")
    fake.add_push_token(b, "ExponentPushToken[ios]", "ios")
    fake.add_push_token(b, _sub(FCM + "x"), "web")
    web = FakeWebpush()
    monkeypatch.setattr("jobs.push.webpush", web)
    calls, http = _expo()
    _run(fake, mid, http=http)
    assert len(calls) == 1
    req = calls[0]
    assert str(req.url) == "https://exp.host/--/api/v2/push/send"
    assert req.headers["authorization"] == "Bearer expo-secret"
    sent = json.loads(req.content)
    assert [m["to"] for m in sent] == ["ExponentPushToken[and]", "ExponentPushToken[ios]"]  # web 토큰은 Expo로 안 간다
    assert all({"to", "title", "body", "data"} == set(m) and m["data"] == {"url": f"/room/{room}"} for m in sent)
    assert sent[0]["title"] == "민수" and sent[0]["body"] == "안녕하세요"
    # 웹: data는 {title, body, url}, VAPID 설정과 만료·시간 제한
    assert len(web.calls) == 1
    w = web.calls[0]
    assert json.loads(w["data"]) == {"title": "민수", "body": "안녕하세요", "url": f"/room/{room}"}
    assert w["subscription_info"]["endpoint"] == FCM + "x"
    assert w["vapid_private_key"] == "vapid-secret" and w["vapid_claims"] == {"sub": "mailto:a@b.c"}
    assert w["ttl"] == 3600 and w["timeout"] == push.WEB_TIMEOUT_S
    assert w["requests_session"].max_redirects == 0  # 리다이렉트를 따라가지 않는다(아래 테스트)


def test_expo_without_access_token_sends_no_authorization(fake):
    _, _, b, mid = _chat(fake)
    fake.add_push_token(b, "ExponentPushToken[x]", "android")
    calls, http = _expo()
    _run(fake, mid, settings=Settings(), http=http)
    assert len(calls) == 1 and "authorization" not in calls[0].headers


def test_expo_batches_of_100(fake):
    _, _, b, mid = _chat(fake)
    for i in range(101):
        fake.add_push_token(b, f"ExponentPushToken[{i}]", "android")
    calls, http = _expo()
    _run(fake, mid, http=http)
    assert [len(json.loads(c.content)) for c in calls] == [100, 1]


def test_one_bad_subscription_does_not_block_others(fake, monkeypatch):
    _, _, b, mid = _chat(fake)
    t1, t2 = _sub(FCM + "1"), _sub(FCM + "2")
    fake.add_push_token(b, t1, "web")
    fake.add_push_token(b, t2, "web")
    web = FakeWebpush(WebPushException("응답 없음"))  # response=None
    monkeypatch.setattr("jobs.push.webpush", web)
    _run(fake, mid)
    assert len(web.calls) == 2
    assert _tokens(fake) == {t1, t2}


def test_send_failures_do_not_raise(fake):
    _, _, b, mid = _chat(fake)
    fake.add_push_token(b, "ExponentPushToken[x]", "android")
    _, http = _expo(status=500, body={"errors": [{"code": "INTERNAL"}]})
    _run(fake, mid, http=http)
    _, http = _expo(error=httpx.ConnectError("down"))
    _run(fake, mid, http=http)
    assert _tokens(fake) == {"ExponentPushToken[x]"}


def test_web_skipped_without_vapid(fake, monkeypatch):
    _, _, b, mid = _chat(fake)
    fake.add_push_token(b, _sub(FCM + "1"), "web")
    web = FakeWebpush()
    monkeypatch.setattr("jobs.push.webpush", web)
    _run(fake, mid, settings=Settings(vapid_subject="mailto:a@b.c"))
    _run(fake, mid, settings=Settings(vapid_private_key="k"))
    assert web.calls == []


def test_notice_texts(fake):
    room_id, a, _, _ = _chat(fake)
    d = asyncio.run(fake.room(room_id))
    g = asyncio.run(fake.room(fake.add_room("group", "팀원", [a], title="팀플방")))

    def msg(text, image=None):
        return asyncio.run(fake.message(fake.add_message(room_id, a, text, image_path=image)))

    assert build_notice(msg("hi"), d, "민수") == {"title": "민수", "body": "hi", "url": f"/room/{room_id}"}
    assert build_notice(msg("hi"), g, "민수")["title"] == "팀플방 · 민수"
    assert build_notice(msg("", "chat-images/x.jpg"), d, "민수")["body"] == "사진을 보냈어요"
    long = build_notice(msg("가" * 120), d, "민수")["body"]
    assert long == "가" * 100 + "…" and len(long) == 101
    assert build_notice(msg("가" * 100), d, "민수")["body"] == "가" * 100  # 딱 100자는 그대로


def test_muted_and_sender_get_nothing(fake):
    room, a, b, mid = _chat(fake)
    c = fake.add_user("하나")
    fake.members[room][c] = False
    fake.add_push_token(a, "ExponentPushToken[sender]", "android")
    fake.add_push_token(b, "ExponentPushToken[muted]", "android")
    fake.add_push_token(c, "ExponentPushToken[ok]", "android")
    fake.set_muted(room, b)
    calls, http = _expo()
    _run(fake, mid, http=http)
    assert [m["to"] for m in json.loads(calls[0].content)] == ["ExponentPushToken[ok]"]


def test_deleted_message_sends_nothing(fake):
    calls, http = _expo()
    _run(fake, 999, http=http)  # 그 사이 지워졌거나 없는 id
    assert calls == []


def test_db_read_failure_propagates_for_retry(fake):
    _, _, _, mid = _chat(fake)

    async def boom(*_a):
        raise ConnectionError("db down")

    fake.push_targets = boom
    with pytest.raises(ConnectionError):
        _run(fake, mid)


# ── SSRF 허용 목록 ─────────────────────────────────────

@pytest.mark.parametrize("url", [
    "https://fcm.googleapis.com/fcm/send/x",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://web.push.apple.com/x",
    "https://wns2-par02p.notify.windows.com/x",
    "https://FCM.googleapis.com:443/x",
])
def test_web_endpoint_allowlist_allows(url):
    assert push_host_allowed(url) is True


@pytest.mark.parametrize("url", [
    "http://fcm.googleapis.com/x",                  # https 아님
    "https://127.0.0.1/x", "https://localhost:8000/x", "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x",
    "https://fcm.googleapis.com.evil.example/x",    # 접미 위장
    "https://evilpush.apple.com/x",                 # 점 없는 접미
    "https://push.apple.com/x",
    "https://user@fcm.googleapis.com/x", "https://@fcm.googleapis.com/x",
    "https://evil.example\\@fcm.googleapis.com/x",  # 역슬래시 파서 차이
    "https://fcm.googleapis.com:8443/x", "https://fcm.googleapis.com:bad/x",
    "https://fcm.googleapis.com./x",
    "https://127.0.0.1\t.push.apple.com/x",         # urlparse는 탭을 지워 허용 호스트로 읽는다
    "https://fcm.googleapis.com\n.evil.example/x", " https://fcm.googleapis.com/x", "https://fcm.googleapis.com /x",
    "ftp://fcm.googleapis.com/x", "//fcm.googleapis.com/x", "not a url", "", "https:///x",
])
def test_web_endpoint_allowlist_rejects(url):
    assert push_host_allowed(url) is False


@pytest.mark.parametrize("bad", [_sub("https://169.254.169.254/x"), "{not json", json.dumps({"keys": {}}), json.dumps([1])],
                         ids=["internal-host", "not-json", "no-endpoint", "not-object"])
def test_disallowed_endpoint_not_sent(fake, monkeypatch, caplog, bad):
    _, _, b, mid = _chat(fake)
    t1 = bad
    # DB는 web 토큰이 https endpoint를 가진 JSON이게 강제하지만, 엔진은 그 검사를 믿지 않는다(FakeRepo는 시드를 안 막는다).
    t2 = _sub(FCM + "ok")
    fake.add_push_token(b, t1, "web")
    fake.add_push_token(b, t2, "web")
    web = FakeWebpush()
    monkeypatch.setattr("jobs.push.webpush", web)
    caplog.set_level(logging.DEBUG)
    _run(fake, mid)
    assert [c["subscription_info"]["endpoint"] for c in web.calls] == [FCM + "ok"]
    assert _tokens(fake) == {t1, t2}  # 허용 안 된 토큰도 지우지 않는다
    assert "push endpoint not allowed" in caplog.text
    assert "169.254" not in caplog.text


def test_web_push_session_does_not_follow_redirects():
    """허용 목록 호스트가 3xx로 내부 주소를 가리켜도 따라가지 않는다."""
    seen = []

    class Redirect(requests.adapters.BaseAdapter):
        def send(self, request, **_kw):
            seen.append(request.url)
            r = requests.Response()
            r.status_code, r.url, r.request, r._content = 302, request.url, request, b""
            r.headers["Location"] = "http://169.254.169.254/latest/meta-data"
            return r

        def close(self):
            pass

    session = push._web_session()
    session.mount("https://", Redirect())
    with pytest.raises(requests.TooManyRedirects):
        session.post(FCM + "x")
    assert seen == [FCM + "x"]


# ── 만료 토큰 삭제 ─────────────────────────────────────

def test_dead_web_subscription_deleted(fake, monkeypatch):
    _, _, b, mid = _chat(fake)
    t = [_sub(FCM + str(i)) for i in range(4)]
    for tok in t:
        fake.add_push_token(b, tok, "web")
    web = FakeWebpush(_gone(404), _gone(410), _gone(500))
    monkeypatch.setattr("jobs.push.webpush", web)
    _run(fake, mid)
    assert len(web.calls) == 4
    assert _tokens(fake) == {t[2], t[3]}  # 404·410만 지운다(500은 일시 장애, 같은 사람의 다른 토큰도 그대로)


def test_expo_device_not_registered_deleted(fake):
    _, _, b, mid = _chat(fake)
    fake.add_push_token(b, "ExponentPushToken[dead]", "android")
    fake.add_push_token(b, "ExponentPushToken[live]", "ios")
    body = {"data": [{"status": "error", "message": "x", "details": {"error": "DeviceNotRegistered"}},
                     {"status": "ok"}]}
    _, http = _expo(body=body)
    _run(fake, mid, http=http)
    assert _tokens(fake) == {"ExponentPushToken[live]"}


def test_other_expo_errors_keep_token(fake):
    _, _, b, mid = _chat(fake)
    fake.add_push_token(b, "ExponentPushToken[x]", "android")
    _, http = _expo(body={"data": [{"status": "error", "details": {"error": "MessageRateExceeded"}}]})
    _run(fake, mid, http=http)
    assert _tokens(fake) == {"ExponentPushToken[x]"}


def test_token_delete_failure_is_swallowed(fake, monkeypatch):
    _, _, b, mid = _chat(fake)
    fake.add_push_token(b, _sub(FCM + "1"), "web")
    fake.add_push_token(b, _sub(FCM + "2"), "web")
    web = FakeWebpush(_gone(410))
    monkeypatch.setattr("jobs.push.webpush", web)

    async def boom(*_a):
        raise ConnectionError("db down")

    fake.delete_push_token = boom
    _run(fake, mid)  # 재시도하면 알림이 겹치니 삼킨다
    assert len(web.calls) == 2


# ── 로그·시간 제한 ─────────────────────────────────────

def test_logs_leak_no_text_token_or_endpoint(fake, monkeypatch, caplog):
    _, _, b, mid = _chat(fake, text="비밀문장")
    secret_ep = FCM + "SECRETENDPOINT"
    fake.add_push_token(b, _sub(secret_ep), "web")
    fake.add_push_token(b, _sub("https://10.0.0.1/SECRETINTERNAL"), "web")
    fake.add_push_token(b, "ExponentPushToken[SECRETTOKEN]", "android")
    monkeypatch.setattr("jobs.push.webpush", FakeWebpush(RuntimeError(f"boom {secret_ep} 비밀문장")))
    caplog.set_level(logging.DEBUG)
    _, http = _expo(status=500, body={"errors": [{"message": "SECRETTOKEN 비밀문장"}]})
    _run(fake, mid, http=http)
    for s in ("비밀문장", "SECRETENDPOINT", "SECRETINTERNAL", "SECRETTOKEN", "expo-secret", "vapid-secret"):
        assert s not in caplog.text
    assert "RuntimeError" in caplog.text  # 예외는 타입 이름만


def test_slow_push_hits_overall_deadline(fake, monkeypatch, caplog):
    _, _, b, mid = _chat(fake)
    fake.add_push_token(b, _sub(FCM + "1"), "web")
    monkeypatch.setattr("jobs.push.webpush", lambda **_k: time.sleep(0.3))
    monkeypatch.setattr(push, "SEND_DEADLINE_S", 0.05)
    caplog.set_level(logging.WARNING)
    _run(fake, mid)  # 예외 없이 끝난다
    assert "push send deadline exceeded" in caplog.text


def test_settings_repr_hides_secrets():
    """Settings는 큐 인자라 repr가 로그·예외에 나올 수 있다: 비밀값은 찍히지 않는다."""
    secrets = ("SECRET-HOOK", "SECRET-SRK", "postgres://u:SECRET-PW@h/db", "SECRET-EXPO", "SECRET-VAPID")
    s = Settings(hook_secret=secrets[0], supabase_service_role_key=secrets[1], supabase_db_url=secrets[2],
                 expo_access_token=secrets[3], vapid_private_key=secrets[4], vapid_subject="mailto:a@b.c",
                 supabase_url="https://x.supabase.co")
    text = repr(s) + str(s)
    for v in secrets:
        assert v not in text
    assert "SECRET" not in text and "supabase.co" in text  # 비밀이 아닌 칸은 그대로 보인다


def test_settings_from_env(monkeypatch):
    monkeypatch.setenv("EXPO_ACCESS_TOKEN", "e")
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "p")
    monkeypatch.setenv("VAPID_SUBJECT", "mailto:x@y.z")
    s = Settings.from_env()
    assert (s.expo_access_token, s.vapid_private_key, s.vapid_subject) == ("e", "p", "mailto:x@y.z")
    assert not hasattr(s, "vapid_public_key")  # 공개키는 앱만 안다
    monkeypatch.delenv("EXPO_ACCESS_TOKEN")
    assert Settings.from_env().expo_access_token == ""
