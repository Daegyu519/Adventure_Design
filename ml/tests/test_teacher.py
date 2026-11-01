"""Rule/format fixtures only; no data."""
from ml.teacher import GROUPS, parse_reading, variants


def rows(n):
    return [{"relation": "친구", "last_them": f"말{i}", "original_reply": f"긴 공감 답장 {i}"} for i in range(n)]


def test_variants_deterministic_and_share():
    a, b = variants(rows(500), 14), variants(rows(500), 14)
    assert a == b
    cold = [r for r in a if r["variant"] != "original"]
    assert 0.3 < len(cold) / 500 < 0.5
    assert all(any(r["draft"] in g for g in GROUPS) for r in cold)
    assert all(r["draft"] == r["original_reply"] for r in a if r["variant"] == "original")


def test_parse_reading():
    assert parse_reading('x {"r":[0.5,0.2,0.1,0.1,0.1],"c":0.7} y') == ([0.5, 0.2, 0.1, 0.1, 0.1], 0.7)
    assert parse_reading('{"r":[0.5],"c":0.7}') is None
    assert parse_reading('{"r":[2,0,0,0,0],"c":0.7}') is None
    assert parse_reading("no json") is None
