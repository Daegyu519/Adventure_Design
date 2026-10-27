"""메모리 Repo. tests/test_db.py의 계약 테스트가 PgRepo와 같은 동작을 강제한다.
시드 메서드는 동기, Repo 메서드는 async. 상태는 공개 속성이다(fake.traces, fake.events, fake.feedback_log, …)."""
from __future__ import annotations

import copy
import json
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from itertools import count
from typing import Any
from uuid import UUID

from app.db import GROUP_MIN_MEMBERS, FeedbackWrite, Msg, PushTarget, Room, SentMsg, TraceRow, check_patterns, week_start


# DB CHECK 제약과 같은 값 범위(supabase/migrations). 어긋나면 운영처럼 실패한다.
RELATIONS = {"친구", "팀원", "선후배", "기타"}
READINGS = {"차갑게", "성의없게", "화나게", "무난하게", "따뜻하게"}
TRACE_PATHS = {"hint", "detail", "mirror"}
EVENT_KINDS = {"hint_shown", "detail_opened", "option_chosen", "sent_with_hint", "sent_after_fix"}
MIRROR_KINDS = {"roleplay", "receive", "predict"}


def _check(ok: bool, what: str) -> None:
    if not ok:
        raise ValueError(f"check violation: {what}")


def _in(v: int | None, lo: int, hi: int) -> bool:
    return v is None or lo <= v <= hi


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _jsonb(v: dict) -> dict:
    """DB의 jsonb처럼: 직렬화할 수 있어야 하고, 넣은 객체와 따로 논다."""
    return json.loads(json.dumps(v, ensure_ascii=False))


@dataclass
class SenderPat:
    count: int
    strength: float
    feeling: str | None


class FakeRepo:
    def __init__(self) -> None:
        self.users: dict[UUID, str] = {}
        self.rooms: dict[UUID, dict] = {}                      # {kind, relation, title}
        self.members: dict[UUID, dict[UUID, bool]] = {}        # room → {user: muted}
        self.messages: dict[int, Msg] = {}
        self.push_tokens: list[PushTarget] = []
        self.events: list[dict] = []                           # public.tone_events 행
        self.mirror_attempts: list[dict] = []
        self.traces: list[dict] = []                           # tone.analysis_traces 행
        self.feedback_log: list[dict] = []
        self.sender_pats: dict[tuple[UUID, str, str, datetime], SenderPat] = {}   # PK (sender, relation, trigger, active_from)
        self.global_pats: dict[str, int] = {}
        self.pattern_reporters: set[tuple[str, UUID]] = set()
        self.baselines: dict[UUID, dict] = {}
        self._ids = count(1)

    # ── 시드 ───────────────────────────────────────────

    def add_user(self, name: str) -> UUID:
        uid = uuid.uuid4()
        self.users[uid] = name
        return uid

    def add_room(self, kind: str, relation: str, members: list[UUID], title: str | None = None) -> UUID:
        _check(relation in RELATIONS, "rooms.relation")
        rid = uuid.uuid4()
        self.rooms[rid] = {"kind": kind, "relation": relation, "title": title}
        self.members[rid] = {m: False for m in members}
        return rid

    def add_message(self, room_id: UUID, sender_id: UUID, text: str, *, image_path: str | None = None,
                    reply_to: int | None = None, at: datetime | None = None) -> int:
        mid = next(self._ids)
        self.messages[mid] = Msg(mid, room_id, sender_id, text, image_path, reply_to, at or _now())
        return mid

    def set_muted(self, room_id: UUID, user_id: UUID) -> None:
        self.members[room_id][user_id] = True

    def add_push_token(self, user_id: UUID, token: str, platform: str) -> None:
        self.push_tokens.append(PushTarget(user_id, token, platform))

    def add_event(self, user_id: UUID, room_id: UUID, kind: str, *, at: datetime | None = None) -> None:
        self.events.append({"id": next(self._ids), "room_id": room_id, "user_id": user_id, "kind": kind,
                            "risk": None, "top_reading": None, "signals": None, "choice": None,
                            "created_at": at or _now()})

    def add_mirror_attempt(self, user_id: UUID, kind: str, card_ref: str, *, gap: int | None = None,
                           at: datetime | None = None) -> None:
        self.mirror_attempts.append({"id": next(self._ids), "user_id": user_id, "kind": kind, "card_ref": card_ref,
                                     "answer_score": None, "predicted": None, "panel_bin": None, "gap": gap,
                                     "created_at": at or _now()})

    def add_sender_pattern(self, sender_id: UUID, relation: str, trigger: str, *, count: int = 1,
                           strength: float = 1.0, feeling: str | None = "차갑게", active_from: datetime) -> None:
        self.sender_pats[(sender_id, relation, trigger, active_from)] = SenderPat(count, strength, feeling)

    def set_global(self, trigger: str, count: int) -> None:
        self.global_pats[trigger] = count

    def rows(self, table: str) -> list[dict]:
        tables = {
            "public.tone_events": lambda: self.events,
            "public.mirror_attempts": lambda: self.mirror_attempts,
            "public.push_tokens": lambda: [asdict(t) for t in self.push_tokens],
            "tone.analysis_traces": lambda: self.traces,
            "tone.feedback_log": lambda: self.feedback_log,
            "tone.sender_patterns": lambda: [{"sender_id": s, "relation": r, "trigger": t, "active_from": a, **asdict(p)}
                                             for (s, r, t, a), p in self.sender_pats.items()],
            "tone.global_patterns": lambda: [{"trigger": t, "count": n} for t, n in self.global_pats.items()],
            "tone.pattern_reporters": lambda: [{"trigger": t, "reporter_id": u} for t, u in self.pattern_reporters],
            "tone.baselines": lambda: [{"user_id": u, **b} for u, b in self.baselines.items()],
        }
        return copy.deepcopy(tables[table]())

    # ── Repo ──────────────────────────────────────────

    async def is_member(self, room_id: UUID, user_id: UUID) -> bool:
        return user_id in self.members.get(room_id, {})

    async def room(self, room_id: UUID) -> Room | None:
        r = self.rooms.get(room_id)
        return Room(room_id, r["kind"], r["relation"], r["title"], len(self.members[room_id])) if r else None

    async def recent_messages(self, room_id: UUID, limit: int = 8) -> list[Msg]:
        msgs = sorted((m for m in self.messages.values() if m.room_id == room_id), key=lambda m: (m.created_at, m.id))
        return msgs[-limit:] if limit > 0 else []

    async def message(self, message_id: int) -> Msg | None:
        return self.messages.get(message_id)

    async def member_names(self, room_id: UUID) -> dict[UUID, str]:
        return {u: self.users[u] for u in self.members.get(room_id, {})}

    async def sender_patterns(self, sender_id: UUID, relation: str, now: datetime) -> dict[str, dict]:
        rows: dict[str, list[tuple[datetime, SenderPat]]] = {}
        for (s, r, t, a), p in self.sender_pats.items():
            if (s, r) == (sender_id, relation) and a <= now:
                rows.setdefault(t, []).append((a, p))
        out = {}
        for t, ps in rows.items():
            n = sum(p.count for _, p in ps)
            out[t] = {"count": n, "strength": sum(p.strength * p.count for _, p in ps) / n,
                      "feeling": max(ps, key=lambda ap: ap[0])[1].feeling}
        return out

    async def global_patterns(self) -> dict[str, int]:
        return dict(self.global_pats)

    async def baseline(self, user_id: UUID) -> dict | None:
        b = self.baselines.get(user_id)
        return dict(b) if b else None

    async def update_baseline(self, user_id: UUID, length: int, polite: bool, softener: bool) -> None:
        _check(length >= 0, "baselines.avg_len")
        b = self.baselines.get(user_id)
        if b is None:
            self.baselines[user_id] = {"avg_len": float(length), "polite_rate": float(polite),
                                       "softener_rate": float(softener), "n": 1}
            return
        n = b["n"]
        for key, v in (("avg_len", length), ("polite_rate", polite), ("softener_rate", softener)):
            b[key] = ((b[key] or 0.0) * n + float(v)) / (n + 1)
        b["n"] = n + 1

    async def insert_trace(self, row: TraceRow) -> None:
        _check(row.path in TRACE_PATHS, "analysis_traces.path")
        _check(row.risk is None or 0 <= row.risk <= 1, "analysis_traces.risk")
        _check(row.latency_ms >= 0, "analysis_traces.latency_ms")
        _check(len(json.dumps(row.experts, ensure_ascii=False).encode()) <= 16384, "analysis_traces.experts")
        self.traces.append({**asdict(row), "experts": _jsonb(row.experts), "created_at": _now()})

    async def insert_event(self, user_id: UUID, room_id: UUID, kind: str, top_reading: str | None,
                           signals: dict) -> None:
        _check(kind in EVENT_KINDS, "tone_events.kind")
        _check(top_reading is None or top_reading in READINGS, "tone_events.top_reading")
        _check(len(json.dumps(signals, ensure_ascii=False).encode()) <= 2000, "tone_events.signals")
        self.events.append({"id": next(self._ids), "room_id": room_id, "user_id": user_id, "kind": kind,
                            "risk": None, "top_reading": top_reading, "signals": _jsonb(signals), "choice": None,
                            "created_at": _now()})

    async def weekly_feedback_count(self, sender_id: UUID, relation: str, since: datetime) -> int:
        def counts(f: dict) -> bool:
            m = self.messages.get(f["message_id"])
            return (f["usable"] and f["created_at"] >= since and m is not None and m.sender_id == sender_id
                    and self.rooms[f["room_id"]]["relation"] == relation)
        return sum(1 for f in self.feedback_log if counts(f))

    async def apply_feedback(self, fb: FeedbackWrite) -> bool:
        # PgRepo와 같은 순서: 값 검사 → 메시지로 보낸 사람·관계를 찾음 → 쓰기. 실패하면 아무것도 안 남는다.
        check_patterns(fb.patterns)
        m = self.messages.get(fb.message_id)
        if m is None or m.room_id != fb.room_id:
            raise ValueError("unknown message")
        room = self.rooms[fb.room_id]
        to_sender = fb.to_sender and room["kind"] == "group" and len(self.members[fb.room_id]) >= GROUP_MIN_MEMBERS
        if any((f["reporter_id"], f["message_id"]) == (fb.reporter_id, fb.message_id) for f in self.feedback_log):
            return False
        self.feedback_log.append({"id": next(self._ids), "room_id": fb.room_id, "reporter_id": fb.reporter_id,
                                  "message_id": fb.message_id, "usable": fb.usable,
                                  "pattern_count": len(fb.patterns) if fb.usable else 0, "created_at": _now()})
        if not fb.usable:
            return True
        for p in sorted(fb.patterns, key=lambda p: p.trigger):
            if (p.trigger, fb.reporter_id) not in self.pattern_reporters:
                self.pattern_reporters.add((p.trigger, fb.reporter_id))
                self.global_pats[p.trigger] = self.global_pats.get(p.trigger, 0) + 1
            if to_sender:
                key = (m.sender_id, room["relation"], p.trigger, fb.active_from)
                old = self.sender_pats.get(key)
                if old is None:
                    self.sender_pats[key] = SenderPat(1, float(p.strength), p.feeling)
                else:
                    self.sender_pats[key] = SenderPat(old.count + 1, (old.strength * old.count + p.strength) / (old.count + 1),
                                                      p.feeling)
        return True

    async def push_targets(self, room_id: UUID, sender_id: UUID) -> list[PushTarget]:
        members = self.members.get(room_id, {})
        return [t for t in self.push_tokens
                if t.user_id in members and t.user_id != sender_id and not members[t.user_id]]

    async def delete_push_token(self, user_id: UUID, token: str) -> None:
        self.push_tokens = [t for t in self.push_tokens if (t.user_id, t.token) != (user_id, token)]

    async def sent_messages(self, user_id: UUID, since: datetime, limit: int = 50) -> list[SentMsg]:
        mine = [m for m in self.messages.values() if m.sender_id == user_id and m.text and m.created_at >= since]
        mine.sort(key=lambda m: (m.created_at, m.id), reverse=True)
        return [SentMsg(m.id, m.room_id, m.text, self.rooms[m.room_id]["relation"], m.created_at) for m in mine[:limit]]

    async def mirror_refs(self, user_id: UUID) -> set[str]:
        return {f"{a['kind']}|{a['card_ref']}" for a in self.mirror_attempts if a["user_id"] == user_id}

    async def insert_mirror_attempt(self, user_id: UUID, kind: str, card_ref: str, answer_score: int | None,
                                    predicted: int | None, panel_bin: int | None, gap: int | None) -> None:
        _check(kind in MIRROR_KINDS, "mirror_attempts.kind")
        _check(1 <= len(card_ref) <= 200, "mirror_attempts.card_ref")
        _check(all(_in(v, 1, 5) for v in (answer_score, predicted, panel_bin)) and _in(gap, 0, 4), "mirror_attempts score")
        self.mirror_attempts.append({"id": next(self._ids), "user_id": user_id, "kind": kind, "card_ref": card_ref,
                                     "answer_score": answer_score, "predicted": predicted, "panel_bin": panel_bin,
                                     "gap": gap, "created_at": _now()})

    async def event_counts(self, user_id: UUID) -> dict[str, int]:
        out: dict[str, int] = {}
        for e in self.events:
            if e["user_id"] == user_id:
                out[e["kind"]] = out.get(e["kind"], 0) + 1
        return out

    async def hints_by_week(self, user_id: UUID, since: datetime) -> dict[date, int]:
        out: dict[date, int] = {}
        for e in self.events:
            if e["user_id"] == user_id and e["kind"] == "hint_shown" and e["created_at"] >= since:
                wk = week_start(e["created_at"])
                out[wk] = out.get(wk, 0) + 1
        return out

    async def predict_gap_by_week(self, user_id: UUID, since: datetime) -> dict[date, float]:
        gaps: dict[date, list[int]] = {}
        for a in self.mirror_attempts:
            if (a["user_id"] == user_id and a["kind"] == "predict" and a["gap"] is not None
                    and a["created_at"] >= since):
                gaps.setdefault(week_start(a["created_at"]), []).append(a["gap"])
        return {wk: sum(g) / len(g) for wk, g in gaps.items()}


class FakeQueue:
    """JobQueue 대역: 넣기만 하고, 테스트가 `run_all()`로 직접 돌린다. 인자는 로그가 아니라 `.jobs`에만 있다."""

    def __init__(self, accepting: bool = True) -> None:
        self.accepting = accepting  # False면 가득 찬 큐처럼 거절한다(호출하는 쪽의 503 경로 테스트용)
        self.jobs: list[tuple[str, Callable[..., Awaitable[None]], tuple]] = []
        self.keys: list[str] = []  # 받은 멱등 키(JobQueue처럼 같은 키는 한 번만 받는다)
        self._ran = 0

    def enqueue(self, name: str, fn: Callable[..., Awaitable[None]], *args: Any, key: str | None = None) -> bool:
        if not self.accepting:
            return False
        if key is not None:
            if key in self.keys:
                return True
            self.keys.append(key)
        self.jobs.append((name, fn, args))
        return True

    def names(self) -> list[str]:
        return [name for name, _, _ in self.jobs]

    async def run_all(self) -> None:
        """넣은 순서대로 실행한다. 실행 중 새로 들어온 것도 돈다. 예외는 그대로 올린다."""
        while self._ran < len(self.jobs):
            _, fn, args = self.jobs[self._ran]
            self._ran += 1
            await fn(*args)
