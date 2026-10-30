"""T-38: /v1/* 사용자별 분당 요청 한도(429). 인증 → 한도 → 방 멤버/DB 순서."""
import uuid

import pytest
from fastapi.routing import APIRoute

from app.main import app, load_config
from app.ratelimit import RateLimiter, get_limiter

ROOM = str(uuid.uuid4())
HINT = ("/v1/hint", {"room_id": ROOM, "text": "ㅇㅇ", "seq": 0})
DETAIL = ("/v1/detail", {"room_id": ROOM, "text": "ㅇㅇ"})
LIMITS = load_config()["limits"]


class Clock:
    now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(client):
    c = Clock()
    limiter = RateLimiter(c)
    app.dependency_overrides[get_limiter] = lambda: limiter
    return c


def hit(client, route):
    path, body = route
    return client.post(path, json=body)


def test_over_limit_is_429_with_retry_after(client, login, clock):
    login(uuid.uuid4())
    for _ in range(LIMITS["hint"]):
        assert hit(client, HINT).status_code != 429
    r = hit(client, HINT)
    assert r.status_code == 429
    assert r.json() == {"detail": "rate_limited"}
    assert int(r.headers["retry-after"]) >= 1


def test_other_user_unaffected(client, login, clock):
    login(uuid.uuid4())
    for _ in range(LIMITS["default"] + 1):
        r = hit(client, DETAIL)
    assert r.status_code == 429
    login(uuid.uuid4())
    assert hit(client, DETAIL).status_code != 429


def test_window_slides(client, login, clock):
    login(uuid.uuid4())
    for _ in range(LIMITS["default"] + 1):
        r = hit(client, DETAIL)
    assert r.status_code == 429
    clock.now += 59
    assert hit(client, DETAIL).status_code == 429
    clock.now += 2
    assert hit(client, DETAIL).status_code != 429


def test_kinds_counted_separately(client, login, clock):
    login(uuid.uuid4())
    for _ in range(LIMITS["default"] + 1):
        r = hit(client, DETAIL)
    assert r.status_code == 429
    assert hit(client, HINT).status_code != 429


def test_unauthenticated_requests_do_not_count(client, login, clock):
    for _ in range(LIMITS["default"] + 5):
        assert hit(client, DETAIL).status_code == 401
    login(uuid.uuid4())
    for _ in range(LIMITS["default"]):
        assert hit(client, DETAIL).status_code != 429


def _calls(dependant):
    for d in dependant.dependencies:
        yield d.call
        yield from _calls(d)


def _api_routes(routes):
    """app.routes는 include_router마다 래퍼 하나다(FastAPI 0.16x): 안으로 들어가 APIRoute를 모은다."""
    for r in routes:
        if isinstance(r, APIRoute):
            yield r
        elif hasattr(r, "original_router"):
            yield from _api_routes(r.original_router.routes)


def test_every_v1_route_is_limited_and_hooks_are_not():
    v1 = hooks = 0
    for route in _api_routes(app.routes):
        limited = any(hasattr(c, "rate_kind") for c in _calls(route.dependant))
        if route.path.startswith("/v1/"):
            v1 += 1
            assert limited, route.path
            assert 429 in route.responses, route.path
        else:
            hooks += route.path.startswith("/hooks/")
            assert not limited, route.path
    assert v1 >= 6 and hooks >= 1


def test_limits_come_from_models_yaml(client, login, clock, tmp_path, monkeypatch):
    cfg = tmp_path / "models.yaml"
    cfg.write_text("limits: {hint: 2, default: 1}\n", encoding="utf-8")
    monkeypatch.setenv("MODELS_PATH", str(cfg))
    load_config.cache_clear()
    try:
        login(uuid.uuid4())
        assert [hit(client, HINT).status_code != 429 for _ in range(3)] == [True, True, False]
    finally:
        load_config.cache_clear()


def test_cors_429_exposes_retry_after(client, login, clock):
    """웹 앱은 다른 출처라 expose_headers가 없으면 Retry-After를 읽지 못한다(T-15)."""
    from app.settings import Settings

    origin = Settings.from_env().cors_origins[0]
    login(uuid.uuid4())
    for _ in range(LIMITS["hint"]):
        client.post(HINT[0], json=HINT[1], headers={"Origin": origin})
    r = client.post(HINT[0], json=HINT[1], headers={"Origin": origin})
    assert r.status_code == 429
    assert "retry-after" in r.headers["access-control-expose-headers"].lower()
