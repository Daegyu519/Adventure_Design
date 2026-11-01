"""P-28: ml/classifier_shim 입력 검사(torch 없이)."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ml.classifier_shim import make_handler, parse_request  # noqa: E402


def body(**kw):
    return json.dumps({"context": [{"role": "them", "text": "힘들어"}], "draft": "ㅇㅇ", "relation": "친구", **kw}).encode()


def test_parse_ok_derives_last_them():
    row = parse_request(body())
    assert row["last_them"] == "힘들어" and row["draft"] == "ㅇㅇ" and row["relation"] == "친구"
    assert parse_request(body(last_them="다른 말"))["last_them"] == "다른 말"


@pytest.mark.parametrize("raw", [
    b"", b"nope", b"[]", body(draft=""), body(draft=3), body(context="x"), body(context=[{"role": "x", "text": "a"}]),
    body(context=[]), body(draft="a" * 5000), body(relation=5), body(last_them=" ")])
def test_parse_rejects_bad_input(raw):
    with pytest.raises(ValueError):
        parse_request(raw)


def _call(handler_cls, method, path, data=b""):
    """소켓 없이 핸들러를 직접 돌린다(테스트는 네트워크 금지)."""
    import io
    h = handler_cls.__new__(handler_cls)
    h.path, h.rfile, h.wfile = path, io.BytesIO(data), io.BytesIO()
    h.headers = {"Content-Length": str(len(data))}
    codes = []
    h.send_response = codes.append
    h.send_header = lambda *a: None
    h.end_headers = lambda: None
    getattr(h, "do_" + method)()
    return codes[0], json.loads(h.wfile.getvalue())


def test_handler_endpoints_400_health_and_internal_error():
    H = make_handler(lambda row: (0.42, 1.5))
    assert _call(H, "GET", "/health") == (200, {"ok": True})
    assert _call(H, "POST", "/score", body()) == (200, {"score": 0.42, "latency_ms": 1.5})
    assert _call(H, "POST", "/score", b"{bad") == (400, {"error": "bad_request"})
    assert _call(H, "POST", "/score", body(draft="")) == (400, {"error": "bad_request"})
    assert _call(H, "POST", "/nope", body())[0] == 404

    def boom(row):
        raise RuntimeError("secret 문장")
    assert _call(make_handler(boom), "POST", "/score", body()) == (500, {"error": "internal"})
