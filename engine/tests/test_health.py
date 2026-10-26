import pytest
from fastapi.testclient import TestClient

from app.main import app, load_config, model_status


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
    cfg = {"providers": {"nvidia": {"api_key_env": "NVIDIA_API_KEY"}, "mock": {}},
           "roles": {"x": ["nvidia:m1", "mock:context"]}}
    assert model_status(cfg, {"NVIDIA_API_KEY": "k"}) == {"nvidia:m1": "up", "mock:context": "up"}


def test_model_status_empty_key_is_down():
    cfg = {"providers": {"nvidia": {"api_key_env": "NVIDIA_API_KEY"}}, "roles": {"x": ["nvidia:m1"]}}
    assert model_status(cfg, {"NVIDIA_API_KEY": ""}) == {"nvidia:m1": "down"}


def test_model_status_allow_no_key_is_up_without_key():
    cfg = {"providers": {"local": {"api_key_env": "LOCAL_API_KEY", "allow_no_key": True}},
           "roles": {"x": ["local:m1"]}}
    assert model_status(cfg, {}) == {"local:m1": "up"}


def test_model_status_unknown_provider_is_down():
    cfg = {"providers": {"mock": {}}, "roles": {"x": ["ghost:m1", "mock:context"]}}
    assert model_status(cfg, {"GHOST_API_KEY": "k"}) == {"ghost:m1": "down", "mock:context": "up"}


def test_startup_fails_when_models_yaml_missing(monkeypatch, tmp_path):
    monkeypatch.setattr("app.main.DEFAULT_MODELS_PATH", tmp_path / "nope.yaml")
    load_config.cache_clear()
    with pytest.raises(FileNotFoundError):
        with TestClient(app):
            pass
    load_config.cache_clear()
