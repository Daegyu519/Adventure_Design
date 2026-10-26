"""데모: 프로토타입의 지은·민수 시나리오를 하네스로 돌려 본다.
키가 없으면 mock 모델로 돈다.   python demo.py [--mock]"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from harness.pipeline import TonePipeline
from harness.router import Router
from harness.schemas import Conversation, Turn
from harness.store import ProfileStore

ROOT = Path(__file__).parent


def convo(pair_id: str, relation: str, *lines: tuple[str, str]) -> Conversation:
    return Conversation(pair_id=pair_id, relation=relation,
                        turns=[Turn(speaker=s, text=t) for s, t in lines])


async def main(force_mock: bool) -> None:
    router = Router.from_file(force_mock=force_mock)
    store = ProfileStore.load(ROOT / "data" / "demo_store.json")
    store.seed_global({"이유 없는 거절": 12, "짧은 답": 9, "감정 표현에 짧은 답": 7})  # 데이터셋에서 모인 일반 패턴이라고 가정
    pipe = TonePipeline(router, store)

    print("== 1. 같은 문장, 다른 맥락 ==")
    for c in [convo("me-friend", "친구", ("them", "내일 7시 맞지?")),
              convo("me-friend", "친구", ("them", "요즘 진짜 너무 힘들다... 취업도 안 되고 다 그만두고 싶어"))]:
        r = await pipe.realtime("ㅇㅇ", c)
        print(f"  상대: {c.last_them()[:30]}")
        print(f"  → 거르기 {r.gate.prior} {r.gate.signals} | 알림: {r.hint.title if r.hint else '없음'} | {r.ms}ms {r.note}")

    print("\n== 2. 입력 중 알림 (지은과 1:1) ==")
    c = convo("minsu-jieun", "팀원",
              ("them", "민수님 이번 주만 마감 하루 미뤄도 될까요? 집에 일이 생겨서요"))
    draft = "안 돼요. 다들 맞춰서 하는 중이에요."
    r = await pipe.realtime(draft, c)
    print(f"  보낼 문장: {draft}")
    print(f"  거르기: {r.gate.prior} {r.gate.signals}")
    if r.verdict:
        print(f"  판단: risk={r.verdict.risk} 기권={r.verdict.abstain} ({r.verdict.reason})")
    print(f"  힌트: {r.hint.model_dump() if r.hint else '없음'}  [{r.ms}ms]")

    print("\n== 3. 살펴보기 (상세 경로) ==")
    d = await pipe.detail(draft, c, intent="마감은 못 미룬다")
    if d:
        print(f"  읽힐 수 있는 뜻: {d.readings}")
        print(f"  이유: {d.why}")
        for o in d.options:
            print(f"  [{o.label}] {o.text}  (지킨 것 {o.keep}, 바꾼 것 {o.change})")
        print(f"  각주: {d.footnote}")

    print("\n== 4. 지은이 AI에게 남긴 하소연 (비동기) ==")
    vent = "민수한테 마감 하루만 미뤄 달라고 했는데 이유도 없이 '안 돼요.' 하고 끝내서 좀 차갑게 느껴졌어"
    res, ack = await pipe.feedback(vent, "minsu-jieun")
    print(f"  추출된 패턴: {[p.model_dump() for p in res.patterns]} (원문은 저장 안 함)")
    print(f"  지은에게 보이는 답: {ack}")
    print(f"  저장된 관계 패턴: {store.patterns_for('minsu-jieun')}")

    print("\n== 5. 다음 대화에서 같은 패턴 ==")
    c2 = convo("minsu-jieun", "팀원", ("them", "회의 자료 오늘 말고 내일 드려도 될까요? 오늘 외근이라서요"))
    r2 = await pipe.realtime("안 돼요.", c2)
    print(f"  보낼 문장: 안 돼요. | 관계 패턴 반영: {r2.verdict.pattern_used if r2.verdict else '-'}"
          f" | risk={r2.verdict.risk if r2.verdict else '-'} | 힌트: {r2.hint.title if r2.hint else '없음'}")

    print("\n== 호출 기록 (원문 없음) ==")
    for t in router.traces:
        print(f"  {t['role']:<13} {t['model']:<45} {t['ms']:>5}ms {'ok' if t['ok'] else 'FAIL ' + t['error']}")


if __name__ == "__main__":
    asyncio.run(main(force_mock="--mock" in sys.argv))
