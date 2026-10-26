from fastapi.testclient import TestClient

from app.main import app, model_status


def test_health_ok_without_any_keys(monkeypatch):
    for k in ("NVIDIA_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    r = TestClient(app).get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["models"]["mock:context"] == "up"
    assert all(v == "down" for k, v in body["models"].items() if k.startswith("nvidia:"))


def test_model_status_up_when_key_present():
    cfg = {"providers": {"nvidia": {"api_key_env": "NVIDIA_API_KEY"}, "mock": {}},
           "roles": {"x": ["nvidia:m1", "mock:context"]}}
    assert model_status(cfg, {"NVIDIA_API_KEY": "k"}) == {"nvidia:m1": "up", "mock:context": "up"}
