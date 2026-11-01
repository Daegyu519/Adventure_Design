"""계약 테스트용 임시 Postgres. 이미 있는 클러스터·데이터 폴더는 건드리지 않는다.

세션마다 임시 폴더에 initdb → 유닉스 소켓만 열고(TCP 끔) 띄움 → DB `tpl`에 shim + 마이그레이션(_platform 제외) 적용.
테스트마다 `createdb -T tpl t<n>`, 끝나면 dropdb. 세션이 끝나면 `pg_ctl stop -m fast`와 임시 폴더 삭제.
`PG_BIN`(기본 Homebrew postgresql@16, keg-only라 PATH 밖)에 initdb가 없으면 pg 테스트는 건너뛴다.
"""
from __future__ import annotations

import asyncio
import inspect
import itertools
import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime
from pathlib import Path
from uuid import UUID

import asyncpg

PG_BIN = Path(os.environ.get("PG_BIN", "/opt/homebrew/opt/postgresql@16/bin"))
REPO_ROOT = Path(__file__).resolve().parents[2]
SHIM = REPO_ROOT / "supabase" / "tests" / "shim.sql"
MIGRATIONS = REPO_ROOT / "supabase" / "migrations"


async def w(x):
    """시드 호출 하나를 받는다: FakeRepo는 동기, PgSeeder는 async."""
    return await x if inspect.isawaitable(x) else x


def missing_reason() -> str | None:
    if not (PG_BIN / "initdb").exists():
        return f"postgres 없음({PG_BIN}/initdb): `brew install postgresql@16` 또는 PG_BIN 지정 시 pg 계약 테스트가 돈다"
    return None


class Cluster:
    def __init__(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="tone-pg-")
        # macOS 소켓 경로는 104바이트 제한이라 /tmp 아래 짧은 이름. worktree가 여럿 돌아도 겹치지 않는다.
        self.sock = tempfile.mkdtemp(prefix="tpg", dir="/tmp")
        self.data = os.path.join(self.tmp, "data")
        self._n = itertools.count()
        self._started = False

    def _run(self, tool: str, *args: str) -> None:
        subprocess.run([str(PG_BIN / tool), *args], check=True, capture_output=True)

    def dsn(self, db: str) -> str:
        return f"postgresql://postgres@/{db}?host={self.sock}"

    def start(self) -> None:
        self._run("initdb", "-D", self.data, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--no-locale")
        self._run("pg_ctl", "-D", self.data, "-o", f"-h '' -k {self.sock} -F -c shared_buffers=16MB",
                  "-w", "-l", os.path.join(self.tmp, "log"), "start")
        self._started = True
        asyncio.run(self._template())

    async def _template(self) -> None:
        conn = await asyncpg.connect(self.dsn("postgres"))
        try:
            await conn.execute("create database tpl")
        finally:
            await conn.close()
        conn = await asyncpg.connect(self.dsn("tpl"))
        try:
            await conn.execute(SHIM.read_text(encoding="utf-8"))
            for f in sorted(MIGRATIONS.glob("*.sql")):
                if "_platform" not in f.name:
                    await conn.execute(f.read_text(encoding="utf-8"))
        finally:
            await conn.close()

    def createdb(self) -> str:
        name = f"t{next(self._n)}"
        self._run("createdb", "-h", self.sock, "-U", "postgres", "-T", "tpl", name)
        return name

    def dropdb(self, name: str) -> None:
        self._run("dropdb", "-h", self.sock, "-U", "postgres", name)

    def stop(self) -> None:
        try:
            if self._started:
                self._run("pg_ctl", "-D", self.data, "-m", "fast", "-w", "stop")
        finally:
            shutil.rmtree(self.tmp, ignore_errors=True)
            shutil.rmtree(self.sock, ignore_errors=True)


TABLE = re.compile(r"(public|tone)\.[a-z_]+")


class PgSeeder:
    """FakeRepo의 시드 메서드와 같은 이름·인자. 슈퍼유저 연결로 바로 넣는다(테스트 전용)."""

    def __init__(self, conn: asyncpg.Connection) -> None:
        self.conn = conn

    async def add_user(self, name: str) -> UUID:
        uid = uuid.uuid4()
        await self.conn.execute("insert into auth.users(id) values ($1)", uid)
        await self.conn.execute("insert into public.profiles(id, name) values ($1, $2)", uid, name)
        return uid

    async def add_room(self, kind: str, relation: str, members: list[UUID], title: str | None = None) -> UUID:
        rid = await self.conn.fetchval(
            "insert into public.rooms(kind, relation, title) values ($1, $2, $3) returning id", kind, relation, title)
        for m in members:
            await self.conn.execute("insert into public.room_members(room_id, user_id) values ($1, $2)", rid, m)
        return rid

    async def add_message(self, room_id: UUID, sender_id: UUID, text: str, *, image_path: str | None = None, file_path: str | None = None,
                          reply_to: int | None = None, at: datetime | None = None) -> int:
        return await self.conn.fetchval(
            """insert into public.messages(room_id, sender_id, text, image_path, file_path, file_name, file_size, reply_to, created_at)
               values ($1, $2, $3, $4, $5, case when $5::text is null then null else 'x.pdf' end,
                       case when $5::text is null then null else 10 end, $6, coalesce($7, now())) returning id""",
            room_id, sender_id, text, image_path, file_path, reply_to, at)

    async def set_muted(self, room_id: UUID, user_id: UUID) -> None:
        await self.conn.execute(
            "update public.room_members set muted = true where room_id = $1 and user_id = $2", room_id, user_id)

    async def add_push_token(self, user_id: UUID, token: str, platform: str) -> None:
        await self.conn.execute(
            "insert into public.push_tokens(user_id, token, platform) values ($1, $2, $3)", user_id, token, platform)

    async def add_event(self, user_id: UUID, room_id: UUID, kind: str, *, at: datetime | None = None) -> None:
        await self.conn.execute(
            "insert into public.tone_events(user_id, room_id, kind, created_at) values ($1, $2, $3, coalesce($4, now()))",
            user_id, room_id, kind, at)

    async def add_mirror_attempt(self, user_id: UUID, kind: str, card_ref: str, *, gap: int | None = None,
                                 at: datetime | None = None) -> None:
        await self.conn.execute(
            """insert into public.mirror_attempts(user_id, kind, card_ref, gap, created_at)
               values ($1, $2, $3, $4, coalesce($5, now()))""", user_id, kind, card_ref, gap, at)

    async def add_sender_pattern(self, sender_id: UUID, relation: str, trigger: str, *, count: int = 1,
                                 strength: float = 1.0, feeling: str | None = "차갑게",
                                 active_from: datetime) -> None:
        await self.conn.execute(
            """insert into tone.sender_patterns(sender_id, relation, trigger, count, strength, feeling, active_from)
               values ($1, $2, $3, $4, $5, $6, $7)""", sender_id, relation, trigger, count, strength, feeling, active_from)

    async def set_global(self, trigger: str, count: int) -> None:
        await self.conn.execute(
            """insert into tone.global_patterns(trigger, count) values ($1, $2)
               on conflict (trigger) do update set count = excluded.count""", trigger, count)

    async def rows(self, table: str) -> list[dict]:
        if not TABLE.fullmatch(table):  # 이름은 정규식을 통과한 것만 SQL에 붙인다
            raise ValueError(table)
        await self.conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
        return [dict(r) for r in await self.conn.fetch(f"select * from {table} t order by t::text")]
