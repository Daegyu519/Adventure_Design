"""T-28b 푸시 발송 작업. 웹훅이 `send_push(repo, settings, message_id)`를 큐에 넣는다.

- 큐 인자는 message_id뿐이다. 본문은 여기서 DB에서 다시 읽는다. 본문·토큰·endpoint는 로그에 남기지 않는다(예외는 타입 이름만).
- DB 읽기 실패는 올려서 큐가 재시도하게 한다. 보내기 단계 실패와 토큰 삭제 실패는 삼킨다(재시도하면 알림이 겹친다).
- 웹 푸시 endpoint는 사용자가 넣은 값이라 알려진 푸시 서비스 호스트만 보낸다(SSRF).
"""
from __future__ import annotations

import asyncio
import json
import logging
from urllib.parse import urlparse

import httpx
import requests
from pywebpush import WebPushException, webpush

from app.db import Msg, PushTarget, Repo, Room
from app.settings import Settings

log = logging.getLogger(__name__)

EXPO_URL = "https://exp.host/--/api/v2/push/send"
EXPO_BATCH = 100
EXPO_TIMEOUT_S = 10.0   # 요청 하나
WEB_TIMEOUT_S = 10      # 웹 푸시 하나
SEND_DEADLINE_S = 120.0  # 보내기 전체: 느린 서비스가 워커를 붙들지 않게
PREVIEW_CHARS = 100

PUSH_HOST_EXACT = {"fcm.googleapis.com", "updates.push.services.mozilla.com"}
PUSH_HOST_SUFFIXES = (".push.apple.com", ".notify.windows.com")


def push_host_allowed(endpoint: str) -> bool:
    """웹 푸시 구독의 endpoint가 알려진 푸시 서비스일 때만 참(SSRF 방지)."""
    # 공백·제어문자·역슬래시: urlparse(탭·줄바꿈을 지운다)와 실제 HTTP 클라이언트가 호스트를 다르게 읽는 틈을 막는다.
    if not endpoint.isprintable() or " " in endpoint or "\\" in endpoint:
        return False
    try:
        u = urlparse(endpoint)
        host, port = u.hostname, u.port  # hostname은 소문자, port는 숫자가 아니면 ValueError
    except ValueError:
        return False
    if u.scheme != "https" or not host or "@" in u.netloc or port not in (None, 443):
        return False
    return host in PUSH_HOST_EXACT or host.endswith(PUSH_HOST_SUFFIXES)


def _web_session() -> requests.Session:
    """웹 푸시용 세션: 리다이렉트를 따라가지 않는다(허용 호스트가 3xx로 내부 주소를 가리켜도 거기로 안 간다).
    3xx를 만나면 TooManyRedirects가 나고, 아래에서 타입 이름만 로그에 남는다."""
    s = requests.Session()
    s.max_redirects = 0
    return s


def build_notice(msg: Msg, room: Room, sender_name: str) -> dict:
    """Expo와 웹이 같은 모양: {title, body, url}. 본문은 짧은 미리보기."""
    title = f"{room.title} · {sender_name}" if room.kind == "group" and room.title else sender_name
    if not msg.text:
        body = "사진을 보냈어요"
    elif len(msg.text) > PREVIEW_CHARS:
        body = msg.text[:PREVIEW_CHARS] + "…"
    else:
        body = msg.text
    return {"title": title, "body": body, "url": f"/room/{msg.room_id}"}


async def send_push(repo: Repo, settings: Settings, message_id: int, http: httpx.AsyncClient | None = None) -> None:
    msg = await repo.message(message_id)
    if msg is None:  # 그 사이 지워졌다
        return
    room = await repo.room(msg.room_id)
    targets = await repo.push_targets(msg.room_id, msg.sender_id)  # 보낸 사람·알림 끈 멤버는 DB가 뺀다
    if room is None or not targets:
        return
    names = await repo.member_names(msg.room_id)
    notice = build_notice(msg, room, names.get(msg.sender_id) or "누군가")
    try:
        async with asyncio.timeout(SEND_DEADLINE_S):
            expo = [t for t in targets if t.platform in ("ios", "android")]
            if expo:
                await _send_expo(repo, settings, notice, expo, http)
            web = [t for t in targets if t.platform == "web"]
            if web and settings.vapid_private_key and settings.vapid_subject:
                with _web_session() as session:
                    for t in web:
                        await _send_web(repo, settings, notice, t, session)
    except TimeoutError:
        log.warning("push send deadline exceeded")


async def _send_expo(repo: Repo, settings: Settings, notice: dict, targets: list[PushTarget],
                     http: httpx.AsyncClient | None) -> None:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if settings.expo_access_token:
        headers["Authorization"] = f"Bearer {settings.expo_access_token}"
    client = http or httpx.AsyncClient(timeout=EXPO_TIMEOUT_S)
    try:
        for i in range(0, len(targets), EXPO_BATCH):
            batch = targets[i:i + EXPO_BATCH]
            body = [{"to": t.token, "title": notice["title"], "body": notice["body"], "data": {"url": notice["url"]}}
                    for t in batch]
            try:
                resp = await client.post(EXPO_URL, json=body, headers=headers)
                if resp.status_code != 200:
                    log.warning("expo push failed: status %s", resp.status_code)
                    continue
                results = resp.json()["data"]
            except Exception as e:  # 네트워크·응답 모양 오류: 메시지에 토큰이 있을 수 있어 타입만
                log.warning("expo push failed: %s", type(e).__name__)
                continue
            for t, r in zip(batch, results):
                if isinstance(r, dict) and r.get("status") == "error" and \
                        (r.get("details") or {}).get("error") == "DeviceNotRegistered":
                    await _forget(repo, t)
    finally:
        if http is None:
            await client.aclose()


async def _send_web(repo: Repo, settings: Settings, notice: dict, t: PushTarget, session: requests.Session) -> None:
    try:
        sub = json.loads(t.token)
        endpoint = sub.get("endpoint") if isinstance(sub, dict) else None
    except ValueError:
        endpoint = None
    if not isinstance(endpoint, str) or not push_host_allowed(endpoint):
        log.warning("push endpoint not allowed")  # endpoint 값은 쓰지 않는다. 토큰도 지우지 않는다
        return
    try:
        await asyncio.to_thread(webpush, subscription_info=sub, data=json.dumps(notice),
                                vapid_private_key=settings.vapid_private_key,
                                vapid_claims={"sub": settings.vapid_subject}, ttl=3600, timeout=WEB_TIMEOUT_S,
                                requests_session=session)
    except WebPushException as e:
        if getattr(e.response, "status_code", None) in (404, 410):  # 만료된 구독
            await _forget(repo, t)
        else:
            log.warning("web push failed: %s", type(e).__name__)
    except Exception as e:
        log.warning("web push failed: %s", type(e).__name__)


async def _forget(repo: Repo, t: PushTarget) -> None:
    try:
        await repo.delete_push_token(t.user_id, t.token)
    except Exception as e:
        log.warning("push token delete failed: %s", type(e).__name__)
