"""방 맥락 읽기. 엔진은 앱이 보낸 맥락을 믿지 않는다: 최근 대화·답장 대상·패턴·기준선은 모두 DB에서 읽는다.
멤버 확인(`ensure_member`)은 호출자가 먼저 한다. 여기서 읽은 문장은 아직 가리지 않았다(가리기는 pipeline 입구)."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from fastapi import HTTPException

from app.db import Msg, Repo, Room
from harness.schemas import Conversation, Turn
from harness.store import ProfileStore

RECENT = 8
PHOTO = "(사진)"   # 사진은 모델에 보내지 않는다


@dataclass(frozen=True)
class RoomContext:
    convo: Conversation
    store: ProfileStore
    names: list[str]
    room: Room


async def _none() -> None:
    return None


class _Labels:
    """나 / 상대(1:1) / 상대1, 상대2 …(그룹, 처음 나온 순서)."""

    def __init__(self, me: UUID, group: bool) -> None:
        self._me, self._group, self._seen = me, group, {}

    def turn(self, m: Msg, prefix: str = "") -> Turn:
        if m.sender_id == self._me:
            speaker, label = "me", "나"
        else:
            speaker = "them"
            label = self._seen.setdefault(m.sender_id, f"상대{len(self._seen) + 1}" if self._group else "상대")
        return Turn(speaker=speaker, text=m.text or PHOTO, label=prefix + label)


async def load_context(repo: Repo, room_id: UUID, user_id: UUID, reply_to: int | None, now: datetime) -> RoomContext:
    room, msgs, members, base, global_patterns, target = await asyncio.gather(
        repo.room(room_id), repo.recent_messages(room_id, RECENT), repo.member_names(room_id),
        repo.baseline(user_id), repo.global_patterns(),
        repo.message(reply_to) if reply_to is not None else _none())
    if room is None:   # 멤버 확인 뒤 사라진 방: 존재 여부를 알리지 않는 같은 403
        raise HTTPException(status_code=403, detail="not_a_member")
    if reply_to is not None and (target is None or target.room_id != room_id):
        raise HTTPException(status_code=422, detail="reply_to not in room")

    pair = f"{user_id}:{room.relation}"
    # active_from이 지난 것만(저장소가 거른다). global_min_obs 조건은 gate·aggregate가 본다.
    patterns = await repo.sender_patterns(user_id, room.relation, now)

    labels = _Labels(user_id, room.kind == "group")
    turns = [labels.turn(m) for m in msgs]
    convo = Conversation(pair_id=pair, relation=room.relation, kind=room.kind, turns=turns,
                         reply_to=labels.turn(target, "답장 대상 · ") if target else None)
    store = ProfileStore(pair_patterns={pair: patterns}, global_patterns=global_patterns,
                         baselines={str(user_id): base} if base else {})
    return RoomContext(convo=convo, store=store, names=list(members.values()), room=room)
