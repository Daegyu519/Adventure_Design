"""T-19: tone.analysis_traces. 힌트·상세 요청마다 trace 1행(겉 신호·전문가 읽힘·결과만, 문장 없음).
spy 모델 이름은 mock_rules 함수 이름이다(context, tone, tone_alt, judge, rewrite)."""
import asyncio
import json
import logging
import time
from dataclasses import asdict
from uuid import uuid4

import pytest

import pipeline
from app import traces
from experts.base import ExpertResult
from harness.schemas import (ContextReading, FeedbackPattern, FeedbackResult, GateResult, JudgeOut, RewriteOption,
                             RewriteSet, ToneReading, Verdict)

LIGHT = "내일 7시 맞지?"
HEAVY = "요즘 진짜 너무 힘들다... 취업도 안 되고 다 그만두고 싶어"
FEATURES = {"prior", "neg", "violation", "pattern", "disagreement", "confidence"}
SECRET = "보라색코끼리"


def _room(fake, them_says=HEAVY, me=None, you_name="박민수"):
    me = me or fake.add_user("김지은")
    you = fake.add_user(you_name)
    room = fake.add_room("direct", "친구", [me, you])
    fake.add_message(room, you, them_says)
    return me, you, room


def _hint(c, room, text="ㅇㅇ", **kw):
    return c.post("/v1/hint", json={"room_id": str(room), "text": text, "seq": 1, **kw})


def _detail(c, room, text="안 돼요.", **kw):
    return c.post("/v1/detail", json={"room_id": str(room), "text": text, **kw})


def _rows(fake, queue) -> list[dict]:
    asyncio.run(queue.run_all())
    return fake.traces


def _res(role, output):
    return ExpertResult(expert_id="e1", role=role, output=output, confidence=0.5, latency_ms=12, model="mock:m")


def _tone(neg: float, conf: float = 0.6) -> dict:
    return {"readings": {"차갑게": neg, "무난하게": round(1 - neg, 3)}, "cues": [], "has_reason": False,
            "confidence": conf}


async def _stall(*_a, **_k):
    await asyncio.sleep(2)
    return []


async def _boom(*_a, **_k):
    raise RuntimeError("secret 박민수")


# ── 요청마다 1행 ──────────────────────────────────────

@pytest.mark.legacy_rt
def test_one_trace_per_hint_request(client, login, fake, queue, registry, monkeypatch):
    me, _, light = _room(fake, LIGHT)
    _, _, heavy = _room(fake, HEAVY, me)
    _, _, slow = _room(fake, HEAVY, me)
    login(me)
    ids = []
    for room in (light, heavy):
        r = _hint(client, room)
        assert r.status_code == 200
        ids.append(r.json()["trace_id"])
    monkeypatch.setattr(fake, "recent_messages", _stall)
    registry.cfg["paths"]["realtime"]["deadline_ms"] = 300
    r = _hint(client, slow)
    assert r.status_code == 200 and r.json()["hint"] is None
    ids.append(r.json()["trace_id"])

    assert queue.names() == ["trace"] * 3   # 요청 하나에 작업 하나
    rows = _rows(fake, queue)
    assert [r["experts"]["status"] for r in rows] == ["gated", "alert", "timeout"]
    assert {r["path"] for r in rows} == {"hint"}   # 엔진 이름 realtime이 아니라 DB의 hint
    assert [str(r["trace_id"]) for r in rows] == ids   # 응답의 trace_id가 그 행의 키다
    assert all(r["user_id"] == me and r["latency_ms"] >= 0 for r in rows)
    assert [r["room_id"] for r in rows] == [light, heavy, slow]
    assert [r["alert"] for r in rows] == [False, True, False]
    assert rows[0]["risk"] is None and 0 <= rows[1]["risk"] <= 1 and rows[2]["risk"] is None


@pytest.mark.legacy_rt
def test_hint_trace_contents(client, login, fake, queue):
    me, _, room = _room(fake, HEAVY)
    login(me)
    _hint(client, room)
    [row] = _rows(fake, queue)
    e = row["experts"]
    assert set(e) == {"status", "gate", "features", "results"}
    assert set(e["gate"]) == {"prior", "signals"} and isinstance(e["gate"]["signals"], list)
    assert set(e["features"]) == FEATURES
    assert {r["role"] for r in e["results"]} == {"context", "tone"}
    assert all({"expert_id", "role", "model", "latency_ms"} <= set(r) for r in e["results"])


def test_hint_error_status(client, login, fake, queue, monkeypatch):
    me, _, room = _room(fake)
    login(me)
    monkeypatch.setattr(fake, "member_names", _boom)
    r = _hint(client, room)
    assert r.status_code == 200 and r.json()["hint"] is None
    [row] = _rows(fake, queue)
    assert row["experts"] == {"status": "error", "gate": None, "features": {}, "results": []}
    assert row["risk"] is None and row["alert"] is False


def test_detail_trace(client, login, fake, queue):
    me, _, room = _room(fake)
    login(me)
    b = _detail(client, room).json()
    [row] = _rows(fake, queue)
    assert row["path"] == "detail" and row["experts"]["status"] == "ok"
    assert set(row["experts"]["features"]) == FEATURES
    assert str(row["trace_id"]) == b["trace_id"] and row["alert"] is b["alert"]
    assert row["room_id"] == room and row["user_id"] == me
    assert {"context", "tone", "rewrite"} <= {r["role"] for r in row["experts"]["results"]}
    assert 0 <= row["risk"] <= 1


def test_detail_recall_with_intent_traces_again(client, login, fake, queue):
    """칩을 바꾼 재호출도 요청이다: trace는 요청마다 한 행."""
    me, _, room = _room(fake)
    login(me)
    assert _detail(client, room).status_code == 200 and _detail(client, room, intent="미안하게").status_code == 200
    assert queue.names().count("trace") == 2 and queue.names().count("event") == 1


def test_detail_failures_leave_a_trace_and_still_503(client, login, fake, queue, spy, registry, monkeypatch):
    me, _, room = _room(fake)
    login(me)
    spy.canned |= {"tone": lambda p: "not json", "tone_alt": lambda p: "not json"}
    assert _detail(client, room).status_code == 503   # 말투 결과 없음
    spy.canned.clear()
    monkeypatch.setattr(fake, "recent_messages", _stall)
    registry.cfg["paths"]["detail"]["deadline_ms"] = 300
    assert _detail(client, room).status_code == 503   # 시간 초과
    monkeypatch.setattr(fake, "member_names", _boom)
    assert _detail(client, room).status_code == 503   # 엔진 오류
    rows = _rows(fake, queue)
    assert [r["experts"]["status"] for r in rows] == ["no_result", "timeout", "error"]
    assert {r["path"] for r in rows} == {"detail"} and queue.names() == ["trace"] * 3   # detail_opened는 없다
    assert rows[0]["experts"]["gate"] is not None and rows[0]["experts"]["features"] == {}
    assert rows[1]["experts"]["gate"] is None and rows[0]["risk"] is None and rows[0]["alert"] is False


# ── 401·403·422는 남기지 않는다 ───────────────────────

@pytest.mark.parametrize("call", [_hint, _detail])
def test_no_trace_for_rejected_requests(client, login, fake, queue, call):
    me, you, room = _room(fake)
    other = fake.add_room("direct", "친구", [me, fake.add_user("최수아")])
    bad_reply = fake.add_message(other, me, "다른 방")
    assert call(client, room).status_code == 401   # 토큰 없음
    login(fake.add_user("최수아"))
    assert call(client, room).status_code == 403   # 비멤버
    login(me)
    assert call(client, room, reply_to=bad_reply).status_code == 422   # 다른 방 메시지
    assert call(client, room, text=" ").status_code == 422   # 형식
    assert "trace" not in queue.names() and fake.traces == []


# ── 응답은 trace 때문에 막히거나 깨지지 않는다 ─────────

@pytest.mark.parametrize("call", [_hint, _detail])
def test_response_survives_full_queue(client, login, fake, queue, call, caplog):
    me, _, room = _room(fake)
    login(me)
    queue.accepting = False
    with caplog.at_level(logging.WARNING):
        assert call(client, room).status_code == 200
    assert "trace enqueue rejected" in caplog.text


@pytest.mark.parametrize("call", [_hint, _detail])
def test_response_survives_trace_build_failure(client, login, fake, queue, monkeypatch, caplog, call):
    me, _, room = _room(fake)
    login(me)

    def boom(*_a, **_k):
        raise RuntimeError(f"{SECRET} 박민수")
    monkeypatch.setattr(traces, "build_trace", boom)
    with caplog.at_level(logging.WARNING):
        assert call(client, room).status_code == 200
    assert "trace failed: RuntimeError" in caplog.text and SECRET not in caplog.text
    assert "trace" not in queue.names()


def test_trace_job_is_the_timeout_wrapper(client, login, fake, queue):
    me, _, room = _room(fake)
    login(me)
    _hint(client, room)
    [(name, fn, args)] = queue.jobs
    assert (name, fn) == ("trace", traces.record) and args[0] is fake and args[1].path == "hint"


def test_trace_job_times_out_on_stalled_insert(monkeypatch):
    """멈춘 DB 호출이 공유 워커를 붙들지 않게 기록 작업이 스스로 시간을 자른다(큐가 재시도한다)."""
    monkeypatch.setattr(traces, "TRACE_DEADLINE_S", 0.05)

    class Stalled:
        async def insert_trace(self, _row):
            await asyncio.sleep(10)
    row = traces.build_trace(uuid4(), "detail", uuid4(), uuid4(), "error", 1)
    t0 = time.monotonic()
    with pytest.raises(TimeoutError):
        asyncio.run(traces.record(Stalled(), row))
    assert time.monotonic() - t0 < 1


# ── 문장 조각이 없다 ──────────────────────────────────

def _inject(spy):
    """모든 전문가 출력의 문장 칸에 원문·이름·자리표시를 넣는다. trace는 허용 목록만 담아야 한다."""
    leak = [SECRET, "민수", "[이름1]", "안 돼요"]
    spy.canned |= {
        "context": lambda p: {"prev_act": "질문", "partner_state": "서운", "expectation_points": [*leak, "이유 설명"],
                              "shared_context": leak, "confidence": 0.7},
        "tone": lambda p: _tone(.9) | {"cues": leak},
        "tone_alt": lambda p: _tone(.1) | {"cues": leak},   # 갈려서 심판까지 돈다
        "judge": lambda p: {"alert": True, "reason": f"{SECRET} 민수 [이름1]"},
        "rewrite": lambda p: {"options": [{"label": "x", "text": f"{SECRET} 안 돼요 [이름1]", "keep": leak,
                                           "change": leak}]},
    }


@pytest.mark.legacy_rt
@pytest.mark.parametrize("call", [_hint, _detail])
def test_trace_has_no_text(client, login, fake, queue, spy, registry, call):
    me, _, room = _room(fake, f"민수야 {HEAVY}", you_name="민수")
    login(me)
    _inject(spy)
    registry.cfg["paths"]["realtime"]["gate_threshold"] = 0.0   # "보라…"의 '라'가 이유로 읽혀 L0가 거르므로, 전문가가 돌게 연다
    draft = f"{SECRET} 안 돼요."
    assert call(client, room, text=draft).status_code == 200
    assert {c["model"] for c in spy.calls} >= {"context", "tone"}   # 전문가가 실제로 돌았다
    [(_, _, args)] = [j for j in queue.jobs if j[0] == "trace"]
    dumped = json.dumps(asdict(args[1]), ensure_ascii=False, default=str)
    queued = json.dumps(args[1:], ensure_ascii=False, default=str)
    for leaked in (SECRET, "안 돼요", "민수", "[이름", "이유 설명"):
        assert leaked not in dumped and leaked not in queued
    _rows(fake, queue)
    assert SECRET not in json.dumps(fake.traces, ensure_ascii=False, default=str)


def test_detail_trace_has_no_text_with_judge_and_rewrite(client, login, fake, queue, spy):
    me, _, room = _room(fake, f"민수야 {HEAVY}", you_name="민수")
    login(me)
    _inject(spy)
    _detail(client, room, text=f"{SECRET} 안 돼요.")
    roles = {r["role"] for r in _rows(fake, queue)[0]["experts"]["results"]}
    assert {"context", "tone", "judge", "rewrite"} <= roles   # 문장이 실린 칸이 많은 역할까지 돌았다


# ── expert_summary: 허용 목록 ─────────────────────────

COMMON = {"expert_id": "e1", "model": "mock:m", "latency_ms": 12}


def test_expert_summary_per_role():
    ctx = ContextReading(prev_act="질문", partner_state="서운", expectation_points=["a", "b"],
                         shared_context=["둘만"], confidence=0.7)
    assert traces.expert_summary(_res("context", ctx)) == COMMON | {
        "role": "context", "prev_act": "질문", "partner_state": "서운", "n_expect": 2, "confidence": 0.7}
    tone = ToneReading(readings={"차갑게": 1.0}, cues=["단서"], has_reason=True, confidence=0.4)
    assert traces.expert_summary(_res("tone", tone)) == COMMON | {
        "role": "tone", "readings": tone.readings, "has_reason": True, "confidence": 0.4}
    assert traces.expert_summary(_res("judge", JudgeOut(alert=True, reason="이유"))) == COMMON | {
        "role": "judge", "alert": True}
    rw = RewriteSet(options=[RewriteOption(label="l", text="t")] * 2)
    assert traces.expert_summary(_res("rewrite", rw)) == COMMON | {"role": "rewrite", "n_options": 2}


def test_expert_summary_unknown_role_has_common_fields_only():
    fb = FeedbackResult(usable=True, patterns=[FeedbackPattern(trigger="t", feeling="차갑게")], dropped_reason="r")
    assert traces.expert_summary(_res("feedback", fb)) == COMMON | {"role": "feedback"}


def test_expert_summary_confidence_is_what_the_aggregator_saw():
    """NaN·범위 밖 confidence는 JSON(jsonb)을 깨므로 집계가 쓴 값(0~1로 자름, NaN은 0)으로 적는다."""
    nan = ContextReading(confidence=float("nan"))
    big = ToneReading(readings={"차갑게": 1.0}, confidence=9.0)
    assert traces.expert_summary(_res("context", nan))["confidence"] == 0.0
    assert traces.expert_summary(_res("tone", big))["confidence"] == 1.0


# ── build_trace ───────────────────────────────────────

def test_build_trace_maps_paths_and_tolerates_missing_parts():
    t, u, r = uuid4(), uuid4(), uuid4()
    row = traces.build_trace(t, "realtime", u, r, "timeout", 1500)
    assert (row.trace_id, row.path, row.user_id, row.room_id, row.latency_ms) == (t, "hint", u, r, 1500)
    assert row.experts == {"status": "timeout", "gate": None, "features": {}, "results": []}
    assert row.risk is None and row.alert is False
    assert traces.build_trace(t, "detail", u, r, "error", 9).path == "detail"

    gated = pipeline.RealtimeOutcome(GateResult(prior=0.2, signals=["짧은 답"], passed=False), None, None, [], "gated")
    row = traces.build_trace(t, "realtime", u, r, "gated", 3, gated)
    assert row.experts == {"status": "gated", "gate": {"prior": 0.2, "signals": ["짧은 답"]}, "features": {},
                           "results": []} and row.risk is None


def test_build_trace_early_abstain_has_no_features():
    """전문가가 하나도 못 쓰이면 집계가 features 없는 기권을 낸다."""
    v = Verdict(risk=0.0, top_reading="무난하게", signals=[], disagreement=0.0, confidence=0.0, abstain=True,
                alert=False)
    out = pipeline.RealtimeOutcome(GateResult(prior=0.9, signals=["짧은 답"], passed=True), v, None, [], "abstain")
    row = traces.build_trace(uuid4(), "realtime", uuid4(), uuid4(), "abstain", 3, out)
    assert row.experts["features"] == {} and row.experts["status"] == "abstain" and row.alert is False


def test_build_trace_gate_signals_are_l0_tags_not_verdict_signals():
    """verdict.signals에는 상대 말에서 나온 기대 문구("… 없음")가 섞일 수 있다. gate 신호(고정 태그)만 적는다."""
    v = Verdict(risk=0.7, top_reading="차갑게", signals=["짧은 답", "보라색코끼리 없음"], disagreement=0.1,
                confidence=0.8, abstain=False, alert=True, features={"prior": 0.5})
    out = pipeline.RealtimeOutcome(GateResult(prior=0.5, signals=["짧은 답"], passed=True), v, None, [], "alert")
    row = traces.build_trace(uuid4(), "realtime", uuid4(), uuid4(), "alert", 3, out)
    assert row.experts["gate"]["signals"] == ["짧은 답"] and "보라색코끼리" not in json.dumps(row.experts, ensure_ascii=False)
    assert row.risk == 0.7 and row.alert is True and row.experts["features"] == {"prior": 0.5}
