"""E3: 실제 모델이 다 막히면 mock으로 떨어지지 않고 기권(NoResult). 무엇이 왜 막혔는지는 로그와 /health에 보인다."""
import asyncio
import logging
import time

import pytest
from fastapi.testclient import TestClient

from app.deps import get_registry
from app.main import app, startup_warnings
from app.settings import DEFAULT_MODELS_PATH
from experts.registry import Registry
from harness.providers import ProviderError
from harness.router import Breaker, NoResult, Router
from harness.schemas import ContextReading

SECRET = "절대로-로그에-나오면-안되는-문장"


def _real_router() -> Router:
    return Router.from_file(DEFAULT_MODELS_PATH, force_mock=False)   # mock_env가 키를 지웠다


def _call(r: Router, user: str = SECRET):
    return asyncio.run(r.call("ctx_fast", "s", user, {"turns": []}, ContextReading, time.monotonic() + 1))


def test_missing_key_abstains_instead_of_mock(caplog):
    caplog.set_level(logging.WARNING)
    with pytest.raises(NoResult):
        _call(_real_router())


def test_force_mock_still_answers_from_mock():
    _, entry = _call(Router.from_file(DEFAULT_MODELS_PATH, force_mock=True))
    assert entry.startswith("mock:")


def test_missing_key_logs_one_warning_per_skipped_entry(caplog):
    caplog.set_level(logging.WARNING)
    with pytest.raises(NoResult):
        _call(_real_router())
    msgs = [r.getMessage() for r in caplog.records]
    assert any("nvidia:poolside/laguna-xs-2.1" in m and "unavailable" in m for m in msgs)
    assert any("github:openai/gpt-4.1-mini" in m and "unavailable" in m for m in msgs)
    assert SECRET not in caplog.text


def test_open_breaker_is_logged(caplog, monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "k")   # 키가 있는 것처럼
    r = _real_router()
    for entry in ("nvidia:poolside/laguna-xs-2.1", "nvidia:nvidia/nemotron-3.5-bolt-e4b"):   # 사슬의 nvidia 항목 모두
        r.breakers[entry] = Breaker(open_until=time.monotonic() + 60)
    caplog.set_level(logging.WARNING)
    with pytest.raises(NoResult):
        _call(r)
    assert any("nvidia:poolside/laguna-xs-2.1" in m and "breaker_open" in m
               for m in (x.getMessage() for x in caplog.records))


def test_failure_logs_exception_type_only(caplog, monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "k")
    r = _real_router()

    class Down:
        available = True

        async def complete(self, *a):
            raise ProviderError(SECRET)   # 메시지에 문장이 섞여도

    r.providers["nvidia"] = Down()
    caplog.set_level(logging.WARNING)
    with pytest.raises(NoResult):
        _call(r)
    assert any("ProviderError" in x.getMessage() for x in caplog.records)
    assert SECRET not in caplog.text


def test_provider_5xx_logs_entry_and_status_class_and_health_counts_it(caplog, monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "k")
    reg = Registry.load(DEFAULT_MODELS_PATH, force_mock=False)

    class Down:
        available = True

        async def complete(self, *a):
            raise ProviderError(SECRET, 503)

    reg.router.providers["nvidia"] = Down()
    caplog.set_level(logging.WARNING)
    with pytest.raises(NoResult):
        _call(reg.router)
    assert any("nvidia:poolside/laguna-xs-2.1" in m and "ProviderError 5xx" in m
               for m in (x.getMessage() for x in caplog.records))
    assert SECRET not in caplog.text
    app.dependency_overrides[get_registry] = lambda: reg
    try:
        body = TestClient(app).get("/health").json()
    finally:
        app.dependency_overrides.clear()
    assert body["failures"]["nvidia"]["ProviderError 5xx"] >= 1
    assert body["failures"]["github"]["unavailable"] >= 1
    assert body["providers"]["nvidia"] == "up" and body["providers"]["github"] == "down"


def test_startup_warns_for_each_unavailable_real_entry(caplog):
    reg = Registry.load(DEFAULT_MODELS_PATH, force_mock=False)
    caplog.set_level(logging.WARNING)
    startup_warnings(reg, {})
    msgs = [r.getMessage() for r in caplog.records]
    assert any("nvidia:nvidia/nemotron-3.5-bolt-e4b" in m for m in msgs)
    assert not any("mock:" in m for m in msgs)
    assert len([m for m in msgs if "nvidia:nvidia/nemotron-3.5-bolt-e4b" in m]) == 1   # 사슬이 겹쳐도 한 번


def test_startup_silent_when_forced_mock(caplog):
    reg = Registry.load(DEFAULT_MODELS_PATH, force_mock=True)
    caplog.set_level(logging.WARNING)
    startup_warnings(reg, {})
    assert caplog.records == []
