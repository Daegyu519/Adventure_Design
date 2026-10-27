"""털어놓기 큐 작업(T-24, ARCHITECTURE 3-4). 라우트가 가린 하소연을 메모리 큐 인자로 넘기고, 이 작업이 L4로 패턴 태그를
뽑아 주간 상한과 방 규칙대로 저장한다. 하소연·L4의 dropped_reason은 저장·로그·trace 어디에도 남기지 않는다(규칙 5).
고정 어휘(TRIGGERS)의 태그와 부정 읽힘만 저장한다: L4가 trigger 자리에 문장 조각을 내놓아도 여기서 걸러진다."""
from __future__ import annotations

import asyncio
from datetime import datetime, time, timedelta, timezone
from uuid import UUID

import pipeline
from app.db import GROUP_MIN_MEMBERS, KST, FeedbackWrite, Repo, week_start
from experts.registry import Registry
from harness.schemas import NEGATIVE, TRIGGERS

WEEKLY_CAP = 5     # 한 (보낸 사람, 관계)에 일주일(KST ISO 주) 동안 반영하는 신고 수(악용 방지)
DB_SLACK_S = 10.0  # L4 deadline 위에 DB 읽기·쓰기 몫. 작업 전체가 이보다 오래 공유 워커를 붙들지 않는다
# ponytail: 털어놓기 작업(최대 L4 60초 + DB)은 push·baseline과 같은 워커 2개를 나눠 쓴다. 라우트가 같은 (신고자, 메시지)와
#   상한에 걸린 (보낸 사람, 관계)는 큐에 안 넣고 재시도도 없지만(max_attempts=1), 한 사람이 서로 다른 메시지로 몰아치면 워커가 찬다.
#   사용자별 요청 한도는 T-38(429)에서, push가 늦어지면 작업 종류별 워커 풀로 나눈다.


def next_midnight_kst(now: datetime) -> datetime:
    return datetime.combine(now.astimezone(KST).date() + timedelta(days=1), time(0), KST)


async def at_weekly_cap(repo: Repo, sender_id: UUID, relation: str, now: datetime) -> bool:
    """이번 주(KST ISO 주의 월요일 0시부터, 주 번호만으로 세지 않는다) 이 (보낸 사람, 관계)에 반영한 신고가 상한인지."""
    since = datetime.combine(week_start(now), time(0), KST)
    return await repo.weekly_feedback_count(sender_id, relation, since) >= WEEKLY_CAP


async def run(repo: Repo, reg: Registry, room_id: UUID, reporter_id: UUID, message_id: int, complaint: str,
              now: datetime | None = None) -> None:
    """complaint는 라우트에서 가린 하소연(메모리 큐 인자로만 온다)."""
    async with asyncio.timeout(reg.cfg["paths"]["async"]["deadline_ms"] / 1000 + DB_SLACK_S):
        now = now or datetime.now(timezone.utc)
        msg, room, names = await asyncio.gather(repo.message(message_id), repo.room(room_id),
                                                repo.member_names(room_id))
        if msg is None or room is None:
            return
        result = await pipeline.feedback(reg, complaint, msg.text, room.relation, list(names.values()))
        patterns = [p for p in result.patterns if p.trigger in TRIGGERS and p.feeling in NEGATIVE] \
            if result is not None and result.usable else []
        # ponytail: 상한 확인과 apply_feedback이 한 트랜잭션이 아니라 동시에 도는 작업 수(워커 2개)만큼 넘칠 수 있다
        #   (최대 WEEKLY_CAP + 워커 수 - 1 = 6건). 정확해야 하면 apply_feedback 안에서 (보낸 사람, 관계) advisory lock 뒤에 센다.
        if patterns and await at_weekly_cap(repo, msg.sender_id, room.relation, now):
            patterns = []
        # 호출자의 요청일 뿐이다: 보낸 사람·관계·그룹 규칙은 apply_feedback이 SQL에서 다시 판정한다
        to_sender = room.kind == "group" and room.member_count >= GROUP_MIN_MEMBERS
        await repo.apply_feedback(FeedbackWrite(room_id, reporter_id, message_id, bool(patterns), patterns,
                                                to_sender, next_midnight_kst(now)))
