"""엔진의 DB 접근은 여기 한 곳이다. 라우트와 작업은 `Repo` Protocol만 안다(테스트는 tests/fakes.FakeRepo).

SQL은 모두 `$n` 파라미터로만 값을 받는다. 문자열로 SQL을 만들지 않는다.
하소연 원문은 받지도 쓰지도 않는다(FeedbackWrite에 문장 칸이 없다).
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Protocol
from uuid import UUID
from zoneinfo import ZoneInfo

import asyncpg

from harness.schemas import READINGS, TRIGGERS, FeedbackPattern

KST = ZoneInfo("Asia/Seoul")
GROUP_MIN_MEMBERS = 3  # 털어놓은 사람을 감출 수 있는 최소 인원. 이보다 작은 방은 global_patterns에만(규칙 14)


def check_patterns(patterns: list[FeedbackPattern]) -> None:
    """패턴 값을 SQL보다 먼저 검사한다. DB CHECK 위반이면 Postgres DETAIL(행 값 = L4가 흘린 하소연 조각)이
    asyncpg 예외 문자열에 실려 로그로 샐 수 있어서다. 메시지는 고정 문구이고 값을 싣지 않는다."""
    for p in patterns:
        if not (isinstance(p.trigger, str) and p.trigger in TRIGGERS):
            raise ValueError("unknown trigger") from None
        if not (isinstance(p.feeling, str) and p.feeling in READINGS):
            raise ValueError("unknown feeling") from None
        if not (type(p.strength) is int and 1 <= p.strength <= 3):
            raise ValueError("bad strength") from None


def week_start(ts: datetime) -> date:
    """ts의 KST 기준 ISO 주 월요일."""
    d = ts.astimezone(KST).date()
    return d - timedelta(days=d.weekday())


@dataclass(frozen=True)
class Room:
    id: UUID
    kind: str
    relation: str
    title: str | None
    member_count: int


@dataclass(frozen=True)
class Msg:
    id: int
    room_id: UUID
    sender_id: UUID
    text: str
    image_path: str | None
    reply_to: int | None
    created_at: datetime


@dataclass(frozen=True)
class SentMsg:
    id: int
    room_id: UUID
    text: str
    relation: str
    created_at: datetime


@dataclass(frozen=True)
class PushTarget:
    user_id: UUID
    token: str
    platform: str


@dataclass(frozen=True)
class TraceRow:
    trace_id: UUID
    path: str
    user_id: UUID
    room_id: UUID | None  # 거울 경로는 방이 없다
    experts: dict
    risk: float | None
    alert: bool
    latency_ms: int


@dataclass(frozen=True)
class FeedbackWrite:
    """보낸 사람·관계 칸은 없다: apply_feedback이 message_id로 DB에서 찾는다(호출자를 믿지 않는다)."""
    room_id: UUID
    reporter_id: UUID
    message_id: int
    usable: bool
    patterns: list[FeedbackPattern]
    to_sender: bool
    active_from: datetime


class Repo(Protocol):
    async def is_member(self, room_id: UUID, user_id: UUID) -> bool: ...
    async def room(self, room_id: UUID) -> Room | None: ...
    async def recent_messages(self, room_id: UUID, limit: int = 8) -> list[Msg]: ...  # 오래된 것 → 최신
    async def message(self, message_id: int) -> Msg | None: ...
    async def member_names(self, room_id: UUID) -> dict[UUID, str]: ...
    async def sender_patterns(self, sender_id: UUID, relation: str, now: datetime) -> dict[str, dict]: ...
    async def global_patterns(self) -> dict[str, int]: ...
    async def baseline(self, user_id: UUID) -> dict | None: ...
    async def update_baseline(self, user_id: UUID, length: int, polite: bool, softener: bool) -> None: ...
    async def insert_trace(self, row: TraceRow) -> None: ...
    async def insert_event(self, user_id: UUID, room_id: UUID, kind: str, top_reading: str | None,
                           signals: dict) -> None: ...
    async def weekly_feedback_count(self, sender_id: UUID, relation: str, since: datetime) -> int: ...
    async def apply_feedback(self, fb: FeedbackWrite) -> bool: ...
    async def push_targets(self, room_id: UUID, sender_id: UUID) -> list[PushTarget]: ...
    async def delete_push_token(self, user_id: UUID, token: str) -> None: ...
    async def sent_messages(self, user_id: UUID, since: datetime, limit: int = 50) -> list[SentMsg]: ...
    async def mirror_refs(self, user_id: UUID) -> set[str]: ...
    async def insert_mirror_attempt(self, user_id: UUID, kind: str, card_ref: str, answer_score: int | None,
                                    predicted: int | None, panel_bin: int | None, gap: int | None) -> None: ...
    async def event_counts(self, user_id: UUID) -> dict[str, int]: ...
    async def hints_by_week(self, user_id: UUID, since: datetime) -> dict[date, int]: ...
    async def predict_gap_by_week(self, user_id: UUID, since: datetime) -> dict[date, float]: ...


_MSG = "id, room_id, sender_id, text, image_path, reply_to, created_at"
_WEEK = "date_trunc('week', created_at at time zone 'Asia/Seoul')::date"  # KST 주 월요일(세션 TimeZone과 무관)


class PgRepo:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    @classmethod
    async def connect(cls, dsn: str) -> "PgRepo":
        # min_size=0: 시작할 때 연결하지 않는다(DB가 죽어 있어도 /health는 뜬다).
        # statement_cache_size=0: Supabase transaction pooler에서도 돈다. timeout은 연결, command_timeout은 쿼리.
        pool = await asyncpg.create_pool(dsn, min_size=0, max_size=5, statement_cache_size=0, command_timeout=5,
                                         timeout=3)
        return cls(pool)

    async def close(self) -> None:
        await self._pool.close()

    async def is_member(self, room_id: UUID, user_id: UUID) -> bool:
        return await self._pool.fetchval(
            "select exists(select 1 from public.room_members where room_id = $1 and user_id = $2)", room_id, user_id)

    async def room(self, room_id: UUID) -> Room | None:
        r = await self._pool.fetchrow(
            """select r.id, r.kind, r.relation, r.title,
                      (select count(*) from public.room_members m where m.room_id = r.id) as member_count
               from public.rooms r where r.id = $1""", room_id)
        return Room(**r) if r else None

    async def recent_messages(self, room_id: UUID, limit: int = 8) -> list[Msg]:
        rows = await self._pool.fetch(
            f"""select {_MSG} from (
                  select {_MSG} from public.messages where room_id = $1 order by created_at desc, id desc limit $2
                ) s order by created_at, id""", room_id, limit)
        return [Msg(**r) for r in rows]

    async def message(self, message_id: int) -> Msg | None:
        r = await self._pool.fetchrow(f"select {_MSG} from public.messages where id = $1", message_id)
        return Msg(**r) if r else None

    async def member_names(self, room_id: UUID) -> dict[UUID, str]:
        rows = await self._pool.fetch(
            """select p.id, p.name from public.room_members m join public.profiles p on p.id = m.user_id
               where m.room_id = $1""", room_id)
        return {r["id"]: r["name"] for r in rows}

    async def sender_patterns(self, sender_id: UUID, relation: str, now: datetime) -> dict[str, dict]:
        # 켜진(active_from <= now) 행을 trigger별로: count는 합, strength는 count 가중 평균, feeling은 가장 늦게 켜진 행
        rows = await self._pool.fetch(
            """select trigger, sum(count)::int as count,
                      (sum(strength::float8 * count) / sum(count))::float8 as strength,
                      (array_agg(feeling order by active_from desc))[1] as feeling
               from tone.sender_patterns
               where sender_id = $1 and relation = $2 and active_from <= $3 group by trigger""",
            sender_id, relation, now)
        return {r["trigger"]: {"count": r["count"], "strength": r["strength"], "feeling": r["feeling"]} for r in rows}

    async def global_patterns(self) -> dict[str, int]:
        return {r["trigger"]: r["count"] for r in await self._pool.fetch("select trigger, count from tone.global_patterns")}

    async def baseline(self, user_id: UUID) -> dict | None:
        r = await self._pool.fetchrow(
            "select avg_len, polite_rate, softener_rate, n from tone.baselines where user_id = $1", user_id)
        return dict(r) if r else None

    async def update_baseline(self, user_id: UUID, length: int, polite: bool, softener: bool) -> None:
        # 한 문장 upsert라 동시에 들어와도 행 잠금으로 줄을 선다(읽고-쓰기 경합 없음).
        await self._pool.execute(
            """insert into tone.baselines as b (user_id, avg_len, polite_rate, softener_rate, n)
               values ($1, $2, $3, $4, 1)
               on conflict (user_id) do update set
                 avg_len = (coalesce(b.avg_len, 0) * b.n + excluded.avg_len) / (b.n + 1),
                 polite_rate = (coalesce(b.polite_rate, 0) * b.n + excluded.polite_rate) / (b.n + 1),
                 softener_rate = (coalesce(b.softener_rate, 0) * b.n + excluded.softener_rate) / (b.n + 1),
                 n = b.n + 1""",
            user_id, float(length), float(polite), float(softener))

    async def insert_trace(self, row: TraceRow) -> None:
        await self._pool.execute(
            """insert into tone.analysis_traces (trace_id, path, user_id, room_id, experts, risk, alert, latency_ms)
               values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)""",
            row.trace_id, row.path, row.user_id, row.room_id, json.dumps(row.experts, ensure_ascii=False),
            row.risk, row.alert, row.latency_ms)

    async def insert_event(self, user_id: UUID, room_id: UUID, kind: str, top_reading: str | None,
                           signals: dict) -> None:
        # risk는 넣지 않는다(응답·앱에 내부 점수를 남기지 않음).
        await self._pool.execute(
            """insert into public.tone_events (user_id, room_id, kind, top_reading, signals)
               values ($1, $2, $3, $4, $5::jsonb)""",
            user_id, room_id, kind, top_reading, json.dumps(signals, ensure_ascii=False))

    async def weekly_feedback_count(self, sender_id: UUID, relation: str, since: datetime) -> int:
        # feedback_log에는 보낸 사람·관계 칸이 없다: 메시지와 방에서 찾는다.
        return await self._pool.fetchval(
            """select count(*) from tone.feedback_log f
               join public.messages m on m.id = f.message_id
               join public.rooms r on r.id = f.room_id
               where m.sender_id = $1 and r.relation = $2 and f.usable and f.created_at >= $3""",
            sender_id, relation, since)

    async def apply_feedback(self, fb: FeedbackWrite) -> bool:
        check_patterns(fb.patterns)  # 첫 쿼리 전에
        async with self._pool.acquire() as conn, conn.transaction():
            # 보낸 사람·관계·그룹 여부는 호출자가 아니라 여기서 읽는다. 규칙 14: 3명 이상 그룹방만 sender_patterns
            src = await conn.fetchrow(
                """select m.sender_id, r.relation,
                          r.kind = 'group' and (select count(*) from public.room_members x where x.room_id = r.id) >= $3
                            as to_sender_ok
                   from public.messages m join public.rooms r on r.id = m.room_id
                   where m.id = $1 and m.room_id = $2""", fb.message_id, fb.room_id, GROUP_MIN_MEMBERS)
            if src is None:
                raise ValueError("unknown message")
            logged = await conn.fetchval(
                """insert into tone.feedback_log (room_id, reporter_id, message_id, usable, pattern_count)
                   values ($1, $2, $3, $4, $5)
                   on conflict (reporter_id, message_id) do nothing returning id""",
                fb.room_id, fb.reporter_id, fb.message_id, fb.usable, len(fb.patterns) if fb.usable else 0)
            if logged is None:
                return False
            if not fb.usable:
                return True
            for p in sorted(fb.patterns, key=lambda p: p.trigger):  # 같은 순서로 잠가 동시 신고끼리 교착을 피한다
                first = await conn.fetchval(
                    """insert into tone.pattern_reporters (trigger, reporter_id) values ($1, $2)
                       on conflict do nothing returning true""", p.trigger, fb.reporter_id)
                if first:  # 전체 패턴 수 = 서로 다른 신고자 수
                    await conn.execute(
                        """insert into tone.global_patterns as g (trigger, count) values ($1, 1)
                           on conflict (trigger) do update set count = g.count + 1""", p.trigger)
                if fb.to_sender and src["to_sender_ok"]:
                    # 자기 active_from 행에만 쌓는다: 이미 켜진 행은 그대로라 재신고가 켜진 패턴을 끄지 않는다
                    await conn.execute(
                        """insert into tone.sender_patterns as s
                             (sender_id, relation, trigger, count, strength, feeling, active_from)
                           values ($1, $2, $3, 1, $4, $5, $6)
                           on conflict (sender_id, relation, trigger, active_from) do update set
                             count = s.count + 1,
                             strength = (s.strength * s.count + excluded.strength) / (s.count + 1),
                             feeling = excluded.feeling,
                             updated_at = now()""",
                        src["sender_id"], src["relation"], p.trigger, float(p.strength), p.feeling, fb.active_from)
            return True

    async def push_targets(self, room_id: UUID, sender_id: UUID) -> list[PushTarget]:
        rows = await self._pool.fetch(
            """select t.user_id, t.token, t.platform
               from public.room_members m join public.push_tokens t on t.user_id = m.user_id
               where m.room_id = $1 and m.user_id <> $2 and not m.muted""", room_id, sender_id)
        return [PushTarget(**r) for r in rows]

    async def delete_push_token(self, user_id: UUID, token: str) -> None:
        await self._pool.execute("delete from public.push_tokens where user_id = $1 and token = $2", user_id, token)

    async def sent_messages(self, user_id: UUID, since: datetime, limit: int = 50) -> list[SentMsg]:
        rows = await self._pool.fetch(
            """select m.id, m.room_id, m.text, r.relation, m.created_at
               from public.messages m join public.rooms r on r.id = m.room_id
               where m.sender_id = $1 and m.text <> '' and m.created_at >= $2
               order by m.created_at desc, m.id desc limit $3""", user_id, since, limit)
        return [SentMsg(**r) for r in rows]

    async def mirror_refs(self, user_id: UUID) -> set[str]:
        rows = await self._pool.fetch("select kind, card_ref from public.mirror_attempts where user_id = $1", user_id)
        return {f"{r['kind']}|{r['card_ref']}" for r in rows}

    async def insert_mirror_attempt(self, user_id: UUID, kind: str, card_ref: str, answer_score: int | None,
                                    predicted: int | None, panel_bin: int | None, gap: int | None) -> None:
        await self._pool.execute(
            """insert into public.mirror_attempts (user_id, kind, card_ref, answer_score, predicted, panel_bin, gap)
               values ($1, $2, $3, $4, $5, $6, $7)""", user_id, kind, card_ref, answer_score, predicted, panel_bin, gap)

    async def event_counts(self, user_id: UUID) -> dict[str, int]:
        rows = await self._pool.fetch(
            "select kind, count(*) as n from public.tone_events where user_id = $1 group by kind", user_id)
        return {r["kind"]: r["n"] for r in rows}

    async def hints_by_week(self, user_id: UUID, since: datetime) -> dict[date, int]:
        rows = await self._pool.fetch(
            f"""select {_WEEK} as wk, count(*) as n from public.tone_events
                where user_id = $1 and kind = 'hint_shown' and created_at >= $2 group by 1""", user_id, since)
        return {r["wk"]: r["n"] for r in rows}

    async def predict_gap_by_week(self, user_id: UUID, since: datetime) -> dict[date, float]:
        rows = await self._pool.fetch(
            f"""select {_WEEK} as wk, avg(gap)::float8 as g from public.mirror_attempts
                where user_id = $1 and kind = 'predict' and gap is not null and created_at >= $2 group by 1""",
            user_id, since)
        return {r["wk"]: r["g"] for r in rows}
