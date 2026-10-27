from datetime import date, datetime, timedelta, timezone

from app.db import week_start

NOW = datetime.now(timezone.utc)
THIS_WEEK = week_start(NOW)
KEYS = {"hints", "details", "fixed", "fix_rate", "hints_by_week", "predict_gap_trend"}


def _get(client):
    return client.get("/v1/stats/me")


def _events(fake, user, room, kind, n, at=None):
    for _ in range(n):
        fake.add_event(user, room, kind, at=at)


def _me(fake):
    me, you = fake.add_user("김지은"), fake.add_user("박민수")
    return me, you, fake.add_room("direct", "친구", [me, you])


def test_counts_and_fix_rate(client, login, fake):
    me, _, room = _me(fake)
    for kind, n in (("hint_shown", 4), ("detail_opened", 2), ("sent_with_hint", 1), ("sent_after_fix", 3)):
        _events(fake, me, room, kind, n)
    login(me)
    r = _get(client)
    assert r.status_code == 200
    body = r.json()
    assert set(body) == KEYS   # 내부 칸 없이 계약 그대로
    assert (body["hints"], body["details"], body["fixed"], body["fix_rate"]) == (4, 2, 3, 0.75)


def test_fix_rate_rounds_to_two_places(client, login, fake):
    me, _, room = _me(fake)
    _events(fake, me, room, "sent_after_fix", 1)
    _events(fake, me, room, "sent_with_hint", 2)
    login(me)
    assert _get(client).json()["fix_rate"] == 0.33


def test_fix_rate_zero_without_sends(client, login, fake):
    me, _, room = _me(fake)
    login(me)
    body = _get(client).json()
    assert (body["hints"], body["details"], body["fixed"], body["fix_rate"]) == (0, 0, 0, 0.0)
    assert body["predict_gap_trend"] == []
    _events(fake, me, room, "hint_shown", 2)   # 힌트만 있고 보낸 것이 없어도 0.0
    assert _get(client).json()["fix_rate"] == 0.0


def test_hints_by_week_five_zero_filled(client, login, fake):
    me, _, room = _me(fake)
    _events(fake, me, room, "hint_shown", 2)
    _events(fake, me, room, "hint_shown", 1, at=NOW - timedelta(weeks=2))
    _events(fake, me, room, "hint_shown", 4, at=NOW - timedelta(weeks=6))   # 5주 밖: 합계에만 든다
    login(me)
    body = _get(client).json()
    weeks = [(THIS_WEEK - timedelta(weeks=i)).isoformat() for i in range(4, -1, -1)]
    assert [w["week"] for w in body["hints_by_week"]] == weeks   # 오래된 것부터, 마지막이 이번 주 월요일
    assert [w["count"] for w in body["hints_by_week"]] == [0, 0, 1, 0, 2]
    assert date.fromisoformat(body["hints_by_week"][-1]["week"]).weekday() == 0
    assert body["hints"] == 7


def test_predict_gap_trend_matches_attempts(client, login, fake):
    me, _, _ = _me(fake)
    fake.add_mirror_attempt(me, "predict", "c1", gap=1)
    fake.add_mirror_attempt(me, "predict", "c2", gap=3)
    fake.add_mirror_attempt(me, "predict", "c0", gap=4, at=NOW - timedelta(weeks=3))
    fake.add_mirror_attempt(me, "predict", "c9", gap=4, at=NOW - timedelta(weeks=6))   # 5주 밖
    fake.add_mirror_attempt(me, "roleplay", "c3", gap=0)                              # predict만 센다
    login(me)
    assert _get(client).json()["predict_gap_trend"] == [
        {"week": (THIS_WEEK - timedelta(weeks=3)).isoformat(), "avg_gap": 4.0},
        {"week": THIS_WEEK.isoformat(), "avg_gap": 2.0}]


def test_other_users_not_counted(client, login, fake):
    me, you, room = _me(fake)
    for kind in ("hint_shown", "detail_opened", "sent_with_hint", "sent_after_fix"):
        _events(fake, you, room, kind, 2)
    fake.add_mirror_attempt(you, "predict", "c1", gap=2)
    login(me)
    body = _get(client).json()
    assert (body["hints"], body["details"], body["fixed"], body["fix_rate"]) == (0, 0, 0, 0.0)
    assert [w["count"] for w in body["hints_by_week"]] == [0] * 5 and body["predict_gap_trend"] == []


def test_no_token_401(client):
    assert _get(client).status_code == 401
