import asyncio
import json
import re
import time
from pathlib import Path

import pytest
import yaml

from app.settings import DEFAULT_MODELS_PATH
from experts.base import ExpertRequest
from experts.llm import LLMExpert
from experts.registry import Registry, run_all
from harness import mock_rules
from harness.pii import Masker
from harness.prompts import turns_text
from harness.router import Router, chains
from harness.schemas import ContextReading, Conversation, FeedbackResult, ToneReading, Turn
from tests.spy import SpyProvider, make_registry

ENGINE = Path(__file__).resolve().parent.parent
CFG = yaml.safe_load(DEFAULT_MODELS_PATH.read_text(encoding="utf-8"))


def _write(tmp_path: Path, cfg: dict) -> Path:
    p = tmp_path / "models.yaml"
    p.write_text(yaml.safe_dump(cfg, allow_unicode=True), encoding="utf-8")
    return p


def _ids(reg: Registry, path: str, role: str) -> list[str]:
    return [e.id for e in reg.for_path(path, role)]


def _expert(reg: Registry, expert_id: str):
    return next(e for e in reg.experts if e.id == expert_id)


def _req(**kw) -> ExpertRequest:
    base = dict(path="detail", draft="안 돼요.", relation="친구",
                turns=[Turn(speaker="them", text="이거 미뤄도 될까요?")])
    return ExpertRequest(**(base | kw))


def test_add_remove_expert_by_config_only(tmp_path):
    cfg = yaml.safe_load(DEFAULT_MODELS_PATH.read_text(encoding="utf-8"))
    cfg["experts"].append({"id": "tone_x", "role": "tone", "model": "nvidia:deepseek-ai/deepseek-v4.1-flash",
                           "prompt": "tone", "paths": ["realtime"], "mock": "tone_alt"})
    assert _ids(Registry.load(_write(tmp_path, cfg), force_mock=True), "realtime", "tone") == ["tone_ds", "tone_x"]
    cfg["experts"] = [e for e in cfg["experts"] if e["id"] != "tone_ds"]
    assert _ids(Registry.load(_write(tmp_path, cfg), force_mock=True), "realtime", "tone") == ["tone_x"]


def test_paths_in_mock_mode():
    reg = make_registry()
    assert _ids(reg, "realtime", "tone") == ["tone_ds"]          # tone_hcx(local, mock 없음) 빠짐
    assert _ids(reg, "detail", "tone") == ["tone_ds", "tone_kimi"]
    assert _ids(reg, "mirror", "context") == ["ctx_deep"]
    assert _ids(reg, "async", "feedback") == ["feedback"]


def test_optional_local_when_available(monkeypatch):
    monkeypatch.setenv("USE_LOCAL_MODEL", "1")
    assert "tone_hcx" in _ids(Registry.load(DEFAULT_MODELS_PATH, force_mock=False), "realtime", "tone")
    assert "tone_hcx" not in _ids(make_registry(), "realtime", "tone")   # force_mock인데 사슬에 mock 없음
    monkeypatch.delenv("USE_LOCAL_MODEL")
    assert "tone_hcx" not in _ids(Registry.load(DEFAULT_MODELS_PATH, force_mock=False), "realtime", "tone")


def test_no_gemini_in_any_chain():
    for expert_id, chain in chains(CFG).items():
        assert not any(m.startswith("gemini:") for m in chain), expert_id


def test_unknown_mock_rejected(tmp_path):
    cfg = yaml.safe_load(DEFAULT_MODELS_PATH.read_text(encoding="utf-8"))
    cfg["experts"][0]["mock"] = "nope"
    with pytest.raises(ValueError):
        Registry.load(_write(tmp_path, cfg), force_mock=True)


def test_llm_expert_result_shape():
    r = asyncio.run(_expert(make_registry(), "tone_ds").run(_req(), time.monotonic() + 1))
    assert r.role == "tone" and isinstance(r.output, ToneReading)
    assert r.model == "mock:tone" and 0 <= r.confidence <= 1


def test_invalid_output_falls_back(tmp_path):
    cfg = {"providers": {"mock": {}},
           "experts": [{"id": "t", "role": "tone", "model": "mock:garbage", "prompt": "tone", "paths": ["detail"]}],
           "fallback": {"mock:garbage": ["mock:tone"]}}
    router = Router.from_file(_write(tmp_path, cfg), force_mock=True)
    router.providers["mock"] = SpyProvider(canned={"garbage": lambda p: "not json"})
    expert = LLMExpert("t", "tone", {"detail"}, 1.0, "tone", router)
    assert asyncio.run(expert.run(_req(), time.monotonic() + 1)).model == "mock:tone"


def test_run_all_drops_late_and_failed():
    reg = make_registry(SpyProvider(canned={"tone_alt": mock_rules.tone_alt}, delay=0.5))
    out = asyncio.run(run_all(reg.for_path("detail", "tone"), _req(), time.monotonic() + 0.1))
    assert [r.expert_id for r in out] == ["tone_ds"]


def test_intent_only_reaches_rewrite():
    spy = SpyProvider()
    reg = make_registry(spy)
    req = _req(intent="미안하게")
    asyncio.run(_expert(reg, "tone_ds").run(req, time.monotonic() + 1))
    asyncio.run(_expert(reg, "rewrite").run(req, time.monotonic() + 1))
    tone, rewrite = spy.calls
    assert tone["payload"]["intent"] is None and "미안하게" not in tone["user"]
    assert rewrite["payload"]["intent"] == "미안하게" and "미안하게" in rewrite["user"]


def test_masker_tokens_and_restore():
    m = Masker(["김민수", "지은"])
    s = "민수야 010-1234-5678, a@b.kr / 김민수랑 지은"
    assert m(s) == "[이름1]야 [전화번호1], [이메일1] / [이름2]랑 [이름3]"
    assert m.restore(m(s)) == s and m("민수") == "[이름1]"


def test_masker_short_names_and_conversation():
    assert Masker(["수"])("수업") == "수업"
    c = Conversation(pair_id="p", turns=[Turn(speaker="them", text="지은아 010-1234-5678", label="지은")],
                     reply_to=Turn(speaker="them", text="지은이가 보냄"))
    masked = Masker(["지은"]).conversation(c)
    assert "지은" not in masked.model_dump_json() and "010-1234" not in masked.model_dump_json()
    assert c.turns[0].text == "지은아 010-1234-5678" and c.reply_to.text == "지은이가 보냄"   # 원본은 그대로


def test_name_survives_rewrite_round_trip():
    spy = SpyProvider()
    reg = make_registry(spy)
    m = Masker(["민수"])
    r = asyncio.run(_expert(reg, "rewrite").run(_req(draft=m("민수야 안 돼요.")), time.monotonic() + 1))
    text = r.output.options[0].text
    assert "[이름1]" in text
    assert "민수" in m.restore(text) and "[이름" not in m.restore(text)
    assert "민수" not in spy.seen()                                              # 모델에는 가린 문장만
    assert "민수" not in json.dumps(list(reg.router.traces), ensure_ascii=False)  # trace에 대응표 없음


def test_router_masks_before_third_party(tmp_path):
    cfg = {"providers": CFG["providers"],
           "experts": [{"id": "x", "role": "context", "model": "nvidia:x", "prompt": "context", "paths": ["detail"]}]}
    r = Router.from_file(_write(tmp_path, cfg), force_mock=False)
    spy = SpyProvider(name="nvidia", canned={"x": mock_rules.context})
    r.providers["nvidia"] = spy
    payload = {"turns": [{"speaker": "them", "text": "010-1234-5678로 연락"}], "deep": {"a": ["010-1234-5678"]}}
    asyncio.run(r.call("x", "s", "번호 010-1234-5678", payload, ContextReading, time.monotonic() + 1))
    assert "010-1234" not in spy.seen() and "[전화번호]" in spy.seen()


def test_router_cache_bounded():
    r = Router.from_file(DEFAULT_MODELS_PATH, force_mock=True)
    r.CACHE_MAX = 3
    for i in range(5):
        asyncio.run(r.call("ctx_fast", "s", f"u{i}", {"turns": []}, ContextReading, time.monotonic() + 1))
    assert len(r.cache) <= 3


def test_only_pipeline_and_router_import_pii():
    importers = set()
    for p in ENGINE.rglob("*.py"):
        rel = p.relative_to(ENGINE)
        if rel.parts[0] in {".venv", "tests"} or rel.as_posix() == "harness/pii.py":
            continue
        if re.search(r"^\s*(from|import)\s.*\bpii\b", p.read_text(encoding="utf-8"), re.M):
            importers.add(rel.as_posix())
    assert importers <= {"pipeline.py", "harness/router.py"}


def test_schema_additions():
    pats = [{"trigger": "짧은 답", "feeling": "차갑게"}, {"trigger": "짧은 답", "feeling": "성의없게"},
            {"trigger": "a", "feeling": "x"}, {"trigger": "b", "feeling": "x"}, {"trigger": "c", "feeling": "x"}]
    fr = FeedbackResult(usable=True, patterns=pats)
    assert [p.trigger for p in fr.patterns] == ["짧은 답", "a", "b"] and fr.patterns[0].feeling == "차갑게"
    c = Conversation(pair_id="p", turns=[Turn(speaker="them", text="최근")], reply_to=Turn(speaker="them", text="답장"))
    assert c.last_them() == "답장"
    assert c.model_copy(update={"reply_to": Turn(speaker="me", text="내 말")}).last_them() == "최근"
    assert turns_text([{"speaker": "them", "text": "hi", "label": "민수"}, {"speaker": "me", "text": "yo"}]) \
        == "[민수] hi\n[나] yo"
