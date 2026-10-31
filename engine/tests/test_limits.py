"""E1: 본문 크기 제한. /v1/*, /hooks/*는 64 KB를 넘으면 JSON 파싱·인증 전에 413."""
from app.limits import MAX_BODY_BYTES

BIG = b"x" * (MAX_BODY_BYTES + 1)
TOO_LARGE = {"detail": "too_large"}


def test_oversized_content_length_without_token_is_413(client):
    r = client.post("/v1/hint", content=BIG, headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json() == TOO_LARGE


def test_oversized_with_token_is_413_before_parsing(client):
    r = client.post("/v1/hint", content=BIG, headers={"content-type": "application/json", "authorization": "Bearer x"})
    assert r.status_code == 413 and r.json() == TOO_LARGE


def test_oversized_hook_is_413_before_secret_check(client):
    r = client.post("/hooks/message", content=BIG)
    assert r.status_code == 413 and r.json() == TOO_LARGE


def test_chunked_body_over_cap_is_413(client):
    def chunks():
        for _ in range(0, len(BIG), 8192):
            yield b"x" * 8192

    r = client.post("/v1/hint", content=chunks(), headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json() == TOO_LARGE


def test_normal_body_unaffected(client):
    r = client.post("/v1/hint", json={"a": 1})   # 인증·모양 오류는 그대로 나온다(413이 아니다)
    assert r.status_code in (401, 422)


def test_other_paths_not_limited(client):
    assert client.post("/health", content=BIG).status_code == 405   # 라우트가 처리(제한 대상 아님)


def test_413_keeps_cors_headers(client):
    origin = "http://localhost:8081"
    r = client.post("/v1/hint", content=BIG, headers={"origin": origin})
    assert r.status_code == 413 and r.headers["access-control-allow-origin"] == origin
