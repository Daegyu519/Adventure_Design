"""GET /v1/stats/me: 로그인한 사용자 본인의 알림·살펴보기·고친 비율과 주별 추이(ARCHITECTURE 4장).
user_id는 토큰에서만 온다(파라미터 없음). 방이 없는 집계라 `ensure_member`는 필요 없다."""
from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends

from app.auth import current_user
from app.contracts import StatsOut, WeekCount, WeekGap
from app.db import KST, Repo, week_start
from app.ratelimit import RATE_LIMITED, limited
from app.deps import get_repo

WEEKS = 5   # 이번 주를 포함한 최근 5주(앱의 WEEKS_SHOWN과 같다)
router = APIRouter()


@router.get("/v1/stats/me", dependencies=[Depends(limited("default"))], responses=RATE_LIMITED)
async def stats_me(user: UUID = Depends(current_user), repo: Repo = Depends(get_repo)) -> StatsOut:
    first = week_start(datetime.now(timezone.utc)) - timedelta(weeks=WEEKS - 1)
    since = datetime.combine(first, time.min, tzinfo=KST)
    counts = await repo.event_counts(user)
    by_week = await repo.hints_by_week(user, since)
    gaps = await repo.predict_gap_by_week(user, since)
    weeks = [first + timedelta(weeks=i) for i in range(WEEKS)]
    fixed, with_hint = counts.get("sent_after_fix", 0), counts.get("sent_with_hint", 0)
    return StatsOut(
        hints=counts.get("hint_shown", 0), details=counts.get("detail_opened", 0), fixed=fixed,
        fix_rate=round(fixed / (fixed + with_hint), 2) if fixed + with_hint else 0.0,
        hints_by_week=[WeekCount(week=w.isoformat(), count=by_week.get(w, 0)) for w in weeks],
        predict_gap_trend=[WeekGap(week=w.isoformat(), avg_gap=gaps[w]) for w in weeks if w in gaps])
