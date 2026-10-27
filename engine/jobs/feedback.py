"""털어놓기(T-24). 하소연 원문은 요청 안에서만 쓴다: `classify`가 L4로 패턴 태그를 뽑고 원문을 버린다.
큐에는 id와 분류 결과(고정 어휘의 태그·읽힘·강도)만 넣고, `run`이 주간 상한과 방 규칙을 적용해 저장한다.
원문·L4의 dropped_reason은 저장·로그·trace·큐 인자 어디에도 남기지 않는다(규칙 5)."""
from __future__ import annotations

import asyncio
from datetime import datetime, time, timedelta, timezone
from uuid import UUID

import pipeline
from app.db import GROUP_MIN_MEMBERS, KST, FeedbackWrite, Msg, Repo, week_start
from experts.registry import Registry
from harness.schemas import NEGATIVE, TRIGGERS, FeedbackPattern

WEEKLY_CAP = 5   # 한 (보낸 사람, 관계)에 일주일(KST ISO 주) 동안 반영하는 신고 수(악용 방지)


def next_midnight_kst(now: datetime) -> datetime:
    return datetime.combine(now.astimezone(KST).date() + timedelta(days=1), time(0), KST)


async def classify(repo: Repo, reg: Registry, msg: Msg, complaint: str) -> list[FeedbackPattern]:
    """요청 안에서 부른다. 저장해도 되는 패턴만 돌려준다: 고정 어휘(TRIGGERS)의 태그와 부정 읽힘.
    L4가 trigger 자리에 문장 조각을 내놓아도 여기서 걸러진다. 쓸모없는 신고면 []."""
    room, names = await asyncio.gather(repo.room(msg.room_id), repo.member_names(msg.room_id))
    result = await pipeline.feedback(reg, complaint, msg.text, room.relation, list(names.values()))
    if result is None or not result.usable:
        return []
    return [p for p in result.patterns if p.trigger in TRIGGERS and p.feeling in NEGATIVE]


async def run(repo: Repo, room_id: UUID, reporter_id: UUID, message_id: int, patterns: list[FeedbackPattern],
              now: datetime | None = None) -> None:
    """큐 작업. 인자는 id와 분류 결과뿐이다."""
    now = now or datetime.now(timezone.utc)
    msg, room = await asyncio.gather(repo.message(message_id), repo.room(room_id))
    if msg is None or room is None:
        return
    since = datetime.combine(week_start(now), time(0), KST)   # 주 번호가 아니라 KST 월요일 0시부터 센다
    if patterns and await repo.weekly_feedback_count(msg.sender_id, room.relation, since) >= WEEKLY_CAP:
        patterns = []
    # 호출자의 요청일 뿐이다: 보낸 사람·관계·그룹 규칙은 apply_feedback가 SQL에서 다시 판정한다
    to_sender = room.kind == "group" and room.member_count >= GROUP_MIN_MEMBERS
    await repo.apply_feedback(FeedbackWrite(room_id, reporter_id, message_id, bool(patterns), patterns, to_sender,
                                            next_midnight_kst(now)))
