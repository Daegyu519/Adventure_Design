"""외부 API로 보내기 전에 개인정보 모양을 가린다. 완벽하지 않으니 예문·동의 데이터 원칙은 그대로 지킨다.
- Masker: 파이프라인 입구에서 요청마다 하나. 이름까지 가리고, 고쳐 쓰기 후보는 restore로 되돌린다.
- mask: 이름 없이 패턴만. 라우터가 외부 공급자로 보내기 직전에 한 번 더 쓴다(안전망)."""
from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable

from .schemas import Conversation, Turn

RULES = [
    (re.compile(r"01[016789][-\s]?\d{3,4}[-\s]?\d{4}"), "[전화번호]"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "[이메일]"),
    (re.compile(r"\d{6}[-\s]?[1-4]\d{6}"), "[주민번호]"),
    (re.compile(r"\d{2,6}[-\s]\d{2,6}[-\s]\d{2,8}"), "[계좌번호]"),
    (re.compile(r"\d{9,}"), "[긴 숫자]"),
]
TOKEN = re.compile(r"\[[^\[\]\d]+\d+\]")


def mask(text: str, names: list[str] | None = None) -> str:
    for pat, rep in RULES:
        text = pat.sub(rep, text)
    for n in names or []:
        if n:
            text = text.replace(n, "[이름]")
    return text


class Masker:
    """같은 값은 같은 자리표시, 종류별 등장 순서로 번호([이름1], [전화번호1] …).
    대응표는 이 객체 메모리에만 둔다. 로그·trace·큐 인자에 넣지 않는다."""

    def __init__(self, names: Iterable[str] = ()):
        full = {n.strip() for n in names if len(n.strip()) >= 2}
        full |= {n[1:] for n in full if re.fullmatch(r"[가-힣]{3}", n)}   # 성 빼고 이름만 부르는 경우
        parts = [("이름", "|".join(map(re.escape, sorted(full, key=len, reverse=True))))] if full else []
        parts += [(rep.strip("[]"), pat.pattern) for pat, rep in RULES]
        # 한 번의 re.sub라 이미 바꾼 자리표시를 다시 건드리지 않는다
        self._re = re.compile("|".join(f"(?P<g{i}>{src})" for i, (_, src) in enumerate(parts)))
        self._kind = {f"g{i}": kind for i, (kind, _) in enumerate(parts)}
        self._tok: dict[str, str] = {}
        self._val: dict[str, str] = {}
        self._n: Counter[str] = Counter()

    def __call__(self, text: str) -> str:
        return self._re.sub(self._sub, text)

    def _sub(self, m: re.Match[str]) -> str:
        v = m.group(0)
        if v not in self._tok:
            kind = self._kind[m.lastgroup or ""]
            self._n[kind] += 1
            tok = f"[{kind}{self._n[kind]}]"
            self._tok[v], self._val[tok] = tok, v
        return self._tok[v]

    def turns(self, turns: list[Turn]) -> list[Turn]:
        return [t.model_copy(update={"text": self(t.text), "label": self(t.label)}) for t in turns]

    def conversation(self, c: Conversation) -> Conversation:
        reply_to = self.turns([c.reply_to])[0] if c.reply_to else None
        return c.model_copy(update={"turns": self.turns(c.turns), "reply_to": reply_to})

    def restore(self, text: str) -> str:
        return TOKEN.sub(lambda m: self._val.get(m.group(0), m.group(0)), text)
