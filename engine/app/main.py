import os
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Literal

import yaml
from fastapi import FastAPI
from pydantic import BaseModel

from app.settings import DEFAULT_MODELS_PATH


@lru_cache
def load_config() -> dict:
    return yaml.safe_load(DEFAULT_MODELS_PATH.read_text(encoding="utf-8")) or {}


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    load_config()  # 파일이 없거나 깨졌으면 요청이 아니라 시작할 때 실패한다
    yield


app = FastAPI(title="tone-chat engine", lifespan=lifespan)


class HealthResponse(BaseModel):
    ok: bool
    models: dict[str, Literal["up", "down"]]


def model_status(cfg: dict, env: Mapping[str, str]) -> dict[str, str]:
    """roles의 모든 `provider:model`에 대해 쓸 수 있으면 "up", 아니면 "down"."""
    providers = cfg.get("providers", {})
    status: dict[str, str] = {}
    for models in cfg.get("roles", {}).values():
        for ref in models:
            name = ref.split(":", 1)[0]
            p = providers.get(name) or {}
            usable = name == "mock" or p.get("allow_no_key", False) or bool(env.get(p.get("api_key_env", "")))  # 빈 값(.env의 `KEY=`)은 없는 것으로
            status[ref] = "up" if usable else "down"
    return status


@app.get("/health")
def health() -> HealthResponse:
    return HealthResponse(ok=True, models=model_status(load_config(), os.environ))
