"""테스트용 Supabase 토큰 서명기. 진짜 공개키 집합(JWKS)과 그 키로 서명한 JWT를 만든다(ES256).
`make_signer()`로 키를 만들고, `signer.jwks`를 `TokenVerifier`의 `fetch_jwks`에 먹이고, `signer.token(...)`을 `verify`에 낸다."""
from __future__ import annotations

import time
from dataclasses import dataclass
from uuid import UUID

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

ISSUER = "https://test.supabase.co/auth/v1"


@dataclass
class Signer:
    kid: str
    private_key: ec.EllipticCurvePrivateKey

    @property
    def jwks(self) -> dict:
        jwk = jwt.algorithms.ECAlgorithm.to_jwk(self.private_key.public_key(), as_dict=True)
        return {"keys": [jwk | {"kid": self.kid, "alg": "ES256", "use": "sig"}]}

    @property
    def public_pem(self) -> bytes:
        return self.private_key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)

    def token(self, sub: UUID, *, exp_in: float = 3600, aud: str = "authenticated",
              iss: str = ISSUER, kid: str | None = None, role: str | None = "authenticated",
              is_anonymous: bool | None = None) -> str:
        """Supabase 로그인 사용자 토큰 모양. `role=None`이면 role claim을 뺀다. `is_anonymous`는 None이면 뺀다."""
        claims = {"sub": str(sub), "aud": aud, "iss": iss, "exp": int(time.time() + exp_in)}
        if role is not None:
            claims["role"] = role
        if is_anonymous is not None:
            claims["is_anonymous"] = is_anonymous
        return jwt.encode(claims, self.private_key, algorithm="ES256", headers={"kid": kid or self.kid})


def make_signer(kid: str = "k1") -> Signer:
    return Signer(kid=kid, private_key=ec.generate_private_key(ec.SECP256R1()))
