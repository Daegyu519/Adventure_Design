import os
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Literal

import yaml
from fastapi import FastAPI
from pydantic import BaseModel

from app.auth import get_verifier
from app.db import PgRepo
from app.routes import hooks
from app.settings import Settings
from harness.providers import available
from harness.router import chains
from jobs.queue import JobQueue


@lru_cache
def load_config() -> dict:
    return yaml.safe_load(Settings.from_env().models_path.read_text(encoding="utf-8")) or {}


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    load_config()  # 파일이 없거나 깨졌으면 요청이 아니라 시작할 때 실패한다
    dsn = Settings.from_env().supabase_db_url
    repo = await PgRepo.connect(dsn) if dsn else None  # 풀은 min_size=0: DB가 죽어 있어도 시작한다
    app.state.repo = repo
    queue = app.state.queue = JobQueue()
    queue.start()
    await get_verifier().warm()  # 첫 /v1/hint가 JWKS 받기를 기다리지 않게. 실패해도 시작은 한다
    try:
        yield
    finally:
        try:
            await queue.stop()  # 남은 작업이 repo를 쓸 수 있으니 repo보다 먼저 비운다
        finally:
            if repo:
                await repo.close()
                app.state.repo = None


app = FastAPI(title="tone-chat engine", lifespan=lifespan)
app.include_router(hooks.router)


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
