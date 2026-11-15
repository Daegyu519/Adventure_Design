"""알림 단계(P-46): 거친 말의 강도 × 편한 사이 × 장난 맥락."""
import pipeline
from harness.schemas import GateResult, Hint, Verdict
from layers import level
from tests.test_hint import _post, _room

LAUGH = "야 나 방금 치킨 두 마리 혼자 다 먹음 ㅋㅋㅋ"
SERIOUS = "네가 저번에 한 말 솔직히 좀 상처였어"


def test_decide_table():
    d = level.decide
    # 알림이 아니면 없음
    assert d(False, 3, False, False, False) == "none"
    # 거친 말이 없거나 강이면 언제나 카드(편한 사이·장난이어도)
    for rough in (0, 3):
        for casual in (False, True):
            for banter in (False, True):
                assert d(True, rough, casual, banter, False) == "card"
    # 중: 보통은 카드, 편한 사이 + 장난이면 조용한 표시
    assert d(True, 2, False, True, False) == "card" and d(True, 2, True, False, False) == "card"
    assert d(True, 2, True, True, False) == "soft"
    # 약: 보통은 조용한 표시, 편한 사이 + 장난이면 없음
    assert d(True, 1, False, False, False) == "soft" and d(True, 1, True, False, False) == "soft"
    assert d(True, 1, True, True, False) == "none"
    # 받는 사람의 하소연이 반영된 알림은 낮추지 않는다
    assert d(True, 2, True, True, True) == "card" and d(True, 1, True, True, True) == "card"


def test_can_soften_only_when_marking_would_change_it():
    c = level.can_soften
    assert c(True, 2, False, True, False) and c(True, 1, False, True, False)
    assert not c(True, 2, False, False, False)   # 장난 맥락이 아니면 표시해도 그대로
    assert not c(True, 3, False, True, False) and not c(True, 0, False, True, False)
    assert not c(True, 2, True, True, False)     # 이미 표시함
    assert not c(True, 2, False, True, True) and not c(False, 2, False, True, False)


def test_playful_needs_laugh_and_no_heavy_talk():
    assert level.playful(LAUGH) and level.playful("오늘따라 나 좀 잘생긴 듯 ㅋㅋ")
    assert not level.playful(SERIOUS) and not level.playful("")
    assert not level.playful("미안 ㅋㅋ 늦을 것 같아") and not level.playful("나 요즘 너무 힘들어 ㅋㅋ")


def _outcome(lv, soften=False):
    v = Verdict(risk=0.8, top_reading="화나게", signals=["비속어"], disagreement=0.0, confidence=0.9, abstain=False, alert=True)
    hint = Hint(title="화난 것처럼 느껴질 수도 있어요", detail="거친 말이 섞이면 화난 것처럼 들리기도 해요") if lv != "none" else None
    return pipeline.RealtimeOutcome(GateResult(prior=0.5, signals=["비속어"], passed=True), v, hint, [],
                                    "alert" if hint else "none", None, lv, soften)


def test_hint_route_passes_casual_and_returns_level(client, login, fake, monkeypatch):
    me, _, room = _room(fake, LAUGH)
    login(me)
    seen = []

    async def fake_realtime(reg, draft, convo, store, user_id, names, t0, casual=False):
        seen.append(casual)
        return _outcome("soft" if casual else "card", soften=not casual)

    monkeypatch.setattr(pipeline, "realtime", fake_realtime)
    a = _post(client, room, "ㅅㅂ").json()["hint"]
    b = _post(client, room, "ㅅㅂ", casual=True).json()["hint"]
    assert seen == [False, True]
    assert a == {"title": "화난 것처럼 느껴질 수도 있어요", "detail": "거친 말이 섞이면 화난 것처럼 들리기도 해요", "level": "card", "can_soften": True}
    assert b["level"] == "soft" and b["can_soften"] is False
    # casual은 참·거짓만 받는다
    assert _post(client, room, "ㅅㅂ", casual="예").status_code == 422


def test_level_none_returns_no_hint(client, login, fake, monkeypatch):
    me, _, room = _room(fake, LAUGH)
    login(me)

    async def fake_realtime(*a, **k):
        return _outcome("none")

    monkeypatch.setattr(pipeline, "realtime", fake_realtime)
    assert _post(client, room, "ㅁㅊ네", casual=True).json()["hint"] is None


def test_realtime_lowers_only_rough_words(monkeypatch):
    # 집계 결과를 고정하고 단계만 본다: 같은 알림이라도 거친 말·사이·맥락에 따라 달라진다
    import asyncio
    import time

    from experts.registry import Registry
    from app.settings import DEFAULT_MODELS_PATH
    from harness.schemas import Conversation, Turn
    from harness.store import ProfileStore

    reg = Registry.load(DEFAULT_MODELS_PATH, True)
    alert = Verdict(risk=0.8, top_reading="화나게", signals=[], disagreement=0.0, confidence=0.9, abstain=False, alert=True)
    monkeypatch.setattr(pipeline, "aggregate", lambda *a, **k: alert)

    def run(draft, them, casual):
        c = Conversation(pair_id="p", relation="친구", turns=[Turn(speaker="them", text=them)])
        o = asyncio.run(pipeline.realtime(reg, draft, c, ProfileStore(), "me", [], time.monotonic(), casual))
        return o.level, o.hint is not None, o.outcome, o.can_soften

    assert run("ㅅㅂ", LAUGH, False) == ("card", True, "alert", True)
    assert run("ㅅㅂ", LAUGH, True) == ("soft", True, "alert", False)
    assert run("ㅅㅂ", SERIOUS, True) == ("card", True, "alert", False)       # 무거운 맥락이면 편한 사이여도 그대로
    assert run("씨발련아", LAUGH, True) == ("card", True, "alert", False)     # 강은 그대로
    assert run("ㅁㅊ네", LAUGH, True) == ("none", False, "none", False)       # 약 + 편한 사이 + 장난: 알림 없음
    assert run("ㅁㅊ네", SERIOUS, False) == ("soft", True, "alert", False)
    assert run("알아서 해", LAUGH, True) == ("card", True, "alert", False)    # 거친 말이 아니면 편한 사이와 무관
