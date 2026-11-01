import asyncio
import logging
import os
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.auth import get_verifier
from app.db import PgRepo
from app.deps import get_registry
from app.limits import BodyLimit
from app.routes import detail, feedback, hint, hooks, mirror, stats
from app.ratelimit import get_limits
from app.settings import Settings, load_config
from experts.registry import Registry
from harness.providers import available
from harness.router import chains
from jobs.feedback import QUEUE_MAXSIZE
from jobs.queue import JobQueue
from mirror import get_mirror_key

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    load_config()  # 파일이 없거나 깨졌으면 요청이 아니라 시작할 때 실패한다
    get_limits()  # limits 값이 틀렸어도 시작할 때 실패한다
    startup_warnings(get_registry(), os.environ)  # 전문가·프롬프트가 틀렸으면 시작할 때 실패(E7), 쓸 수 없는 모델은 경고
    cfg = Settings.from_env()
    if cfg.hook_secret and not (cfg.vapid_private_key and cfg.vapid_subject):
        log.warning("web push disabled: vapid not configured")   # 웹 알림이 조용히 안 나가는 걸 시작할 때 알린다
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
            for c in get_registry().classifiers:   # 공유 httpx 클라이언트를 닫는다
                getattr(c.backend, "close", lambda: None)()
            if repo:
                await repo.close()
                app.state.repo = None


app = FastAPI(title="tone-chat engine", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)  # 공개 URL에 문서 노출 금지. 타입 생성은 app.openapi()(openapi_dump)
app.add_middleware(BodyLimit)  # CORS보다 안쪽: 413에도 CORS 헤더가 붙는다


@app.middleware("http")
async def unexpected_to_503(request: Request, call_next):
    """처리 못 한 예외: 로그엔 타입만(메시지에 문장이 섞일 수 있다), 응답은 고정 코드 503.
    CORS 바깥(ServerErrorMiddleware)에서 나는 500은 헤더가 없어 앱 웹이 오류를 읽지 못하므로 안쪽에서 잡는다."""
    try:
        return await call_next(request)
    except Exception as e:  # noqa: BLE001
        log.error("unhandled error: %s", type(e).__name__)
        return JSONResponse({"detail": "engine_unavailable"}, status_code=503)


@app.exception_handler(RequestValidationError)
async def invalid_request(_: Request, __: RequestValidationError) -> JSONResponse:
    """기본 422는 `input`(초안·하소연 원문)을 되돌려 준다. 고정 코드만 낸다."""
    return JSONResponse({"detail": "invalid_request"}, status_code=422)

# 앱 웹 빌드가 Authorization 헤더를 달고 부를 때의 사전 요청(OPTIONS)을 통과시킨다. 쿠키를 쓰지 않아 credentials는 끈다.
app.add_middleware(CORSMiddleware, allow_origins=list(Settings.from_env().cors_origins),
                   allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Authorization", "Content-Type"],
                   expose_headers=["Retry-After"])  # 429의 대기 시간을 웹 앱이 읽게 한다(T-15)
app.include_router(hooks.router)
app.include_router(hint.router)
app.include_router(detail.router)
app.include_router(feedback.router)
app.include_router(stats.router)
app.include_router(mirror.router)


class HealthResponse(BaseModel):
    ok: bool
    models: dict[str, Literal["up", "down"]]
    providers: dict[str, Literal["up", "down"]]
    classifiers: dict[str, Literal["up", "down"]]   # 판별기 id → 켜져 있고 서비스가 답하면 up(P-28)
    failures: dict[str, dict[str, int]]   # 공급자 → {실패·건너뜀 종류: 횟수}(프로세스 시작 뒤). 원문 없음


def provider_status(cfg: dict, env: Mapping[str, str], force_mock: bool = False) -> dict[str, str]:
    """mock은 force_mock(테스트·평가)일 때만 보인다. 운영에서 "up"으로 보이면 실제 모델이 산다고 오해한다."""
    providers = cfg.get("providers") or {}
    return {name: "up" if available(name, p or {}, env) else "down" for name, p in providers.items()
            if force_mock or name != "mock"}


def model_status(cfg: dict, env: Mapping[str, str]) -> dict[str, str]:
    """전문가 사슬의 모든 `provider:model`에 대해 쓸 수 있으면 "up", 아니면 "down"."""
    providers = cfg.get("providers") or {}
    status: dict[str, str] = {}
    for chain in chains(cfg).values():
        for ref in chain:
            name = ref.split(":", 1)[0]
            status[ref] = "up" if available(name, providers.get(name) or {}, env) else "down"
    return status


def startup_warnings(reg: Registry, env: Mapping[str, str]) -> None:
    """force_mock이 아닌데 쓸 수 없는 실제 모델은 시작할 때 한 번씩 알린다(키가 빠져 mock으로 도는 걸 조용히 두지 않는다)."""
    if reg.router.force_mock:
        return
    for ref, state in model_status(reg.cfg, env).items():
        if state == "down" and not ref.startswith("mock:"):
            log.warning("model unavailable at startup: %s", ref)


def classifier_status(cfg: dict, reg: Registry) -> dict[str, str]:
    live = {c.id: c for c in reg.classifiers}
    return {e["id"]: "up" if (c := live.get(e["id"])) and getattr(c.backend, "healthy", lambda: True)() else "down"
            for e in cfg.get("classifiers", []) if e.get("enabled")}


@app.get("/health")
def health(reg: Registry = Depends(get_registry)) -> HealthResponse:
    cfg = load_config()
    return HealthResponse(ok=True, models=model_status(cfg, os.environ), providers=provider_status(cfg, os.environ, reg.router.force_mock),
                          classifiers=classifier_status(cfg, reg), failures=reg.router.failures)
