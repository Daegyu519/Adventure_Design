"""거울 세션(T-35): /v1/mirror/today · /v1/mirror/answer, 엔진 서명 card_id, 상황 카드 20장.
spy 모델 이름은 mock_rules 함수 이름이다(tone, tone_alt, …)."""
import asyncio
import json
import logging
import re
from collections import Counter
from datetime import date, datetime, time, timedelta, timezone

import pytest

import mirror
from app.db import KST
from harness.schemas import READINGS
from layers.guard import guard

NOW = datetime.now(timezone.utc)
DAY_START = datetime.combine(NOW.astimezone(KST).date(), time.min, KST)   # 오늘 0시(KST)
BEFORE_TODAY = DAY_START - timedelta(seconds=1)   # 어제 답한 것: 오늘 카드에서 뺀다
TOPICS = {"일정 조율": "sched", "역할 요청": "role", "거절": "refuse", "마감 독촉": "due"}
OTHER_APPS = re.compile(r"카카오|카톡|인스타|디스코드|kakao|instagram|discord", re.I)
KINDS = ["roleplay", "receive", "predict"]
CARD_KEYS = {"card_id", "kind", "persona", "relation", "situation", "message"}
ANSWER_KEYS = {"readings", "inner_voice", "reveal", "options", "gap"}
CONTENT = mirror.load_content(mirror.CONTENT_PATH)


def _room(fake, relation="팀원"):
    me, you = fake.add_user("김지은"), fake.add_user("박민수")
    room = fake.add_room("group", relation, [me, you, fake.add_user("최수아")])
    return me, you, room


def _today(c) -> list[dict]:
    r = c.post("/v1/mirror/today")
    assert r.status_code == 200, r.text
    return r.json()["cards"]


def _by_kind(cards: list[dict]) -> dict[str, dict]:
    return {c["kind"]: c for c in cards}


def _answer(c, card_id: str, **kw):
    return c.post("/v1/mirror/answer", json={"card_id": card_id, **kw})


def _sign(user, kind="predict", ref="card:due-01", relation="팀원", persona="민지", d: date | None = None) -> str:
    d = d or datetime.now(KST).date()
    payload = {"u": str(user), "k": kind, "s": ref, "r": relation, "p": persona, "d": d.isoformat()}
    return mirror.sign(payload, mirror.get_mirror_key())


def _tone(neg: float) -> dict:
    return {"readings": {"차갑게": neg, "무난하게": round(1 - neg, 3)}, "cues": [], "has_reason": False,
            "confidence": 0.6}


def _floats(x) -> list[float]:
    if isinstance(x, float):
        return [x]
    if isinstance(x, dict):
        return [f for v in x.values() for f in _floats(v)]
    if isinstance(x, list):
        return [f for v in x for f in _floats(v)]
    return []


# ── 카드 파일 ──────────────────────────────────────────

def test_cards_yaml_valid():
    cards = CONTENT.cards
    assert len(cards) == 20 and Counter(c.topic for c in cards) == {t: 5 for t in TOPICS}
    assert len({c.id for c in cards}) == 20
    assert all(re.fullmatch(rf"{TOPICS[c.topic]}-0[1-5]", c.id) for c in cards)
    personas = {p["name"]: p["relation"] for p in CONTENT.personas}
    assert len(personas) >= 4 and set(personas.values()) == {"팀원", "선후배"}
    assert all(personas.get(c.persona) == c.relation for c in cards)   # 카드 인물·관계는 personas와 같다
    assert set(CONTENT.inner_voice) == set(READINGS)
    assert all(v.endswith("수도 있어요") for v in CONTENT.inner_voice.values())   # 문장 느낌만, 확정하지 않는다
    texts = [*CONTENT.inner_voice.values(), *personas,
             *(s for c in cards for s in (c.situation, c.message, c.sample_reply))]
    assert all(t.strip() for t in texts)
    for t in texts:
        assert guard(t) == t and not OTHER_APPS.search(t), t
    assert len({c.sample_reply for c in cards}) == 20   # 되돌려 받기·예측 대체 문장이 겹치지 않는다


def test_load_content_rejects_forbidden_copy(tmp_path):
    bad = tmp_path / "cards.yaml"
    bad.write_text(mirror.CONTENT_PATH.read_text(encoding="utf-8").replace("아직이요.", "반드시 할게요."),
                   encoding="utf-8")
    with pytest.raises(ValueError):
        mirror.load_content(bad)


# ── 서명 ──────────────────────────────────────────────

def test_sign_roundtrip_and_wrong_key():
    payload = {"u": "x", "k": "receive", "s": "msg:3", "r": "팀원", "p": "민지", "d": "2026-10-27"}
    cid = mirror.sign(payload, b"k1")
    assert mirror.unsign(cid, b"k1") == payload
    assert "민지" not in cid and "." in cid   # base64url 두 조각
    for bad in (lambda: mirror.unsign(cid, b"k2"), lambda: mirror.unsign("abc", b"k1"),
                lambda: mirror.unsign(cid + "x", b"k1"), lambda: mirror.unsign("." + cid, b"k1")):
        with pytest.raises(ValueError):
            bad()


# ── 오늘의 카드 ────────────────────────────────────────

def test_today_three_kinds_deterministic(client, login, fake):
    me, _, room = _room(fake)
    for t in ("내일 회의 몇 시예요?", "자료 올렸어요", "그건 제가 할게요"):
        fake.add_message(room, me, t)
    login(me)
    first = _today(client)
    assert [c["kind"] for c in first] == KINDS and all(set(c) == CARD_KEYS for c in first)
    assert _today(client) == first   # 같은 날 다시 부르면 같은 카드


def test_today_uses_own_messages(client, login, fake):
    me, you, room = _room(fake)
    mine = {"내일 회의 몇 시예요?", "자료 올렸어요", "그건 제가 할게요"}
    for t in mine:
        fake.add_message(room, me, t)
    fake.add_message(room, you, "남이 보낸 말")
    fake.add_message(room, me, "한 달 넘은 말", at=NOW - timedelta(days=40))
    fake.add_message(room, me, "가" * 501)   # 초안 상한(500자)을 넘는 문장은 카드로 쓰지 않는다
    login(me)
    k = _by_kind(_today(client))
    rec, pre = k["receive"], k["predict"]
    assert rec["message"] in mine and pre["message"] in mine and rec["message"] != pre["message"]
    first_teammate = next(p["name"] for p in CONTENT.personas if p["relation"] == "팀원")
    assert rec["relation"] == pre["relation"] == "팀원" and rec["persona"] == first_teammate
    assert rec["situation"] == f"{first_teammate}에게서 온 메시지" and pre["situation"] == "팀원에게 보낸다면"
    rp = next(c for c in CONTENT.cards if c.message == k["roleplay"]["message"])
    assert (k["roleplay"]["persona"], k["roleplay"]["relation"], k["roleplay"]["situation"]) == \
        (rp.persona, rp.relation, rp.situation)


def test_today_falls_back_to_cards(client, login, fake):
    me, _, _ = _room(fake)
    login(me)
    k = _by_kind(_today(client))
    samples = {c.sample_reply: c for c in CONTENT.cards}
    rec, pre = k["receive"], k["predict"]
    assert rec["message"] in samples and pre["message"] in samples and rec["message"] != pre["message"]
    card = samples[pre["message"]]
    assert (pre["persona"], pre["relation"]) == (card.persona, card.relation)
    word = {"팀원": "팀원", "선후배": "선후배"}[card.relation]
    assert pre["situation"] == f"{word}에게 보낸다면" and rec["situation"] == f"{rec['persona']}에게서 온 메시지"


def test_predict_situation_for_other_relation(client, login, fake):
    me, _, room = _room(fake, relation="기타")
    fake.add_message(room, me, "그날은 어려울 것 같아요")
    fake.add_message(room, me, "알겠어요")
    login(me)
    assert _by_kind(_today(client))["predict"]["situation"] == "상대에게 보낸다면"


def test_today_skips_used_refs(client, login, fake):
    me, _, room = _room(fake)
    a = fake.add_message(room, me, "첫 문장이에요")
    fake.add_message(room, me, "두 번째 문장이에요")
    keep = "due-03"
    for c in CONTENT.cards:
        if c.id != keep:
            fake.add_mirror_attempt(me, "roleplay", f"card:{c.id}", at=BEFORE_TODAY)
    fake.add_mirror_attempt(me, "receive", f"msg:{a}", at=BEFORE_TODAY)
    fake.add_mirror_attempt(me, "predict", f"msg:{a}", at=BEFORE_TODAY)
    login(me)
    k = _by_kind(_today(client))
    assert k["roleplay"]["message"] == next(c.message for c in CONTENT.cards if c.id == keep)
    assert k["receive"]["message"] == "두 번째 문장이에요"
    assert k["predict"]["message"] in {c.sample_reply for c in CONTENT.cards}   # a는 썼고 b는 receive가 가져갔다


def test_today_same_after_answering_today(client, login, fake):
    """오늘 답한 카드는 오늘 카드에서 빼지 않는다: 답한 뒤 다시 열어도 그날 세 장은 그대로다(하루 3장)."""
    me, _, room = _room(fake)
    fake.add_message(room, me, "첫 문장이에요")
    fake.add_message(room, me, "두 번째 문장이에요")
    login(me)
    first = _today(client)
    k = _by_kind(first)
    assert _answer(client, k["receive"]["card_id"], score=2).status_code == 200
    assert _answer(client, k["roleplay"]["card_id"], reply="네 알겠어요").status_code == 200
    assert _today(client) == first
    assert _answer(client, k["predict"]["card_id"], predicted=3).status_code == 200
    assert _today(client) == first and len(fake.mirror_attempts) == 3


def test_today_next_day_excludes_answered(client, login, fake):
    """다음 날(KST)에는 전날 답한 출처를 그 종류에서 뺀다."""
    me, _, room = _room(fake)
    fake.add_message(room, me, "첫 문장이에요")
    fake.add_message(room, me, "두 번째 문장이에요")
    login(me)
    k = _by_kind(_today(client))
    assert _answer(client, k["receive"]["card_id"], score=2).status_code == 200
    for a in fake.mirror_attempts:   # 하루가 지난 것처럼
        a["created_at"] -= timedelta(days=1)
    again = _by_kind(_today(client))
    assert again["receive"]["message"] != k["receive"]["message"]
    assert again["predict"]["message"] == k["receive"]["message"]   # 예측으로는 아직 쓰지 않은 문장


# ── 답하기: 거부 ───────────────────────────────────────

@pytest.mark.parametrize("tamper", ["payload", "sig", "drop_sig", "garbage", "wrong_key"])
def test_tampered_card_422(client, login, fake, tamper):
    me, _, _ = _room(fake)
    login(me)
    cid = _by_kind(_today(client))["predict"]["card_id"]
    body, sig = cid.split(".")
    flip = lambda s, i: s[:i] + ("A" if s[i] != "A" else "B") + s[i + 1:]  # noqa: E731
    forged = {"payload": f"{flip(body, 5)}.{sig}", "sig": f"{body}.{flip(sig, 3)}", "drop_sig": body,
              "garbage": "not-a-card", "wrong_key": mirror.sign(mirror.unsign(cid, mirror.get_mirror_key()), b"x")}
    r = _answer(client, forged[tamper], predicted=3)
    assert r.status_code == 422 and fake.mirror_attempts == []


def test_oversized_card_id_rejected_by_schema(client, login, fake):
    """서명 검사 전에 길이 상한(512자)이 막는다."""
    me, _, _ = _room(fake)
    login(me)
    r = _answer(client, "a" * 513, predicted=3)
    assert r.status_code == 422 and r.json()["detail"][0]["type"] == "string_too_long"


@pytest.mark.parametrize("path,body", [("/v1/mirror/today", None), ("/v1/mirror/answer", {"card_id": "x", "score": 3})])
def test_mirror_routes_require_token_401(client, fake, path, body):
    assert client.post(path, json=body).status_code == 401 and fake.mirror_attempts == []


def test_other_users_card_403(client, login, fake):
    me, you, _ = _room(fake)
    login(you)
    theirs = _by_kind(_today(client))["predict"]["card_id"]
    login(me)
    assert _answer(client, theirs, predicted=3).status_code == 403 and fake.mirror_attempts == []


def test_expired_card_422(client, login, fake):
    me, _, _ = _room(fake)
    login(me)
    today = datetime.now(KST).date()
    assert _answer(client, _sign(me, d=today - timedelta(days=3)), predicted=3).status_code == 422
    assert _answer(client, _sign(me, d=today + timedelta(days=1)), predicted=3).status_code == 422
    assert _answer(client, _sign(me, d=today - timedelta(days=1)), predicted=3).status_code == 200   # 어제 카드는 받는다


def test_signed_ref_to_unknown_card_422(client, login, fake):
    me, _, room = _room(fake)
    login(me)
    assert _answer(client, _sign(me, ref="card:nope-01"), predicted=3).status_code == 422
    mine = fake.add_message(room, me, "역할극 카드는 상황 카드만")   # 엔진은 역할극에 메시지를 쓰지 않는다
    assert _answer(client, _sign(me, kind="roleplay", ref=f"msg:{mine}"), reply="네").status_code == 422
    assert fake.mirror_attempts == []


def test_signed_ref_to_someone_elses_message_403(client, login, fake):
    """서명이 맞아도 문장은 DB에서 다시 읽고, 본인이 보낸 메시지가 아니면 거부한다."""
    me, you, room = _room(fake)
    theirs = fake.add_message(room, you, "남이 보낸 말")
    login(me)
    assert _answer(client, _sign(me, ref=f"msg:{theirs}"), predicted=3).status_code == 403
    assert _answer(client, _sign(me, ref="msg:999999"), predicted=3).status_code == 403
    assert fake.mirror_attempts == []


@pytest.mark.parametrize("kind,body", [
    ("predict", {}), ("predict", {"score": 3}), ("receive", {"predicted": 3}), ("roleplay", {"score": 3}),
    ("roleplay", {"reply": "   "}), ("predict", {"predicted": 6}), ("receive", {"score": 0}),
])
def test_kind_requires_its_field_422(client, login, fake, kind, body):
    me, _, _ = _room(fake)
    login(me)
    cid = _by_kind(_today(client))[kind]["card_id"]
    assert _answer(client, cid, **body).status_code == 422 and fake.mirror_attempts == []


# ── 답하기: 결과 ───────────────────────────────────────

def test_answer_roleplay(client, login, fake):
    me, _, _ = _room(fake)
    login(me)
    card = _by_kind(_today(client))["roleplay"]
    r = _answer(client, card["card_id"], reply="안 돼요.")
    assert r.status_code == 200
    b = r.json()
    assert set(b) == ANSWER_KEYS and set(b["readings"]) == set(READINGS)
    assert set(b["readings"].values()) <= {"자주", "가끔", "드물어요"}
    assert b["inner_voice"] in CONTENT.inner_voice.values()
    assert b["options"] is not None and len(b["options"]) <= 1 and b["gap"] is None and b["reveal"] is None
    assert all(set(o) == {"label", "text", "keep", "change"} for o in b["options"])
    ref = f"card:{next(c.id for c in CONTENT.cards if c.message == card['message'])}"
    assert [(a["kind"], a["card_ref"], a["panel_bin"], a["gap"]) for a in fake.mirror_attempts] == \
        [("roleplay", ref, None, None)]


def test_answer_predict_gap_and_record(client, login, fake, spy):
    me, _, room = _room(fake)
    mid = fake.add_message(room, me, "그건 어렵겠어요.")
    fake.add_mirror_attempt(me, "receive", f"msg:{mid}", at=BEFORE_TODAY)   # 되돌려 받기가 먼저 가져가지 않게
    login(me)
    spy.canned |= {"tone": lambda p: _tone(.7), "tone_alt": lambda p: _tone(.7)}   # 부정 0.7 → 4칸
    card = _by_kind(_today(client))["predict"]
    assert card["message"] == "그건 어렵겠어요."
    b = _answer(client, card["card_id"], predicted=1).json()
    assert set(b) == ANSWER_KEYS and b["gap"] == mirror.panel_bin(.7) - 1 == 3
    assert b["readings"]["차갑게"] == "자주" and b["reveal"] is None and b["inner_voice"] is None and b["options"] is None
    assert _floats(b) == [] and "panel" not in json.dumps(b)
    [row] = [a for a in fake.mirror_attempts if a["kind"] == "predict"]
    assert (row["kind"], row["card_ref"], row["predicted"], row["answer_score"], row["panel_bin"], row["gap"]) == \
        ("predict", f"msg:{mid}", 1, None, 4, 3)


def test_answer_receive_reveal(client, login, fake):
    me, _, room = _room(fake)
    today = datetime.now(KST).date()
    thursday = today - timedelta(days=today.weekday() + 7) + timedelta(days=3)
    fake.add_message(room, me, "내일까지는 힘들어요.", at=datetime.combine(thursday, datetime.min.time(), KST)
                     + timedelta(hours=12))
    login(me)
    card = _by_kind(_today(client))["receive"]
    assert card["message"] == "내일까지는 힘들어요."
    b = _answer(client, card["card_id"], score=2).json()
    assert b["reveal"] == "이건 지난주 목요일에 당신이 팀원에게 보낸 문장이에요"
    assert 0 <= b["gap"] <= 4 and fake.mirror_attempts[0]["answer_score"] == 2

    login(fake.add_user("이도현"))   # 보낸 문장이 없으면 카드 문장: 공개할 출처가 없다
    b = _answer(client, _by_kind(_today(client))["receive"]["card_id"], score=2).json()
    assert b["reveal"] is None and b["gap"] is not None


def test_answer_twice_records_once(client, login, fake):
    me, _, room = _room(fake)
    fake.add_message(room, me, "확인했어요")
    login(me)
    cid = _by_kind(_today(client))["predict"]["card_id"]
    first, again = _answer(client, cid, predicted=2), _answer(client, cid, predicted=5)
    assert first.status_code == again.status_code == 200
    assert len(fake.mirror_attempts) == 1 and fake.mirror_attempts[0]["predicted"] == 2


def test_roleplay_option_restores_phone(client, login, fake, spy):
    """역할극 답의 개인정보는 모델에 가린 채 가고, 고쳐 쓰기 후보에는 원래 값으로 돌아온다."""
    me, _, _ = _room(fake)
    login(me)
    # 원문은 차갑게 읽혀 고쳐 쓰기가 돌고, 후보는 덜 차갑게 다시 읽혀 통과한다
    soft = lambda p: _tone(.05 if "어려울 것 같아요" in p["draft"] else 1.0)  # noqa: E731
    spy.canned |= {"tone": soft, "tone_alt": soft}
    card = _by_kind(_today(client))["roleplay"]
    b = _answer(client, card["card_id"], reply="안 돼요. 010-1234-5678로 전화해").json()
    [opt] = b["options"]
    assert "010-1234-5678" in opt["text"] and "[전화번호" not in json.dumps(b, ensure_ascii=False)
    assert spy.calls and "010-1234" not in spy.seen()


def test_answer_deadline_503(client, login, fake, registry, monkeypatch):
    """paths.mirror.deadline_ms를 넘기면 503이고 기록하지 않는다."""
    me, _, room = _room(fake)
    fake.add_message(room, me, "확인했어요")
    login(me)
    cid = _by_kind(_today(client))["receive"]["card_id"]
    registry.cfg["paths"]["mirror"]["deadline_ms"] = 50

    async def slow(_mid):
        await asyncio.sleep(1)
    monkeypatch.setattr(fake, "message", slow)
    r = _answer(client, cid, score=3)
    assert r.status_code == 503 and r.json() == {"detail": "engine_unavailable"} and fake.mirror_attempts == []


def test_no_panel_result_503(client, login, fake, spy):
    me, _, _ = _room(fake)
    login(me)
    spy.canned |= {"tone": lambda p: "not json", "tone_alt": lambda p: "not json"}
    r = _answer(client, _by_kind(_today(client))["predict"]["card_id"], predicted=3)
    assert r.status_code == 503 and r.json() == {"detail": "engine_unavailable"} and fake.mirror_attempts == []


# ── 칸 · 날짜 ─────────────────────────────────────────

@pytest.mark.parametrize("neg,expected", [
    (0.0, 1), (0.19, 1), (0.2, 2), (0.4, 3), (0.6, 4), (0.2 + 0.2 + 0.2, 4), (0.79, 4), (0.8, 5), (1.0, 5)])
def test_panel_bin_edges(neg, expected):
    assert mirror.panel_bin(neg) == expected


@pytest.mark.parametrize("sent,today,expected", [
    ("2026-10-22", "2026-10-27", "지난주 목요일"),
    ("2026-10-27", "2026-10-27", "오늘"),
    ("2026-10-26", "2026-10-27", "어제"),
    ("2026-10-28", "2026-10-30", "이번 주 수요일"),
    ("2026-10-19", "2026-10-27", "지난주 월요일"),
    ("2026-10-18", "2026-10-27", "9일 전"),
    ("2026-10-13", "2026-10-27", "14일 전"),
])
def test_relative_day(sent, today, expected):
    assert mirror.relative_day(date.fromisoformat(sent), date.fromisoformat(today)) == expected


# ── 개인정보 · 공급자 ──────────────────────────────────

def test_mirror_never_gemini_and_masked(client, login, fake, spy, registry):
    me, _, room = _room(fake)   # 박민수가 같은 방 멤버
    mid = fake.add_message(room, me, "민수야 010-1234-5678로 연락줘")
    fake.add_mirror_attempt(me, "receive", f"msg:{mid}", at=BEFORE_TODAY)   # 그 문장이 예측 카드로 나오게
    login(me)
    card = _by_kind(_today(client))["predict"]
    assert card["message"] == "민수야 010-1234-5678로 연락줘"   # 본인에게는 원문 그대로 보인다
    n = len(registry.router.traces)
    assert _answer(client, card["card_id"], predicted=3).status_code == 200
    used = [t["model"] for t in list(registry.router.traces)[n:]]
    assert used and all(m.startswith("mock:") for m in used) and spy.calls
    assert "민수" not in spy.seen() and "010-1234" not in spy.seen()
    mirror_experts = [e["id"] for e in registry.cfg["experts"] if "mirror" in e["paths"]]
    assert mirror_experts and not any(m.startswith("gemini:") for e in mirror_experts
                                      for m in registry.router.chains[e])


# ── 서명 키 ───────────────────────────────────────────

@pytest.fixture
def fresh_key():
    mirror.get_mirror_key.cache_clear()
    yield
    mirror.get_mirror_key.cache_clear()


def test_mirror_key_rejects_short_secret(monkeypatch, fresh_key):
    monkeypatch.setenv("MIRROR_SECRET", "too-short-secret")
    with pytest.raises(ValueError) as e:
        mirror.get_mirror_key()
    assert "32" in str(e.value) and "too-short" not in str(e.value)   # 값은 메시지에 싣지 않는다
    monkeypatch.setenv("MIRROR_SECRET", "k" * 32)
    assert mirror.get_mirror_key() == b"k" * 32


def test_short_secret_fails_startup(monkeypatch, fresh_key):
    from fastapi.testclient import TestClient

    from app.main import app
    monkeypatch.setenv("MIRROR_SECRET", "short")
    with pytest.raises(ValueError):
        with TestClient(app):
            pass


@pytest.mark.parametrize("force_mock,warned", [("", True), ("1", False)])
def test_mirror_key_warns_once_when_unset(monkeypatch, caplog, fresh_key, force_mock, warned):
    monkeypatch.delenv("MIRROR_SECRET", raising=False)
    monkeypatch.setenv("FORCE_MOCK", force_mock)
    with caplog.at_level(logging.WARNING, logger="mirror"):
        assert len(mirror.get_mirror_key()) == 32 and mirror.get_mirror_key() == mirror.get_mirror_key()
    assert len([r for r in caplog.records if "MIRROR_SECRET" in r.getMessage()]) == int(warned)
