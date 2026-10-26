"""L4 피드백. 상대의 하소연을 패턴 태그로 바꿔 저장하고 원문은 버린다. 비동기로 돈다.
채팅 앱에서는 받은 메시지를 길게 눌러 털어놓기 때문에, 어떤 메시지에 대한 하소연인지(about_text)도 함께 넘긴다."""
from __future__ import annotations

from harness import pii, prompts
from harness.router import NoResult, Router
from harness.schemas import FeedbackResult
from harness.store import ProfileStore

ACK = ("이야기해 줘서 고마워요. 누가 남겼는지는 드러나지 않게, "
       "비슷한 표현이 나올 때 '이렇게 느껴질 수도 있어요' 정도로만 조심스럽게 전해질 수 있어요.")


async def ingest(router: Router, text: str, pair_id: str, store: ProfileStore, deadline: float,
                 names: list[str] | None = None, about_text: str = "") -> tuple[FeedbackResult, str]:
    masked = pii.mask(text, names)
    about = pii.mask(about_text, names) if about_text else "(없음)"
    system, user = prompts.render("feedback", text=masked, about=about)
    try:
        result, _ = await router.call("feedback", system, user, {"text": masked, "about": about_text},
                                      FeedbackResult, deadline)
    except NoResult:
        return FeedbackResult(usable=False, dropped_reason="분석 실패"), ACK
    if result.usable and result.patterns:
        if not store.add_patterns(pair_id, result.patterns):
            result = result.model_copy(update={"usable": False, "dropped_reason": "이번 주 반영 한도"})
        store.save()
    # text, masked는 여기서 버려진다. 어디에도 저장하지 않는다.
    return result, ACK
