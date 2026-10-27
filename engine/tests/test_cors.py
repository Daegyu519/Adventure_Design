from app.settings import Settings

PREFLIGHT = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"}


def test_preflight_allowed_origin(client):
    origin = Settings.from_env().cors_origins[0]
    r = client.options("/v1/hint", headers={"Origin": origin, **PREFLIGHT})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == origin
    allowed = r.headers["access-control-allow-headers"].lower()
    assert "authorization" in allowed and "content-type" in allowed
    assert "POST" in r.headers["access-control-allow-methods"]
    assert "access-control-allow-credentials" not in r.headers   # 쿠키를 쓰지 않는다


def test_preflight_disallowed_origin(client):
    r = client.options("/v1/hint", headers={"Origin": "https://evil.example", **PREFLIGHT})
    assert r.status_code == 400
    assert "access-control-allow-origin" not in r.headers


def test_cors_origins_env_parsed(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "https://a.example, https://b.example")
    assert Settings.from_env().cors_origins == ("https://a.example", "https://b.example")
    for empty in ("", " , "):
        monkeypatch.setenv("CORS_ORIGINS", empty)
        assert Settings.from_env().cors_origins == ("http://localhost:8081",)
    monkeypatch.delenv("CORS_ORIGINS")
    assert Settings.from_env().cors_origins == ("http://localhost:8081",)
