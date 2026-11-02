"""사용자에게 보이는 문구. 확정하지 않는 말투만 쓰고, 출처(누가 말했는지)는 절대 드러내지 않는다."""
from __future__ import annotations

import re

from harness.schemas import DetailReport, Hint, RewriteOption, Verdict

TITLES = {
    "차갑게": "차갑게 느껴질 수도 있어요",
    "성의없게": "성의 없게 느껴질 수도 있어요",
    "화나게": "화난 것처럼 느껴질 수도 있어요",
}
WHY = {
    "이유 없는 거절": "이유 없이 거절만 하면 그렇게 읽히기도 해요",
    "마침표로 끝남": "채팅에서 마침표로 끝내면 딱딱하게 읽히는 경우가 있어요",
    "짧은 답": "답이 짧으면 관심이 없어 보일 때가 있어요",
    "따지는 말투": "따지듯 묻는 말은 화난 것처럼 들리기도 해요",
    "비속어": "거친 말이 섞이면 화난 것처럼 들리기도 해요",
    "자음만 쓴 답": "자음만 보내면 대충 답한 것처럼 보일 때가 있어요",
    "감정 표현에 짧은 답": "마음을 털어놓은 말에 짧게 답하면 서운하게 느끼기도 해요",
    "상대 말에 비해 짧은 답": "기대하며 보낸 말에 짧게 답하면 관심 없어 보일 때가 있어요",
    "평소보다 짧음": "평소 말투보다 짧아서 달라 보일 수 있어요",
    "존댓말이 갑자기 빠짐": "평소와 다르게 존댓말이 빠져 있어요",
    "이유 설명 없음": "상대가 이유를 기다리고 있을 수 있어요",
    "공감 한마디 없음": "공감 한마디가 있으면 덜 서운하게 읽힐 수 있어요",
    "대안 제시 없음": "대신할 방법을 붙이면 덜 단호하게 읽힐 수 있어요",
}
FOOTNOTE = ("비슷한 대화에서 모인 반응을 바탕으로 한 조언이라 틀릴 수도 있어요. "
            "누가 어떤 반응을 남겼는지는 알 수 없어요.")

# 확정 표현, 출처를 짐작하게 하는 표현은 내보내지 않는다
FORBIDDEN = re.compile(r"(확실히|분명히|반드시|상대가 말하길|상대방이 그러는데|님이 말한|피드백을 남겼|싫어했어요|기분 나빠했어요)")


def guard(text: str) -> str:
    if FORBIDDEN.search(text):
        raise ValueError("금지 표현이 포함됨")  # 검사한 문장은 복원된 실명을 담을 수 있어 메시지에 싣지 않는다
    return text


# 털어놓기 안내(prototype layers/feedback.py 그대로). 불러올 때 금지어 검사를 통과해야 한다.
ACK = guard("이야기해 줘서 고마워요. 누가 남겼는지는 드러나지 않게, "
            "비슷한 표현이 나올 때 '이렇게 느껴질 수도 있어요' 정도로만 조심스럽게 전해질 수 있어요.")


def render_hint(v: Verdict) -> Hint | None:
    if not v.alert:
        return None
    detail = next((WHY[s] for s in v.signals if s in WHY), "이 대화 흐름에서는 다르게 읽힐 수 있어요")
    return Hint(title=guard(TITLES.get(v.top_reading, "다르게 읽힐 수도 있어요")), detail=guard(detail))


# 의도 칩별로 어긋남으로 보는 읽힘(ARCHITECTURE 3-3). 단호한 거절이 차갑게 읽히는 것은 어긋남이 아니다.
MISMATCH = {"단호하게": {"화나게", "성의없게"}, "미안하게": {"차갑게", "화나게", "성의없게"}, "가볍게": {"차갑게", "화나게"}}
PHRASE = {"차갑게": "차갑게", "성의없게": "성의 없게", "화나게": "화난 것처럼"}
OPTION_LABELS = ("조금만 바꾼 문장", "가장 부드럽게 바꾼 문장")   # 고쳐 쓰기 후보의 원래 순번대로


def render_mismatch(intent: str | None, readings: dict[str, float]) -> str | None:
    """가장 많이 읽힌 뜻(다섯 중 최대)이 그 의도와 어긋날 때만 한 줄. 앱은 이 문구를 그대로 보여 준다."""
    top = max(readings, key=readings.__getitem__)
    if intent is None or top not in MISMATCH.get(intent, ()):
        return None
    return guard(f"{intent} 말하려던 것과 달리 {PHRASE[top]} 읽힐 수도 있어요")


def freq(p: float) -> str:
    return "자주" if p >= 0.35 else "가끔" if p >= 0.15 else "드물어요"


def render_detail(v: Verdict, readings: dict[str, float], options: list[RewriteOption]) -> DetailReport:
    why = [guard(WHY[s]) for s in v.signals if s in WHY][:3]
    return DetailReport(verdict=v, readings={k: freq(p) for k, p in readings.items()},
                        why=why, options=options, footnote=FOOTNOTE)
