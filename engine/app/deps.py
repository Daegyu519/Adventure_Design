from functools import lru_cache

from fastapi import HTTPException, Request

from app.db import Repo
from app.settings import Settings
from jobs.queue import JobQueue


@lru_cache
def get_settings() -> Settings:
    return Settings.from_env()


def get_repo(request: Request) -> Repo:
    repo = getattr(request.app.state, "repo", None)
    if repo is None:  # SUPABASE_DB_URL이 비어 있으면 DB가 필요한 요청만 503
        raise HTTPException(status_code=503, detail="db_unavailable")
    return repo


def get_queue(request: Request) -> JobQueue:
    return request.app.state.queue
