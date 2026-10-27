# CLAUDE.md

1:1·그룹 채팅 앱과, 보내기 전에 말투를 조용히 알려 주는 AI 엔진을 만드는 저장소다. 수업 프로젝트 규모(2~3명, 1~2달, 파일럿 20~30명)이고 출시는 목표가 아니다.

작업 전에 항상 `ARCHITECTURE.md`를 읽는다. 작업 단위는 `docs/tasks.md`의 ID다.

## 작업 방식

- "T-07 해줘"처럼 지시가 오면 `docs/tasks.md`에서 그 작업의 범위, 선행 작업, 완료 기준을 확인하고 그 범위만 한다.
- 선행 작업이 끝나지 않았으면 시작 전에 알린다.
- 아키텍처와 다르게 해야 할 이유가 생기면 코드를 바꾸기 전에 먼저 말한다. 합의되면 `ARCHITECTURE.md`를 같은 변경에서 고친다.
- 끝나면 `docs/tasks.md`의 상태를 `완료`로 바꾸고, 완료 기준을 어떻게 확인했는지 완료 기준 칸 끝에 `확인:`으로 한 줄 남긴다.
- 한 작업 = 한 브랜치(worktree) = 한 번의 `scripts/land`. 사용법은 `docs/COLLAB.md`. 브랜치 이름은 `t07-login`처럼(`scripts/claim`이 붙인다).
- `prototype/tone-harness`는 참고용이다. 고치지 말고, 필요한 코드는 `engine/`으로 옮겨서 쓴다(옮길 곳은 ARCHITECTURE 9장).

## 어디에 무엇을

| 경로 | 내용 |
|---|---|
| `apps/mobile` | Expo 앱 (expo-router, TypeScript strict). iOS·Android·웹 |
| `engine` | FastAPI AI 엔진 (Python 3.11+) |
| `engine/config/models.yaml` | 공급자, 전문가, 경로 시간 제한, 집계 가중치 |
| `engine/prompts` | 프롬프트. 바꾸면 평가를 다시 돌린다 |
| `supabase/migrations` | DB 변경은 여기 SQL로만 |
| `eval` | 대조 세트, 평가 스크립트 |
| `design` | HTML 목업, 대비 검사 |
| `design-system/tone-chat/MASTER.md` | 디자인 규칙 (D-01) |
| `engine/content` | 거울 상황 카드 (`mirror_cards.yaml`) |
| `scripts`, `docs/COLLAB.md` | 두 계정 협업 (claim, land, check) |

## 어기면 안 되는 규칙

1. 앱에는 모델 API 키와 Supabase service role 키를 넣지 않는다.
2. 모델 이름과 키는 `models.yaml`과 환경 변수에만 둔다. 코드에 직접 쓰지 않는다.
3. LLM 출력은 pydantic 스키마 검사를 통과해야 쓴다. 실패하면 폴백, 모두 실패하면 기권(힌트 없음).
4. 사용자에게 보이는 힌트 문구는 템플릿과 금지어 검사를 통과한 것만 내보낸다. 확정 표현과 출처를 짐작하게 하는 표현은 금지다.
5. 하소연(피드백) 원문은 DB, 로그, trace 어디에도 저장하지 않는다.
6. 힌트가 있어도 메시지 전송을 막지 않는다.
7. 한 사람의 피드백만으로 알림을 띄우지 않는다. 보낸 사람 패턴은 전체 패턴 관찰 수가 기준을 넘을 때만 반영한다.
8. 실시간 힌트는 1.5초를 넘기면 결과를 버린다.
9. 실제 대화는 Gemini 무료 등급에 보내지 않는다. 예문·합성 데이터만.
10. `tone` 스키마는 앱에서 접근할 수 없게 둔다(API 비공개, 서비스 키로만).
11. 엔진 장애가 채팅을 막으면 안 된다. 채팅 경로에 엔진 호출을 넣지 않는다.
12. 사진은 모델에 보내지 않는다. 판정은 텍스트만 한다.
13. 실제 대화에서 뽑은 거울 카드도 Gemini 무료 등급에 보내지 않는다.
14. 1:1 방의 하소연은 보낸 사람 패턴(`tone.sender_patterns`)에 넣지 않는다. 전체 패턴(`tone.global_patterns`)에만 더한다.
15. 카카오톡·인스타그램·디스코드의 이름, 로고, 색, 에셋을 쓰지 않는다(노란색·갈색 계열 포함). 조사 결과는 기능 이름 수준으로만 남긴다.
16. 외부 모델로 가는 문장(초안, 최근 대화, 답장 대상, 의도, 하소연, 거울 카드)은 파이프라인 입구에서 요청마다 한 번 `pii.Masker`(참여자 이름 + 개인정보 패턴)를 거친다. 모든 레이어는 가린 문장만 받는다. 고쳐 쓰기 후보(거울 `options` 포함)의 자리표시는 엔진이 응답 직전에 `Masker.restore`로 되돌리고, 자리표시→원문 대응표는 그 요청의 `Masker` 메모리에만 둔다(로그·trace·큐 인자 금지). 라우터는 mock이 아닌 공급자로 보내기 직전에 `pii.mask`(패턴만)를 한 번 더 한다(안전망).

## 코드 규칙

- Python: 타입 힌트, pydantic v2, httpx + asyncio, pytest. 외부 모델 호출 테스트는 mock 공급자로.
- TypeScript: strict. 엔진·DB 타입은 생성한 것만 쓴다(`openapi-typescript`, `supabase gen types typescript`). 손으로 타입을 복제하지 않는다.
- 엔진 API나 DB 구조를 바꾸면 앱 타입을 다시 생성해서 같은 브랜치에 넣는다.
- 프롬프트·모델·가중치를 바꾸면 `scripts/land`가 평가 게이트를 돌린다(`eval/run_eval.py --mock`). 정밀도가 `eval/baseline.json`보다 낮으면 합치지 않는다.
- 사용자에게 보이는 문구는 한국어, "~일 수도 있어요" 같은 확정하지 않는 말투.

## 명령

명령은 해당 작업에서 정해지면 여기에 채운다.

| 용도 | 명령 |
|---|---|
| 엔진 실행 | `cd engine && uv run uvicorn app.main:app --reload --env-file ../.env` |
| 엔진 테스트 | `cd engine && uv run pytest -q` |
| 앱 실행 | `cd apps/mobile && npx expo start` (앱 환경 변수는 `apps/mobile/.env`, 예시는 `apps/mobile/.env.example`. 루트 `.env`는 앱이 읽지 않는다) |
| 타입 생성 | (T-14, T-03a) |
| 평가 | (T-17) |
| 마이그레이션 | `supabase/migrations/*.sql` (적용은 T-02 이후 `supabase db push`) |
| DB 테스트 | `cd supabase && npm test` |
| 작업 잡기 | `scripts/claim T-07 login` (마지막 줄이 worktree 경로) |
| 합치기 | worktree 안에서 `scripts/land T-07` |
| 검사 | `scripts/check` |
