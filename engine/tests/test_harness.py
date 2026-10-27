import asyncio
import time

import pytest
import yaml

from app.settings import DEFAULT_MODELS_PATH
from harness import pii
from harness.router import NoResult, Router, chains
from harness.schemas import ContextReading, Conversation, ToneReading, Turn
from harness.store import ProfileStore
from layers import aggregate, gate, guard


def test_pii_mask():
    assert pii.mask("010-1234-5678로 연락줘") == "[전화번호]로 연락줘"
    assert "[이메일]" in pii.mask("a.b@cnu.ac.kr 로 보내")


def test_guard_never_confirms_or_reveals_source():
    with pytest.raises(ValueError):
        guard.guard("상대가 말하길 차가웠대요")
    with pytest.raises(ValueError):
        guard.guard("확실히 차갑게 느껴져요")


def test_guard_error_does_not_echo_text():
    text = "민수 님이 말한 대로 확실히 차가워요"  # 복원된 실명이 들어 있을 수 있는 문장
    with pytest.raises(ValueError) as e:
        guard.guard(text)
    assert "민수" not in str(e.value) and text not in str(e.value) and "확실히" not in repr(e.value)


def test_gate_passes_short_reply_to_heavy_message_only():
    store = ProfileStore()
    light = Conversation(pair_id="p", turns=[Turn(speaker="them", text="내일 7시 맞지?")])
    heavy = Conversation(pair_id="p", turns=[Turn(speaker="them", text="요즘 너무 힘들다 다 그만두고 싶어")])
    assert not gate.score("ㅇㅇ", light, store, "me", 0.3, 5).passed
    assert gate.score("ㅇㅇ", heavy, store, "me", 0.3, 5).passed


def test_router_falls_back_to_mock():
    r = Router.from_file(DEFAULT_MODELS_PATH, force_mock=True)
    obj, model = asyncio.run(r.call("ctx_fast", "s", "u", {"turns": []}, ContextReading,
                                    time.monotonic() + 1))
    assert model.startswith("mock")


def test_router_gives_up_after_deadline():
    r = Router.from_file(DEFAULT_MODELS_PATH, force_mock=True)
    with pytest.raises(NoResult):
        asyncio.run(r.call("ctx_fast", "s", "u2", {"turns": []}, ContextReading, time.monotonic() - 1))


def test_single_report_alone_does_not_boost():
    cfg = Router.from_file(DEFAULT_MODELS_PATH, force_mock=True).config["aggregate"]
    pair = {"p": {"이유 없는 거절": {"count": 1, "strength": 3, "feeling": "차갑게"}}}
    c = Conversation(pair_id="p", turns=[Turn(speaker="them", text="이거 미뤄도 될까요?")])
    ctx = ContextReading(prev_act="부탁", expectation_points=["이유 설명"], confidence=0.8)
    tones = [(ToneReading(readings={"차갑게": 0.5, "무난하게": 0.5}, confidence=0.8), 1.0)]

    def verdict(store):
        g = gate.score("안 돼요.", c, store, "me", 0.3, global_min_obs=cfg["global_min_obs"])
        return aggregate.aggregate("안 돼요.", g, ctx, tones, store, c, cfg)

    # 한 사람의 피드백뿐이면 관계 패턴은 반영되지 않는다
    assert not verdict(ProfileStore(pair_patterns=pair, global_patterns={"이유 없는 거절": 1})).pattern_used
    # 일반 패턴이 충분히 쌓이면 반영된다
    assert verdict(ProfileStore(pair_patterns=pair, global_patterns={"이유 없는 거절": 10})).pattern_used


def test_no_gemini_on_real_text_roles():
    cfg = yaml.safe_load(DEFAULT_MODELS_PATH.read_text(encoding="utf-8"))
    for expert_id, chain in chains(cfg).items():
        assert not any(e.startswith("gemini:") for e in chain), expert_id
