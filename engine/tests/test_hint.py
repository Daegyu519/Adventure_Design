import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import pipeline
from app.auth import TokenVerifier, get_verifier
from app.context import load_context
from app.db import Repo
from app.main import app
from app.openapi_dump import merged
from tests.jwks import ISSUER, make_signer

SNAPSHOT = Path(__file__).resolve().parents[2] / "apps" / "mobile" / "lib" / "types" / "engine.openapi.json"
NOW = datetime.now(timezone.utc)
LIGHT = "내일 7시 맞지?"
HEAVY = "요즘 진짜 너무 힘들다... 취업도 안 되고 다 그만두고 싶어"


def _room(fake, them_says: str | None = None, me_name="김지은", you_name="박민수"):
    me, you = fake.add_user(me_name), fake.add_user(you_name)
    room = fake.add_room("direct", "친구", [me, you])
    if them_says:
        fake.add_message(room, you, them_says)
    return me, you, room


def _post(c, room, text, seq=7, headers=None, **kw):
    return c.post("/v1/hint", json={"room_id": str(room), "text": text, "seq": seq, **kw}, headers=headers or {})


def test_light_message_no_hint(client, login, fake):
    me, _, room = _room(fake, LIGHT)
    login(me)
    r = _post(client, room, "ㅇㅇ")
    assert r.status_code == 200
    body = r.json()
    assert body["hint"] is None and body["seq"] == 7
    assert uuid.UUID(body["trace_id"])


def test_heavy_context_hint(client, login, fake):
    me, _, room = _room(fake, HEAVY)
    login(me)
    start = time.monotonic()
    r = _post(client, room, "ㅇㅇ", seq=3)
    assert r.status_code == 200 and time.monotonic() - start < 1.5   # mock 전문가까지 다 돌아도 예산 안
    body = r.json()
    assert body["hint"]["title"] == "성의 없게 느껴질 수도 있어요"
    # 내부 점수(risk, 확률, signals …)는 응답에 없다
    assert set(body) == {"seq", "hint", "trace_id"} and set(body["hint"]) == {"title", "detail"}
    assert body["seq"] == 3


def test_reply_to_other_room_422(client, login, fake):
    me, you, room = _room(fake, HEAVY)
    other = fake.add_room("direct", "친구", [me, fake.add_user("최수아")])
    login(me)
    assert _post(client, room, "ㅇㅇ", reply_to=fake.add_message(other, me, "다른 방")).status_code == 422
    assert _post(client, room, "ㅇㅇ", reply_to=fake.add_message(room, you, "같은 방")).status_code == 200


def test_not_member_403(client, login, fake):
    _, _, room = _room(fake, HEAVY)
    login(fake.add_user("최수아"))
    r = _post(client, room, "ㅇㅇ")
    assert r.status_code == 403 and r.json() == {"detail": "not_a_member"}


def test_no_token_401(client, fake):
    _, _, room = _room(fake, HEAVY)
    assert _post(client, room, "ㅇㅇ").status_code == 401
    assert client.post("/v1/hint", json={}).status_code == 401   # 본문 검사보다 인증이 먼저


@pytest.mark.parametrize("text", ["", "   ", "가" * 501])
def test_text_validation_422(client, login, fake, text):
    me, _, room = _room(fake, HEAVY)
    login(me)
    assert _post(client, room, text).status_code == 422


@pytest.mark.parametrize("bad", [{"seq": -1}, {"reply_to": 0}, {"reply_to": 2**63}, {"room_id": "nope"}])
def test_other_fields_validated_422(client, login, fake, bad):
    me, _, room = _room(fake, HEAVY)
    login(me)
    body = {"room_id": str(room), "text": "ㅇㅇ", "seq": 1} | bad
    assert client.post("/v1/hint", json=body).status_code == 422


def test_budget_timeout_returns_null(client, login, fake, registry, monkeypatch):
    me, _, room = _room(fake, HEAVY)
    login(me)

    async def slow(*_a, **_k):
        await asyncio.sleep(2)
        return []
    monkeypatch.setattr(fake, "recent_messages", slow)
    registry.cfg["paths"]["realtime"]["deadline_ms"] = 300
    start = time.monotonic()
    r = _post(client, room, "ㅇㅇ")
    assert r.status_code == 200 and r.json()["hint"] is None
    assert time.monotonic() - start < 0.6


def test_unexpected_error_returns_null_and_logs_type_only(client, login, fake, monkeypatch, caplog):
    me, _, room = _room(fake, HEAVY)
    login(me)

    async def boom(*_a, **_k):
        raise RuntimeError("secret ㅇㅇ 박민수")
    monkeypatch.setattr(fake, "member_names", boom)
    with caplog.at_level(logging.WARNING):
        r = _post(client, room, "ㅇㅇ")
    assert r.status_code == 200 and r.json()["hint"] is None
    assert "hint failed: RuntimeError" in caplog.text and "secret" not in caplog.text


def test_no_raw_pii_reaches_experts(client, login, fake, spy):
    me, you, room = _room(fake, "요즘 힘들다 민수야 010-1234-5678로 연락줘", me_name="민수", you_name="이지은")
    # 답장 대상은 최근 8개 밖에 둔다: 이 문장은 reply_to 경로로만 전문가에게 간다
    target = fake.add_message(room, you, "요즘 너무 힘들어 민수야 지은이 번호 010-9876-5432로 연락해줘", at=NOW - timedelta(hours=1))
    for i in range(8):
        fake.add_message(room, you, "응", at=NOW - timedelta(minutes=50 - i))
    login(me)
    assert _post(client, room, "민수 ㅇㅇ", reply_to=target).status_code == 200
    assert len(spy.calls) >= 1
    seen = spy.seen()
    assert "민수" not in seen and "지은" not in seen
    assert "010-1234" not in seen and "010-9876" not in seen and "9876-5432" not in seen
    replies = [c["payload"]["reply_to"]["text"] for c in spy.calls if c["payload"].get("reply_to")]
    assert replies and all("[전화번호" in t and "[이름" in t for t in replies)   # 답장 대상이 가려진 채로 갔다


def test_group_room_prompts_name_the_room_and_speakers(client, login, fake, spy):
    a, b, c = fake.add_user("김지은"), fake.add_user("박민수"), fake.add_user("최수아")
    room = fake.add_room("group", "팀원", [a, b, c])
    fake.add_message(room, b, HEAVY)
    login(a)
    assert _post(client, room, "ㅇㅇ").status_code == 200
    by_model = {call["model"]: call for call in spy.calls}
    assert set(by_model) == {"context", "tone"}
    assert all(call["user"].startswith("방: 그룹방\n") for call in spy.calls)
    assert "[상대1] " in by_model["context"]["user"] and "[상대1]" in by_model["context"]["system"]


def test_sender_pattern_needs_global_min_obs(fake, registry):
    """보낸 사람 패턴이 있어도 전체 관찰 수가 global_min_obs(5) 미만이면 L0에서 반영되지 않는다."""
    me, _, room = _room(fake, LIGHT)
    fake.add_sender_pattern(me, "친구", "짧은 답", strength=3, active_from=NOW - timedelta(days=1))

    def run(global_obs: int) -> pipeline.RealtimeOutcome:
        fake.set_global("짧은 답", global_obs)
        ctx = asyncio.run(load_context(fake, room, me, None, NOW))
        return asyncio.run(pipeline.realtime(registry, "ㅇㅇ", ctx.convo, ctx.store, str(me), ctx.names,
                                             time.monotonic()))

    four = run(4)
    assert four.outcome == "gated" and four.verdict is None and four.results == []
    five = run(5)
    assert five.gate.passed and five.verdict.pattern_used
    assert five.outcome in {"abstain", "alert", "none"} and five.results


def test_realtime_outcomes(fake, registry):
    me, _, room = _room(fake, HEAVY)
    ctx = asyncio.run(load_context(fake, room, me, None, NOW))
    out = asyncio.run(pipeline.realtime(registry, "ㅇㅇ", ctx.convo, ctx.store, str(me), ctx.names, time.monotonic()))
    assert out.outcome == "alert" and out.hint.title == "성의 없게 느껴질 수도 있어요"
    assert {r.role for r in out.results} == {"context", "tone"}


def test_every_room_route_checks_membership_before_reading(client, login, fake, monkeypatch):
    """room_id를 받는 모든 /v1/* 라우트: 비멤버는 403이고, 멤버 확인 말고는 아무것도 읽지 않는다.
    새 라우트를 더하면 SAMPLES에 예시 본문을 더해야 이 테스트가 통과한다."""
    samples = {"/v1/hint": {"text": "ㅇㅇ", "seq": 0}}
    spec = app.openapi()

    def takes_room(op: dict) -> bool:
        if any(p.get("name") == "room_id" for p in op.get("parameters", [])):
            return True
        ref = op.get("requestBody", {}).get("content", {}).get("application/json", {}).get("schema", {}).get("$ref", "")
        return "room_id" in spec["components"]["schemas"].get(ref.rsplit("/", 1)[-1], {}).get("properties", {})

    routes = [(path, method) for path, ops in spec["paths"].items() if path.startswith("/v1/")
              for method, op in ops.items() if takes_room(op)]
    assert ("/v1/hint", "post") in routes

    _, _, room = _room(fake, HEAVY)
    login(fake.add_user("최수아"))
    touched: list[str] = []
    for name in (n for n in vars(Repo) if not n.startswith("_") and n != "is_member"):
        async def record(*_a, _name=name, **_k):
            touched.append(_name)
        monkeypatch.setattr(fake, name, record)

    for path, method in routes:
        assert path in samples, f"{path}: 예시 본문을 samples에 더한다"
        rid = str(room)
        r = client.request(method.upper(), path.replace("{room_id}", rid), params={"room_id": rid},
                           json={"room_id": rid, **samples[path]})
        assert r.status_code == 403, path
    assert touched == []


def test_auth_outage_is_503_and_bad_token_401(client, fake):
    """토큰 검증 오류는 hint=null로 삼키지 않고 그대로 올린다."""
    me, _, room = _room(fake, HEAVY)
    signer = make_signer()

    async def down():
        raise ConnectionError("jwks down")
    app.dependency_overrides[get_verifier] = lambda: TokenVerifier(ISSUER, down)
    r = _post(client, room, "ㅇㅇ", headers={"Authorization": f"Bearer {signer.token(me)}"})
    assert r.status_code == 503 and r.json() == {"detail": "auth_unavailable"}

    async def up():
        return signer.jwks
    app.dependency_overrides[get_verifier] = lambda: TokenVerifier(ISSUER, up)
    r = _post(client, room, "ㅇㅇ", headers={"Authorization": f"Bearer {signer.token(me, exp_in=-60)}"})
    assert r.status_code == 401


def test_first_hint_after_startup_has_no_jwks_fetch(client, fake, monkeypatch):
    monkeypatch.setenv("SUPABASE_DB_URL", "")
    signer = make_signer()
    calls: list[int] = []

    async def fetch():
        calls.append(1)
        return signer.jwks
    verifier = TokenVerifier(ISSUER, fetch)
    monkeypatch.setattr("app.main.get_verifier", lambda: verifier)
    app.dependency_overrides[get_verifier] = lambda: verifier
    me, _, room = _room(fake, LIGHT)
    with TestClient(app) as c:
        assert len(calls) == 1   # 시작할 때 받아 둔다
        r = _post(c, room, "ㅇㅇ", headers={"Authorization": f"Bearer {signer.token(me)}"})
        assert r.status_code == 200
        assert len(calls) == 1   # 첫 힌트는 받기를 기다리지 않는다


def test_openapi_snapshot_current():
    """앱 타입(engine.openapi.json)이 엔진과 같다. 엔진에 아직 없는 /v1 경로만 seed에서 남는다."""
    if not SNAPSHOT.exists():
        pytest.skip("앱 OpenAPI 스냅숏 없음")
    snap = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    assert snap == merged(json.loads(json.dumps(app.openapi())), snap)


def test_openapi_merge_keeps_only_unserved_seed_paths():
    ref = lambda name: {"$ref": f"#/components/schemas/{name}"}  # noqa: E731
    engine = {"openapi": "3.1.0", "info": {"title": "engine"},
              "paths": {"/v1/hint": {"post": ref("HintIn")}, "/health": {"get": {}}},
              "components": {"schemas": {"HintIn": {"engine": True}}}}
    detail = {"post": {**ref("DetailIn"), "security": [{"HTTPBearer": []}]}}
    seed = {"openapi": "3.1.0", "info": {"title": "seed"},
            "paths": {"/v1/hint": {"post": ref("OldHint"), "security": [{"Unused": []}]}, "/v1/detail": detail},
            "components": {"schemas": {"HintIn": {"engine": False}, "OldHint": {}, "Stale": {},
                                       "DetailIn": {"properties": {"intent": ref("Intent")}}, "Intent": {}},
                           "securitySchemes": {"HTTPBearer": {"type": "http"}, "Unused": {}}}}
    out = merged(engine, seed)
    assert out["info"] == {"title": "engine"}
    assert out["paths"] == {"/v1/hint": {"post": ref("HintIn")}, "/health": {"get": {}}, "/v1/detail": detail}
    assert out["components"]["securitySchemes"] == {"HTTPBearer": {"type": "http"}}   # 옮긴 경로가 쓰는 것만
    assert set(out["components"]["schemas"]) == {"HintIn", "DetailIn", "Intent"}   # 쓰이지 않는 seed 스키마는 버린다
    assert out["components"]["schemas"]["HintIn"] == {"engine": True}                 # 엔진 것이 이긴다
    assert merged(engine, {})["paths"] == engine["paths"]
