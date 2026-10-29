"""POST /v1/detail(T-21): 판정(큰 맥락 + 말투 여럿, 갈리면 심판) → 어긋남 → 고쳐 쓰기 + 세 가지 확인 → 이름 복원.
spy 모델 이름은 mock_rules 함수 이름이다(context, tone, tone_alt, judge, rewrite)."""
import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from uuid import uuid4

import pytest

import pipeline
from app.context import load_context
from experts.base import ExpertRequest, ExpertResult
from harness.router import NoResult
from harness.schemas import READINGS, RewriteOption, ToneReading
from jobs import events
from layers import rewrite
from layers.guard import FOOTNOTE, OPTION_LABELS, render_mismatch

NOW = datetime.now(timezone.utc)
ASK = "이번 주만 마감 하루 미뤄도 될까요? 집에 일이 생겨서요"
DRAFT = "안 돼요."
PII_DRAFT = "민수야 안 돼요. 010-1234-5678로 전화해"
SOFT = "지금은 어려울 것 같아요. (이유)"
BODY_KEYS = {"alert", "top_reading", "readings", "why", "options", "mismatch", "footnote", "trace_id"}


def _room(fake, me_name="김지은", you_name="박민수"):
    me, you = fake.add_user(me_name), fake.add_user(you_name)
    room = fake.add_room("direct", "팀원", [me, you])
    fake.add_message(room, you, ASK)
    return me, you, room


def _post(c, room, text=DRAFT, **kw):
    return c.post("/v1/detail", json={"room_id": str(room), "text": text, **kw})


def _tone(neg: float, conf: float = 0.6, key: str = "차갑게") -> dict:
    return {"readings": {key: neg, "무난하게": round(1 - neg, 3)}, "cues": [], "has_reason": False, "confidence": conf}


def _opt(text: str, keep=("거절 의도",), change=("말끝",)) -> dict:
    return {"label": "모델이 붙인 라벨", "text": text, "keep": list(keep), "change": list(change)}


def _models(spy, start: int = 0) -> list[str]:
    return [c["model"] for c in spy.calls[start:]]


def _floats(x) -> list[float]:
    if isinstance(x, float):
        return [x]
    if isinstance(x, dict):
        return [f for v in x.values() for f in _floats(v)]
    if isinstance(x, list):
        return [f for v in x for f in _floats(v)]
    return []


def _detail(fake, registry, me, room, text=DRAFT, intent=None) -> pipeline.DetailOutcome:
    ctx = asyncio.run(load_context(fake, room, me, None, NOW))
    return asyncio.run(pipeline.detail(registry, text, ctx.convo, ctx.store, str(me), ctx.names, intent,
                                       time.monotonic()))


# ── 응답 ──────────────────────────────────────────────

def test_alert_with_readings_and_options(client, login, fake):
    me, _, room = _room(fake)
    login(me)
    start = time.monotonic()
    r = _post(client, room)
    assert r.status_code == 200 and time.monotonic() - start < 8
    b = r.json()
    assert b["alert"] is True and b["top_reading"] == "차갑게"
    assert set(b["readings"]) == set(READINGS) and set(b["readings"].values()) <= {"자주", "가끔", "드물어요"}
    assert 1 <= len(b["options"]) <= 2 and all(o["label"] in OPTION_LABELS for o in b["options"])
    assert b["footnote"] == FOOTNOTE and b["why"] and b["mismatch"] is None


def test_no_internal_scores_in_response(client, login, fake):
    me, _, room = _room(fake)
    login(me)
    b = _post(client, room).json()
    assert set(b) == BODY_KEYS
    assert all(set(o) == {"label", "text", "keep", "change"} for o in b["options"])
    assert _floats(b) == []


def test_intent_recall_only_reruns_rewrite(client, login, fake, spy):
    me, _, room = _room(fake)
    login(me)
    first = _post(client, room)
    assert first.status_code == 200 and "rewrite" in _models(spy)
    n = len(spy.calls)
    again = _post(client, room, intent="미안하게")
    assert again.status_code == 200
    assert _models(spy, n) == ["rewrite"]   # 판정(맥락·말투·후보 재판정)은 라우터 캐시에서


def test_intent_not_in_judging_inputs(client, login, fake, spy):
    me, _, room = _room(fake)
    login(me)
    spy.canned |= {"tone": lambda p: _tone(.9), "tone_alt": lambda p: _tone(.1)}   # 심판까지 부른다
    assert _post(client, room, intent="미안하게").status_code == 200
    judging = [c for c in spy.calls if c["model"] != "rewrite"]
    rewrites = [c for c in spy.calls if c["model"] == "rewrite"]
    assert {"context", "tone", "tone_alt", "judge"} <= {c["model"] for c in judging} and rewrites
    assert all(c["payload"]["intent"] is None and "미안하게" not in c["user"] for c in judging)
    assert rewrites[0]["payload"]["intent"] == "미안하게" and "내 의도: 미안하게" in rewrites[0]["user"]
    assert all(c["user"].startswith("방: 1:1\n") for c in spy.calls)   # 심판·고쳐 쓰기 프롬프트에도 방 줄


@pytest.mark.parametrize("bad", ["네 할게요.", "안 돼.", "안 돼요."])   # 거절→승낙, 반말, 덜 부정적 아님
def test_rewrite_checks_drop_bad_candidates(client, login, fake, spy, bad):
    me, _, room = _room(fake)
    login(me)
    spy.canned["rewrite"] = lambda p: {"options": [_opt(bad), _opt(SOFT)]}
    b = _post(client, room).json()
    assert [(o["label"], o["text"]) for o in b["options"]] == [(OPTION_LABELS[1], SOFT)]


def test_rewrite_restores_masked_values(client, login, fake, spy):
    me, _, room = _room(fake)
    login(me)
    b = _post(client, room, PII_DRAFT).json()
    texts = " ".join(o["text"] for o in b["options"])
    assert b["options"] and "민수" in texts and "010-1234-5678" in texts
    shown = json.dumps(b, ensure_ascii=False)
    assert "[이름" not in shown and "[전화번호" not in shown
    assert "민수" not in spy.seen() and "010-1234" not in spy.seen()


@pytest.mark.parametrize("where,opt", [
    ("text", _opt("[이름7]야 " + SOFT)),                     # 모델이 지어낸 자리표시는 되돌릴 수 없다
    ("text-unnumbered", _opt("[이름]야 " + SOFT)),           # 번호 없는 자리표시 모양도
    ("text-underscore", _opt("[이름_7]야 " + SOFT)),          # 번호 앞에 기호가 붙어도(restore가 못 되돌린다)
    ("change-unnumbered", _opt(SOFT, change=["[긴 숫자] 지움"])),
    ("keep", _opt(SOFT, keep=["[전화번호2] 그대로"])),
    ("keep-forbidden", _opt(SOFT, keep=["반드시 거절"])),
    ("change", _opt(SOFT, change=["분명히 부드럽게"])),       # 문구 검사(금지어)
])
def test_option_dropped_when_unrestored_or_forbidden(client, login, fake, spy, where, opt):
    me, _, room = _room(fake)
    login(me)
    spy.canned["rewrite"] = lambda p: {"options": [opt, _opt(SOFT)]}
    b = _post(client, room).json()
    assert [o["label"] for o in b["options"]] == [OPTION_LABELS[1]], where


def test_only_first_two_candidates(client, login, fake, spy):
    me, _, room = _room(fake)
    login(me)
    spy.canned["rewrite"] = lambda p: {"options": [_opt(SOFT), _opt("지금은 어려워요 (이유)"), _opt("어렵겠어요 (이유)")]}
    b = _post(client, room).json()
    assert [o["label"] for o in b["options"]] == list(OPTION_LABELS)


def test_checker_is_first_tone_expert_that_answered(client, login, fake, spy):
    """경로의 첫 말투 전문가가 답하지 못하면, 원문을 읽은 다음 전문가가 후보도 읽는다."""
    me, _, room = _room(fake)
    login(me)
    spy.canned["tone"] = lambda p: "not json"
    b = _post(client, room).json()
    assert b["alert"] and b["options"]
    assert _models(spy).count("tone_alt") >= 2   # 원문 + 후보


def test_bracket_label_typed_in_draft_is_kept(client, login, fake, spy):
    """사용자가 직접 쓴 대괄호 말([사진])이 후보에 그대로 있으면 자리표시로 보지 않는다."""
    me, _, room = _room(fake)
    login(me)
    spy.canned["rewrite"] = lambda p: {"options": [_opt("[사진] " + SOFT), _opt("[사진] 지금은 어려워요 (이유)")]}
    b = _post(client, room, "[사진] 안 돼요.").json()
    assert b["alert"] and b["options"] and all(o["text"].startswith("[사진] ") for o in b["options"])


# ── 세 가지 확인 ───────────────────────────────────────

@pytest.mark.parametrize("cand,ok", [
    ("네 할게요.", False),                  # 거절이 승낙으로
    ("안 돼.", False),                      # 존댓말 → 반말
    (SOFT, True),
    ("지금은 어려워요 (이유는 나중에)", True),   # 괄호 빈칸을 빼고 보면 존댓말로 끝난다
    ("(안 돼요) 좋아요", False),            # 괄호 속 거절은 거절로 치지 않는다
])
def test_surface_ok(cand, ok):
    assert rewrite.surface_ok(DRAFT, cand) is ok


class _Checker:
    """후보 문장 → neg. None이면 그 후보에서 실패한다."""
    id, role, paths, weight = "c", "tone", {"detail"}, 1.0

    def __init__(self, negs: dict[str, float | None]):
        self.negs = negs

    async def run(self, req: ExpertRequest, deadline: float) -> ExpertResult:
        neg = self.negs[req.draft]
        if neg is None:
            raise NoResult("x")
        out = ToneReading(readings={"차갑게": neg, "무난하게": 1 - neg}, confidence=1.0)
        return ExpertResult(expert_id=self.id, role="tone", output=out, confidence=1.0, latency_ms=0, model="t")


def test_check_needs_lower_neg_and_a_working_checker():
    opts = [RewriteOption(label="x", text=t) for t in ("어려울 것 같아요.", "지금은 어려워요.", "어렵겠어요.")]
    checker = _Checker({"어려울 것 같아요.": .75, "지금은 어려워요.": .5, "어렵겠어요.": None})
    assert all(rewrite.surface_ok(DRAFT, o.text) for o in opts)   # 셋 다 checker까지 간다
    req = ExpertRequest(path="detail", draft=DRAFT, relation="팀원")
    out = asyncio.run(rewrite.check(checker, req, opts, .7, time.monotonic() + 1))
    assert out == [(1, opts[1])]   # 덜 부정적이지 않은 것, checker가 실패한 것은 탈락. 원래 순번은 그대로


# ── 어긋남 ────────────────────────────────────────────

@pytest.mark.parametrize("intent,top,expected", [
    ("단호하게", "차갑게", None),   # 단호한 거절이 차갑게 읽히는 것은 어긋남이 아니다
    ("단호하게", "화나게", "단호하게 말하려던 것과 달리 화난 것처럼 읽힐 수도 있어요"),
    ("미안하게", "차갑게", "미안하게 말하려던 것과 달리 차갑게 읽힐 수도 있어요"),
    ("미안하게", "성의없게", "미안하게 말하려던 것과 달리 성의 없게 읽힐 수도 있어요"),
    ("가볍게", "성의없게", None),
    ("가볍게", "무난하게", None),
    (None, "화나게", None),
])
def test_mismatch_table(intent, top, expected):
    readings = {k: 0.1 for k in READINGS} | {top: 0.6}
    assert render_mismatch(intent, readings) == expected


def test_mismatch_in_response_body(client, login, fake, spy):
    me, _, room = _room(fake)
    login(me)
    spy.canned |= {"tone": lambda p: _tone(.6, key="화나게"), "tone_alt": lambda p: _tone(.6, key="화나게")}
    assert _post(client, room, intent="단호하게").json()["mismatch"].startswith("단호하게 말하려던 것과 달리")
    assert _post(client, room).json()["mismatch"] is None   # 앱은 이 값을 그대로 보여 준다


def test_member_named_like_intent_keeps_mismatch(client, login, fake, spy):
    """의도 칩 값은 고정 Literal이라 어긋남은 원래 값으로 본다. 모델로 가는 의도만 가린 값이다."""
    me, _, room = _room(fake, you_name="미안")
    login(me)
    b = _post(client, room, intent="미안하게").json()
    assert b["mismatch"] == "미안하게 말하려던 것과 달리 차갑게 읽힐 수도 있어요" and b["options"]
    rw = [c for c in spy.calls if c["model"] == "rewrite"]
    assert rw and "[이름" in rw[0]["payload"]["intent"] and "미안" not in rw[0]["payload"]["intent"]


def test_mismatch_alone_triggers_rewrite(fake, registry, spy):
    me, _, room = _room(fake)
    angry_but_mild = {"readings": {"화나게": .4, "무난하게": .3, "따뜻하게": .3}, "confidence": .6}
    spy.canned |= {"tone": lambda p: angry_but_mild, "tone_alt": lambda p: angry_but_mild}
    plain = _detail(fake, registry, me, room, "좋아요!")
    assert not plain.verdict.alert and plain.mismatch is None and "rewrite" not in _models(spy)
    firm = _detail(fake, registry, me, room, "좋아요!", intent="단호하게")
    assert not firm.verdict.alert and firm.mismatch and "rewrite" in _models(spy)


# ── 심판 ──────────────────────────────────────────────

@pytest.mark.parametrize("judged", [True, False, None])   # None: 심판 실패 → 기권 그대로
def test_judge_called_on_disagreement(fake, registry, spy, judged):
    me, _, room = _room(fake)
    spy.canned |= {"tone": lambda p: _tone(.9), "tone_alt": lambda p: _tone(.1),
                   "judge": lambda p: "not json" if judged is None else {"alert": judged, "reason": "r"}}
    out = _detail(fake, registry, me, room)
    assert out.verdict.disagreement > registry.cfg["aggregate"]["max_disagreement"]
    calls = [c for c in spy.calls if c["model"] == "judge"]
    assert calls and set(calls[0]["payload"]) >= {"context", "tone_a", "tone_b", "risk"}
    assert json.loads(calls[0]["payload"]["tone_a"])["readings"]["차갑게"] == .9
    assert json.loads(calls[0]["payload"]["tone_b"])["readings"]["차갑게"] == .1
    assert out.verdict.abstain is (judged is None) and out.verdict.alert is bool(judged)
    assert ("rewrite" in _models(spy)) is bool(judged)


def test_judge_skipped_for_low_confidence_abstain(fake, registry, spy):
    """심판은 의견이 갈린 기권만 푼다. 자신 없는 기권은 심판이 답할 수 있어도 기권으로 남는다."""
    me, _, room = _room(fake)
    spy.canned |= {"tone": lambda p: _tone(.9, conf=.05), "tone_alt": lambda p: _tone(.1, conf=.05),
                   "judge": lambda p: {"alert": True, "reason": "r"}}
    out = _detail(fake, registry, me, room)
    agg = registry.cfg["aggregate"]
    assert out.verdict.disagreement > agg["max_disagreement"] and out.verdict.confidence < agg["min_confidence"]
    assert "judge" not in _models(spy) and out.verdict.abstain and not out.verdict.alert
    assert out.report.options == []


def test_judge_gate_uses_unrounded_confidence(fake, registry, spy):
    """집계는 반올림 전 값으로 기권한다(0.3996 < 0.4). 반올림한 0.4로 심판을 부르면 자신 없는 기권이 풀린다."""
    me, _, room = _room(fake)
    spy.canned |= {"tone": lambda p: _tone(.9, conf=.0992), "tone_alt": lambda p: _tone(.1, conf=.0992),
                   "judge": lambda p: {"alert": True, "reason": "r"}}
    out = _detail(fake, registry, me, room)
    assert out.verdict.confidence == registry.cfg["aggregate"]["min_confidence"]   # 보이는 값은 반올림된 경계
    assert out.verdict.features["confidence"] < registry.cfg["aggregate"]["min_confidence"]
    assert "judge" not in _models(spy) and out.verdict.abstain and not out.verdict.alert


# ── 기록 · 오류 ────────────────────────────────────────

def test_detail_opened_recorded_once(client, login, fake, queue):
    me, _, room = _room(fake)
    login(me)
    b = _post(client, room).json()
    assert queue.names() == ["event", "trace"]   # trace는 요청마다(T-19)
    _, fn, args = queue.jobs[0]
    assert fn is events.record and args[0] is fake   # 작업이 스스로 제한 시간을 둔다
    assert args[1:5] == (me, room, "detail_opened", b["top_reading"])
    assert isinstance(args[-1], dict) and set(args[-1]) == {"signals", "trace_id"}
    assert isinstance(args[-1]["signals"], list) and args[-1]["trace_id"] == b["trace_id"]
    assert DRAFT not in json.dumps(args, ensure_ascii=False, default=str)   # 큐 인자에 문장 없음
    assert _post(client, room, intent="미안하게").status_code == 200
    assert queue.names() == ["event", "trace", "trace"]   # 칩을 바꾼 재호출은 detail_opened를 기록하지 않는다
    asyncio.run(queue.run_all())
    assert [(e["kind"], e["top_reading"], e["risk"]) for e in fake.events] == [("detail_opened", "차갑게", None)]


def test_event_job_times_out_on_stalled_insert(monkeypatch):
    """멈춘 DB 호출이 공유 워커를 붙들지 않게 기록 작업이 스스로 시간을 자른다(큐가 재시도한다)."""
    monkeypatch.setattr(events, "EVENT_DEADLINE_S", 0.05)

    class Stalled:
        async def insert_event(self, *_a):
            await asyncio.sleep(10)
    t0 = time.monotonic()
    with pytest.raises(TimeoutError):
        asyncio.run(events.record(Stalled(), uuid4(), uuid4(), "detail_opened", "차갑게", {"signals": []}))
    assert time.monotonic() - t0 < 1


def test_no_tone_result_503(client, login, fake, spy, queue):
    me, _, room = _room(fake)
    login(me)
    spy.canned |= {"tone": lambda p: "not json", "tone_alt": lambda p: "not json"}
    r = _post(client, room)
    assert r.status_code == 503 and r.json() == {"detail": "engine_unavailable"}
    assert queue.names() == ["trace"]   # detail_opened는 없고 trace만 남는다(T-19)


def test_timeout_503_and_errors_log_type_only(client, login, fake, registry, monkeypatch, caplog):
    me, _, room = _room(fake)
    login(me)

    async def slow(*_a, **_k):
        await asyncio.sleep(2)
        return []
    monkeypatch.setattr(fake, "recent_messages", slow)
    registry.cfg["paths"]["detail"]["deadline_ms"] = 300
    start = time.monotonic()
    assert _post(client, room).status_code == 503 and time.monotonic() - start < 1

    async def boom(*_a, **_k):
        raise RuntimeError("secret 박민수")
    monkeypatch.setattr(fake, "member_names", boom)
    with caplog.at_level(logging.WARNING):
        assert _post(client, room).status_code == 503
    assert "detail failed: RuntimeError" in caplog.text and "secret" not in caplog.text


def test_no_raw_pii_reaches_any_expert(client, login, fake, spy):
    me, you, room = _room(fake)
    target = fake.add_message(room, you, "민수야 지은이 번호 010-9876-5432로 연락해줘")
    login(me)
    spy.canned |= {"tone": lambda p: _tone(.9 if p["draft"].startswith("[이름") else .1),
                   "tone_alt": lambda p: _tone(.1), "judge": lambda p: {"alert": True, "reason": "r"}}
    b = _post(client, room, PII_DRAFT, reply_to=target).json()
    models = _models(spy)
    assert {"context", "tone", "tone_alt", "judge", "rewrite"} <= set(models)
    assert models.count("tone") >= 2 and b["options"]   # 후보 재판정까지 돌았다
    seen = spy.seen()
    assert "민수" not in seen and "지은" not in seen
    assert "010-1234" not in seen and "010-9876" not in seen and "9876-5432" not in seen


def test_reply_to_other_room_422(client, login, fake):
    me, you, room = _room(fake)
    other = fake.add_room("direct", "친구", [me, fake.add_user("최수아")])
    login(me)
    assert _post(client, room, reply_to=fake.add_message(other, me, "다른 방")).status_code == 422
    assert _post(client, room, reply_to=fake.add_message(room, you, "같은 방")).status_code == 200


@pytest.mark.parametrize("bad", [{"intent": "화나게"}, {"text": " "}, {"text": "가" * 501}, {"reply_to": 0}])
def test_detail_validation_422(client, login, fake, bad):
    me, _, room = _room(fake)
    login(me)
    assert client.post("/v1/detail", json={"room_id": str(room), "text": DRAFT} | bad).status_code == 422


# ── 거울용 패널 ────────────────────────────────────────

def test_panel_reads_masked_draft_with_mirror_tones_only(registry, spy):
    p = asyncio.run(pipeline.panel(registry, "민수야 안 돼요.", "선후배", ["박민수"], time.monotonic()))
    assert set(p) == set(READINGS) and abs(sum(p.values()) - 1) < 0.01
    assert set(_models(spy)) == {"tone", "tone_alt"} and all(c["payload"]["turns"] == [] for c in spy.calls)
    assert "민수" not in spy.seen()
    spy.canned |= {"tone": lambda p: "not json", "tone_alt": lambda p: "not json"}
    assert asyncio.run(pipeline.panel(registry, "다른 문장", "친구", [], time.monotonic())) is None
