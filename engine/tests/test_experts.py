import asyncio
import json
import re
import socket
import time
from pathlib import Path

import httpx
import pytest
import yaml
from pydantic import ValidationError

from app.settings import DEFAULT_MODELS_PATH
from experts.base import ExpertRequest
from experts.llm import LLMExpert
from experts.registry import Registry, run_all
from harness import mock_rules, pii, prompts
from harness.pii import Masker
from harness.prompts import turns_text
from harness.providers import OpenAICompatProvider, ProviderError
from harness.router import NoResult, Router, chains
from harness.schemas import ContextReading, Conversation, FeedbackResult, RewriteSet, ToneReading, Turn
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


def test_unknown_provider_rejected(tmp_path):
    cfg = yaml.safe_load(DEFAULT_MODELS_PATH.read_text(encoding="utf-8"))
    cfg["experts"][0]["model"] = "nvdia:x"
    with pytest.raises(ValueError, match="nvdia"):
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


@pytest.mark.parametrize("bad", [float("inf"), float("-inf"), float("nan")])
def test_tone_reading_rejects_non_finite(bad):
    with pytest.raises(ValidationError):
        ToneReading(readings={"차갑게": bad, "무난하게": 0.5})


def test_infinity_reading_falls_back(tmp_path):
    """json.loads는 Infinity를 받아들인다. 그런 출력은 스키마에서 떨어지고 다음 모델로 넘어가야 한다(규칙 3)."""
    cfg = {"providers": {"mock": {}},
           "experts": [{"id": "t", "role": "tone", "model": "mock:inf", "prompt": "tone", "paths": ["detail"]}],
           "fallback": {"mock:inf": ["mock:tone"]}}
    router = Router.from_file(_write(tmp_path, cfg), force_mock=True)
    raw = '{"readings": {"차갑게": Infinity, "무난하게": 0.5}, "confidence": 0.8}'
    router.providers["mock"] = SpyProvider(canned={"inf": lambda p: raw})
    expert = LLMExpert("t", "tone", {"detail"}, 1.0, "tone", router)
    assert asyncio.run(expert.run(_req(), time.monotonic() + 1)).model == "mock:tone"


class _Raises:
    id, role, paths, weight = "boom", "tone", {"detail"}, 1.0

    def __init__(self, exc: Exception):
        self.exc = exc

    async def run(self, req, deadline):
        raise self.exc


def test_run_all_drops_late_and_failed():
    # 늦은 전문가(TimeoutError)는 빠진다
    reg = make_registry(SpyProvider(canned={"tone_alt": mock_rules.tone_alt}, delay=0.5))
    out = asyncio.run(run_all(reg.for_path("detail", "tone"), _req(), time.monotonic() + 0.1))
    assert [r.expert_id for r in out] == ["tone_ds"]
    # 모든 모델이 실패한 전문가(NoResult)도 빠진다: tone_kimi의 mock 사슬이 깨진 JSON만 돌려줌
    reg = make_registry(SpyProvider(canned={"tone_alt": lambda p: "not json"}))
    out = asyncio.run(run_all(reg.for_path("detail", "tone"), _req(), time.monotonic() + 1))
    assert [r.expert_id for r in out] == ["tone_ds"]
    tone_ds = _expert(reg, "tone_ds")
    assert len(asyncio.run(run_all([tone_ds, _Raises(NoResult("x"))], _req(), time.monotonic() + 1))) == 1
    # 그 밖의 예외(버그)는 숨기지 않고 올린다
    with pytest.raises(RuntimeError):
        asyncio.run(run_all([tone_ds, _Raises(RuntimeError("bug"))], _req(), time.monotonic() + 1))


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


@pytest.mark.parametrize("raw, kind", [
    ("010-1234-5678", "전화번호"), ("010.1234.5678", "전화번호"), ("+82 10-1234-5678", "전화번호"),
    ("+82-010-1234-5678", "전화번호"), ("900101-1234567", "주민번호"), ("900101-5234567", "주민번호"),
    ("9001015234567", "주민번호"), ("1234-5678-9012-3456", "카드번호"), ("1234 5678 9012 3456", "카드번호"),
    ("a@b.kr", "이메일"), ("a＠b.com", "이메일"), ("110-123-456789", "계좌번호"), ("12345678901234567890", "긴 숫자"),
])
def test_pii_patterns(raw, kind):
    assert pii.mask(f"연락처 {raw} 야") == f"연락처 [{kind}] 야"
    m = Masker()
    assert m(f"연락처 {raw} 야") == f"연락처 [{kind}1] 야" and m.restore(f"[{kind}1]") == raw


def test_pii_email_local_part_bounded_and_latin_names():
    assert pii.mask("a" * 70 + "@b.kr") == "a" * 6 + "[이메일]"     # 로컬 부분은 64자까지만 본다
    m = Masker(["Minsu"])
    masked = m("minsu hi MINSU")
    assert masked == "[이름1] hi [이름2]" and m.restore(masked) == "minsu hi MINSU"


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


@pytest.mark.parametrize("provider", ["nvidia", "local"])   # local도 원격을 가리킬 수 있어 예외 아님
def test_router_masks_before_third_party(tmp_path, provider):
    cfg = {"providers": CFG["providers"],
           "experts": [{"id": "x", "role": "context", "model": f"{provider}:x", "prompt": "context",
                        "paths": ["detail"]}]}
    r = Router.from_file(_write(tmp_path, cfg), force_mock=False)
    spy = SpyProvider(name=provider, canned={"x": mock_rules.context})
    r.providers[provider] = spy
    payload = {"turns": [{"speaker": "them", "text": "010-1234-5678로 연락"}], "deep": {"a": ["010-1234-5678"]}}
    asyncio.run(r.call("x", "s 010-1234-5678", "번호 010-1234-5678", payload, ContextReading, time.monotonic() + 1))
    assert "010-1234" not in spy.seen() and "[전화번호]" in spy.calls[0]["system"]
    assert "[전화번호]" in spy.calls[0]["user"] and "[전화번호]" in json.dumps(spy.calls[0]["payload"], ensure_ascii=False)


def test_safety_net_leaves_prompts_intact():
    for f in prompts.DIR.glob("*.md"):
        system, user, _ = prompts.load(f.stem)
        assert pii.mask(system) == system and pii.mask(user) == user, f.name


def test_router_cache_returns_copies():
    r = Router.from_file(DEFAULT_MODELS_PATH, force_mock=True)
    call = lambda: asyncio.run(r.call("rewrite", "s", "u", {"draft": "안 돼요."}, RewriteSet,  # noqa: E731
                                      time.monotonic() + 1))[0]
    first = call()
    original = first.options[0].text
    first.options[0].text = "민수에게 복원됨"          # 한 요청이 결과를 제자리에서 고쳐도
    second = call()                                     # 캐시에서 꺼낸 결과는 그대로
    assert second.options[0].text == original
    second.options[0].text = "지은에게 복원됨"
    assert call().options[0].text == original


def _http_provider(handler) -> OpenAICompatProvider:
    p = OpenAICompatProvider("nvidia", {"base_url": "http://fake", "allow_no_key": True})
    p._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return p


@pytest.mark.parametrize("body", [{"error": "secret-reply 민수"}, {"choices": []}, {"choices": [{"message": None}]},
                                  {"choices": [{"message": {"content": ["secret-reply"]}}]}])
def test_bad_provider_response_falls_back(tmp_path, body):
    p = _http_provider(lambda req: httpx.Response(200, json=body))
    with pytest.raises(ProviderError) as e:
        asyncio.run(p.complete("x", "s", "secret-request 민수", {}, 1))
    assert "secret" not in str(e.value) and "민수" not in str(e.value) and e.value.__cause__ is None
    cfg = {"providers": CFG["providers"], "fallback": {"nvidia:x": ["mock:context"]},
           "experts": [{"id": "x", "role": "context", "model": "nvidia:x", "prompt": "context", "paths": ["detail"]}]}
    r = Router.from_file(_write(tmp_path, cfg), force_mock=False)
    r.providers["nvidia"] = p
    _, model = asyncio.run(r.call("x", "s", "u", {"turns": []}, ContextReading, time.monotonic() + 1))
    assert model == "mock:context"                       # 폴백이 돌고
    assert r.traces[0]["model"] == "nvidia:x" and r.traces[0]["ok"] is False
    assert r.breakers["nvidia:x"].fails == 1              # 차단기도 실패를 센다


def test_http_error_message_has_no_body():
    p = _http_provider(lambda req: httpx.Response(500, text="secret-reply 민수"))
    with pytest.raises(ProviderError) as e:
        asyncio.run(p.complete("x", "s", "u", {}, 1))
    assert "secret" not in str(e.value)


def test_network_is_blocked():
    with pytest.raises(RuntimeError):
        socket.create_connection(("example.com", 80), timeout=1)


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
