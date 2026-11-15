"""알림 단계(P-46). 집계가 알림이라고 한 문장을 '거친 말의 강도 × 편한 사이 × 장난 맥락'으로 카드·조용한 표시·없음으로 나눈다.
모델에 묻지 않는 계산이라 같은 입력은 항상 같은 단계다(프롬프트로 넣으면 효과가 작고 흔들렸다, 일지 2026-11-13 15절).

| 강도(korean.rough_level) | 보통 | 편한 사이 + 장난 맥락 |
| 강 3 | card | card |
| 중 2 | card | soft |
| 약 1 | soft | none |
거친 말이 없으면(0) 언제나 card: 편한 사이 표시는 거친 말에만 쓴다.

편한 사이(casual)는 보내는 사람이 자기 기기에서 켠 표시다. 어떻게 읽히는지는 받는 사람의 것이라, 이 표시는 끄기가 아니라
한 단계 낮추기까지만 한다. 받는 사람의 하소연이 반영된 알림(pattern_used)은 낮추지 않는다."""
from __future__ import annotations

from typing import Literal

from harness import korean as K

Level = Literal["card", "soft", "none"]


def playful(last_them: str) -> bool:
    """직전 상대 말이 장난으로 읽히는가: 웃음이 있고, 마음을 털어놓거나 사과하는 말이 아니다."""
    return bool(K.LAUGH_ANY.search(last_them)) and not (K.emotional(last_them) or K.APOLOGY.search(last_them))


def decide(alert: bool, rough: int, casual: bool, banter: bool, pattern_used: bool) -> Level:
    if not alert:
        return "none"
    if rough in (0, 3) or pattern_used:
        return "card"
    if casual and banter:
        return "soft" if rough == 2 else "none"
    return "card" if rough == 2 else "soft"


def can_soften(alert: bool, rough: int, casual: bool, banter: bool, pattern_used: bool) -> bool:
    """편한 사이로 표시하면 이 알림이 낮아지는가(앱이 그때만 버튼을 보인다)."""
    return alert and not casual and decide(alert, rough, True, banter, pattern_used) != decide(alert, rough, False, banter, pattern_used)
