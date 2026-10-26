"""채팅 앱 저장소 (SQLite). 수업 데모용이라 파일 하나로 끝낸다. 운영 DB로 바꿀 때도 표 구조는 그대로 쓴다.

- 대화(messages)는 채팅 앱이라 저장한다. 두 사람 모두 가입할 때 '말투 도움' 이용에 동의한 상태를 전제로 한다.
- 하소연 원문은 어디에도 저장하지 않는다. feedback_log에는 '언제, 어느 대화에서, 쓸 만했는지'만 남는다.
- tone_events는 효과 측정용이다(알림 수, 살펴보기 비율, 고친 비율)."""
from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tone_hint_on INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  user_a TEXT NOT NULL REFERENCES users(id),
  user_b TEXT NOT NULL REFERENCES users(id),
  relation TEXT NOT NULL DEFAULT '친구',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tone_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- hint_shown, detail_opened, option_chosen, sent_with_hint, sent_after_fix
  risk REAL,
  top_reading TEXT,
  signals TEXT,                -- JSON 배열
  choice TEXT,                 -- A, B, original
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS feedback_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  usable INTEGER NOT NULL,
  pattern_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, id);
"""


class DB:
    def __init__(self, path: str | Path = ":memory:"):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        self.conn.executescript(SCHEMA)

    def _q(self, sql: str, args: tuple = ()) -> list[dict]:
        with self.lock:
            cur = self.conn.execute(sql, args)
            self.conn.commit()
            return [dict(r) for r in cur.fetchall()]

    # ----- 사용자·방 -----
    def upsert_user(self, uid: str, name: str) -> None:
        self._q("INSERT INTO users(id, name) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name", (uid, name))

    def user(self, uid: str) -> dict | None:
        rows = self._q("SELECT * FROM users WHERE id=?", (uid,))
        return rows[0] if rows else None

    def set_hint(self, uid: str, on: bool) -> None:
        self._q("UPDATE users SET tone_hint_on=? WHERE id=?", (int(on), uid))

    def create_room(self, rid: str, a: str, b: str, relation: str) -> dict:
        self._q("INSERT OR IGNORE INTO rooms(id, user_a, user_b, relation) VALUES(?, ?, ?, ?)", (rid, a, b, relation))
        return self.room(rid)

    def room(self, rid: str) -> dict | None:
        rows = self._q("SELECT * FROM rooms WHERE id=?", (rid,))
        return rows[0] if rows else None

    def rooms_of(self, uid: str) -> list[dict]:
        return self._q(
            "SELECT r.*, u.name AS other_name FROM rooms r "
            "JOIN users u ON u.id = CASE WHEN r.user_a=? THEN r.user_b ELSE r.user_a END "
            "WHERE r.user_a=? OR r.user_b=?", (uid, uid, uid))

    @staticmethod
    def other(room: dict, uid: str) -> str:
        return room["user_b"] if room["user_a"] == uid else room["user_a"]

    # ----- 메시지 -----
    def add_message(self, rid: str, sender: str, text: str) -> dict:
        with self.lock:
            cur = self.conn.execute("INSERT INTO messages(room_id, sender_id, text) VALUES(?, ?, ?)", (rid, sender, text))
            self.conn.commit()
            mid = cur.lastrowid
        return self._q("SELECT * FROM messages WHERE id=?", (mid,))[0]

    def message(self, mid: int) -> dict | None:
        rows = self._q("SELECT * FROM messages WHERE id=?", (mid,))
        return rows[0] if rows else None

    def recent(self, rid: str, n: int = 8) -> list[dict]:
        rows = self._q("SELECT * FROM messages WHERE room_id=? ORDER BY id DESC LIMIT ?", (rid, n))
        return list(reversed(rows))

    # ----- 측정 -----
    def log_event(self, rid: str, uid: str, kind: str, risk: float | None = None, top: str | None = None,
                  signals: list[str] | None = None, choice: str | None = None) -> None:
        self._q("INSERT INTO tone_events(room_id, user_id, kind, risk, top_reading, signals, choice) VALUES(?,?,?,?,?,?,?)",
                (rid, uid, kind, risk, top, json.dumps(signals or [], ensure_ascii=False), choice))

    def log_feedback(self, rid: str, reporter: str, mid: int, usable: bool, n: int) -> None:
        self._q("INSERT INTO feedback_log(room_id, reporter_id, message_id, usable, pattern_count) VALUES(?,?,?,?,?)",
                (rid, reporter, mid, int(usable), n))

    def stats(self, uid: str) -> dict:
        """리포트 화면용 숫자. 원문 없이 이벤트만으로 계산한다."""
        def count(kind: str) -> int:
            return self._q("SELECT COUNT(*) AS c FROM tone_events WHERE user_id=? AND kind=?", (uid, kind))[0]["c"]
        shown = count("hint_shown")
        fixed = count("sent_after_fix") + self._q(
            "SELECT COUNT(*) AS c FROM tone_events WHERE user_id=? AND kind='option_chosen' AND choice!='original'", (uid,))[0]["c"]
        return {"hints": shown, "details": count("detail_opened"), "fixed": fixed,
                "fix_rate": round(fixed / shown, 2) if shown else None}
