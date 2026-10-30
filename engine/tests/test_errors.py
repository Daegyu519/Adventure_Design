"""E4: 오류 응답은 고정 코드만. 입력값을 되돌려 주지 않고, 예기치 못한 오류도 CORS 헤더를 단 503."""
import logging
import uuid

from fastapi.testclient import TestClient

from app.deps import get_repo
from app.main import app

SECRET_TEXT = "비밀문장-절대로-되돌려주면-안됨"


def test_validation_error_is_fixed_code_without_input_echo(client, login):
    login(uuid.uuid4())
    r = client.post("/v1/hint", json={"room_id": "not-a-uuid", "text": SECRET_TEXT, "seq": "x"})
    assert r.status_code == 422
    assert r.json() == {"detail": "invalid_request"}
    assert SECRET_TEXT not in r.text


def test_malformed_json_without_token_leaks_nothing(client):
    r = client.post("/v1/hint", content=('{"text": "' + SECRET_TEXT).encode(), headers={"content-type": "application/json"})
    assert r.status_code == 422 and r.json() == {"detail": "invalid_request"}
    assert SECRET_TEXT not in r.text


class _Boom:
    def __getattr__(self, name):
        async def fail(*a, **k):
            raise RuntimeError(SECRET_TEXT)
        return fail


def test_unhandled_error_is_503_with_cors_and_logs_type_only(client, login, caplog):
    login(uuid.uuid4())
    app.dependency_overrides[get_repo] = lambda: _Boom()
    origin = "http://localhost:8081"
    caplog.set_level(logging.WARNING)
    r = TestClient(app, raise_server_exceptions=False).get("/v1/stats/me", headers={"origin": origin})
    assert r.status_code == 503 and r.json() == {"detail": "engine_unavailable"}
    assert r.headers["access-control-allow-origin"] == origin
    assert "RuntimeError" in caplog.text and SECRET_TEXT not in caplog.text


def test_http_exceptions_still_pass_through(client):
    r = client.post("/hooks/message", json={}, headers={"x-hook-secret": "wrong"})
    assert r.status_code == 401 and r.json() == {"detail": "unauthorized"}
