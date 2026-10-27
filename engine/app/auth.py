"""엔진의 인증 경계. 앱이 보낸 Supabase access token(Bearer)을 JWKS 공개키로 검증하고, 방 멤버인지 확인한다.
Repo는 접근 검사를 하지 않는다: 방을 읽는 모든 라우트는 `current_user`와 `ensure_member`를 거쳐야 한다.
토큰은 어디에도 남기지 않는다(로그·예외 메시지·응답 본문 금지). 거절 사유는 고정 문구나 예외 종류 이름만 쓴다."""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from functools import lru_cache
from uuid import UUID

import httpx
import jwt
from fastapi import Depends, Header, HTTPException

from app.db import Repo
from app.deps import get_settings

log = logging.getLogger(__name__)

# 힌트 예산이 1.5초라 느린 JWKS 서버를 오래 기다리지 않는다.
JWKS_TIMEOUT_S = 1.0
# 비대칭 알고리즘만 받는다. HS256(공개키를 비밀로 쓰는 혼동 공격)과 none은 여기서 걸러진다.
ALGORITHMS = ("ES256", "RS256")
REQUIRED_CLAIMS = ["exp", "sub", "aud", "iss"]
USER_ROLE = "authenticated"  # anon·service_role 토큰과 익명 로그인(is_anonymous)은 사용자로 보지 않는다


class AuthError(Exception):
    """토큰을 믿을 수 없다. 메시지는 고정 문구(토큰 내용 금지)."""


class AuthUnavailable(AuthError):
    """키를 얻을 수 없어 검증하지 못했다(JWKS 장애·빈 키 집합). 토큰이 나쁜 게 아니라서 401이 아니라 503으로 답한다."""


class NoUsableKeys(Exception):
    """JWKS 응답에 쓸 수 있는 키가 하나도 없다."""


class TokenVerifier:
    def __init__(
        self,
        issuer: str,
        fetch_jwks: Callable[[], Awaitable[dict]],
        *,
        audience: str = "authenticated",
        ttl_s: float = 600.0,
        refetch_gap_s: float = 60.0,
        failure_backoff_s: float = 3.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._issuer = issuer
        self._fetch = fetch_jwks
        self._audience = audience
        self._ttl = ttl_s
        self._gap = refetch_gap_s
        self._backoff = failure_backoff_s
        self._clock = clock
        self._keys: dict[str, jwt.PyJWK] = {}
        self._fetched_at: float | None = None  # 마지막으로 키를 성공해서 받은 시각(빈 응답은 성공이 아니다)
        self._failed: tuple[str, float] | None = None  # 마지막 시도가 실패했으면 (예외 종류, 시각)
        self._gen = 0  # 끝난 받기 시도 수. 기다리는 사이 시도가 끝났으면 그 결과를 같이 쓴다
        self._lock = asyncio.Lock()  # 동시 요청이 JWKS 서버를 한꺼번에 두드리지 않게

    async def verify(self, token: str) -> UUID:
        try:
            header = jwt.get_unverified_header(token)
        except (jwt.PyJWTError, TypeError, ValueError):
            raise AuthError("malformed token") from None
        alg, kid = header.get("alg"), header.get("kid")
        if alg not in ALGORITHMS:
            raise AuthError("unsupported alg")
        if not isinstance(kid, str):
            raise AuthError("missing kid")
        key = await self._key(kid)
        if key.algorithm_name != alg:
            raise AuthError("alg does not match key")
        try:
            claims = jwt.decode(
                token, key.key, algorithms=[alg], audience=self._audience, issuer=self._issuer,
                options={"require": REQUIRED_CLAIMS}, leeway=10)
        except jwt.PyJWTError as e:
            raise AuthError(type(e).__name__) from None
        if claims.get("role") != USER_ROLE or claims.get("is_anonymous") not in (None, False):
            raise AuthError("not a user token")
        try:
            return UUID(claims["sub"])
        except (ValueError, TypeError, AttributeError):
            raise AuthError("invalid sub") from None

    async def warm(self) -> None:
        """서버가 뜰 때 키를 미리 받아 둔다(첫 요청이 JWKS 받기를 기다리지 않게). 실패해도 시작을 막지 않는다.
        실패해도 backoff는 걸지 않는다: 첫 요청이 바로 다시 받는다."""
        try:
            async with self._lock:
                await self._refresh()
                self._gen += 1
        except Exception as e:  # noqa: BLE001 - 예외 종류만 남긴다(메시지에 URL·응답이 섞일 수 있다)
            log.warning("jwks warm failed: %s", type(e).__name__)

    # ── 키 캐시 ────────────────────────────────────────

    def _age(self) -> float | None:
        return None if self._fetched_at is None else self._clock() - self._fetched_at

    def _cached(self, kid: str) -> jwt.PyJWK | None:
        age = self._age()
        return self._keys.get(kid) if age is not None and age < self._ttl else None

    def _recent_failure(self) -> str | None:
        """backoff 안에 실패한 시도가 있으면 그 예외 종류."""
        if self._failed and self._clock() - self._failed[1] < self._backoff:
            return self._failed[0]
        return None

    def _may_attempt(self) -> bool:
        if self._recent_failure() is not None:
            return False
        age = self._age()
        return age is None or age >= min(self._gap, self._ttl)

    async def _key(self, kid: str) -> jwt.PyJWK:
        key = self._cached(kid)
        if key is None:
            seen = self._gen
            async with self._lock:
                key = self._cached(kid)  # 기다리는 사이 다른 요청이 받아 왔을 수 있다
                # 기다리는 사이 시도가 한 번이라도 끝났으면(성공이든 실패든) 그 결과를 같이 쓴다
                if key is None and self._gen == seen and self._may_attempt():
                    try:
                        await self._refresh()
                        self._failed = None
                    except Exception as e:  # noqa: BLE001
                        self._failed = (type(e).__name__, self._clock())
                    self._gen += 1
                    key = self._cached(kid)
            if key is None:
                if (why := self._recent_failure()) is not None:
                    raise AuthUnavailable(f"jwks unavailable: {why}")
                raise AuthError("unknown kid")
        return key

    async def _refresh(self) -> None:
        """JWKS를 받아 캐시를 바꾼다. 실패(빈 키 집합 포함)는 예외이고, 그땐 캐시와 시각을 건드리지 않는다."""
        jwks = await self._fetch()
        try:
            found = jwt.PyJWKSet.from_dict(jwks).keys
        except (jwt.PyJWTError, TypeError, AttributeError):
            found = []  # 깨진 집합: 아무 키도 믿지 않는다
        keys = {
            k.key_id: k for k in found
            if k.key_id and k.algorithm_name in ALGORITHMS and k.public_key_use in (None, "sig")
        }
        if not keys:
            raise NoUsableKeys
        self._keys = keys
        self._fetched_at = self._clock()


@lru_cache
def get_verifier() -> TokenVerifier:
    base = get_settings().supabase_url.rstrip("/")
    if not base:  # 개발·테스트: 키가 없으니 모든 토큰이 거절된다
        async def fetch() -> dict:
            return {"keys": []}
        return TokenVerifier("", fetch)

    async def fetch() -> dict:
        # httpx timeout은 연결·읽기 단계별이라 조금씩 흘려 주는 서버는 못 막는다: 전체를 한 번에 자른다.
        async with asyncio.timeout(JWKS_TIMEOUT_S):
            async with httpx.AsyncClient(timeout=JWKS_TIMEOUT_S) as c:
                r = await c.get(f"{base}/auth/v1/.well-known/jwks.json")
                r.raise_for_status()
                return r.json()

    return TokenVerifier(f"{base}/auth/v1", fetch)


def _unauthorized() -> HTTPException:
    return HTTPException(status_code=401, detail="unauthorized", headers={"WWW-Authenticate": "Bearer"})


async def current_user(
    authorization: str | None = Header(None),
    verifier: TokenVerifier = Depends(get_verifier),
) -> UUID:
    scheme, _, token = (authorization or "").partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        raise _unauthorized()
    try:
        return await verifier.verify(token)
    except AuthUnavailable as e:  # 토큰이 아니라 우리 쪽 문제: 앱이 다시 시도하게 503
        log.warning("auth unavailable: %s", e)  # 예외 종류 이름만(토큰·응답 본문 없음)
        raise HTTPException(status_code=503, detail="auth_unavailable") from None
    except AuthError as e:
        log.info("auth rejected: %s", e)
        raise _unauthorized() from None


async def ensure_member(repo: Repo, room_id: UUID, user_id: UUID) -> None:
    """방 멤버가 아니면 403. 없는 방도 같은 403이다(방 존재 여부를 알려 주지 않는다)."""
    if not await repo.is_member(room_id, user_id):
        raise HTTPException(status_code=403, detail="not_a_member")
