"""prompts/*.md를 읽어 system / user 부분으로 나눈다. 프롬프트를 고치면 평가 세트를 다시 돌린다."""
from __future__ import annotations

import hashlib
from functools import lru_cache
from pathlib import Path

DIR = Path(__file__).resolve().parent.parent / "prompts"


@lru_cache
def load(name: str) -> tuple[str, str, str]:
    text = (DIR / f"{name}.md").read_text(encoding="utf-8")
    _, rest = text.split("## system", 1)
    system, user = rest.split("## user", 1)
    version = hashlib.sha1(text.encode()).hexdigest()[:8]   # 기록용 프롬프트 버전
    return system.strip(), user.strip(), version


def render(name: str, **kw) -> tuple[str, str]:
    system, user, _ = load(name)
    return system, user.format(**kw)


def turns_text(turns: list[dict], n: int = 6) -> str:
    return "\n".join(f"[{'나' if t['speaker'] == 'me' else '상대'}] {t['text']}" for t in turns[-n:])
