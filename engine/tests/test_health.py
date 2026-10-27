from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.db import PgRepo
from app.deps import get_repo
from app.main import app, load_config, model_status


def _cfg(providers: dict, *models: str, fallback: dict | None = None) -> dict:
    experts = [{"id": f"e{i}", "role": "context", "model": m, "prompt": "context"} for i, m in enumerate(models)]
    return {"providers": providers, "experts": experts, "fallback": fallback or {}}


def test_health_ok_without_any_keys(monkeypatch):
    for k in ("NVIDIA_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    r = TestClient(app).get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["models"]["mock:context"] == "up"
    nvidia = {k: v for k, v in body["models"].items() if k.startswith("nvidia:")}
    assert nvidia  # 비어 있으면 아래 all()이 아무것도 검사하지 않는다
    assert all(v == "down" for v in nvidia.values())


def test_model_status_up_when_key_present():
    cfg = _cfg({"nvidia": {"api_key_env": "NVIDIA_API_KEY"}, "mock": {}}, "nvidia:m1",
               fallback={"nvidia:m1": ["mock:context"]})
    assert model_status(cfg, {"NVIDIA_API_KEY": "k"}) == {"nvidia:m1": "up", "mock:context": "up"}


def test_model_status_empty_key_is_down():
    cfg = _cfg({"nvidia": {"api_key_env": "NVIDIA_API_KEY"}}, "nvidia:m1")
    assert model_status(cfg, {"NVIDIA_API_KEY": ""}) == {"nvidia:m1": "down"}


def test_model_status_allow_no_key_is_up_without_key():
    cfg = _cfg({"other": {"api_key_env": "OTHER_API_KEY", "allow_no_key": True}}, "other:m1")
    assert model_status(cfg, {}) == {"other:m1": "up"}


def test_model_status_local_needs_flag():
    cfg = _cfg({"local": {"api_key_env": "LOCAL_API_KEY", "allow_no_key": True}}, "local:m1")
    assert model_status(cfg, {}) == {"local:m1": "down"}
    assert model_status(cfg, {"USE_LOCAL_MODEL": "1"}) == {"local:m1": "up"}


def test_model_status_unknown_provider_is_down():
    cfg = _cfg({"mock": {}}, "ghost:m1", "mock:context")
    assert model_status(cfg, {"GHOST_API_KEY": "k"}) == {"ghost:m1": "down", "mock:context": "up"}


def test_startup_fails_when_models_yaml_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("MODELS_PATH", str(tmp_path / "nope.yaml"))
    load_config.cache_clear()
    with pytest.raises(FileNotFoundError):
        with TestClient(app):
            pass
    load_config.cache_clear()


def test_get_repo_503_without_db():
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))
    with pytest.raises(HTTPException) as e:
        get_repo(request)
    assert e.value.status_code == 503


def test_lifespan_without_db_url_has_no_repo(monkeypatch):
    monkeypatch.setenv("SUPABASE_DB_URL", "")
    with TestClient(app) as c:
        assert app.state.repo is None
        assert c.get("/health").status_code == 200


def test_lifespan_dead_db_still_serves_health(monkeypatch, tmp_path):
    """풀은 min_size=0이라 시작할 때 연결하지 않는다: DB가 죽어 있어도 /health는 뜬다."""
    monkeypatch.setenv("SUPABASE_DB_URL", f"postgresql://postgres@/nope?host={tmp_path}")
    with TestClient(app) as c:
        assert isinstance(app.state.repo, PgRepo)
        assert c.get("/health").status_code == 200
