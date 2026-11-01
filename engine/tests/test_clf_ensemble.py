"""P-28: 학습된 판별기를 HTTP 서비스로 부르고, 집계에 가중 항 `clf`로 넣는다. 실패는 신호 없음(항 생략)이다."""
import asyncio
import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
import yaml

import pipeline
from app import traces
from app.context import load_context
from app.main import classifier_status
from app.settings import DEFAULT_MODELS_PATH
from experts.base import ExpertRequest
from experts.classifier import ClassifierExpert, HttpBackend, load_classifiers
from experts.registry import Registry
from harness.schemas import Turn
from harness.store import ProfileStore
from tests.test_aggregate import CFG, CONVO, GATE, run, tone
from tests.test_traces import HEAVY, SECRET, _room

URL = "http://localhost:11481/score"
CONFIG = yaml.safe_load(DEFAULT_MODELS_PATH.read_text(encoding="utf-8"))


def req():
    return ExpertRequest(path="realtime", relation="친구", draft="ㅇㅇ", turns=[Turn(speaker="them", text="힘들어")])


def expert(handler, timeout_ms=150):
    backend = HttpBackend(URL, timeout_ms, httpx.Client(transport=httpx.MockTransport(handler), timeout=timeout_ms / 1000))
    return ClassifierExpert("clf_cold", "kcelectra-p14b", backend, {"realtime", "detail"}, exclusive=False)


def call(e):
    return asyncio.run(e.run(req(), time.monotonic() + 1))


def test_http_backend_ok_sends_only_masked_row():
    seen = []

    def handler(r: httpx.Request):
        seen.append(json.loads(r.content))
        return httpx.Response(200, json={"score": 0.7, "latency_ms": 12.5})

    s = call(expert(handler))
    assert (s.cold_score, s.model_id, s.latency_ms) == (0.7, "kcelectra-p14b", 12.5)
    assert set(seen[0]) == {"context", "draft", "relation", "last_them"}
    assert seen[0]["draft"] == "ㅇㅇ" and seen[0]["last_them"] == "힘들어"


@pytest.mark.parametrize("resp", [
    httpx.Response(500, json={"error": "internal"}), httpx.Response(400, json={"error": "bad_request"}),
    httpx.Response(200, content=b"not json"), httpx.Response(200, json={"score": 7, "latency_ms": 1}),
    httpx.Response(200, json={"latency_ms": 1}), httpx.Response(200, json={"score": "nan", "latency_ms": 1})])
def test_http_backend_failures_give_no_signal(resp):
    assert call(expert(lambda r: resp)) is None


def test_http_backend_connection_error_and_timeout_give_no_signal():
    def down(r):
        raise httpx.ConnectError("secret 문장")

    def slow(r):
        time.sleep(0.4)
        return httpx.Response(200, json={"score": 0.9, "latency_ms": 1})

    assert call(expert(down)) is None
    t = time.monotonic()
    assert call(expert(slow, timeout_ms=1000)) is not None   # 느려도 제한 안이면 받는다
    e = expert(slow)
    assert asyncio.run(e.run(req(), time.monotonic() + 0.05)) is None   # 마감 안에 못 오면 신호 없음
    assert time.monotonic() - t < 1.5


def test_http_backend_selected_only_with_use_local_model():
    entries = CONFIG["classifiers"]
    assert load_classifiers(entries, Path("."), env={}) == []
    assert load_classifiers(entries, Path("."), env={"USE_LOCAL_MODEL": "0"}) == []
    assert load_classifiers(entries, Path("."), force_mock=True, env={"USE_LOCAL_MODEL": "1"}) == []
    [c] = load_classifiers(entries, Path("."), env={"USE_LOCAL_MODEL": "1"})
    assert isinstance(c.backend, HttpBackend) and c.backend.url == URL and not c.exclusive


def test_production_models_yaml_classifier_and_weight():
    [e] = CONFIG["classifiers"]
    assert e["id"] == "clf_cold" and e["model_id"] == "kcelectra-p14b" and e["backend"] == "http"
    assert e["url"] == URL and set(e["paths"]) == {"realtime", "detail"} and e["optional"] is True
    assert e["timeout_ms"] <= 150
    assert isinstance(CONFIG["aggregate"]["weights"]["clf"], (int, float))


def test_aggregate_with_and_without_clf_term():
    base = run([(tone(0.5), 1.0)])
    assert "clf" not in base.features                      # 없으면 항 자체가 없다
    same = run([(tone(0.5), 1.0)], store=ProfileStore())
    assert same.risk == base.risk
    w = CFG["weights"]["clf"]
    hi = A_agg(0.9)
    assert hi.features["clf"] == 0.9
    f = base.features
    z0 = _z(f)
    assert hi.risk == pytest.approx(1 / (1 + 2.718281828 ** -(z0 + w * 0.9)), abs=2e-3)
    assert A_agg(0.0).risk == base.risk                    # clf=0은 값 0(기여 없음), 생략과 같은 위험도
    assert A_agg(0.9).risk > base.risk > 0 and A_agg(None).features.keys() == base.features.keys()
    assert "clf" not in A_agg(float("nan")).features       # 비정상 값은 생략


def A_agg(clf):
    from layers import aggregate as A
    return A.aggregate("안 돼요.", GATE, __import__("tests.test_aggregate", fromlist=["CTX"]).CTX,
                       [(tone(0.5), 1.0)], ProfileStore(), CONVO, CFG, clf)


def _z(f):
    w = CFG["weights"]
    return w["bias"] + w["prior"] * f["prior"] + w["neg"] * f["neg"] + w["violation"] * f["violation"] + w["pattern"] * f["pattern"]


def _reg(spy, backend, paths=("realtime", "detail")):
    from tests.spy import make_registry
    reg = make_registry(spy)
    reg.classifiers = [ClassifierExpert("clf_cold", "kcelectra-p14b", backend, set(paths), exclusive=False)]
    return reg


class Backend:
    def __init__(self, score=0.8, sleep=0.0, fail=False):
        self.score, self.sleep, self.fail, self.rows = score, sleep, fail, []

    def predict(self, row):
        self.rows.append(row)
        time.sleep(self.sleep)
        if self.fail:
            raise RuntimeError("secret")
        return self.score, 3.0


def _go(reg, fake, me, room, fn=pipeline.realtime, **kw):
    ctx = asyncio.run(load_context(fake, room, me, None, datetime.now(timezone.utc)))
    args = (reg, "ㅇㅇ", ctx.convo, ctx.store, str(me), ctx.names)
    async def timed():   # asyncio.run은 끝날 때 남은 스레드를 기다리므로 안에서 잰다(운영 루프는 계속 돈다)
        t0 = time.monotonic()
        out = await fn(*args, *kw.get("extra", ()), t0)
        return out, time.monotonic() - t0
    return asyncio.run(timed())


def test_realtime_clf_term_present_and_trace_number_only(fake, spy):
    me, _, room = _room(fake, HEAVY)
    b = Backend(0.8)
    out, _ = _go(_reg(spy, b), fake, me, room)
    assert out.clf == 0.8 and out.verdict.features["clf"] == 0.8
    assert b.rows and "ㅇㅇ" in json.dumps(b.rows[0], ensure_ascii=False)
    row = traces.build_trace(uuid.uuid4(), "realtime", uuid.uuid4(), uuid.uuid4(), "alert", 10, out)
    assert row.experts["clf"] == 0.8
    assert SECRET not in json.dumps(row.experts, ensure_ascii=False) and "ㅇㅇ" not in json.dumps(row.experts, ensure_ascii=False)


def test_realtime_without_clf_has_no_term(fake, spy):
    me, _, room = _room(fake, HEAVY)
    for backend in (Backend(fail=True), None):
        reg = _reg(spy, backend) if backend else _reg(spy, Backend())
        if backend is None:
            reg.classifiers = []
        out, _ = _go(reg, fake, me, room)
        assert out.clf is None and "clf" not in out.verdict.features
        assert "clf" not in traces.build_trace(uuid.uuid4(), "realtime", uuid.uuid4(), uuid.uuid4(), "none", 1, out).experts


def test_slow_classifier_does_not_delay_past_deadline(fake, spy):
    me, _, room = _room(fake, HEAVY)
    reg = _reg(spy, Backend(sleep=3.0))
    dl = reg.cfg["paths"]["realtime"]["expert_deadline_ms"] / 1000
    out, took = _go(reg, fake, me, room)
    assert out.clf is None and took < dl + 0.3 and out.verdict is not None


def test_detail_uses_same_term(fake, spy):
    me, _, room = _room(fake, HEAVY)
    out, _ = _go(_reg(spy, Backend(0.6)), fake, me, room, fn=pipeline.detail, extra=(None,))
    assert out.clf == 0.6 and out.verdict.features["clf"] == 0.6
    assert traces.build_trace(uuid.uuid4(), "detail", uuid.uuid4(), uuid.uuid4(), "ok", 1, out).experts["clf"] == 0.6


def test_classifier_not_used_on_other_paths(spy):
    reg = _reg(spy, Backend(), paths=("realtime",))
    assert [c.id for c in reg.classifiers_for("realtime")] == ["clf_cold"] and reg.classifiers_for("detail") == []


def test_health_status_reports_up_and_down(spy):
    class Up(Backend):
        def healthy(self):
            return True

    class Down(Backend):
        def healthy(self):
            return False

    cfg = CONFIG
    assert classifier_status(cfg, _reg(spy, Up())) == {"clf_cold": "up"}
    assert classifier_status(cfg, _reg(spy, Down())) == {"clf_cold": "down"}
    reg = _reg(spy, Up())
    reg.classifiers = []
    assert classifier_status(cfg, reg) == {"clf_cold": "down"}
