"""요청 본문 크기 제한(순수 ASGI). /v1/*, /hooks/*의 본문이 64 KB를 넘으면 JSON 파싱·인증보다 먼저 413.
Content-Length가 크면 읽지 않고 거절하고, 없거나 거짓인 스트림(chunked)은 읽는 중 누적이 넘으면 거절한다.
본문 내용은 로그에 남기지 않는다."""
from __future__ import annotations

import json

from starlette.types import ASGIApp, Message, Receive, Scope, Send

MAX_BODY_BYTES = 64 * 1024
PREFIXES = ("/v1/", "/hooks/")
_BODY = json.dumps({"detail": "too_large"}).encode()


class BodyLimit:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith(PREFIXES):
            return await self.app(scope, receive, send)
        declared = dict(scope["headers"]).get(b"content-length", b"")
        if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            return await self._reject(send)
        seen, rejected = 0, False

        async def counted() -> Message:
            nonlocal seen, rejected
            msg = await receive()
            if msg["type"] == "http.request" and not rejected:
                seen += len(msg.get("body", b""))
                if seen > MAX_BODY_BYTES:   # 앱(FastAPI)은 본문 읽기 예외를 400으로 바꾸니 여기서 직접 답하고 연결을 끊은 것으로 알린다
                    rejected = True
                    await self._reject(send)
                    return {"type": "http.disconnect"}
            return msg

        async def watched(msg: Message) -> None:
            if not rejected:   # 413을 보낸 뒤 앱이 내는 응답은 버린다
                await send(msg)

        await self.app(scope, counted, watched)

    @staticmethod
    async def _reject(send: Send) -> None:
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(_BODY)).encode())]})
        await send({"type": "http.response.body", "body": _BODY})
