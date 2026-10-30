"""prompts/*.md를 읽어 system / user 부분으로 나눈다. 프롬프트를 고치면 평가 세트를 다시 돌린다."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

DIR = Path(__file__).resolve().parent.parent / "prompts"


@lru_cache
def load(name: str) -> tuple[str, str]:
    text = (DIR / f"{name}.md").read_text(encoding="utf-8")
    _, rest = text.split("## system", 1)
    system, user = rest.split("## user", 1)
    return system.strip(), user.strip()


def render(name: str, **kw) -> tuple[str, str]:
    system, user = load(name)
    return system, user.format(**kw)


def turns_text(turns: list[dict]) -> str:
    """[label 또는 나/상대] text. 자르지 않는다(DB가 8개로 자른다)."""
    return "\n".join(f"[{t.get('label') or ('나' if t['speaker'] == 'me' else '상대')}] {t['text']}" for t in turns)
