"""한국어 채팅 문장의 겉 신호. L0 거르기와 mock 모델이 같이 쓴다.
규칙은 출발점일 뿐이고, 나중에 분류기(KcELECTRA 등)로 바꿀 자리다."""
from __future__ import annotations

import re

REFUSAL = re.compile(r"(안\s?돼|안\s?되|못\s?해|못\s?하|어려워|어려울|어렵|싫어|싫은데|안\s?할|불가)")
REASON = re.compile(r"(라서|이라서|해서|어서|아서|느라|때문|왜냐|거든|니까|으니|대신|라)")
SOFTENER = re.compile(r"(ㅎㅎ|ㅋㅋ|ㅠ|ㅜ|~|!|\^\^|😊|🙏|😂|ㅎ$)")
HEDGE = re.compile(r"(것\s?같|듯|혹시|조금|좀|일단|아마)")
APOLOGY = re.compile(r"(미안|죄송|ㅈㅅ)")
SHORT_ACK = {"ㅇㅇ", "ㅇ", "응", "네", "넹", "ㅇㅋ", "ok", "오키", "그래", "알겠어", "알겠습니다", "네.", "응.", "ㅇㅇ."}
POLITE_END = re.compile(r"(요|니다|세요|죠)[.!?~ㅎㅠ\s]*$")


def surface(text: str) -> dict:
    t = text.strip()
    core = re.sub(r"[\s.!?~]+$", "", t)
    return {
        "length": len(t),
        "short": len(core) <= 4 or t in SHORT_ACK,
        "period_end": t.endswith(".") and not t.endswith(".."),
        "refusal": bool(REFUSAL.search(t)),
        "has_reason": bool(REASON.search(t)) and len(t) > 8,
        "softener": bool(SOFTENER.search(t)),
        "hedge": bool(HEDGE.search(t)),
        "apology": bool(APOLOGY.search(t)),
        "polite": bool(POLITE_END.search(t)),
        "question_back": t.endswith("?"),
    }


def emotional(text: str) -> bool:
    return bool(re.search(r"(고민|힘들|속상|서운|우울|지쳤|걱정|무서|혼났|망쳤|돌아가|아파|입원|헤어졌|그만두고|ㅠ|ㅜ|어떡|어떻게 해야)", text)) or len(text) > 45


def asks_favor(text: str) -> bool:
    return bool(re.search(r"(될까요|돼요\?|되나요|가능할까|해줄 수|해 줄 수|부탁|미뤄도|빌려)", text))


def has_reason(text: str) -> bool:
    return bool(re.search(r"(해서요|어서요|아서요|라서요|생겨서|때문|느라)", text))


def invites(text: str) -> bool:
    return bool(re.search(r"(볼래|갈래|할래|먹을래|올래|어때\?|같이)", text))


def high_stakes(text: str) -> bool:
    """상대가 마음을 담았거나 기대하며 보낸 말. 이럴 때 짧은 답은 겉 신호가 약해도 위험할 수 있다."""
    return emotional(text) or shares_news(text) or invites(text) or bool(APOLOGY.search(text))


def shares_news(text: str) -> bool:
    return bool(re.search(r"(합격|붙었|됐어|생일|축하|드디어|해냈|받았어)", text))
