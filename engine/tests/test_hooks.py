import dataclasses
import logging

import pytest

from app.deps import get_settings
from app.main import app

SECRET = {"X-Hook-Secret": "test-secret"}
ROOM = "6f1c2c9e-7a54-4a0e-9d57-0a3b1f7e2c11"
SENDER = "0b9d1a3e-52c7-4f6a-8c1e-9d2f4a6b8c10"


def _insert(table: str = "messages", **record) -> dict:
    rec = {"id": 42, "room_id": ROOM, "sender_id": SENDER, "text": "비밀문장",
           "created_at": "2026-10-27T09:00:00+00:00", **record}
    return {"type": "INSERT", "table": table, "schema": "public", "record": rec, "old_record": None}


def test_wrong_secret_401(client):
    # 본문이 깨져 있어도 401: 비밀값을 먼저 본다
    r = client.post("/hooks/message", content=b"not json", headers={"X-Hook-Secret": "wrong"})
    assert r.status_code == 401


def test_missing_header_401(client):
    assert client.post("/hooks/message", json=_insert()).status_code == 401


def test_non_ascii_secret_401_not_500(client):
    # hmac.compare_digest(str, str)는 비ASCII에서 TypeError → 500이 되면 안 된다
    r = client.post("/hooks/message", json=_insert(), headers={"X-Hook-Secret": "비밀".encode()})
    assert r.status_code == 401


def test_empty_configured_secret_rejects(client):
    base = app.dependency_overrides[get_settings]()
    app.dependency_overrides[get_settings] = lambda: dataclasses.replace(base, hook_secret="")
    assert client.post("/hooks/message", json=_insert(), headers={"X-Hook-Secret": ""}).status_code == 401


def test_insert_logged_without_text(client, caplog):
    caplog.set_level(logging.DEBUG)
    r = client.post("/hooks/message", json=_insert(), headers=SECRET)
    assert r.status_code == 202
    assert r.json() == {}
    assert "id=42" in caplog.text
    assert "비밀문장" not in caplog.text


def test_other_events_ignored(client, caplog):
    caplog.set_level(logging.DEBUG)
    r = client.post("/hooks/message", json=_insert(table="reactions"), headers=SECRET)
    assert r.status_code == 202
    assert "hook message" not in caplog.text


@pytest.mark.parametrize("patch", [{"type": "UPDATE"}, {"type": "DELETE"}, {"schema": "tone"}],
                         ids=["update", "delete", "other-schema"])
def test_non_insert_or_non_public_ignored(client, caplog, patch):
    caplog.set_level(logging.DEBUG)
    r = client.post("/hooks/message", json={**_insert(), **patch}, headers=SECRET)
    assert r.status_code == 202
    assert "hook message" not in caplog.text


def test_malformed_payload_422_does_not_echo_text(client):
    r = client.post("/hooks/message", json={"type": "INSERT"}, headers=SECRET)
    assert r.status_code == 422
    bad = client.post("/hooks/message", json=_insert(id="x"), headers=SECRET)
    assert bad.status_code == 422
    assert "비밀문장" not in bad.text


def test_hook_not_in_openapi():
    assert "/hooks/message" not in app.openapi()["paths"]
