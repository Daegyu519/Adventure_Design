import asyncio
import base64
import dataclasses
import hashlib
import hmac
import json
import logging
import time
import uuid

import jwt
import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import auth
from app.auth import AuthError, AuthUnavailable, TokenVerifier, current_user, ensure_member, get_verifier
from app.main import app
from app.settings import Settings
from tests.jwks import ISSUER, make_signer


class Fetcher:
    """호출 수를 세는 fetch_jwks."""

    def __init__(self, *signers, jwks=None):
        self.calls = 0
        self.jwks = jwks if jwks is not None else {"keys": [k for s in signers for k in s.jwks["keys"]]}

    async def __call__(self):
        self.calls += 1
        return self.jwks


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def verifier(fetch, **kw) -> TokenVerifier:
    return TokenVerifier(ISSUER, fetch, **kw)


def verify(v: TokenVerifier, token: str):
    return asyncio.run(v.verify(token))


def b64(obj) -> str:
    raw = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def claims(sub, **kw):
    return {"sub": str(sub), "aud": "authenticated", "iss": ISSUER, "role": "authenticated",
            "exp": int(time.time() + 3600)} | kw


def test_valid_es256_token():
    s, uid = make_signer(), uuid.uuid4()
    assert verify(verifier(Fetcher(s)), s.token(uid)) == uid


def test_expired_token_rejected():
    s = make_signer()
    with pytest.raises(AuthError):
        verify(verifier(Fetcher(s)), s.token(uuid.uuid4(), exp_in=-60))


def test_forged_signature_rejected():
    real, evil = make_signer("k1"), make_signer("k1")  # 같은 kid, 다른 키
    with pytest.raises(AuthError):
        verify(verifier(Fetcher(real)), evil.token(uuid.uuid4()))


def test_wrong_audience_or_issuer_rejected():
    s = make_signer()
    v = verifier(Fetcher(s))
    with pytest.raises(AuthError):
        verify(v, s.token(uuid.uuid4(), aud="anon"))
    with pytest.raises(AuthError):
        verify(v, s.token(uuid.uuid4(), iss="https://evil.supabase.co/auth/v1"))


def test_hs256_and_none_rejected():
    s, uid = make_signer(), uuid.uuid4()
    v = verifier(Fetcher(s))
    # 알고리즘 혼동 공격: 공개키 PEM을 HMAC 비밀로 쓴 HS256 토큰(PyJWT는 만들어 주지 않아 직접 조립한다)
    head = b64({"alg": "HS256", "typ": "JWT", "kid": s.kid})
    body = b64(claims(uid))
    sig = b64(hmac.new(s.public_pem, f"{head}.{body}".encode(), hashlib.sha256).digest())
    with pytest.raises(AuthError):
        verify(v, f"{head}.{body}.{sig}")
    # alg none
    with pytest.raises(AuthError):
        verify(v, f"{b64({'alg': 'none', 'typ': 'JWT', 'kid': s.kid})}.{body}.")
    with pytest.raises(AuthError):
        verify(v, f"{b64({'alg': 'None', 'typ': 'JWT', 'kid': s.kid})}.{body}.")


def test_jwks_cached_and_refetched_on_new_kid():
    k1, k2 = make_signer("k1"), make_signer("k2")
    clock = Clock()
    fetch = Fetcher(k1)
    v = verifier(fetch, clock=clock)
    verify(v, k1.token(uuid.uuid4()))
    verify(v, k1.token(uuid.uuid4()))
    assert fetch.calls == 1
    # 키가 돌았다: 60초가 지난 뒤 새 kid가 오면 한 번 다시 받는다
    fetch.jwks = {"keys": k1.jwks["keys"] + k2.jwks["keys"]}
    clock.now += 61
    uid = uuid.uuid4()
    assert verify(v, k2.token(uid)) == uid
    assert fetch.calls == 2
    # 60초 안에 모르는 kid를 반복해도 더 받지 않는다
    ghost = make_signer("ghost")
    for _ in range(3):
        with pytest.raises(AuthError):
            verify(v, ghost.token(uuid.uuid4()))
    assert fetch.calls == 2
    clock.now += 61
    with pytest.raises(AuthError):
        verify(v, ghost.token(uuid.uuid4()))
    assert fetch.calls == 3


def test_unknown_kid_within_gap_of_first_fetch_is_not_refetched():
    k1, ghost = make_signer("k1"), make_signer("ghost")
    clock, fetch = Clock(), Fetcher(k1)
    v = verifier(fetch, clock=clock)
    verify(v, k1.token(uuid.uuid4()))
    clock.now += 30
    with pytest.raises(AuthError):
        verify(v, ghost.token(uuid.uuid4()))
    assert fetch.calls == 1


def test_key_cache_expires_after_ttl():
    s, clock = make_signer(), Clock()
    fetch = Fetcher(s)
    v = verifier(fetch, clock=clock)
    verify(v, s.token(uuid.uuid4()))
    clock.now += 599
    verify(v, s.token(uuid.uuid4()))
    assert fetch.calls == 1
    clock.now += 2  # 600초를 넘기면 아는 kid여도 다시 받는다(폐기된 키를 오래 믿지 않는다)
    verify(v, s.token(uuid.uuid4()))
    assert fetch.calls == 2


def test_empty_jwks_rejects():
    s = make_signer()
    for jwks in ({"keys": []}, {}, {"keys": "nope"}, {"keys": [None, 3]}, None):
        v = verifier(Fetcher(jwks=jwks))
        with pytest.raises(AuthError):
            verify(v, s.token(uuid.uuid4()))


def test_fetch_failure_rejects_and_next_call_retries():
    s = make_signer()
    calls = []

    async def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise OSError("down")
        return s.jwks

    clock = Clock()
    v = verifier(flaky, clock=clock)
    uid = uuid.uuid4()
    with pytest.raises(AuthError):
        verify(v, s.token(uid))
    clock.now += 3.1  # 실패 뒤 3초(backoff)가 지나면 다음 요청이 다시 받는다
    assert verify(v, s.token(uid)) == uid
    assert len(calls) == 2


@pytest.mark.parametrize("bad", ["", "abc", "a.b.c", "a.b", "....", "Bearer x"])
def test_malformed_token_rejected(bad):
    s = make_signer()
    with pytest.raises(AuthError):
        verify(verifier(Fetcher(s)), bad)


def test_missing_kid_and_missing_claims_rejected():
    s, uid = make_signer(), uuid.uuid4()
    v = verifier(Fetcher(s))
    no_kid = jwt.encode(claims(uid), s.private_key, algorithm="ES256")
    with pytest.raises(AuthError):
        verify(v, no_kid)
    for missing in ("sub", "exp", "aud", "iss"):
        c = claims(uid)
        del c[missing]
        t = jwt.encode(c, s.private_key, algorithm="ES256", headers={"kid": s.kid})
        with pytest.raises(AuthError):
            verify(v, t)
    t = jwt.encode(claims("not-a-uuid"), s.private_key, algorithm="ES256", headers={"kid": s.kid})
    with pytest.raises(AuthError):
        verify(v, t)


def test_token_never_logged(caplog):
    s = make_signer()
    tok = s.token(uuid.uuid4(), exp_in=-60)
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(AuthError) as e:
            verify(verifier(Fetcher(s)), tok)
    assert tok not in caplog.text and tok not in str(e.value)
    assert tok.split(".")[1] not in caplog.text


def _me_app(v: TokenVerifier) -> TestClient:
    mini = FastAPI()

    @mini.get("/me")
    def me(uid: uuid.UUID = Depends(current_user)):
        return {"uid": str(uid)}

    mini.dependency_overrides[get_verifier] = lambda: v
    return TestClient(mini)


def test_current_user_dependency():
    s, uid = make_signer(), uuid.uuid4()
    c = _me_app(verifier(Fetcher(s)))
    r = c.get("/me")
    assert r.status_code == 401 and r.headers["www-authenticate"] == "Bearer"
    r = c.get("/me", headers={"Authorization": "Basic x"})
    assert r.status_code == 401 and r.headers["www-authenticate"] == "Bearer"
    r = c.get("/me", headers={"Authorization": "Bearer"})
    assert r.status_code == 401
    r = c.get("/me", headers={"Authorization": "Bearer garbage"})
    assert r.status_code == 401 and r.headers["www-authenticate"] == "Bearer"
    r = c.get("/me", headers={"Authorization": f"Bearer {s.token(uid, exp_in=-60)}"})
    assert r.status_code == 401
    r = c.get("/me", headers={"Authorization": f"Bearer {s.token(uid)}"})
    assert r.status_code == 200 and r.json() == {"uid": str(uid)}
    r = c.get("/me", headers={"Authorization": f"bearer {s.token(uid)}"})  # 스킴은 대소문자 무시
    assert r.status_code == 200


def test_401_body_does_not_echo_token():
    s = make_signer()
    tok = s.token(uuid.uuid4(), exp_in=-60)
    r = _me_app(verifier(Fetcher(s))).get("/me", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 401 and tok not in r.text


def test_ensure_member_403(fake):
    a, outsider = fake.add_user("a"), fake.add_user("o")
    room = fake.add_room("dm", "친구", [a])
    assert asyncio.run(ensure_member(fake, room, a)) is None
    with pytest.raises(HTTPException) as e:
        asyncio.run(ensure_member(fake, room, outsider))
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:  # 없는 방도 같은 403(방 존재 여부를 알려 주지 않는다)
        asyncio.run(ensure_member(fake, uuid.uuid4(), a))
    assert e.value.status_code == 403


def test_warm_prefetches_jwks():
    s = make_signer()
    fetch = Fetcher(s)
    v = verifier(fetch)
    asyncio.run(v.warm())
    assert fetch.calls == 1
    verify(v, s.token(uuid.uuid4()))
    verify(v, s.token(uuid.uuid4()))
    assert fetch.calls == 1


def test_warm_failure_is_swallowed_and_next_verify_refetches(caplog):
    s = make_signer()
    calls = []

    async def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise ConnectionError("boom https://x.supabase.co secret-detail")
        return s.jwks

    v = verifier(flaky)
    with caplog.at_level(logging.WARNING, logger="app.auth"):
        asyncio.run(v.warm())  # 예외 없이 끝난다
    assert "jwks warm failed: ConnectionError" in caplog.text
    assert "secret-detail" not in caplog.text  # 예외 종류만 남긴다
    uid = uuid.uuid4()
    assert verify(v, s.token(uid)) == uid
    assert len(calls) == 2


def test_lifespan_warms_jwks(monkeypatch):
    fetch = Fetcher(make_signer())
    monkeypatch.setattr("app.main.get_verifier", lambda: verifier(fetch))
    with TestClient(app):
        assert fetch.calls == 1


class _Resp:
    def raise_for_status(self):
        pass

    def json(self):
        return {"keys": []}


def test_jwks_fetch_timeout_is_one_second(monkeypatch):
    seen = {}

    class FakeClient:
        def __init__(self, *a, **kw):
            seen["timeout"] = kw.get("timeout")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, **kw):
            seen["url"] = url
            return _Resp()

    settings = dataclasses.replace(Settings.from_env(), supabase_url="https://test.supabase.co/")
    monkeypatch.setattr(auth, "get_settings", lambda: settings)
    monkeypatch.setattr(auth.httpx, "AsyncClient", FakeClient)
    get_verifier.cache_clear()
    try:
        v = get_verifier()
        assert v._issuer == "https://test.supabase.co/auth/v1"  # 끝 슬래시는 떼서 iss와 맞춘다
        asyncio.run(v._fetch())
    finally:
        get_verifier.cache_clear()
    assert seen["timeout"] == 1.0 == auth.JWKS_TIMEOUT_S
    assert seen["url"] == "https://test.supabase.co/auth/v1/.well-known/jwks.json"


def test_no_supabase_url_means_empty_jwks(monkeypatch):
    settings = dataclasses.replace(Settings.from_env(), supabase_url="")
    monkeypatch.setattr(auth, "get_settings", lambda: settings)
    get_verifier.cache_clear()
    try:
        assert asyncio.run(get_verifier()._fetch()) == {"keys": []}
    finally:
        get_verifier.cache_clear()


def test_login_fixture_overrides_current_user(login):
    uid = uuid.uuid4()
    login(uid)
    assert app.dependency_overrides[current_user]() == uid


# ── fix round 1 ────────────────────────────────────────

def failing_fetch(calls: list, *, slow: bool = True):
    async def fetch():
        calls.append(1)
        if slow:
            await asyncio.sleep(0.01)  # 대기열이 쌓이도록 한 번 양보한다
        raise OSError("jwks down")
    return fetch


def test_concurrent_verifies_share_one_failed_fetch():
    s, calls = make_signer(), []
    v = verifier(failing_fetch(calls))

    async def go():
        return await asyncio.gather(*(v.verify(s.token(uuid.uuid4())) for _ in range(10)),
                                    return_exceptions=True)

    results = asyncio.run(go())
    assert len(calls) == 1
    assert all(isinstance(r, AuthUnavailable) for r in results)


def test_fast_failures_do_not_refetch_within_backoff_then_retry_after():
    s, calls, clock = make_signer(), [], Clock()
    v = verifier(failing_fetch(calls, slow=False), clock=clock)
    for _ in range(10):  # 바로 실패하는 fetch: 요청마다 다시 받지 않는다
        with pytest.raises(AuthUnavailable):
            verify(v, s.token(uuid.uuid4()))
    assert len(calls) == 1
    clock.now += 2.9
    with pytest.raises(AuthUnavailable):
        verify(v, s.token(uuid.uuid4()))
    assert len(calls) == 1
    clock.now += 0.2  # 3초가 지났다
    with pytest.raises(AuthUnavailable):
        verify(v, s.token(uuid.uuid4()))
    assert len(calls) == 2


def test_concurrent_verifies_share_one_successful_fetch():
    s, calls = make_signer(), []

    async def slow_ok():
        calls.append(1)
        await asyncio.sleep(0.01)
        return s.jwks

    v = verifier(slow_ok)
    uid = uuid.uuid4()

    async def go():
        return await asyncio.gather(*(v.verify(s.token(uid)) for _ in range(10)))

    assert asyncio.run(go()) == [uid] * 10
    assert len(calls) == 1


def test_waiters_share_outcome_when_their_kid_is_not_in_the_fresh_set():
    k1, ghost, calls = make_signer("k1"), make_signer("ghost"), []

    async def slow_ok():
        calls.append(1)
        await asyncio.sleep(0.01)
        return k1.jwks

    v = verifier(slow_ok)

    async def go():
        return await asyncio.gather(*(v.verify(ghost.token(uuid.uuid4())) for _ in range(5)),
                                    return_exceptions=True)

    results = asyncio.run(go())
    assert len(calls) == 1
    assert all(type(r) is AuthError for r in results)  # 아는 kid가 아니라서 401(503 아님)


def test_empty_jwks_is_unavailable_and_does_not_lock_out_for_the_refetch_gap():
    s, clock = make_signer(), Clock()
    fetch = Fetcher(jwks={"keys": []})
    v = verifier(fetch, clock=clock)
    uid = uuid.uuid4()
    with pytest.raises(AuthUnavailable):
        verify(v, s.token(uid))
    fetch.jwks = s.jwks  # 키가 곧 올라왔다
    clock.now += 3.1  # 60초 간격이 아니라 3초 backoff만 기다리면 된다
    assert verify(v, s.token(uid)) == uid
    assert fetch.calls == 2


def test_empty_refresh_keeps_previously_cached_keys():
    s, clock = make_signer(), Clock()
    fetch = Fetcher(s)
    v = verifier(fetch, clock=clock)
    verify(v, s.token(uuid.uuid4()))
    fetch.jwks = {"keys": []}
    clock.now += 61
    with pytest.raises(AuthError):  # 모르는 kid → 다시 받았더니 빈 응답
        verify(v, make_signer("other").token(uuid.uuid4()))
    uid = uuid.uuid4()
    assert verify(v, s.token(uid)) == uid  # 아는 키는 TTL 안이라 계속 통한다
    assert fetch.calls == 2


def test_unavailable_is_an_auth_error_subclass():
    assert issubclass(AuthUnavailable, AuthError)


@pytest.mark.parametrize("role,anon", [
    ("anon", None), ("service_role", None), (None, None), ("authenticated", True), ("authenticated", "true")],
    ids=["anon", "service_role", "no-role", "anonymous-user", "anonymous-string"])
def test_non_user_tokens_rejected(role, anon):
    s = make_signer()
    with pytest.raises(AuthError) as e:
        verify(verifier(Fetcher(s)), s.token(uuid.uuid4(), role=role, is_anonymous=anon))
    assert not isinstance(e.value, AuthUnavailable)


def test_is_anonymous_false_is_accepted():
    s, uid = make_signer(), uuid.uuid4()
    assert verify(verifier(Fetcher(s)), s.token(uid, is_anonymous=False)) == uid


def test_current_user_503_on_outage_and_401_on_bad_token(caplog):
    s = make_signer()
    down = _me_app(verifier(failing_fetch([], slow=False)))
    tok = s.token(uuid.uuid4())
    with caplog.at_level(logging.WARNING, logger="app.auth"):
        r = down.get("/me", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 503 and r.json() == {"detail": "auth_unavailable"}
    assert "www-authenticate" not in r.headers
    warnings = [x for x in caplog.records if x.levelno == logging.WARNING]
    assert warnings and "OSError" in caplog.text
    assert tok not in caplog.text and "jwks down" not in caplog.text  # 토큰·예외 메시지는 남기지 않는다
    # 같은 장애 중에도 모양이 깨진 토큰은 키가 필요 없으니 401이다
    r = down.get("/me", headers={"Authorization": "Bearer garbage"})
    assert r.status_code == 401 and r.json() == {"detail": "unauthorized"}
    # JWKS가 멀쩡하면 만료·위조는 401
    up = _me_app(verifier(Fetcher(s)))
    for t in (s.token(uuid.uuid4(), exp_in=-60), make_signer("k1").token(uuid.uuid4())):
        r = up.get("/me", headers={"Authorization": f"Bearer {t}"})
        assert r.status_code == 401 and r.json() == {"detail": "unauthorized"}
        assert r.headers["www-authenticate"] == "Bearer"


def test_jwks_fetch_is_capped_as_a_whole(monkeypatch):
    """httpx timeout은 단계별이라 조금씩 흘려 주는 서버는 못 막는다: 전체를 asyncio.timeout으로 자른다."""
    class SlowDrip:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, **kw):
            for _ in range(200):  # 단계마다는 빠르지만 합치면 4초
                await asyncio.sleep(0.02)
            return _Resp()

    settings = dataclasses.replace(Settings.from_env(), supabase_url="https://test.supabase.co")
    monkeypatch.setattr(auth, "get_settings", lambda: settings)
    monkeypatch.setattr(auth.httpx, "AsyncClient", SlowDrip)
    monkeypatch.setattr(auth, "JWKS_TIMEOUT_S", 0.05)
    get_verifier.cache_clear()
    s = make_signer()
    try:
        v = get_verifier()
        t0 = time.monotonic()
        with pytest.raises(AuthUnavailable):
            verify(v, s.token(uuid.uuid4(), iss="https://test.supabase.co/auth/v1"))
        assert time.monotonic() - t0 < 1.0
    finally:
        get_verifier.cache_clear()


def test_waiters_share_a_failed_attempt_even_without_backoff_or_gap():
    """세대 카운터만으로도 한 번만 받는다(backoff·간격이 0이어도)."""
    s, calls = make_signer(), []
    v = verifier(failing_fetch(calls), failure_backoff_s=0, refetch_gap_s=0)

    async def go():
        return await asyncio.gather(*(v.verify(s.token(uuid.uuid4())) for _ in range(10)),
                                    return_exceptions=True)

    results = asyncio.run(go())
    assert len(calls) == 1
    # 백오프가 0이면 "최근 실패"가 없으니 대기자는 키를 못 찾은 것으로 답한다(401). 중요한 건 fetch가 1번이라는 것
    assert all(isinstance(r, AuthError) for r in results)
