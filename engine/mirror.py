"""거울 세션(ARCHITECTURE 3-5): 상황 카드, 오늘의 카드 고르기, 엔진 서명 card_id, 패널 칸, 날짜 말.
card_id에는 문장이 없고 출처 참조(`msg:<id>`·`card:<id>`)만 있다. 답할 때 문장은 DB·카드 파일에서 다시 읽는다."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import random
import secrets
from dataclasses import dataclass
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path
from uuid import UUID

import yaml

from app.contracts import MirrorCard, MirrorKind
from app.db import SentMsg
from app.settings import Settings
from harness.schemas import READINGS
from layers.guard import guard

log = logging.getLogger(__name__)
CONTENT_PATH = Path(__file__).resolve().parent / "content" / "mirror_cards.yaml"
MIN_KEY_BYTES = 32
WORD = {"친구": "친구", "팀원": "팀원", "선후배": "선후배", "기타": "상대"}   # 방 관계 → 문구에 쓰는 말
DAYS = "월화수목금토일"
MAX_LEN = 500   # 초안 상한(contracts.Draft)과 같다. 더 긴 보낸 문장은 카드로 쓰지 않는다


@dataclass(frozen=True)
class Card:
    id: str
    topic: str
    persona: str
    relation: str
    situation: str
    message: str
    sample_reply: str


@dataclass(frozen=True)
class Content:
    cards: list[Card]
    personas: list[dict]
    inner_voice: dict[str, str]


def load_content(path: Path) -> Content:
    """보이는 문구는 모두 여기서 문구 검사를 거친다(걸리면 ValueError로 시작·테스트가 실패)."""
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    c = Content([Card(**x) for x in raw["cards"]], raw["personas"], raw["inner_voice"])
    if set(c.inner_voice) != set(READINGS):
        raise ValueError("inner_voice는 읽힘 다섯 키")
    for s in (*c.inner_voice.values(), *(p["name"] for p in c.personas),
              *(t for x in c.cards for t in (x.situation, x.message, x.sample_reply))):
        guard(s)
    return c


@lru_cache
def get_content() -> Content:
    return load_content(CONTENT_PATH)


@lru_cache
def get_mirror_key() -> bytes:
    """MIRROR_SECRET(32바이트 이상)이 있으면 그 값. 짧으면 ValueError(값은 싣지 않는다, 엔진 시작이 실패한다).
    없으면 프로세스마다 임의 키이고, mock이 아니면 경고를 한 번 남긴다."""
    # ponytail: 재시작하면 그날 카드 무효, 여러 프로세스면 MIRROR_SECRET 필수
    s = Settings.from_env()
    key = s.mirror_secret.encode()
    if key and len(key) < MIN_KEY_BYTES:
        raise ValueError(f"MIRROR_SECRET는 {MIN_KEY_BYTES}바이트 이상이어야 한다")
    if key:
        return key
    if not s.force_mock:
        log.warning("MIRROR_SECRET 없음: 프로세스마다 임의 키라 재시작·여러 워커에서는 card_id가 맞지 않는다")
    return secrets.token_bytes(MIN_KEY_BYTES)


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _mac(body: str, key: bytes) -> str:
    return _b64(hmac.new(key, body.encode(), hashlib.sha256).digest()[:16])


def sign(payload: dict, key: bytes) -> str:
    """b64url(압축 JSON) + "." + b64url(HMAC-SHA256 앞 16바이트). 서명은 보낸 그대로의 앞 조각에 건다."""
    body = _b64(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())
    return f"{body}.{_mac(body, key)}"


def unsign(card_id: str, key: bytes) -> dict:
    body, sig = card_id.split(".")   # 조각이 둘이 아니면 ValueError
    if not hmac.compare_digest(_mac(body, key).encode(), sig.encode()):
        raise ValueError("bad signature")
    payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    if not isinstance(payload, dict):
        raise ValueError("bad payload")
    return payload


def panel_bin(neg: float) -> int:
    """부정 확률을 0.2 간격 1~5칸으로. 0.6/0.2 = 2.999…처럼 경계가 아래 칸으로 새지 않게 소수 6자리에서 자른 뒤 ×5."""
    return min(5, int(round(neg, 6) * 5) + 1)


def relative_day(sent: date, today: date) -> str:
    n = (today - sent).days
    if n <= 0:
        return "오늘"
    if n == 1:
        return "어제"
    weeks = ((today - timedelta(days=today.weekday())) - (sent - timedelta(days=sent.weekday()))).days // 7
    if weeks <= 1:
        return f"{'이번 주' if weeks == 0 else '지난주'} {DAYS[sent.weekday()]}요일"
    return f"{n}일 전"


def today_cards(user_id: UUID, today: date, sent: list[SentMsg], used: set[str], content: Content,
                key: bytes) -> list[MirrorCard]:
    """역할극 1장(쓰지 않은 상황 카드) + 되돌려 받기·예측 각 1장(쓰지 않은 본인 문장, 모자라면 카드 sample_reply).
    같은 사용자·같은 날·같은 기록이면 같은 카드다."""
    rng = random.Random(f"{user_id}:{today.isoformat()}")

    def card(kind: MirrorKind, ref: str, relation: str, persona: str, situation: str, message: str) -> MirrorCard:
        payload = {"u": str(user_id), "k": kind, "s": ref, "r": relation, "p": persona, "d": today.isoformat()}
        return MirrorCard(card_id=sign(payload, key), kind=kind, persona=persona, relation=relation,
                          situation=situation, message=message)

    rp = rng.choice([c for c in content.cards if f"roleplay|card:{c.id}" not in used] or content.cards)
    out = [card("roleplay", f"card:{rp.id}", rp.relation, rp.persona, rp.situation, rp.message)]
    taken: set[str] = set()   # 되돌려 받기와 예측은 서로 다른 문장
    for kind in ("receive", "predict"):
        msgs = [m for m in sent if f"{kind}|msg:{m.id}" not in used and m.text not in taken and len(m.text) <= MAX_LEN]
        if msgs:
            m = rng.choice(msgs)
            ref, text, relation = f"msg:{m.id}", m.text, m.relation
            persona = next((p["name"] for p in content.personas if p["relation"] == relation),
                           content.personas[0]["name"])
        else:
            pool = [c for c in content.cards if c.sample_reply not in taken]
            c = rng.choice([c for c in pool if f"{kind}|card:{c.id}" not in used] or pool)
            ref, text, relation, persona = f"card:{c.id}", c.sample_reply, c.relation, c.persona
        taken.add(text)
        situation = f"{persona}에게서 온 메시지" if kind == "receive" else f"{WORD[relation]}에게 보낸다면"
        out.append(card(kind, ref, relation, persona, situation, text))
    return out
