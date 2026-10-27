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


class AuthError(Exception):
    """토큰을 믿을 수 없다. 메시지는 고정 문구(토큰 내용 금지)."""


class TokenVerifier:
    def __init__(
        self,
        issuer: str,
        fetch_jwks: Callable[[], Awaitable[dict]],
        *,
        audience: str = "authenticated",
        ttl_s: float = 600.0,
        refetch_gap_s: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._issuer = issuer
        self._fetch = fetch_jwks
        self._audience = audience
        self._ttl = ttl_s
        self._gap = refetch_gap_s
        self._clock = clock
        self._keys: dict[str, jwt.PyJWK] = {}
        self._fetched_at: float | None = None  # 마지막으로 성공해서 받은 시각
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
        try:
            return UUID(claims["sub"])
        except (ValueError, TypeError, AttributeError):
            raise AuthError("invalid sub") from None

    async def warm(self) -> None:
        """서버가 뜰 때 키를 미리 받아 둔다(첫 요청이 JWKS 받기를 기다리지 않게). 실패해도 시작을 막지 않는다."""
        try:
            async with self._lock:
                await self._refresh()
        except Exception as e:  # noqa: BLE001 - 예외 종류만 남긴다(메시지에 URL·응답이 섞일 수 있다)
            log.warning("jwks warm failed: %s", type(e).__name__)

    # ── 키 캐시 ────────────────────────────────────────

    def _age(self) -> float | None:
        return None if self._fetched_at is None else self._clock() - self._fetched_at

    def _cached(self, kid: str) -> jwt.PyJWK | None:
        age = self._age()
        return self._keys.get(kid) if age is not None and age < self._ttl else None

    def _may_refetch(self) -> bool:
        age = self._age()
        return age is None or age >= min(self._gap, self._ttl)

    async def _key(self, kid: str) -> jwt.PyJWK:
        key = self._cached(kid)
        if key is None:
            async with self._lock:
                key = self._cached(kid)  # 기다리는 사이 다른 요청이 받아 왔을 수 있다
                if key is None and self._may_refetch():
                    try:
                        await self._refresh()
                    except Exception as e:  # noqa: BLE001
                        raise AuthError(f"jwks unavailable: {type(e).__name__}") from None
                    key = self._cached(kid)
        if key is None:
            raise AuthError("unknown kid")
        return key

    async def _refresh(self) -> None:
        jwks = await self._fetch()
        try:
            found = jwt.PyJWKSet.from_dict(jwks).keys
        except (jwt.PyJWTError, TypeError, AttributeError):
            found = []  # 빈 집합·깨진 집합: 아무 키도 믿지 않는다
        self._keys = {
            k.key_id: k for k in found
            if k.key_id and k.algorithm_name in ALGORITHMS and k.public_key_use in (None, "sig")
        }
        self._fetched_at = self._clock()
        if not self._keys:
            log.warning("jwks has no usable keys")


@lru_cache
def get_verifier() -> TokenVerifier:
    base = get_settings().supabase_url.rstrip("/")
    if not base:  # 개발·테스트: 키가 없으니 모든 토큰이 거절된다
        async def fetch() -> dict:
            return {"keys": []}
        return TokenVerifier("", fetch)

    async def fetch() -> dict:
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
    except AuthError as e:
        log.info("auth rejected: %s", e)
        raise _unauthorized() from None


async def ensure_member(repo: Repo, room_id: UUID, user_id: UUID) -> None:
    """방 멤버가 아니면 403. 없는 방도 같은 403이다(방 존재 여부를 알려 주지 않는다)."""
    if not await repo.is_member(room_id, user_id):
        raise HTTPException(status_code=403, detail="not_a_member")
