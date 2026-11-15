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
# 따지는 말투: 반문·탓하기·"됐어"로 끊기(화나게 쪽 겉 신호). "다 됐어"처럼 끝난 일을 알리는 말은 문장 맨 앞만 본다
BLAME = re.compile(r"(왜\s?(이제|매번|맨날|또|자꾸|이래|그래|그랬)|몇\s?번|^(아\s)?됐어|됐거든|됐다고|됐고|그만\s?(해|좀|하라)|도대체|어이없|짜증(?!\s?(나겠|났겠|날\s?만))|열\s?받(?!겠|았겠|을\s?만)|빡\s?(치|쳐|침)|장난\s?(해|하냐|치냐|하나)|뭐\s?하자는|미쳤(어|냐|나)\?|하라고|잖아요?\?|했잖아|말했잖|ㅡㅡ|-_-|\?{2,}|\?!|!\?)")
# 비속어(욕·초성 욕·거친 강조어). 띄어 쓰거나 초성으로 바꿔 쓴 것도 잡는다. 친한 사이 장난은 모델·판별기가 위험도로 거른다
PROFANITY = re.compile(r"(씨\s?[발빨바팔]|시\s?[발바](?![점견])|ㅅ\s?ㅂ|ㅆ\s?ㅂ|(?<!곱)씹|좆|좇|존\s?나|졸\s?라(?![서대매])|ㅈ\s?ㄴ|ㅈ\s?같|개\s?(새|색|같|빡|짜증)|ㄱ\s?ㅅ\s?ㄲ|새\s?끼(?!\s?손)|병\s?신|븅\s?신|ㅂ\s?ㅅ|지\s?랄|ㅈ\s?ㄹ|닥\s?쳐|꺼\s?져|엿\s?(먹|같)|염\s?병|썅|니미|느금|미친\s?(놈|년|새|것)|ㅁ\s?ㅊ|또라이|(^|\s)ㅗ+($|\s))")
# 강조어로만 쓴 거친 말("존나 고마워", "ㅁㅊ 대박")은 비속어 신호로 보지 않는다: 좋은 뜻의 말이 있고 따지는 말투가 아닐 때만(P-42).
# 욕 자체(씨발·새끼 …)는 좋은 말이 같이 있어도 그대로 비속어다
INTENSIFIER = re.compile(r"(존\s?나|졸\s?라(?![서대매])|ㅈ\s?ㄴ|ㅁ\s?ㅊ)")
POSITIVE = re.compile(r"(고마|고맙|감사|(?<!안)(?<!안\s)좋(?!겠냐|냐)|맛있|대박|웃기|웃겨|귀엽|귀여|예쁘|예뻐|이쁘|이뻐|멋있|멋지|재밌|재미있|축하|사랑|최고|행복|잘했|잘한다|부럽|신나|설레)")
# 거친 말의 강도(P-44, 2026-11-15 사용자가 정한 표). 0 없음 · 1 약 · 2 중 · 3 강. 아직 판정에 쓰지 않는다(surface의 rough_level로만 낸다).
# 규칙: 온전히 쓴 욕·거친 말과 초성 욕은 중. 욕에 비하하는 말이 겹치면(련·년·새끼) 강. 감탄·강조어는 약.
# ㅋㅋ·ㅎㅎ가 붙으면 한 단계 낮춘다(약 아래로는 안 내린다). 가족을 건드리는 말은 기본이 강이고 웃음으로 낮추지 않는다.
# 사람마다 다르게 받아들이는 것(가족 욕의 체감, 초성의 세기)은 여기서 풀지 않는다
ROUGH_FAMILY = re.compile(r"(니\s?[애에]미|느금마?|니미)")
ROUGH_FAMILY_MILD = re.compile(r"(니\s?엄마|느그\s?엄마|ㄴ\s?ㅇ\s?ㅁ)")
ROUGH_STRONG = re.compile(r"((씨\s?[발빨팔]|시\s?발)\s?(련|년|놈|새\s?끼)|개\s?(새\s?끼|색\s?[기히]|같은\s?(년|놈|새\s?끼))"
                          r"|(병\s?신|븅\s?신|미친|또라이|좆)\s?(같은\s?)?(년|새\s?끼))")
ROUGH_FULL = re.compile(r"(씨\s?[발빨바팔]|시\s?[발바](?![점견])|(?<!곱)씹|좆|좇|개\s?(새|색|같)|새\s?끼(?!\s?손)|병\s?신|븅\s?신|지\s?랄|썅"
                        r"|미친\s?(놈|년|새|것)|또라이|꺼\s?져|닥\s?쳐|죽을래|뒤질래|엿\s?(먹|같)|염\s?병)")
ROUGH_CHOSUNG = re.compile(r"(ㅅ\s?ㅂ|ㅆ\s?ㅂ|ㅂ\s?ㅅ|ㅁ\s?ㅊ\s?ㄴ|ㄷ\s?ㅊ|ㅈ\s?ㄹ|ㄱ\s?ㅅ\s?ㄲ|ㅈ\s?같)")
ROUGH_MILD = re.compile(r"(ㅁ\s?ㅊ(?!\s?ㄴ)|미쳤|존\s?나|졸\s?라(?![서대매])|ㅈ\s?ㄴ|뭐래|개\s?(빡|짜증))")
LAUGH_ANY = re.compile(r"(ㅋ{2,}|ㅎ{2,}|ㅋ$)")
CONSONANTS = re.compile(r"^[ㄱ-ㅎ\s.!?~]+$")   # ㅇㅇ·ㅇㅋ·ㄴㄴ
LAUGH = re.compile(r"^[ㅋㅎ\s.!?~]+$")         # ㅋㅋ·ㅎㅎ만이면 자음 답으로 보지 않는다


def profane(t: str) -> bool:
    blame = bool(BLAME.search(t))
    rest = INTENSIFIER.sub("", t) if POSITIVE.search(t) and not blame else t
    return bool(PROFANITY.search(rest))


def rough_level(t: str) -> int:
    """거친 말의 강도 0~3(위 규칙). 강조어만 있고 좋은 뜻의 말이면 0(profane과 같은 예외)."""
    if ROUGH_FAMILY.search(t):
        return 3
    if ROUGH_STRONG.search(t):
        level = 3
    elif ROUGH_FULL.search(t) or ROUGH_CHOSUNG.search(t) or ROUGH_FAMILY_MILD.search(t):
        level = 2
    elif ROUGH_MILD.search(t) and not (POSITIVE.search(t) and not BLAME.search(t)):
        level = 1
    else:
        return 0
    return max(1, level - 1) if LAUGH_ANY.search(t) else level


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
        "blame": bool(BLAME.search(t)),
        "profanity": profane(t),
        "rough_level": rough_level(t),
        "consonants": bool(CONSONANTS.match(t)) and not LAUGH.match(t),
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
