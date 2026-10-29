import asyncio
import os
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Literal

import yaml
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.auth import get_verifier
from app.db import PgRepo
from app.routes import detail, feedback, hint, hooks, mirror, stats
from app.settings import Settings
from harness.providers import available
from harness.router import chains
from jobs.feedback import QUEUE_MAXSIZE
from jobs.queue import JobQueue
from mirror import get_mirror_key


@lru_cache
def load_config() -> dict:
    return yaml.safe_load(Settings.from_env().models_path.read_text(encoding="utf-8")) or {}


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    load_config()  # 파일이 없거나 깨졌으면 요청이 아니라 시작할 때 실패한다
    get_mirror_key()  # MIRROR_SECRET가 짧으면 시작할 때 실패한다(없으면 경고 한 번)
    dsn = Settings.from_env().supabase_db_url
    repo = await PgRepo.connect(dsn) if dsn else None  # 풀은 min_size=0: DB가 죽어 있어도 시작한다
    app.state.repo = repo
    queue = app.state.queue = JobQueue()
    # 털어놓기 전용: 워커 1개(작업이 차례로 돌아 주간 상한이 넘치지 않는다), 작은 대기 한도. 몰아쳐도 공유 큐는 그대로다
    feedback_queue = app.state.feedback_queue = JobQueue(workers=1, maxsize=QUEUE_MAXSIZE)
    queue.start()
    feedback_queue.start()
    await get_verifier().warm()  # 첫 /v1/hint가 JWKS 받기를 기다리지 않게. 실패해도 시작은 한다
    try:
        yield
    finally:
        try:
            # 남은 작업이 repo를 쓸 수 있으니 repo보다 먼저 비운다. 하나가 실패해도 둘 다 끝난 뒤에 올린다
            errors = [e for e in await asyncio.gather(queue.stop(), feedback_queue.stop(), return_exceptions=True) if e]
            if errors:
                raise errors[0]
        finally:
            if repo:
                await repo.close()
                app.state.repo = None


app = FastAPI(title="tone-chat engine", lifespan=lifespan)
# 앱 웹 빌드가 Authorization 헤더를 달고 부를 때의 사전 요청(OPTIONS)을 통과시킨다. 쿠키를 쓰지 않아 credentials는 끈다.
app.add_middleware(CORSMiddleware, allow_origins=list(Settings.from_env().cors_origins),
                   allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Authorization", "Content-Type"])
app.include_router(hooks.router)
app.include_router(hint.router)
app.include_router(detail.router)
app.include_router(feedback.router)
app.include_router(stats.router)
app.include_router(mirror.router)


class HealthResponse(BaseModel):
    ok: bool
    models: dict[str, Literal["up", "down"]]


def model_status(cfg: dict, env: Mapping[str, str]) -> dict[str, str]:
    """전문가 사슬의 모든 `provider:model`에 대해 쓸 수 있으면 "up", 아니면 "down"."""
    providers = cfg.get("providers") or {}
    status: dict[str, str] = {}
    for chain in chains(cfg).values():
        for ref in chain:
            name = ref.split(":", 1)[0]
            status[ref] = "up" if available(name, providers.get(name) or {}, env) else "down"
    return status


@app.get("/health")
def health() -> HealthResponse:
    return HealthResponse(ok=True, models=model_status(load_config(), os.environ))
