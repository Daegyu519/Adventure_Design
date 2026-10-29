"""POST /v1/mirror/today · /v1/mirror/answer(거울 세션, ARCHITECTURE 3-5).
card_id는 엔진이 서명한 출처 참조다. 답할 때 서명(422)·주인(403)·날짜(오늘·어제 KST, 422)를 보고, 문장은 앱이 아니라
DB(본인이 보낸 메시지)·카드 파일에서 다시 읽는다. 시간 초과·엔진 오류·결과 없음은 503이다."""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import date, datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

import mirror
import pipeline
from app.auth import current_user
from app.contracts import MirrorAnswerIn, MirrorAnswerOut, MirrorTodayOut, OptionOut, Readings
from app.db import KST, Repo
from app.deps import get_registry, get_repo
from experts.registry import Registry
from harness.schemas import Conversation, Turn
from harness.store import ProfileStore
from layers.aggregate import negative
from layers.guard import freq, guard

log = logging.getLogger(__name__)
router = APIRouter()
UNAVAILABLE = "engine_unavailable"
NEEDS = {"roleplay": "reply", "receive": "score", "predict": "predicted"}   # 종류별 필수 답


@router.post("/v1/mirror/today")
async def mirror_today(user: UUID = Depends(current_user), repo: Repo = Depends(get_repo)) -> MirrorTodayOut:
    now = datetime.now(timezone.utc)
    sent = await repo.sent_messages(user, now - timedelta(days=30))
    return MirrorTodayOut(cards=mirror.today_cards(user, now.astimezone(KST).date(), sent, await repo.mirror_refs(user),
                                                   mirror.get_content(), mirror.get_mirror_key()))


@router.post("/v1/mirror/answer")
async def mirror_answer(body: MirrorAnswerIn, user: UUID = Depends(current_user), repo: Repo = Depends(get_repo),
                        reg: Registry = Depends(get_registry)) -> MirrorAnswerOut:
    t0 = time.monotonic()
    today = datetime.now(KST).date()
    try:
        c = mirror.unsign(body.card_id, mirror.get_mirror_key())
    except ValueError:
        raise HTTPException(status_code=422, detail="bad_card") from None
    # 서명이 맞으면 payload는 엔진이 만든 것이다(모양은 today_cards가 정한다)
    kind, ref, relation, persona = c["k"], c["s"], c["r"], c["p"]
    if c["u"] != str(user):
        raise HTTPException(status_code=403, detail="forbidden")
    if date.fromisoformat(c["d"]) not in (today, today - timedelta(days=1)):
        raise HTTPException(status_code=422, detail="expired_card")
    if getattr(body, NEEDS[kind]) is None:
        raise HTTPException(status_code=422, detail=f"{NEEDS[kind]}_required")
    content = mirror.get_content()

    async def run() -> MirrorAnswerOut | None:
        if ref.startswith("msg:") and kind != "roleplay":   # 본인이 보낸 메시지만. 이름은 그 방 멤버(가리기용)
            m = await repo.message(int(ref.removeprefix("msg:")))
            if m is None or m.sender_id != user:
                raise HTTPException(status_code=403, detail="forbidden")
            text, names, sent_on = m.text, list((await repo.member_names(m.room_id)).values()), m.created_at
        else:
            card = next((x for x in content.cards if f"card:{x.id}" == ref), None)
            if card is None:
                raise HTTPException(status_code=422, detail="bad_card")
            text, names, sent_on = card.message if kind == "roleplay" else card.sample_reply, [], None

        if kind == "roleplay":
            convo = Conversation(pair_id="mirror", relation=relation,
                                 turns=[Turn(speaker="them", text=text, label=persona)])
            out = await pipeline.detail(reg, body.reply, convo, ProfileStore(), str(user), [], None, t0, path="mirror")
            if out.report is None:
                return None
            top = max(out.readings, key=out.readings.__getitem__)
            res = MirrorAnswerOut(readings=Readings(**out.report.readings), inner_voice=content.inner_voice[top],
                                  options=[OptionOut(**o.model_dump()) for o in out.report.options[:1]])
            score = predicted = panel = gap = None
        else:
            p = await pipeline.panel(reg, text, relation, names, t0)
            if p is None:
                return None
            score, predicted = (body.score, None) if kind == "receive" else (None, body.predicted)
            panel = mirror.panel_bin(negative(p))
            gap = abs((score or predicted) - panel)
            reveal = None
            if kind == "receive" and sent_on is not None:
                day = mirror.relative_day(sent_on.astimezone(KST).date(), today)
                reveal = guard(f"이건 {day}에 당신이 {mirror.WORD[relation]}에게 보낸 문장이에요")
            res = MirrorAnswerOut(readings=Readings(**{k: freq(v) for k, v in p.items()}), reveal=reveal, gap=gap)

        # ponytail: 읽고-쓰기라 동시에 두 번 답하면 두 줄이 남을 수 있다. 막아야 하면 (user_id, kind, card_ref) unique 제약
        if f"{kind}|{ref}" not in await repo.mirror_refs(user):
            await repo.insert_mirror_attempt(user, kind, ref, score, predicted, panel, gap)
        return res

    try:
        res = await asyncio.wait_for(run(), reg.cfg["paths"]["mirror"]["deadline_ms"] / 1000)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 - 시간 초과·엔진 오류는 503. 메시지에 문장이 섞일 수 있어 종류만 남긴다
        log.warning("mirror answer failed: %s", type(e).__name__)
        raise HTTPException(status_code=503, detail=UNAVAILABLE) from None
    if res is None:
        raise HTTPException(status_code=503, detail=UNAVAILABLE)
    return res
