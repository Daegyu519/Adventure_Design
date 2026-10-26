"""1:1 채팅 앱 서버. 채팅(WebSocket)과 말투 하네스를 한 프로세스에서 돌린다(수업 데모 규모).

흐름
- 입력 중:  클라이언트가 멈춘 지 0.5초 뒤 draft를 보냄 → 실시간 경로 → 보낸 사람에게만 hint
- 전송:     send → DB 저장 → 두 사람에게 message (힌트가 있어도 전송을 막지 않음)
- 살펴보기: POST /api/tone/detail → 상세 경로
- 털어놓기: 받은 메시지를 길게 눌러 POST /api/feedback → 패턴만 저장, 원문 버림
실행: uvicorn server.app:app --reload   (키가 없으면 mock 모델로 돈다)"""
from __future__ import annotations

import asyncio
import os
from collections import defaultdict
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel

from harness.pipeline import TonePipeline
from harness.router import Router
from harness.schemas import Conversation, Turn
from harness.store import ProfileStore

from .db import DB

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.getenv("TONE_DATA_DIR", ROOT / "data"))


# 요청 형식 (from __future__ annotations 때문에 모듈 수준에 둬야 FastAPI가 본문으로 인식한다)
class UserIn(BaseModel):
    id: str
    name: str


class RoomIn(BaseModel):
    user_a: str
    user_b: str
    relation: str = "친구"


class DetailIn(BaseModel):
    room_id: str
    user_id: str
    text: str
    intent: str = ""


class FeedbackIn(BaseModel):
    room_id: str
    user_id: str
    message_id: int
    text: str


class EventIn(BaseModel):
    room_id: str
    user_id: str
    kind: str
    choice: str | None = None
    risk: float | None = None
    top_reading: str | None = None
    signals: list[str] | None = None


class Hub:
    """접속한 사용자별 WebSocket 목록. 같은 사람이 여러 기기로 들어와도 다 받는다."""

    def __init__(self):
        self.sockets: dict[str, set[WebSocket]] = defaultdict(set)

    async def send(self, uid: str, payload: dict) -> None:
        for ws in list(self.sockets.get(uid, ())):
            try:
                await ws.send_json(payload)
            except Exception:
                self.sockets[uid].discard(ws)


def create_app(db_path: str | Path | None = None, store_path: str | Path | None = None,
               force_mock: bool | None = None) -> FastAPI:
    app = FastAPI(title="말투 알림 채팅")
    db = DB(db_path or DATA / "chat.db")
    store = ProfileStore.load(store_path or DATA / "patterns.json")
    router = Router.from_file(force_mock=os.getenv("FORCE_MOCK") == "1" if force_mock is None else force_mock)
    pipe = TonePipeline(router, store)
    hub = Hub()
    latest_seq: dict[tuple[str, str], int] = {}
    app.state.db, app.state.store, app.state.pipe = db, store, pipe

    # 데모용 기본 데이터: 민수·지은 1:1 방, 데이터셋에서 모였다고 가정한 일반 패턴
    db.upsert_user("minsu", "민수")
    db.upsert_user("jieun", "지은")
    db.create_room("minsu-jieun", "minsu", "jieun", "팀원")
    if not store.global_patterns:
        store.seed_global({"이유 없는 거절": 12, "짧은 답": 9, "감정 표현에 짧은 답": 7, "마침표로 끝남": 6})

    def member_room(rid: str, uid: str) -> dict:
        room = db.room(rid)
        if not room or uid not in (room["user_a"], room["user_b"]):
            raise HTTPException(404, "방이 없거나 참여자가 아님")
        return room

    def conversation(room: dict, uid: str) -> Conversation:
        """서버가 DB에서 직접 맥락을 만든다. 클라이언트가 보낸 맥락은 믿지 않는다."""
        turns = [Turn(speaker="me" if m["sender_id"] == uid else "them", text=m["text"]) for m in db.recent(room["id"])]
        return Conversation(pair_id=room["id"], relation=room["relation"], turns=turns)

    # ---------- REST ----------
    @app.get("/")
    def index():
        return FileResponse(Path(__file__).parent / "static" / "index.html")

    @app.post("/api/users")
    def add_user(u: UserIn):
        db.upsert_user(u.id, u.name)
        return db.user(u.id)

    @app.post("/api/users/{uid}/hint")
    def toggle_hint(uid: str, on: bool):
        db.set_hint(uid, on)
        return db.user(uid)

    @app.post("/api/rooms")
    def add_room(r: RoomIn):
        rid = "-".join(sorted([r.user_a, r.user_b]))
        return db.create_room(rid, r.user_a, r.user_b, r.relation)

    @app.get("/api/rooms")
    def list_rooms(user_id: str):
        return db.rooms_of(user_id)

    @app.get("/api/rooms/{rid}/messages")
    def messages(rid: str, user_id: str):
        member_room(rid, user_id)
        return db.recent(rid, 50)

    @app.post("/api/tone/detail")
    async def detail(d: DetailIn):
        room = member_room(d.room_id, d.user_id)
        convo = conversation(room, d.user_id)
        report = await pipe.detail(d.text, convo, d.intent, user_id=d.user_id)
        if report is None:
            return {"report": None}
        v = report.verdict
        db.log_event(d.room_id, d.user_id, "detail_opened", v.risk, v.top_reading, v.signals)
        # verdict.reason 같은 내부 값은 내보내지 않는다
        return {"report": {"alert": v.alert, "top_reading": v.top_reading, "readings": report.readings,
                           "why": report.why, "options": [o.model_dump() for o in report.options],
                           "footnote": report.footnote}}

    @app.post("/api/feedback")
    async def feedback(f: FeedbackIn):
        room = member_room(f.room_id, f.user_id)
        msg = db.message(f.message_id)
        if not msg or msg["room_id"] != room["id"] or msg["sender_id"] == f.user_id:
            raise HTTPException(400, "받은 메시지에만 털어놓을 수 있어요")
        result, ack = await pipe.feedback(f.text, room["id"], about_text=msg["text"])
        db.log_feedback(room["id"], f.user_id, f.message_id, result.usable, len(result.patterns))
        return {"ack": ack}          # 무엇이 추출됐는지는 털어놓은 사람에게도 보여 주지 않는다

    @app.post("/api/events")
    def event(e: EventIn):
        member_room(e.room_id, e.user_id)
        db.log_event(e.room_id, e.user_id, e.kind, e.risk, e.top_reading, e.signals, e.choice)
        return {"ok": True}

    @app.get("/api/stats/{uid}")
    def stats(uid: str):
        return db.stats(uid)

    # ---------- WebSocket ----------
    async def check_draft(uid: str, room: dict, text: str, seq: int) -> None:
        key = (uid, room["id"])
        r = await pipe.realtime(text, conversation(room, uid), user_id=uid)
        if latest_seq.get(key) != seq:
            return                    # 그사이 더 새로운 입력이 왔으면 버린다
        hint = r.hint.model_dump() if r.hint else None
        meta = None
        if r.hint and r.verdict:
            meta = {"risk": r.verdict.risk, "top_reading": r.verdict.top_reading, "signals": r.verdict.signals}
        await hub.send(uid, {"type": "hint", "room_id": room["id"], "seq": seq, "hint": hint, "meta": meta, "ms": r.ms})

    @app.websocket("/ws/{uid}")
    async def ws_endpoint(ws: WebSocket, uid: str):
        if not db.user(uid):
            await ws.close(code=4404)
            return
        await ws.accept()
        hub.sockets[uid].add(ws)
        try:
            while True:
                data = await ws.receive_json()
                room = db.room(data.get("room_id", ""))
                if not room or uid not in (room["user_a"], room["user_b"]):
                    await ws.send_json({"type": "error", "detail": "방이 없거나 참여자가 아님"})
                    continue
                if data["type"] == "draft":
                    seq = int(data.get("seq", 0))
                    latest_seq[(uid, room["id"])] = seq
                    if db.user(uid)["tone_hint_on"] and data.get("text", "").strip():
                        asyncio.create_task(check_draft(uid, room, data["text"], seq))
                    else:
                        await ws.send_json({"type": "hint", "room_id": room["id"], "seq": seq, "hint": None})
                elif data["type"] == "send":
                    text = data.get("text", "").strip()
                    if not text:
                        continue
                    latest_seq[(uid, room["id"])] = latest_seq.get((uid, room["id"]), 0) + 1   # 남은 검사 무효화
                    msg = db.add_message(room["id"], uid, text)
                    pipe.sent(text, user_id=uid)
                    for target in (uid, db.other(room, uid)):
                        await hub.send(target, {"type": "message", "message": msg, "client_id": data.get("client_id")})
        except WebSocketDisconnect:
            pass
        finally:
            hub.sockets[uid].discard(ws)

    return app


app = create_app()
