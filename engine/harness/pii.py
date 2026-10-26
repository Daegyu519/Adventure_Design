"""외부 API로 보내기 전에 개인정보 모양을 가린다. 완벽하지 않으니 예문·동의 데이터 원칙은 그대로 지킨다."""
from __future__ import annotations

import re

RULES = [
    (re.compile(r"01[016789][-\s]?\d{3,4}[-\s]?\d{4}"), "[전화번호]"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "[이메일]"),
    (re.compile(r"\d{6}[-\s]?[1-4]\d{6}"), "[주민번호]"),
    (re.compile(r"\d{2,6}[-\s]\d{2,6}[-\s]\d{2,8}"), "[계좌번호]"),
    (re.compile(r"\d{9,}"), "[긴 숫자]"),
]


def mask(text: str, names: list[str] | None = None) -> str:
    for pat, rep in RULES:
        text = pat.sub(rep, text)
    for n in names or []:
        if n:
            text = text.replace(n, "[이름]")
    return text
