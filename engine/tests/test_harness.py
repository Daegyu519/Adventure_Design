import asyncio
import time
from pathlib import Path

import pytest
import yaml

from harness import pii
from harness.router import NoResult, Router
from harness.schemas import ContextReading, Conversation, Turn
from harness.store import ProfileStore
from layers import gate, guard

ROOT = Path(__file__).resolve().parent.parent  # engine/


def test_pii_mask():
    assert pii.mask("010-1234-5678로 연락줘") == "[전화번호]로 연락줘"
    assert "[이메일]" in pii.mask("a.b@cnu.ac.kr 로 보내")


def test_guard_never_confirms_or_reveals_source():
    with pytest.raises(ValueError):
        guard.guard("상대가 말하길 차가웠대요")
    with pytest.raises(ValueError):
        guard.guard("확실히 차갑게 느껴져요")


def test_gate_passes_short_reply_to_heavy_message_only():
    store = ProfileStore()
    light = Conversation(pair_id="p", turns=[Turn(speaker="them", text="내일 7시 맞지?")])
    heavy = Conversation(pair_id="p", turns=[Turn(speaker="them", text="요즘 너무 힘들다 다 그만두고 싶어")])
    assert not gate.score("ㅇㅇ", light, store, "me", 0.3).passed
    assert gate.score("ㅇㅇ", heavy, store, "me", 0.3).passed


def test_router_falls_back_to_mock():
    r = Router.from_file(force_mock=True)
    obj, model = asyncio.run(r.call("context_fast", "s", "u", {"turns": []}, ContextReading,
                                    time.monotonic() + 1))
    assert model.startswith("mock")


def test_router_gives_up_after_deadline():
    r = Router.from_file(force_mock=True)
    with pytest.raises(NoResult):
        asyncio.run(r.call("context_fast", "s", "u2", {"turns": []}, ContextReading, time.monotonic() - 1))


def test_single_report_alone_does_not_boost():
    from harness.schemas import FeedbackPattern, ToneReading
    # 프로토타입 layers/judge.py는 T-13에서 layers/aggregate.py로 옮겨 온다. 그때 import 이름만 맞추면 켜진다.
    judge = pytest.importorskip("layers.judge", reason="judge는 T-13에서 aggregate로 이전")
    cfg = Router.from_file(force_mock=True).config["judge"]
    store = ProfileStore()
    store.add_patterns("p", [FeedbackPattern(trigger="이유 없는 거절", feeling="차갑게", strength=3)])
    c = Conversation(pair_id="p", turns=[Turn(speaker="them", text="이거 미뤄도 될까요?")])
    g = gate.score("안 돼요.", c, store, "me", 0.3)
    ctx = ContextReading(prev_act="부탁", expectation_points=["이유 설명"], confidence=0.8)
    tone = ToneReading(readings={"차갑게": 0.5, "무난하게": 0.5}, confidence=0.8)
    # 한 사람의 피드백뿐이면 관계 패턴은 반영되지 않는다
    assert not judge.aggregate("안 돼요.", g, ctx, [tone], store, c, cfg).pattern_used
    # 일반 패턴이 충분히 쌓이면 반영된다
    store.seed_global({"이유 없는 거절": 10})
    assert judge.aggregate("안 돼요.", g, ctx, [tone], store, c, cfg).pattern_used


def test_no_gemini_on_real_text_roles():
    cfg = yaml.safe_load((ROOT / "config" / "models.yaml").read_text(encoding="utf-8"))
    for role, chain in cfg["roles"].items():
        assert not any(e.startswith("gemini:") for e in chain), role
