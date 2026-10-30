"""외부 API로 보내기 전에 개인정보 모양을 가린다. 완벽하지 않으니 예문·동의 데이터 원칙은 그대로 지킨다.
- Masker: 파이프라인 입구에서 요청마다 하나. 이름까지 가리고, 고쳐 쓰기 후보는 restore로 되돌린다.
- mask: 이름 없이 패턴만. 라우터가 mock이 아닌 공급자로 보내기 직전에 한 번 더 쓴다(안전망)."""
from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable

from .schemas import Conversation, Turn

# 순서가 곧 우선순위다(같은 위치에서 앞 규칙이 이긴다). 카드는 주민번호보다 앞(16자리가 13자리로 잘리지 않게).
# 바꿀 문구가 None인 규칙은 가리지 않고 그대로 둔다: 날짜·시각은 말투 맥락이라 계좌 규칙보다 앞에서 뺀다.
_MM, _DD = r"(?:0?[1-9]|1[0-2])", r"(?:0?[1-9]|[12]\d|3[01])"
RULES: list[tuple[re.Pattern[str], str | None]] = [
    (re.compile(r"(?:\+82[-.\s]?0?|0)1[016789][-.\s]?\d{3,4}[-.\s]?\d{4}"), "[전화번호]"),
    (re.compile(r"[\w.+-]{1,64}[@＠][\w-]+\.[\w.]+"), "[이메일]"),
    (re.compile(r"(?<!\d)\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}(?!\d)"), "[카드번호]"),
    # 7번째 5~8은 외국인등록번호. 앞자리를 날짜처럼 쓴 것(1990-01-01 1234567)도 날짜 예외보다 먼저 잡는다
    (re.compile(r"(?<!\d)(?:19|20)?\d{2}[-./]?\d{2}[-./]?\d{2}[-\s]?[1-8]\d{6}(?!\d)"), "[주민번호]"),
    # YYYY-MM-DD·YYYY.MM.DD·YYYY/MM/DD, MM/DD, 19:30
    (re.compile(rf"(?<![\d/.-])(?:(?:19|20)\d\d[-./]{_MM}[-./]{_DD}|{_MM}/{_DD}|(?:[01]?\d|2[0-3]):[0-5]\d)(?![\d/.:-]?\d)"),
     None),
    (re.compile(r"\d{2,6}[-\s]\d{2,6}[-\s]\d{2,8}"), "[계좌번호]"),
    (re.compile(r"\d{9,}"), "[긴 숫자]"),
]
TOKEN = re.compile(r"\[[^\[\]\d]+\d+\]")
# 규칙마다 따로 돌리면 뒤 규칙 자리에서 앞 규칙이 먼저 걸린다(예: 주민번호 속 010… → "90[전화번호]"). 한 번에 돈다.
_ALL = re.compile("|".join(f"(?P<g{i}>{pat.pattern})" for i, (pat, _) in enumerate(RULES)))


def mask(text: str) -> str:
    return _ALL.sub(lambda m: RULES[int((m.lastgroup or "g0")[1:])][1] or m.group(0), text)


class Masker:
    """같은 값은 같은 자리표시, 종류별 등장 순서로 번호([이름1], [전화번호1] …).
    대응표는 이 객체 메모리에만 둔다. 로그·trace·큐 인자에 넣지 않는다."""

    def __init__(self, names: Iterable[str] = ()):
        full = {n.strip() for n in names if len(n.strip()) >= 2}
        full |= {n[1:] for n in full if re.fullmatch(r"[가-힣]{3}", n)}   # 성 빼고 이름만 부르는 경우
        alts = "|".join(map(re.escape, sorted(full, key=len, reverse=True)))
        parts = [("이름", f"(?i:{alts})")] if full else []     # 영문 이름은 대소문자 무시
        parts += [(rep and rep.strip("[]"), pat.pattern) for pat, rep in RULES]
        # 한 번의 re.sub라 이미 바꾼 자리표시를 다시 건드리지 않는다
        self._re = re.compile("|".join(f"(?P<g{i}>{src})" for i, (_, src) in enumerate(parts)))
        self._kind: dict[str, str | None] = {f"g{i}": kind for i, (kind, _) in enumerate(parts)}
        self._tok: dict[str, str] = {}
        self._val: dict[str, str] = {}
        self._n: Counter[str] = Counter()

    def __call__(self, text: str) -> str:
        return self._re.sub(self._sub, text)

    def _sub(self, m: re.Match[str]) -> str:
        v, kind = m.group(0), self._kind[m.lastgroup or ""]
        if kind is None:   # 날짜·시각: 가리지 않는다
            return v
        if v not in self._tok:
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
