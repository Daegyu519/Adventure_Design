import asyncio
import dataclasses
import socket

import asyncpg
import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import current_user
from app.db import PgRepo
from app.deps import get_queue, get_repo, get_settings
from app.main import app
from app.settings import Settings
from tests.fakes import FakeQueue, FakeRepo
from tests.pg import Cluster, PgSeeder, missing_reason


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """테스트는 mock 공급자만 쓴다. 실제 연결·DNS를 시도하면 바로 실패한다(OSError가 아니라 폴백으로 묻히지 않음).
    예외는 임시 Postgres의 유닉스 소켓 하나다(TCP는 끈 채로 띄운다)."""
    def deny(*_a, **_k):
        raise RuntimeError("테스트에서 네트워크 금지")

    real_connect = socket.socket.connect

    def connect(sock, address):
        if sock.family == socket.AF_UNIX:
            return real_connect(sock, address)
        deny()

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket.socket, "connect_ex", deny)
    monkeypatch.setattr(socket, "getaddrinfo", deny)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", deny)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", deny)


@pytest.fixture(autouse=True)
def mock_env(monkeypatch):
    monkeypatch.setenv("FORCE_MOCK", "1")
    for k in ("NVIDIA_API_KEY", "GITHUB_TOKEN", "GEMINI_API_KEY", "USE_LOCAL_MODEL"):
        monkeypatch.delenv(k, raising=False)


@pytest.fixture
def fake() -> FakeRepo:
    return FakeRepo()


@pytest.fixture
def queue() -> FakeQueue:
    return FakeQueue()


@pytest.fixture
def client(fake, queue):
    """lifespan은 돌지 않는다(`with` 없이 만든다). DB·큐는 fake, 설정은 테스트 값."""
    settings = dataclasses.replace(Settings.from_env(), hook_secret="test-secret",
                                   supabase_url="https://test.supabase.co")
    app.dependency_overrides[get_repo] = lambda: fake
    app.dependency_overrides[get_queue] = lambda: queue
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def login():
    """`login(user_id)` → 이 요청들은 그 사용자로 인증된 것으로 본다(토큰 검증은 test_auth.py에서 따로 본다)."""
    def do(user_id):
        app.dependency_overrides[current_user] = lambda: user_id

    yield do
    app.dependency_overrides.pop(current_user, None)


@pytest.fixture(scope="session")
def pg_cluster():
    reason = missing_reason()
    if reason:
        pytest.skip(reason)
    cluster = Cluster()
    try:
        cluster.start()
        yield cluster
    finally:
        cluster.stop()


@pytest.fixture
def pg_dsn(pg_cluster):
    """테스트마다 새 DB(템플릿 tpl 복사)."""
    name = pg_cluster.createdb()
    yield pg_cluster.dsn(name)
    pg_cluster.dropdb(name)


@pytest.fixture(params=["fake", "pg"])
def world(request):
    """`world(body)`가 `body(repo, seed)`를 asyncio.run으로 돌린다.
    asyncpg 풀은 만든 이벤트 루프에 묶이므로 pg 쪽은 body와 같은 루프 안에서 연결한다."""
    if request.param == "fake":
        repo = FakeRepo()
        return lambda body: asyncio.run(body(repo, repo))

    dsn = request.getfixturevalue("pg_dsn")

    async def run(body):
        repo = await PgRepo.connect(dsn)
        conn = await asyncpg.connect(dsn)
        try:
            return await body(repo, PgSeeder(conn))
        finally:
            await conn.close()
            await repo.close()

    return lambda body: asyncio.run(run(body))
