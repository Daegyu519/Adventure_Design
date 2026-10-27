# 단계 1 · AI 엔진 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 엔진이 Supabase 토큰으로 사용자를 확인하고 방 맥락을 DB에서 직접 읽는다. 그 위에 실시간 힌트, 살펴보기, 털어놓기, 거울, 리포트 API와 웹훅(기준선, 푸시)을 올리고, 모두 mock 공급자만으로 테스트되게 한다.

**Architecture:** 요청 → `app/auth`(JWKS) → `app/db.Repo`(asyncpg) → `app/context`(최근 8턴, 화자 표시, 답장 대상, 패턴·기준선 스냅숏) → `pipeline.py`(입구에서 `pii.Masker` 한 번 → L0 → 레지스트리 전문가 동시 호출 → 집계 → 문구 검사 → 자리표시 복원) → 응답. 응답을 늦추면 안 되는 쓰기(trace, 이벤트, 하소연, 기준선, 푸시)는 `jobs/queue.JobQueue`(asyncio)로 넘긴다. 모델 호출은 모두 `models.yaml`의 `experts`를 `Registry`가 만든 `LLMExpert`로 한다.

**Tech Stack:** Python 3.11 · uv · FastAPI · pydantic v2 · httpx · asyncpg · PyJWT[crypto] · pywebpush · pytest · Postgres 16(brew, 테스트용 임시 클러스터) · openapi-typescript(앱 계획의 `npm run gen:engine:pull`)

**Spec:** `docs/superpowers/specs/2026-10-27-tone-chat-scope-design.md` (기준 문서 `ARCHITECTURE.md`, `CLAUDE.md`, `docs/tasks.md`). 단계 0 계획 `docs/superpowers/plans/2026-10-27-phase0-foundation.md`의 결과 위에서 시작한다.

**이 계획의 범위:** 엔진만 한다: T-06(→T-06a, T-06b), T-10, T-12, T-13, T-14, T-17, T-19, T-21, T-23, T-24, T-26, T-27b(T-27의 엔진 몫), T-28b(T-28의 엔진 몫), T-35. 앱은 `2026-10-27-phase1-app.md`가 맡는다(T-27a, T-28a 등). 이 계획이 만드는 새 행은 T-10-live, T-17-live다("이 계획에서 정한 것" 11번). 범위 밖은 T-16(사람이 하는 라벨링), T-18, T-20, T-29, 그리고 ARCHITECTURE 4장의 사용자별 429다. 429는 L0가 대부분을 걸러 무료 한도 안에 들므로 건너뛴다. 한 사람이 한도를 다 쓰는 일이 생기면 그때 `TokenBucket`을 사용자별로 재사용한다.

**시작 조건:** main에 단계 0의 T-05, T-11(이미 합쳐짐)과 T-03a, T-03b(마이그레이션)가 있어야 한다.

## Global Constraints

- 모델 이름과 키는 `engine/config/models.yaml`과 환경 변수에만 둔다. 코드에 직접 쓰지 않는다.
- 실제 대화 문장이 지나가는 경로(실시간·상세·털어놓기·거울)의 전문가와 폴백 목록에는 `gemini:`가 없다. Gemini 공급자 정의는 합성 문장 평가용으로만 남긴다.
- 외부 모델로 가는 문장(초안, 최근 대화, 답장 대상, 의도, 하소연, 거울 카드)은 `pipeline.py` 입구에서 한 번 `Masker`(참여자 이름 포함)를 거친다. 전문가와 레이어는 가린 문장만 받는다. 고쳐 쓰기 후보(거울 `options` 포함)의 자리표시는 응답 직전에 되돌린다. 대응표는 그 요청의 메모리에만 두고 로그, trace, 큐 인자에 넣지 않는다. 그 위에 `Router.call`이 mock이 아닌 모든 공급자(`local` 포함. 로컬 주소가 원격을 가리킬 수 있다)로 보내기 직전에 패턴 가리기를 한 번 더 한다(안전망).
- LLM 출력은 pydantic 검사를 통과한 것만 쓴다. 실패하면 폴백, 모두 실패하면 그 전문가를 빼고, 말투 전문가가 0개면 기권한다.
- 사용자에게 보이는 엔진 문구(힌트 제목·이유, 어긋남 줄, 옵션 라벨·keep·change, 거울 속마음·공개 문구, 털어놓기 안내)는 고정 템플릿과 `guard.guard`를 통과한 것만 내보낸다. 한국어로, "~수도 있어요"처럼 쓴다.
- 하소연 원문은 DB, 로그, trace, 큐 실패 로그 어디에도 남지 않는다.
- 한 사람의 피드백만으로 알림을 띄우지 않는다. 보낸 사람 패턴은 L0(`gate`)와 L3(`aggregate`) 모두에서 `global_patterns[trigger] ≥ global_min_obs`(5, 서로 다른 신고자 수)일 때만 반영한다.
- 1:1 방 하소연(그리고 멤버가 3명 미만인 방의 하소연)은 `tone.sender_patterns`에 넣지 않고 `tone.global_patterns`에만 더한다. 그룹 하소연의 `active_from`은 다음 날 0시(Asia/Seoul)다.
- 실시간 힌트는 `paths.realtime.deadline_ms`(1500)를 넘기면 `hint=null`이다. 엔진 장애는 채팅을 막지 않는다(채팅 경로에 엔진 호출 없음).
- 응답에 내부 점수(risk, 확률, 가중치, disagreement, reason, panel 칸)를 넣지 않는다. 읽힘 키는 `차갑게, 성의없게, 화나게, 무난하게, 따뜻하게` 다섯 개로 고정하고, 표시는 `자주/가끔/드물어요`로만 한다.
- 사진은 모델에 보내지 않는다. 사진만 있는 메시지는 맥락에서 `(사진)`으로 바꾼다.
- 엔진은 앱이 보낸 맥락을 믿지 않는다. 최근 대화, 답장 대상, 거울 문장은 엔진이 DB에서 읽는다.
- `tone` 스키마에는 엔진(`SUPABASE_DB_URL`)만 접근한다. DB 변경은 `supabase/migrations/`의 SQL로만 한다.
- 엔진 API를 바꾼 브랜치는 같은 브랜치에서 `apps/mobile/lib/types/engine.openapi.json`과 `engine.ts`를 다시 생성한다.
- Python 3.11, 타입 힌트, pydantic v2, httpx + asyncio, pytest를 쓴다. 테스트는 mock 공급자만 쓰고 네트워크를 쓰지 않는다(`tests/conftest.py`가 막는다).
- 루트 체크아웃을 직접 고치지 않는다. 작업마다 `scripts/claim` worktree에서 한다. 서브에이전트 모델은 `sonnet` 또는 `opus`만 쓴다.

## Review Focus

- 고쳐 쓰기 후보나 거울 `options`에 `[이름1]`·`[전화번호1]`이 남은 채 입력창으로 들어갈 수 있다. 엔진이 원래 값으로 되돌려야 한다(Task 2 `test_name_survives_rewrite_round_trip`, Task 9 `test_rewrite_restores_masked_values`).
- 같은 사람이 같은 메시지나 같은 신호로 털어놓기를 되풀이할 수 있다. 한 번만 세야 하고, 전체 패턴 수는 서로 다른 신고자 수여야 한다(Task 1 `test_apply_feedback`, Task 10 `test_same_reporter_repeats_count_once`).
- 서버 시계가 UTC여도 한국 자정과 주 경계가 맞아야 한다. `active_from`, 주간 상한, 주별 힌트 수는 Asia/Seoul 기준이다(Task 1 `test_mirror_and_stats`, Task 10 `test_kst_boundaries`).
- L4가 `trigger`·`feeling` 자리에 문장 조각을 내놓을 수 있다. 고정 목록 밖의 값은 저장하지 않는다(Task 10 `test_unknown_trigger_or_feeling_not_stored`, `test_apply_feedback_rejects_bad_values`, `test_bad_pattern_error_has_no_value`).
- 같은 보낸 사람·관계·신호의 재신고가 이미 켜진 패턴을 다시 "다음 날부터"로 밀어 숨길 수 있다. 활성 시각별 행으로 막는다(Task 10 `test_rereport_keeps_active_pattern`, `test_rereport_next_day_keeps_yesterdays_pattern`). 또 `apply_feedback`는 보낸 사람·관계를 호출자에게 받지 않고, 그룹(3명 이상) 판정도 SQL에서 한 번 더 한다(Task 10 `test_apply_feedback_group_rule_in_sql`).
- 웹 푸시 구독 하나가 만료되거나 실패할 수 있다. 다른 수신자는 계속 받아야 하고, 재시도 때문에 알림이 겹치면 안 된다(Task 8 `test_one_bad_subscription_does_not_block_others`). 만료(404·410)된 구독은 지운다(`test_dead_web_subscription_deleted`).
- 웹 푸시 구독 JSON은 사용자가 `push_tokens`에 쓴 값이라 `endpoint`가 내부 주소일 수 있다. 알려진 푸시 서비스 호스트가 아니면 부르지 않는다(Task 8 `test_web_endpoint_allowlist`, `test_disallowed_endpoint_not_sent`).
- 첫 `/v1/hint`가 JWKS 받기를 기다리면 1.5초 예산을 먹는다. 시작 때 미리 받아 둔다(Task 3 `test_lifespan_warms_jwks`, Task 7 `test_first_hint_after_startup_has_no_jwks_fetch`).
- 브라우저 앱이 `Authorization` 헤더를 달고 엔진을 부르려면 CORS 사전 요청이 통과해야 한다. 허용하지 않은 origin은 통과하면 안 된다(Task 7 `test_preflight_allowed_origin`, `test_preflight_disallowed_origin`).

## 이 계획에서 정한 것

1. **DB 접근:** asyncpg 풀 하나(`SUPABASE_DB_URL`)를 쓴다. 대시보드 Connect의 Session pooler URI를 쓴다(무료 플랜 직접 연결은 IPv6 전용). `statement_cache_size=0`이라 transaction pooler에서도 돈다. SQL은 모두 `app/db.py`의 `PgRepo`에만 둔다. 라우트와 작업은 `Repo` Protocol만 안다. 테스트는 `tests/fakes.FakeRepo`와 `PgRepo`에 **같은 계약 테스트**를 돌린다. Postgres 쪽은 `brew install postgresql@16`의 initdb로 세션마다 임시 클러스터를 띄우고, `supabase/tests/shim.sql`과 `supabase/migrations`(`_platform` 제외)를 적용한다. postgres가 없으면 pg 쪽만 건너뛴다. ORM과 Supabase REST는 쓰지 않는다(`tone`은 API 비공개).
2. **상세 경로 두 번째 말투 전문가:** `nvidia:moonshotai/kimi-k3`(`mock: tone_alt`)다. 거울은 상세 경로 전문가를 그대로 쓴다(`paths: [detail, mirror]`).
3. **`reply_to`:** `/v1/hint`와 `/v1/detail`이 선택 값으로 받는다. 엔진이 DB에서 같은 방인지 확인한다. 없거나 다른 방이면 422다. 답장 대상은 맥락 맨 앞에 둔다.
4. **"그룹방 하소연":** `rooms.kind = 'group'`이고 멤버가 3명 이상인 방이다. `global_patterns.count`는 신호별 서로 다른 신고자 수다(`tone.pattern_reporters`). 같은 (신고자, 메시지)는 DB unique로 한 번만 받는다. `sender_patterns`는 활성 시각(`active_from`)별 행으로 쌓는다(기본 키에 `active_from` 포함, T-24 마이그레이션). 재신고는 자기 `active_from`(다음 KST 자정) 행만 올리므로 이미 켜진 패턴은 꺼지지 않고, 새 증가분만 다음 날 0시부터 보인다(익명성 유지).
5. **고쳐 쓰기:** `alert`이거나 의도 어긋남이 있을 때 돈다. 옵션 라벨은 고정(`조금만 바꾼 문장` / `가장 부드럽게 바꾼 문장`)이다. `detail_opened`는 `intent` 없는 첫 호출만 기록하고, `risk`는 `tone_events`(사용자가 읽을 수 있는 표)에 넣지 않는다.
6. **거울:** 되돌려 받기와 예측은 맥락 없이 거울 경로 말투 전문가만 쓴다(`pipeline.panel`). `card_id`는 `MIRROR_SECRET` HMAC으로 서명한다(값이 없으면 프로세스마다 임의 키). 오늘과 어제 카드만 유효하다. 속마음은 읽힘별 고정 문구다.
7. **리포트:** `fix_rate = sent_after_fix / (sent_after_fix + sent_with_hint)`이고, 분모가 0이면 0.0이다. 주는 KST 월요일 날짜 문자열(`YYYY-MM-DD`)로 최근 5주를 센다. `hint_shown`은 앱이 기록한다(`signals: {trace_id}`). `tone_events.signals`는 양쪽 모두 jsonb 객체다(앱 `{trace_id}`, 엔진 `{signals: […], trace_id}`). `mirror_attempts`는 엔진이 `/v1/mirror/answer` 안에서 서비스 권한(`SUPABASE_DB_URL` 직접 연결)으로 쓰고, 앱은 읽기만 한다(앱은 panel 칸을 모른다). 푸시 내용은 Expo·웹 모두 `{title, body, url: "/room/<room_id>"}`다. 앱 쪽 시간 제한은 1700ms(엔진 1.5초 + 네트워크)다.
8. **ID:** T-06은 T-06a(DB 접근)와 T-06b(인증)로 나눈다. T-27은 T-27a(앱 화면)·T-27b(엔진), T-28은 T-28a(앱 등록)·T-28b(엔진 발송)로 나눈다. 앱 T-04b와 엔진 Task 8·12 중 먼저 land되는 작업이 부모 행을 두 행으로 바꾸고(둘 다 `대기`), 나중 작업은 자기 행만 고친다.
9. **평가:** 알림이 0개면 precision을 0.0으로 낸다(jq 비교용). 대조 세트는 T-16 전까지 프로토타입의 8쌍을 쓴다.
10. **CORS:** `CORS_ORIGINS`(쉼표로 나눈 origin, 기본 `http://localhost:8081` = 웹 dev)를 `CORSMiddleware`에 넣는다. 메서드는 GET·POST·OPTIONS, 헤더는 Authorization·Content-Type이다. 앱 웹 빌드는 브라우저에서 엔진을 직접 부르므로 사전 요청(OPTIONS)이 통과해야 한다.
11. **키·사람 작업이 필요한 기준:** 완료 기준이 T-02(실제 Supabase), T-16(사람 라벨), 실제 키 실행을 요구하면 상태를 `진행`으로 두지 않는다(`scripts/land`는 `완료`만 받는다). 그 행의 완료 기준을 "mock/로컬 기준"(지금 이 작업이 확인하는 것)으로 줄이고 선행 칸에서 T-02·T-16을 빼서 `완료`로 한다. 남은 확인은 `<ID>-live` 행(상태 `대기`, 선행 T-02 또는 T-16)으로 만든다. 이 계획에서는 T-10(Task 6)과 T-17(Task 15)이 해당한다.
12. **JWKS:** 엔진이 뜰 때 한 번 미리 받고(lifespan), 받기 제한시간은 1초다. 첫 `/v1/hint`가 JWKS 받기를 기다려 1.5초 예산을 쓰지 않게 한다.

## 작업 순서와 웨이브

같은 웨이브의 작업은 각자 worktree에서 동시에 해도 된다. 같은 웨이브끼리 겹치는 파일(`app/contracts.py`, `app/main.py`, `pipeline.py`, `tests/conftest.py`, `docs/tasks.md`)에는 덧붙이기만 한다.

| Task | 작업 ID | 선행 Task | 웨이브 | 권장 모델 |
|---|---|---|---|---|
| 1 | T-06a 엔진 DB 접근 계층 | 단계 0 T-03b | 1 | opus |
| 2 | T-12 전문가 인터페이스 + 가리기 한 곳 | 단계 0 T-11 | 1 | opus |
| 3 | T-06b JWKS 인증 + 방 멤버 확인 | 1 | 2 | sonnet |
| 4 | T-13 집계기 + 패턴 조건 | 2 | 2 | opus |
| 5 | T-23 작업 큐 | 1 | 2 | sonnet |
| 6 | T-10 웹훅 수신 | 1 | 2 | sonnet |
| 7 | T-14 `/v1/hint` + OpenAPI | 3, 4 | 3 | opus |
| 8 | T-28b 푸시 발송 | 5, 6 | 3 | sonnet |
| 9 | T-21 `/v1/detail` | 5, 7 | 4 | opus |
| 10 | T-24 털어놓기 → 패턴 | 5, 7 | 4 | opus |
| 11 | T-26 기준선 | 5, 6, 7 | 4 | sonnet |
| 12 | T-27b `/v1/stats/me` | 7 | 4 | sonnet |
| 13 | T-19 analysis_traces | 9 | 5 | sonnet |
| 14 | T-35 거울 API | 9 | 5 | opus |
| 15 | T-17 평가 스크립트 + baseline | 9 | 5 | sonnet |

## 공통 작업 흐름

- **잡기:** `scripts/claim <ID> <slug>`를 실행하고, 출력 마지막 줄의 worktree로 이동한다. 테스트는 `cd engine && uv run pytest -q`로 돌린다.
- **끝내기(구현자):** `docs/tasks.md`의 그 행을 `완료`로 바꾸고, 완료 기준 칸 끝에 `확인:` 한 줄을 붙인 뒤 commit한다. 구현자는 여기서 멈춘다. 완료 기준이 T-02·T-16·실제 키를 요구하는 작업(T-10, T-17)은 "이 계획에서 정한 것" 11번대로 행을 나눈다.
- **합치기(리뷰 통과 뒤 컨트롤러):** worktree에서 `git merge main`을 한다. `apps/mobile/lib/types/engine.openapi.json`과 `engine.ts`가 충돌하면 손으로 고치지 말고 다시 생성한다. 나머지 충돌은 양쪽을 다 남긴다. 그다음 `scripts/check`, `scripts/land <ID>` 순으로 실행한다.
- **API를 바꾼 작업:** `apps/mobile/package.json`에 `gen:engine:pull`이 있으면 `cd apps/mobile && npm run gen:engine:pull`을 실행한다. 없으면(앱 T-04b가 아직 안 합쳐졌다) 두 단계로 같은 일을 한다. 먼저 `cd engine && mkdir -p ../apps/mobile/lib/types && uv run python -c "import json; from app.main import app; print(json.dumps(app.openapi()))" > ../apps/mobile/lib/types/engine.openapi.json`으로 덤프하고, 저장소 루트에서 `npx -y openapi-typescript apps/mobile/lib/types/engine.openapi.json -o apps/mobile/lib/types/engine.ts`로 `engine.ts`를 만든다. `engine.openapi.json`과 `engine.ts` 둘 다 커밋에 넣는다.

---

### Task 1: T-06a 엔진 DB 접근 계층

**Files:**
- Create: `engine/app/db.py`, `engine/app/deps.py`, `engine/tests/__init__.py`(빈 파일), `engine/tests/conftest.py`, `engine/tests/fakes.py`, `engine/tests/pg.py`, `engine/tests/test_db.py`, `supabase/migrations/20261028000001_engine.sql`
- Modify: `engine/pyproject.toml`(`asyncpg>=0.29`), `engine/app/main.py`(lifespan), `docs/tasks.md`, `ARCHITECTURE.md` 10장, `CLAUDE.md` 명령 표

**Interfaces:**
- Consumes: 단계 0 SQL(`rooms.kind/relation/title`, `room_members.muted`, `messages`, `profiles.name`, `push_tokens`, `tone_events`, `mirror_attempts`, `tone.*`), `app.settings.Settings`, `harness.schemas.FeedbackPattern`.
- Produces (`app.db`):
  ```python
  KST = ZoneInfo("Asia/Seoul")
  def week_start(ts: datetime) -> date    # ts의 KST 기준 ISO 주 월요일
  @dataclass(frozen=True) class Room: id: UUID; kind: str; relation: str; title: str | None; member_count: int
  @dataclass(frozen=True) class Msg: id: int; room_id: UUID; sender_id: UUID; text: str; image_path: str | None; reply_to: int | None; created_at: datetime
  @dataclass(frozen=True) class SentMsg: id: int; room_id: UUID; text: str; relation: str; created_at: datetime
  @dataclass(frozen=True) class PushTarget: user_id: UUID; token: str; platform: str
  @dataclass(frozen=True) class TraceRow: trace_id: UUID; path: str; user_id: UUID; room_id: UUID; experts: dict; risk: float | None; alert: bool; latency_ms: int
  @dataclass(frozen=True) class FeedbackWrite: room_id: UUID; reporter_id: UUID; message_id: int; sender_id: UUID; relation: str; usable: bool; patterns: list[FeedbackPattern]; to_sender: bool; active_from: datetime
  class Repo(Protocol):   # 모두 async
      is_member(room_id, user_id) -> bool
      room(room_id) -> Room | None
      recent_messages(room_id, limit: int = 8) -> list[Msg]                 # 오래된 것 → 최신
      message(message_id: int) -> Msg | None
      member_names(room_id) -> dict[UUID, str]
      sender_patterns(sender_id, relation: str, now: datetime) -> dict[str, dict]  # active_from <= now만. {trigger: {count, strength, feeling}}
      global_patterns() -> dict[str, int]
      baseline(user_id) -> dict | None                                       # {avg_len, polite_rate, softener_rate, n}
      update_baseline(user_id, length: int, polite: bool, softener: bool) -> None  # SQL 한 문장 upsert로 누적 평균
      insert_trace(row: TraceRow) -> None
      insert_event(user_id, room_id, kind: str, top_reading: str | None, signals: dict) -> None  # risk는 넣지 않음. signals는 jsonb 객체 {"signals": [...], "trace_id": "..."}
      weekly_feedback_count(sender_id, relation: str, since: datetime) -> int  # usable 행만
      apply_feedback(fb: FeedbackWrite) -> bool                              # 한 트랜잭션. (reporter, message) 중복이면 False, 변화 없음
      push_targets(room_id, sender_id) -> list[PushTarget]                  # 보낸 사람·muted 제외
      delete_push_token(user_id, token: str) -> None                        # 죽은 구독 정리(Task 8). 없는 행이면 조용히 지나감
      sent_messages(user_id, since: datetime, limit: int = 50) -> list[SentMsg]  # 본인, text 있는 것, 최신 먼저
      mirror_refs(user_id) -> set[str]                                       # f"{kind}|{card_ref}"
      insert_mirror_attempt(user_id, kind: str, card_ref: str, answer_score: int | None, predicted: int | None, panel_bin: int | None, gap: int | None) -> None
      event_counts(user_id) -> dict[str, int]
      hints_by_week(user_id, since: datetime) -> dict[date, int]             # hint_shown, 키는 week_start
      predict_gap_by_week(user_id, since: datetime) -> dict[date, float]     # mirror_attempts kind='predict' gap 평균
  class PgRepo:  # Repo 구현
      @classmethod
      async def connect(cls, dsn: str) -> "PgRepo"   # asyncpg.create_pool(dsn, min_size=0, max_size=5, statement_cache_size=0, command_timeout=5)
      async def close(self) -> None
  ```
  - `apply_feedback`가 usable일 때 하는 일은 셋이다. 패턴마다 `tone.pattern_reporters(trigger, reporter_id)`에 넣는다. 그 행이 새로 들어갔을 때만 `global_patterns.count + 1`을 한다. `to_sender`면 `sender_patterns`를 upsert한다(count + 1, strength는 누적 평균, feeling은 새 값, `active_from` = `fb.active_from`). 패턴은 `sorted(patterns, key=lambda p: p.trigger)` 순서로 처리한다(동시 신고가 같은 행을 반대 순서로 잠가 데드락 나는 것을 막는다). 이 Task 10(T-24)이 `sender_patterns` 키·`FeedbackWrite`·읽기 규칙을 바꾼다(Task 10 "`Repo.apply_feedback` 규칙"). usable이 아니면 `feedback_log`만 남긴다(`pattern_count` 0).
  - `app.deps.get_settings() -> Settings`(`lru_cache`, `Settings.from_env()`), `app.deps.get_repo(request: Request) -> Repo`(`request.app.state.repo`이 없으면 503).
  - `tests.fakes.FakeRepo`: `Repo` 구현에 동기 시드 메서드를 더한다. 시드 메서드는 `add_user(name) -> UUID`, `add_room(kind, relation, members, title=None) -> UUID`, `add_message(room_id, sender_id, text, *, image_path=None, reply_to=None, at=None) -> int`, `set_muted(room_id, user_id)`, `add_push_token(user_id, token, platform)`, `add_event(user_id, room_id, kind, *, at=None)`, `add_mirror_attempt(user_id, kind, card_ref, *, gap=None, at=None)`, `add_sender_pattern(sender_id, relation, trigger, *, count=1, strength=1.0, feeling="차갑게", active_from)`, `set_global(trigger, count)`, `rows(table: str) -> list[dict]`다. 상태는 공개 속성으로 둔다(`fake.traces`, `fake.events`, `fake.feedback_log`, …).
  - `tests.pg.PgSeeder(conn)`: 같은 이름의 시드 메서드를 async로 둔다.
  - `tests/conftest.py` 픽스처:
    - `fake`
    - `client`: `TestClient(app)`(lifespan은 돌지 않음), `get_repo`→`fake`, `get_settings`→`dataclasses.replace(Settings.from_env(), hook_secret="test-secret", supabase_url="https://test.supabase.co")`. 끝나면 `app.dependency_overrides.clear()`.
    - `pg_dsn`: 테스트마다 새 DB. postgres가 없으면 skip.
    - autouse `no_network`: `httpx.AsyncHTTPTransport.handle_async_request`와 `httpx.HTTPTransport.handle_request`가 예외를 던진다.
    - autouse `mock_env`: `FORCE_MOCK=1`을 넣고 `NVIDIA_API_KEY`, `GITHUB_TOKEN`, `GEMINI_API_KEY`, `USE_LOCAL_MODEL`을 지운다.

- [ ] **Step 1: claim** — `scripts/claim T-06a engine-db`

- [ ] **Step 2: Postgres 준비**

Run: `ls /opt/homebrew/opt/postgresql@16/bin/initdb || brew install postgresql@16`
keg-only라 PATH에 넣지 않는다. `tests/pg.py`는 env `PG_BIN`(기본 그 폴더)을 쓴다.

- [ ] **Step 3: 실패하는 계약 테스트 작성** — `tests/pg.py`, `tests/test_db.py`

`tests/pg.py`의 세션 픽스처가 하는 일:
1. `initdb -D <tmp>/data -U postgres -A trust -E UTF8 --no-locale`로 클러스터를 만든다.
2. `pg_ctl -D … -o "-h '' -k <sock> -F -c shared_buffers=16MB" -w -l <tmp>/log start`로 띄운다. TCP는 끄고 유닉스 소켓만 쓴다. `<sock>`은 `tempfile.mkdtemp(prefix="tpg", dir="/tmp")`다(macOS 소켓 경로 길이 제한 때문이고, worktree 여러 개가 동시에 돌아도 겹치지 않는다).
3. DB `tpl`에 `supabase/tests/shim.sql`과 `supabase/migrations/*.sql`(이름에 `_platform`이 없는 것, 이름순)을 asyncpg `execute`로 적용한다.
4. 테스트마다 `createdb -T tpl t<n>`, 끝나면 `dropdb`. 세션이 끝나면 `pg_ctl stop -m fast`.

`world` 픽스처는 params `["fake", "pg"]`로 `(repo, seed)`를 돌려준다. 시드는 `await w(seed.add_user("민수"))`(`inspect.isawaitable`로 동기·비동기 모두 받는 헬퍼)로 쓴다. 테스트 본문은 `asyncio.run`으로 돈다.

```python
def test_membership_and_room(world)        # 멤버 True·비멤버 False; room(): kind "group", relation "팀원", member_count 3; 없는 방 None
def test_recent_messages(world)            # 10개 → 8개, created_at 오름차순, 마지막이 최신; 사진만 메시지는 text == "", image_path 유지
def test_message_and_names(world)          # message(id).room_id 일치, 없는 id → None; member_names == {uid_a: "민수", ...}
def test_sender_patterns_active_from(world)  # active_from 내일 → {}; 어제 → {"짧은 답": {"count": 2, "strength": 1.5, "feeling": "성의없게"}}
def test_baseline_running_average(world)   # update(10,True,False), update(20,False,False) → {"avg_len":15.0,"polite_rate":0.5,"softener_rate":0.0,"n":2}
def test_apply_feedback(world)
    # to_sender=True → sender_patterns count 1·active_from 저장, global["짧은 답"] == 1, feedback_log 1행(pattern_count 1), 반환 True
    # 같은 (reporter, message) 다시 → False, 세 표 모두 그대로
    # 같은 신고자가 다른 메시지 4개로 같은 trigger → global["짧은 답"] == 1 (서로 다른 신고자 수)
    # 다른 신고자 → 2; to_sender=False → sender_patterns 그대로
    # usable=False → feedback_log pattern_count 0, 패턴 표 그대로
def test_weekly_feedback_count(world)      # since 이전·usable=False·다른 관계·다른 보낸 사람 제외
def test_push_targets(world)               # 보낸 사람·muted 제외, 한 사람 토큰 2개면 2개; delete_push_token(user, token) 뒤 그 토큰만 빠지고, 없는 토큰이면 조용히 지나감
def test_sent_messages(world)              # 남의 것·사진만·since 이전 제외, relation 채움, 최신 먼저, limit 지킴
def test_mirror_and_stats(world)           # mirror_refs == {"predict|msg:7"}; event_counts == {"hint_shown": 2, ...}
                                           # hints_by_week: 2026-10-25T15:30Z 이벤트 → {date(2026,10,26): 1} (KST로는 월요일, UTC로 세면 10-19 주가 됨)
                                           # predict_gap_by_week: gap 1, 3 → {월요일: 2.0}
def test_insert_trace_and_event(world)     # rows("tone.analysis_traces")[0]["experts"] == 넣은 dict; rows("public.tone_events")[0]["risk"] is None; 같은 행의 signals == {"signals": ["짧은 답"], "trace_id": "…"}(객체로 저장됨)
```

- [ ] **Step 4: 실패 확인**

Run: `cd engine && uv run pytest -q tests/test_db.py`
Expected: FAIL (`ModuleNotFoundError: app.db`)

- [ ] **Step 5: 구현** — `app/db.py`, `app/deps.py`, `tests/fakes.py`, 마이그레이션, lifespan

마이그레이션 `20261028000001_engine.sql`:
```sql
-- 엔진이 쓰는 제약·색인. 하소연 원문 칸은 없다.
create unique index if not exists feedback_log_reporter_message_key on tone.feedback_log (reporter_id, message_id);
create table if not exists tone.pattern_reporters (
  trigger text not null, reporter_id uuid not null, created_at timestamptz not null default now(),
  primary key (trigger, reporter_id));
grant all on tone.pattern_reporters to service_role;
create index if not exists messages_room_created_idx on public.messages (room_id, created_at desc);
create index if not exists tone_events_user_kind_idx on public.tone_events (user_id, kind, created_at);
```
단계 0 칸 타입이 계약 테스트와 안 맞으면(예: `sender_patterns.strength`가 정수) 같은 파일에서 `alter … type real`로 맞춘다.

`PgRepo` 규칙:
- jsonb는 `$n::jsonb`에 `json.dumps`를 넘긴다.
- 주 묶기는 `date_trunc('week', created_at at time zone 'Asia/Seoul')::date`로 한다.
- `apply_feedback`는 `insert … on conflict (reporter_id, message_id) do nothing returning id`로 시작한다.

lifespan은 기존 `load_config()` 다음에 `app.state.repo = await PgRepo.connect(dsn)`을 한다(`supabase_db_url`이 비면 `None`). 종료 때는 `close()`를 부른다. `min_size=0`이라 DB가 죽어 있어도 `/health`는 뜬다.

- [ ] **Step 6: 통과 확인**

Run: `cd engine && uv run pytest -q tests/test_db.py`
Expected: `22 passed`(postgres 있음) 또는 `11 passed, 11 skipped`
Run: `cd supabase && npm test`
Expected: 단계 0 테스트가 새 마이그레이션과 함께 그대로 통과
Run: `cd engine && uv run pytest -q`
Expected: 기존 테스트 포함 실패 0

- [ ] **Step 7: 문서 + 완료 처리 + commit**

- `docs/tasks.md`: T-06 행을 두 행으로 바꾼다.
  - `| T-06a | 엔진 DB 접근 계층: asyncpg Repo, FakeRepo 계약 테스트, 엔진 색인·pattern_reporters 마이그레이션 | 엔진, DB | T-03b, T-05 | 같은 계약 테스트가 FakeRepo와 임시 Postgres 둘 다 통과. 확인: … | 완료 |`
  - `| T-06b | 엔진 인증: Supabase JWKS로 토큰 검증하는 의존성, 방 멤버 확인 헬퍼(room_members) | 엔진 | T-06a | 정상·만료·위조 토큰, 비참여자 403 테스트 | 대기 |`
  - 다른 행의 선행 칸에 있는 `T-06`은 `T-06b`로 바꾼다.
- `ARCHITECTURE.md` 10장 표에 행을 더한다: `엔진 DB 접근은 asyncpg + app/db.py 한 곳 | SQL이 한 파일에 모이고, 가짜와 진짜에 같은 테스트 | ORM, Supabase REST(tone 비공개)`
- `CLAUDE.md` 명령 표에 행을 더한다: `엔진 DB 테스트 준비 | brew install postgresql@16 (없으면 pg 계약 테스트만 건너뜀)`

```bash
git add -A && git commit -m "T-06a: engine Repo (asyncpg) with fake/pg contract tests"
```

---

### Task 2: T-12 전문가 인터페이스 · 레지스트리 · LLMExpert + 가리기 한 곳

**Files:**
- Create: `engine/experts/__init__.py`, `engine/experts/base.py`, `engine/experts/llm.py`, `engine/experts/registry.py`, `engine/tests/spy.py`, `engine/tests/test_experts.py`
- Modify: `engine/harness/{router,providers,pii,schemas,prompts}.py`, `engine/config/models.yaml`, `engine/app/settings.py`, `engine/app/main.py`, `engine/tests/test_harness.py`, `engine/tests/test_health.py`, `ARCHITECTURE.md` 6-2·6-4·8장, `.env.example`

**Interfaces:**
- Consumes: T-11 하네스(`Router`, `MockProvider`, `mock_rules`, `prompts.render`, `schemas`), `app.settings.DEFAULT_MODELS_PATH`.
- Produces:
  - `harness.providers.available(name: str, pcfg: dict, env: Mapping[str, str]) -> bool`: mock은 항상 True, local은 `env.get("USE_LOCAL_MODEL") == "1"`일 때만, 나머지는 `env[api_key_env]`가 비어 있지 않거나 `allow_no_key`일 때 True. `OpenAICompatProvider.available`과 `app.main.model_status`가 이 함수 하나를 같이 쓴다.
  - `harness.router.chains(cfg: dict) -> dict[str, list[str]]`: 전문가 id → `[model, *fallback.get(model, [])]`. `mock:auto`는 `mock:<expert["mock"]>`(없으면 `prompt` 이름)으로 바꾼다.
  - `Router.from_file(path: Path, force_mock: bool = False)`: path는 필수다. 출처는 `Settings.models_path` 하나로 한다.
  - `Router.chains`
  - `Router.call(expert_id, system, user, payload, schema, deadline) -> tuple[T, str]`
  - `Router.timeout(path) -> float`: `paths.<path>.deadline_ms / 1000`
  - `Router.CACHE_MAX = 2048`: 넘으면 캐시를 통째로 비운다(`# ponytail: 전체 비우기, LRU 필요하면 교체`).
  - `Router.traces`: `deque(maxlen=1000)`
  - 안전망: 공급자 이름이 `mock`이 아니면(`local` 포함, 로컬 주소가 원격을 가리킬 수 있어 예외 없음), 보내기 직전에 `system`·`user`와 `payload` 안의 모든 문자열(중첩 포함)에 `pii.mask(…)`(이름 없이 패턴만)를 쓴다.
  - `harness.pii.Masker(names: Iterable[str] = ())`
    - 메서드: `__call__(text) -> str`, `turns(list[Turn]) -> list[Turn]`, `conversation(Conversation) -> Conversation`(turns·reply_to를 가린 복사본), `restore(text) -> str`
    - 자리표시: 같은 값은 같은 자리표시를 받는다. 종류별로 등장 순서대로 번호를 붙인다(`[전화번호1]`, `[이메일1]`, `[주민번호1]`, `[계좌번호1]`, `[긴 숫자1]`, `[이름1]`).
    - 이름: 2글자 이상만 가린다. 3글자 한글 이름은 뒤 2글자도 따로 가린다(이름만 부르는 경우).
    - 정규식 규칙과 이름(긴 것 먼저)을 **한 번의 `re.sub`(콜백)**로 처리해서, 이미 바꾼 자리표시를 다시 건드리지 않는다.
    - 기존 `mask(text, names=None)`는 그대로 둔다.
  - `harness.schemas`:
    - `Turn.label: str = ""`
    - `Conversation.reply_to: Turn | None = None`, `Conversation.kind: Literal["direct", "group"] = "direct"`. `last_them()`은 `reply_to`가 상대 말이면 그것을, 아니면 마지막 상대 말을 돌려준다.
    - `JudgeOut(alert: bool, reason: str = "")`
    - `TRIGGERS: frozenset[str]` = gate 신호 7개(이유 없는 거절, 마침표로 끝남, 짧은 답, 감정 표현에 짧은 답, 상대 말에 비해 짧은 답, 평소보다 짧음, 존댓말이 갑자기 빠짐) ∪ feedback 프롬프트 태그(늦은 답에 사과 없음, 반말 전환, 농담에 정색). 하소연에서 뽑은 trigger를 저장해도 되는 **고정 목록**이다. 이 밖의 값은 `jobs/feedback.run`이 버리고 `apply_feedback`도 거부한다(Task 10)
    - `FeedbackResult.patterns`에 `field_validator`를 둔다. trigger가 겹치면 첫 것만 남기고, 3개까지만 남긴다.
  - `harness.prompts.turns_text(turns: list[dict]) -> str`: `[label 또는 나/상대] text`. 자르지 않는다(DB가 8개로 자른다).
  - `experts.base`:
    ```python
    ExpertPath = Literal["realtime", "detail", "mirror", "async"]
    class ExpertRequest(BaseModel):
        path: ExpertPath
        draft: str                        # 가린 상태
        turns: list[Turn] = []            # 가린 상태, 오래된 것 → 최신
        relation: str
        signals: list[str] = []
        reply_to: Turn | None = None      # 답장 대상(가린 상태). 프롬프트 맥락 맨 앞 줄
        room_kind: Literal["direct", "group"] = "direct"
        intent: str | None = None         # rewrite 전문가에게만 전달된다
        extra: dict[str, Any] = {}        # judge: context/tone_a/tone_b/risk, feedback: text/about
        @classmethod
        def from_convo(cls, path: ExpertPath, draft: str, convo: Conversation, signals: list[str]) -> "ExpertRequest"
        def last_them(self) -> str
    class ExpertResult(BaseModel):
        expert_id: str; role: Literal["context", "tone", "judge", "rewrite", "feedback"]
        output: ContextReading | ToneReading | JudgeOut | RewriteSet | FeedbackResult
        confidence: float; latency_ms: int; model: str
    class Expert(Protocol):
        id: str; role: str; paths: set[str]; weight: float
        async def run(self, req: ExpertRequest, deadline: float) -> ExpertResult: ...
    ```
  - `experts.llm.LLMExpert(id, role, paths, weight, prompt, router)`의 `run`:
    - 프롬프트 변수는 `{relation, room("1:1" | "그룹방"), turns(turns_text, reply_to가 있으면 맨 앞), last_them, draft, intent(없으면 "보낸 뜻 그대로"), signals(", "로 잇거나 "없음"), **extra}`다.
    - payload는 `req.model_dump(mode="json", exclude={"path", "extra"}) | req.extra`다.
    - role이 `rewrite`가 아니면 변수와 payload에서 intent를 None으로 지운다(판정 단계 캐시가 의도에 따라 갈리지 않게).
    - 스키마는 role별로 고른다(context → `ContextReading`, tone → `ToneReading`, judge → `JudgeOut`, rewrite → `RewriteSet`, feedback → `FeedbackResult`). confidence는 출력에 있으면 그 값, 없으면 1.0이다.
  - `experts.registry.Registry`
    - 메서드: `load(path: Path, force_mock: bool) -> Registry`, `.router`, `.cfg`, `for_path(path, role) -> list[Expert]`(설정 순서), `weight(expert_id) -> float`(기본 1.0)
    - 빠지는 전문가: `force_mock`인데 사슬에 mock이 없는 전문가, `optional`인데 첫 모델 공급자가 `available`이 아닌 전문가
    - 로드 때 검사(실패하면 `ValueError`): role이 다섯 개 중 하나인지, prompt 파일이 있는지, 사슬의 `mock:<name>`이 `mock_rules`에 있는지
  - `async experts.registry.run_all(experts: list[Expert], req: ExpertRequest, deadline: float) -> list[ExpertResult]`: 동시에 돌린다. `NoResult`와 `TimeoutError`는 빼고, 다른 예외는 그대로 올린다.
  - `tests/spy.py`
    - `SpyProvider(name: str = "mock", canned: dict[str, Callable[[dict], dict | str]] | None = None, delay: float = 0.0)`: `.calls: list[dict]`(model, user, payload), `seen() -> str`(전부 이어 붙인 문자열). canned에 없는 model은 `mock_rules`로 답한다. `available = True`.
    - `make_registry(spy: SpyProvider | None = None, path: Path = DEFAULT_MODELS_PATH) -> Registry`: force_mock으로 만들고, spy를 `router.providers[spy.name]`에 넣는다.
  - `Settings.from_env()`가 env `MODELS_PATH`(없으면 `DEFAULT_MODELS_PATH`)를 읽는다. `app.main.load_config()`는 `Settings.from_env().models_path`를 읽고, `model_status(cfg, env)`는 `chains(cfg)`의 모든 항목을 `available`로 판정한다.

- [ ] **Step 1: claim** — `scripts/claim T-12 experts`

- [ ] **Step 2: 실패하는 테스트 작성** — `tests/test_experts.py`

```python
def test_add_remove_expert_by_config_only(tmp_path)  # tone_x(mock: tone_alt, paths [realtime]) 추가 → for_path("realtime","tone") ids == ["tone_ds","tone_x"]; tone_ds 지움 → ["tone_x"]
def test_paths_in_mock_mode()                # realtime tone == ["tone_ds"](tone_hcx 빠짐), detail tone == ["tone_ds","tone_kimi"], mirror context == ["ctx_deep"], async feedback == ["feedback"]
def test_optional_local_when_available(monkeypatch)  # USE_LOCAL_MODEL=1, force_mock=False → "tone_hcx" in realtime tone ids
def test_no_gemini_in_any_chain()            # chains(cfg)의 어떤 항목도 "gemini:"로 시작하지 않음
def test_unknown_mock_rejected(tmp_path)     # mock: nope → ValueError
def test_llm_expert_result_shape()           # tone_ds.run → role "tone", isinstance(output, ToneReading), model "mock:tone", 0 <= confidence <= 1
def test_invalid_output_falls_back(tmp_path)  # 사슬 [mock:garbage, mock:tone], canned {"garbage": lambda p: "not json"} → model == "mock:tone"
def test_run_all_drops_late_and_failed()     # canned tone_alt delay 0.5, deadline = now + 0.1 → [r.expert_id] == ["tone_ds"]
def test_intent_only_reaches_rewrite()       # intent="미안하게": tone 호출 payload["intent"] is None, user에 "미안하게" 없음; rewrite 호출 payload["intent"] == "미안하게"
def test_masker_tokens_and_restore():
    m = Masker(["김민수", "지은"])
    s = "민수야 010-1234-5678, a@b.kr / 김민수랑 지은"
    assert m(s) == "[이름1]야 [전화번호1], [이메일1] / [이름2]랑 [이름3]"
    assert m.restore(m(s)) == s and m("민수") == "[이름1]"
def test_masker_short_names_and_conversation()  # Masker(["수"])("수업") == "수업"; conversation()은 turns와 reply_to를 가리고 원본은 그대로
def test_name_survives_rewrite_round_trip()  # m = Masker(["민수"]); rewrite 전문가에 m("민수야 안 돼요.") → 후보 text에 "[이름1]" → m.restore(text)에 "민수" 있고 "[이름" 없음
@pytest.mark.parametrize("provider", ["nvidia", "local"])   # local도 원격을 가리킬 수 있어 예외 아님
def test_router_masks_before_third_party(provider)   # 사슬 [<provider>:x], providers[provider] = SpyProvider(name=provider), force_mock=False, user·payload에 날것 "010-1234-5678" → spy.seen()에 "010-1234" 없음, "[전화번호]" 있음
def test_router_cache_bounded()              # r.CACHE_MAX = 3, 서로 다른 입력 5번 → len(r.cache) <= 3
def test_only_pipeline_and_router_import_pii()  # engine/**/*.py(tests, harness/pii.py 제외) 중 pii를 import하는 파일 ⊆ {"pipeline.py", "harness/router.py"}
```
기존 테스트도 고친다:
- `test_harness.py`: 라우터 테스트는 `Router.from_file(DEFAULT_MODELS_PATH, force_mock=True).call("ctx_fast", …)`로 바꾼다. `test_no_gemini_on_real_text_roles`는 `chains(cfg)`를 돈다.
- `test_health.py`: cfg를 `experts` 형식으로 바꾼다. `test_model_status_allow_no_key_is_up_without_key`의 공급자 이름은 `other`로 바꾼다. 새로 `test_model_status_local_needs_flag`를 둔다(local은 flag 없으면 down, `USE_LOCAL_MODEL=1`이면 up). 시작 실패 테스트는 `monkeypatch.setenv("MODELS_PATH", …)`로 바꾼다.

- [ ] **Step 3: 실패 확인**

Run: `cd engine && uv run pytest -q tests/test_experts.py`
Expected: FAIL (`No module named 'experts'`)

- [ ] **Step 4: `models.yaml`을 experts 형식으로 교체 + 구현**

`providers` 블록은 T-11 것을 그대로 둔다(gemini 주석 포함). `roles`, `timeouts_ms`, `judge`, `gate`는 지우고 아래로 바꾼다.
```yaml
experts:
  - {id: ctx_fast,  role: context,  model: nvidia:deepseek-ai/deepseek-v4.1-flash, prompt: context,  paths: [realtime]}
  - {id: ctx_deep,  role: context,  model: nvidia:moonshotai/kimi-k3,              prompt: context,  paths: [detail, mirror]}
  - {id: tone_ds,   role: tone,     model: nvidia:deepseek-ai/deepseek-v4.1-flash, prompt: tone,     paths: [realtime, detail, mirror], weight: 1.0}
  - {id: tone_kimi, role: tone,     model: nvidia:moonshotai/kimi-k3,              prompt: tone,     paths: [detail, mirror], weight: 1.0, mock: tone_alt}
  - {id: tone_hcx,  role: tone,     model: local:naver-hyperclovax/HyperCLOVAX-SEED-Text-Instruct-1.5B, prompt: tone, paths: [realtime, detail, mirror], weight: 1.0, optional: true}
  - {id: judge,     role: judge,    model: nvidia:moonshotai/kimi-k3,              prompt: judge,    paths: [detail, mirror]}
  - {id: rewrite,   role: rewrite,  model: nvidia:deepseek-ai/deepseek-v4.1-flash, prompt: rewrite,  paths: [detail, mirror]}
  - {id: feedback,  role: feedback, model: nvidia:moonshotai/kimi-k3,              prompt: feedback, paths: [async]}
fallback:   # 실제 문장이 지나가므로 gemini 금지
  nvidia:deepseek-ai/deepseek-v4.1-flash: [github:openai/gpt-4.1-mini, mock:auto]
  nvidia:moonshotai/kimi-k3: [nvidia:deepseek-ai/deepseek-v4.1-flash, mock:auto]
paths:
  realtime: {deadline_ms: 1500, expert_deadline_ms: 1200, gate_threshold: 0.3}
  detail:   {deadline_ms: 8000}
  mirror:   {deadline_ms: 8000}
  async:    {deadline_ms: 60000}
aggregate:
  weights: {bias: -2.2, prior: 1.6, neg: 2.4, violation: 1.4, pattern: 0.9}
  alert_threshold: 0.6
  max_disagreement: 0.35
  min_confidence: 0.4
  global_min_obs: 5     # 신호별 서로 다른 신고자 수
```

- [ ] **Step 5: 통과 확인**

Run: `cd engine && uv run pytest -q`
Expected: 실패 0. skipped는 `test_single_report_alone_does_not_boost` 1개다(T-13에서 켠다).

- [ ] **Step 6: 문서 + 완료 처리 + commit**

`ARCHITECTURE.md`를 고친다.
- 6-2: `ExpertRequest`에 `reply_to`, `room_kind`, `intent`(rewrite만), `extra`를 추가하고, path에 `mirror`를 추가한다. `models.yaml` 예시를 위 블록으로 바꾼다.
- 6-4: "라우터는 전문가 ID로 부른다", "입구 Masker + 외부 공급자 전송 직전 패턴 가리기 안전망", "캐시 상한"을 적는다.
- 8장 엔진 행에 `MODELS_PATH`(선택, 기본 `engine/config/models.yaml`)와 `USE_LOCAL_MODEL`(선택, `1`이면 로컬 모델 사용)을 더한다. `.env.example` 엔진 "선택" 블록에도 `MODELS_PATH=`, `USE_LOCAL_MODEL=`을 더한다.

tasks.md T-12를 `완료`로 바꾼다. 확인 칸에는 `test_experts.py` 통과와 가린 문장만 가는 테스트, 이름 복원 테스트를 적는다.

```bash
git add -A && git commit -m "T-12: expert interface, registry, LLMExpert, single-entry Masker"
```

---

### Task 3: T-06b JWKS 인증 + 방 멤버 확인

**Files:**
- Create: `engine/app/auth.py`, `engine/tests/jwks.py`, `engine/tests/test_auth.py`
- Modify: `engine/pyproject.toml`(`PyJWT[crypto]>=2.8`), `engine/app/main.py`(lifespan에서 JWKS 미리 받기), `engine/tests/conftest.py`(`login` 픽스처), `README.md`(한 줄)

**Interfaces:**
- Consumes: `app.deps.get_settings`, `app.db.Repo`, `tests.fakes.FakeRepo`.
- Produces:
  - `AuthError(Exception)`
  - `TokenVerifier(issuer: str, fetch_jwks: Callable[[], Awaitable[dict]], *, audience: str = "authenticated", ttl_s: float = 600.0, refetch_gap_s: float = 60.0)`, `async verify(token: str) -> UUID`, `async warm() -> None`
    - 헤더 `alg`는 `ES256`·`RS256`만 받는다.
    - 키는 `jwt.PyJWKSet.from_dict`로 만들고 `ttl_s` 동안 캐시한다. 모르는 `kid`가 오면 마지막 fetch가 `refetch_gap_s`보다 오래됐을 때만 한 번 다시 받는다.
    - `jwt.decode(..., algorithms=[alg], audience, issuer, options={"require": ["exp", "sub", "aud", "iss"]}, leeway=10)` 결과의 `sub`를 UUID로 돌려준다.
    - 실패는 모두 `AuthError`다(빈 키 집합 포함).
    - `warm()`은 `fetch_jwks()`를 한 번 불러 키 캐시를 채운다. 실패해도 예외를 올리지 않고 `log.warning("jwks warm failed: %s", type(e).__name__)`만 남긴다(첫 요청이 다시 받는다).
  - `get_verifier() -> TokenVerifier`(`lru_cache`): issuer는 `f"{supabase_url}/auth/v1"`이다. JWKS는 `f"{supabase_url}/auth/v1/.well-known/jwks.json"`을 httpx로 받는다(timeout `JWKS_TIMEOUT_S = 1.0`초. 힌트 예산이 1.5초라 느린 JWKS 서버를 오래 기다리지 않는다). `supabase_url`이 비면 항상 `{"keys": []}`다.
  - `current_user(authorization: str | None = Header(None), verifier: TokenVerifier = Depends(get_verifier)) -> UUID`: `Bearer` 아님·검증 실패 → 401 + `WWW-Authenticate: Bearer`.
  - `async ensure_member(repo: Repo, room_id: UUID, user_id: UUID) -> None`: 멤버가 아니면 403.
  - conftest `login` 픽스처: `login(user_id)`가 `app.dependency_overrides[current_user] = lambda: user_id`를 넣는다.
  - lifespan(`app.main`): 기존 `load_config()`·Repo·큐 다음에 `await get_verifier().warm()`을 부른다. 첫 `/v1/hint`가 JWKS 받기를 기다리지 않게 하려는 것이다.
  - `tests/jwks.py`: `make_signer(kid: str = "k1") -> Signer`. `Signer.jwks`(JWK 집합 dict), `Signer.token(sub: UUID, *, exp_in: float = 3600, aud: str = "authenticated", iss: str = "https://test.supabase.co/auth/v1", kid: str | None = None) -> str`. Task 7 테스트도 쓴다.

- [ ] **Step 1: claim** — `scripts/claim T-06b auth`

- [ ] **Step 2: 실패하는 테스트 작성** — `tests/test_auth.py`

테스트 키와 토큰은 `tests/jwks.py`의 `make_signer()`가 만든다. 키는 `cryptography`의 `ec.generate_private_key(ec.SECP256R1())`로 만들고, JWK는 `jwt.algorithms.ECAlgorithm.to_jwk(pub, as_dict=True) | {"kid": "k1", "alg": "ES256", "use": "sig"}`다. claims는 `sub`, `aud="authenticated"`, `iss="https://test.supabase.co/auth/v1"`, `exp`다. `fetch_jwks`는 호출 수를 세는 async 함수다.
```python
def test_valid_es256_token()                 # verify → UUID(sub)
def test_expired_token_rejected()            # exp 1분 전 → AuthError
def test_forged_signature_rejected()         # 다른 키로 서명, 같은 kid → AuthError
def test_wrong_audience_or_issuer_rejected()
def test_hs256_and_none_rejected()           # 공개키 PEM을 HS256 비밀로 쓴 토큰, alg none → AuthError
def test_jwks_cached_and_refetched_on_new_kid()  # verify 2번 → fetch 1번; 새 kid 토큰 → fetch 2번; 60초 안에 모르는 kid 반복 → 추가 fetch 없음
def test_empty_jwks_rejects()
def test_current_user_dependency()           # 작은 FastAPI 앱: 헤더 없음 401(WWW-Authenticate 있음), "Basic x" 401, 정상 200 {"uid": ...}
def test_ensure_member_403(fake)             # 비멤버 → HTTPException(403), 멤버 → None
def test_warm_prefetches_jwks()             # warm() → fetch 1번; 이어서 verify 2번 → fetch 여전히 1번. fetch가 예외를 던지는 verifier의 warm()은 예외 없이 끝나고, 다음 verify가 다시 받는다(fetch 2번)
def test_lifespan_warms_jwks(monkeypatch)   # app.main.get_verifier를 호출 수 세는 TokenVerifier로 바꾸고 `with TestClient(app):` → 들어가자마자 fetch 1번
def test_jwks_fetch_timeout_is_one_second(monkeypatch)  # app.auth의 httpx.AsyncClient를 가짜로 바꿔 get_verifier()의 fetch를 실행 → timeout == 1.0, GET URL == "https://test.supabase.co/auth/v1/.well-known/jwks.json"
```

- [ ] **Step 3: 실패 확인** — `cd engine && uv run pytest -q tests/test_auth.py` → FAIL (`No module named 'app.auth'`)

- [ ] **Step 4: 구현** — `app/auth.py`, `tests/jwks.py`. `pyproject.toml`에 의존성을 더하고 `uv sync`. 블로킹 없는 httpx로 받는다. `app/main.py` lifespan에서 `warm()`을 부른다.

- [ ] **Step 5: 통과 확인** — `cd engine && uv run pytest -q tests/test_auth.py` → Expected: `12 passed`

- [ ] **Step 6: 완료 처리 + commit**

`README.md` 엔진 절에 한 줄을 넣는다: "Supabase JWKS가 비어 있으면(예전 HS256 프로젝트) 대시보드 Settings → JWT Keys에서 비대칭 키로 바꾼다." tasks.md T-06b를 `완료`로 바꾼다. 확인 칸: 정상·만료·위조·비참여자 테스트 통과.
```bash
git add -A && git commit -m "T-06b: Supabase JWKS verifier, current_user, ensure_member"
```

---

### Task 4: T-13 집계기 + 보낸 사람 패턴 조건

**Files:**
- Create: `engine/layers/aggregate.py`, `engine/tests/test_aggregate.py`
- Modify: `engine/layers/gate.py`, `engine/harness/schemas.py`(`Verdict.features`), `engine/tests/test_harness.py`

**Interfaces:**
- Consumes: Task 2의 `schemas`(`ToneReading`, `ContextReading`, `Conversation`, `GateResult`, `Verdict`, `NEGATIVE`), `harness.store.ProfileStore`(`patterns_for`, `global_patterns`, `baseline`).
- Produces:
  - `layers.gate.score(draft, convo, store, user_id, threshold, global_min_obs: int) -> GateResult`: 관계 패턴 일치(+0.15씩, 최대 0.3)는 `store.global_patterns.get(sig, 0) >= global_min_obs`인 신호만 센다.
  - `layers.aggregate.aggregate(draft: str, gate: GateResult, ctx: ContextReading | None, tones: list[tuple[ToneReading, float]], store: ProfileStore, convo: Conversation, cfg: dict) -> Verdict`. `tones`는 (읽힘, 전문가 weight) 쌍이고, `cfg`는 `models.yaml`의 `aggregate`다.
  - `merged(tones) -> dict[str, float]`: `α = weight × confidence` 가중 평균. 키 5개.
  - `negative(readings: dict[str, float]) -> float`
  - `missing_points(draft, ctx, tones) -> list[str]`: 프로토타입 `layers/judge.py` 그대로.
  - `Verdict.features: dict[str, float] = {}`: 키는 `prior, neg, violation, pattern, disagreement, confidence`다(T-19 trace, T-20 학습용).
- 규칙(ARCHITECTURE 6-3):
  - `neg = Σα·neg_k / Σα`다. α가 0인 전문가는 neg와 의견 차이에서 뺀다.
  - 쓸 말투 전문가가 없으면 `Verdict(risk=0.0, top_reading="무난하게", abstain=True, alert=False, …)`를 돌려준다.
  - `ctx is None`이면 violation 0, confidence = 말투 confidence 평균이다.
  - pattern 항은 gate 신호 ∩ `patterns_for(pair_id)` 중 `global ≥ global_min_obs`인 것에 대해 `min(1, Σ strength/3)`이다.
  - abstain = disagreement > max_disagreement 또는 confidence < min_confidence. alert = not abstain이고 risk ≥ alert_threshold.
  - top_reading은 alert이면 부정 셋 중 최대, 아니면 merged 최대다.
  - 늦은 전문가 제외는 호출자(`run_all`)가 한다.

- [ ] **Step 1: claim** — `scripts/claim T-13 aggregate`

- [ ] **Step 2: 실패하는 테스트 작성** — `tests/test_aggregate.py` + `test_harness.py` 켜기

```python
def test_single_expert_formula()       # risk == round(1/(1+exp(-z)), 3), z는 features 값으로 손 계산
def test_alpha_weighting()             # (neg .8, w1, c1) + (neg .2, w1, c.25) → features["neg"] == approx((.8 + .2*.25) / 1.25)
def test_zero_tone_experts_abstain()   # tones=[] → abstain True, alert False
def test_disagreement_abstains()       # neg .9 vs .1 → disagreement .8 → abstain
def test_zero_weight_ignored()         # (neg .9, w0) + (neg .1, w1) → features["neg"] == approx(.1), disagreement 0
def test_missing_context_scores()      # ctx None → features["violation"] == 0, Verdict 정상
def test_low_confidence_abstains()
def test_one_report_alone_changes_nothing()
    # store = ProfileStore(pair_patterns={"p": {"이유 없는 거절": {"count":1,"strength":3,"feeling":"차갑게"}}}, global_patterns={"이유 없는 거절": 1})
    # gate.score(...).prior == 빈 store일 때 prior;  aggregate risk == 패턴 없을 때 risk, pattern_used False
    # global 5 → prior 커짐, risk 커짐, pattern_used True
```
`test_harness.py::test_single_report_alone_does_not_boost`에서 `importorskip("layers.judge")`를 지운다. 대신 `from layers import aggregate`, `cfg = Router.from_file(DEFAULT_MODELS_PATH, force_mock=True).config["aggregate"]`, `tones=[(tone, 1.0)]`를 쓴다. store는 `add_patterns`·`seed_global` 대신 `ProfileStore(pair_patterns=…, global_patterns=…)`로 직접 만든다(T-24가 그 메서드를 지운다). `gate.score` 호출에는 `global_min_obs=cfg["global_min_obs"]`를 넘긴다.

- [ ] **Step 3: 실패 확인** — `cd engine && uv run pytest -q tests/test_aggregate.py tests/test_harness.py` → FAIL (`No module named 'layers.aggregate'`)

- [ ] **Step 4: 구현** — `layers/aggregate.py`(프로토타입 `layers/judge.py`의 `aggregate`·`missing_points`를 옮겨 위 규칙으로 고침). `gate.score`에 인자를 더한다.

- [ ] **Step 5: 통과 확인**

Run: `cd engine && uv run pytest -q`
Expected: 실패 0, **skipped 0**

- [ ] **Step 6: 완료 처리 + commit**

tasks.md T-13을 `완료`로 바꾼다. 확인 칸: "전문가 1·2·0개, 의견 갈림, 신고 하나로는 L0·L3 둘 다 안 오름 통과. `test_single_report_alone_does_not_boost`가 aggregate로 켜져 skipped 0".
```bash
git add -A && git commit -m "T-13: aggregator with alpha weights; sender patterns gated on global_min_obs in gate and aggregate"
```

---

### Task 5: T-23 작업 큐

**Files:**
- Create: `engine/jobs/__init__.py`, `engine/jobs/queue.py`, `engine/tests/test_queue.py`
- Modify: `engine/app/deps.py`(`get_queue`), `engine/app/main.py`(lifespan), `engine/tests/fakes.py`(`FakeQueue`), `engine/tests/conftest.py`(`client`가 `get_queue` → `FakeQueue`, `queue` 픽스처)

**Interfaces:**
- Produces:
  - `JobQueue(workers: int = 2, max_attempts: int = 3, backoff_s: float = 1.0, maxsize: int = 1000)`
    - 메서드: `start() -> None`, `async stop(drain_s: float = 5.0) -> None`, `enqueue(name: str, fn: Callable[..., Awaitable[None]], *args: Any) -> bool`(가득 차면 False), `async join() -> None`
    - 재시도: 실패하면 `backoff_s * 2 ** (attempt - 1)`초 뒤 `call_later`로 다시 넣는다. `max_attempts`를 넘기면 버리고 `log.warning("job %s dropped after %d attempts: %s", name, n, type(e).__name__)`를 남긴다. 인자와 예외 메시지는 로그에 쓰지 않는다.
    - `# ponytail: 메모리 큐라 재시작하면 대기 작업이 사라짐(ARCHITECTURE 10장). Redis로 바꿀 때 feedback 작업 인자(하소연 원문)는 Redis에 넣지 않는다.`
  - `app.deps.get_queue(request) -> JobQueue`(`request.app.state.queue`). lifespan에서 `JobQueue()`를 만들어 `start()`하고, 종료 때 `stop()`한다.
  - `tests.fakes.FakeQueue`: `.jobs: list[tuple[str, Callable, tuple]]`, `enqueue(...) -> True`, `names() -> list[str]`, `async run_all()`(넣은 순서대로 실행하고, 실행 중 새로 들어온 것도 실행한다. 예외는 그대로 올린다).

- [ ] **Step 1: claim** — `scripts/claim T-23 job-queue`

- [ ] **Step 2: 실패하는 테스트 작성** — `tests/test_queue.py`

```python
def test_enqueued_job_runs()
def test_retry_then_success()          # 두 번 실패 후 성공, max_attempts 3, backoff .01 → 3번 호출
def test_drop_logs_no_args(caplog)     # fn이 ValueError("비밀하소연"), 인자 "비밀하소연" → 버려짐; "비밀하소연" not in caplog.text; "ValueError" in caplog.text
def test_full_queue_rejects()          # maxsize 1, start 전 → 두 번째 enqueue False
def test_stop_drains_pending()         # 넣고 stop → 모두 실행됨
def test_lifespan_starts_queue()       # with TestClient(app): isinstance(app.state.queue, JobQueue)
```

- [ ] **Step 3: 실패 확인** — `cd engine && uv run pytest -q tests/test_queue.py` → FAIL (`No module named 'jobs'`)

- [ ] **Step 4: 구현** — `asyncio.Queue(maxsize)` + 워커 태스크 `workers`개.

- [ ] **Step 5: 통과 확인** — `cd engine && uv run pytest -q tests/test_queue.py` → Expected: `6 passed`

- [ ] **Step 6: 완료 처리 + commit** — tasks.md T-23 `완료`. 확인 칸: 넣기·재시도·인자 없는 실패 로그 테스트.
```bash
git add -A && git commit -m "T-23: asyncio job queue with retry and payload-free logs"
```

---

### Task 6: T-10 웹훅 수신

**Files:**
- Create: `engine/app/routes/__init__.py`, `engine/app/routes/hooks.py`, `engine/tests/test_hooks.py`
- Modify: `engine/app/main.py`(`include_router`), `README.md`(dev 웹훅 연결 절), `ARCHITECTURE.md` 2장, `docs/tasks.md`(T-10 행)

**Interfaces:**
- Consumes: `app.deps.get_settings`.
- Produces:
  - `MessageRecord(id: int, room_id: UUID, sender_id: UUID, text: str = "", image_path: str | None = None, reply_to: int | None = None, created_at: datetime)`
  - `HookPayload(type: str, table: str, schema_name: str = Field(alias="schema"), record: dict | None = None, old_record: dict | None = None)`
  - `POST /hooks/message`(`include_in_schema=False`)이 하는 일:
    1. `request: Request`로 먼저 `X-Hook-Secret`을 `hmac.compare_digest`로 비교한다. 설정값이 비어 있으면 항상 401이다.
    2. 본문을 `HookPayload`로 검사한다(422).
    3. `type == "INSERT"`, `table == "messages"`, `schema == "public"`일 때만 `MessageRecord`로 읽는다.
    4. `log.info("hook message id=%s room=%s", …)`를 남긴다(text는 남기지 않는다).
    5. 202 `{}`를 돌려준다. 다른 이벤트도 202로 받고 무시한다.
  - 본문 끝의 `# 작업 넣기: T-26 기준선, T-28b 푸시` 자리에 뒤 작업이 `queue.enqueue(...)`를 더한다.
  - DB 웹훅 자체는 SQL 마이그레이션이 아니라 Supabase 대시보드 Database → Webhooks에서 만든다(절차는 README, Step 6). 이 작업은 수신 쪽만 만든다.

- [ ] **Step 1: claim** — `scripts/claim T-10 webhook`

- [ ] **Step 2: 실패하는 테스트 작성** — `tests/test_hooks.py`

```python
def test_wrong_secret_401(client)            # 본문이 깨져 있어도 401(비밀값을 먼저 봄)
def test_missing_header_401(client)
def test_empty_configured_secret_rejects(client)   # get_settings override hook_secret="" → 헤더가 ""여도 401
def test_insert_logged_without_text(client, caplog)  # 202; "id=42" in caplog.text; "비밀문장" not in caplog.text
def test_other_events_ignored(client, caplog) # table "reactions" → 202, 로그 줄 없음
def test_hook_not_in_openapi()               # "/hooks/message" not in app.openapi()["paths"]
```

- [ ] **Step 3: 실패 확인** — `cd engine && uv run pytest -q tests/test_hooks.py` → FAIL (404)

- [ ] **Step 4: 구현** — `app/routes/hooks.py` + `main.py`에 `app.include_router(hooks.router)`

- [ ] **Step 5: 통과 확인** — `cd engine && uv run pytest -q tests/test_hooks.py` → Expected: `6 passed`

- [ ] **Step 6: README + ARCHITECTURE + 완료 처리 + commit**

웹훅은 마이그레이션에 두지 않고 대시보드에서 설정한다. README "dev 웹훅 연결" 절에 넣을 절차:
1. 엔진을 실행한다.
2. `cloudflared tunnel --url http://localhost:8000`으로 터널을 연다.
3. Supabase 대시보드 Database → Webhooks에서 만든다: 표 `public.messages`, Insert, HTTP POST `<터널 URL>/hooks/message`, 헤더 `X-Hook-Secret: <HOOK_SECRET>`.
4. 터널 URL은 실행할 때마다 바뀌므로 웹훅 URL도 고친다.

`ARCHITECTURE.md` 2장 `supabase/migrations/` 줄을 "표 · RLS · 함수 (이름에 _platform이 붙은 파일은 실제 Supabase에서만). DB 웹훅은 여기 없고 대시보드 Database → Webhooks에서 만든다(README)"로 고친다.

`docs/tasks.md`: T-10 행의 선행 칸에서 `T-02`를 빼고(`T-03a, T-05`), 완료 기준을 "mock/로컬 기준: TestClient로 INSERT 수신 로그, 비밀값 틀리면 401, 다른 이벤트 무시(test_hooks.py 6개 통과). 확인: …"으로 줄여 `완료`로 바꾼다. 실제 연결은 새 행으로 남긴다.
- `| T-10-live | 웹훅 실제 연결: Supabase 대시보드 Webhooks(public.messages INSERT) → cloudflared 터널 → 엔진, README 절차대로 | 엔진, DB | T-02, T-10 | 실제 메시지를 보내면 엔진 로그에 수신 기록, 비밀값 틀리면 401 | 대기 |`
```bash
git add -A && git commit -m "T-10: /hooks/message with X-Hook-Secret"
```

---

### Task 7: T-14 `POST /v1/hint` + OpenAPI

**Files:**
- Create: `engine/app/contracts.py`, `engine/app/context.py`, `engine/pipeline.py`, `engine/app/routes/hint.py`, `engine/tests/test_context.py`, `engine/tests/test_hint.py`, `engine/tests/test_cors.py`
- Modify: `engine/app/deps.py`(`get_registry`), `engine/app/settings.py`(`cors_origins`), `engine/app/main.py`(CORS), `.env.example`, `engine/prompts/context.md`, `engine/prompts/tone.md`, `engine/tests/conftest.py`(픽스처 `spy` = `SpyProvider()`, `registry` = `make_registry(spy)`. `client`가 `get_registry` → 그 `registry`), `apps/mobile/lib/types/engine.openapi.json`·`engine.ts`(생성), `ARCHITECTURE.md` 4장·8장, `CLAUDE.md` 명령 표

**Interfaces:**
- Consumes: Task 1의 `Repo`·`Room`·`Msg`, Task 3의 `current_user`·`ensure_member`, Task 2의 `Registry`·`run_all`·`ExpertRequest`·`Masker`, Task 4의 `aggregate`·`gate.score(…, global_min_obs)`, `guard.render_hint`.
- Produces:
  - `app.contracts`:
    ```python
    Draft = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    Reading = Literal["차갑게", "성의없게", "화나게", "무난하게", "따뜻하게"]
    Freq = Literal["자주", "가끔", "드물어요"]
    class HintIn(BaseModel): room_id: UUID; text: Draft; seq: int = Field(ge=0); reply_to: int | None = None
    class HintBody(BaseModel): title: str; detail: str
    class HintOut(BaseModel): seq: int; hint: HintBody | None; trace_id: UUID
    ```
  - `app.context.RoomContext(convo: Conversation, store: ProfileStore, names: list[str], room: Room)`
  - `async app.context.load_context(repo: Repo, room_id: UUID, user_id: UUID, reply_to: int | None, now: datetime) -> RoomContext`
    - 독립적인 읽기는 `asyncio.gather`로 한다.
    - `recent_messages(room_id, 8)`: 보낸 사람이 나면 `Turn(speaker="me", label="나")`다. 다른 사람은 `speaker="them"`이고, 그룹방이면 `label="상대{n}"`(오래된 것부터 처음 나온 순서로 1, 2, …), 1:1이면 `"상대"`다. text가 비면(사진만) `"(사진)"`이다.
    - `reply_to`가 있으면 `repo.message`로 읽는다. 없거나 `room_id`가 다르면 `HTTPException(422, "reply_to not in room")`이다. 같은 방이면 `convo.reply_to = Turn(speaker, text, label=f"답장 대상 · {label}")`이다(최근 8개에 없는 사람이면 다음 번호).
    - `names = list(member_names.values())`
    - `store = ProfileStore(pair_patterns={pair: repo.sender_patterns(user_id, relation, now)}, global_patterns=repo.global_patterns(), baselines={str(user_id): b} if b else {})`. 여기서 `pair = f"{user_id}:{relation}"`다. 패턴 조건은 gate·aggregate가 본다.
    - `convo = Conversation(pair_id=pair, relation=room.relation, kind=room.kind, turns=…, reply_to=…)`
  - `pipeline.RealtimeOutcome(gate: GateResult, verdict: Verdict | None, hint: Hint | None, results: list[ExpertResult], outcome: Literal["gated", "abstain", "alert", "none"])`
  - `async pipeline.realtime(reg: Registry, draft: str, convo: Conversation, store: ProfileStore, user_id: str, names: list[str], t0: float) -> RealtimeOutcome`. 순서:
    1. `m = Masker(names)`로 초안과 대화를 가린다(이 파일의 입구 말고는 가리지 않는다).
    2. `gate.score(…, paths.realtime.gate_threshold, aggregate.global_min_obs)`를 부른다. 통과하지 못하면 `outcome="gated"`로 끝난다.
    3. `run_all(context + tone of "realtime", ExpertRequest.from_convo("realtime", …), t0 + expert_deadline_ms/1000)`
    4. `aggregate`
    5. `guard.render_hint`
  - `app.deps.get_registry() -> Registry`(`lru_cache`, `Registry.load(get_settings().models_path, get_settings().force_mock)`)
  - `Settings.cors_origins: tuple[str, ...]`: env `CORS_ORIGINS`를 쉼표로 나눠 공백을 떼고, 비어 있거나 없으면 `("http://localhost:8081",)`다.
  - `app.main`: `app.add_middleware(CORSMiddleware, allow_origins=list(Settings.from_env().cors_origins), allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Authorization", "Content-Type"])`. 쿠키를 쓰지 않으므로 `allow_credentials`는 켜지 않는다. 앱 웹 빌드가 `Authorization` 헤더를 달고 엔진을 부를 때 브라우저가 보내는 사전 요청(OPTIONS)이 통과해야 한다.
  - `POST /v1/hint` → `HintOut`:
    1. `t0 = monotonic()`, `trace_id = uuid4()`
    2. 본문(`ensure_member` → `load_context` → `pipeline.realtime`)을 `asyncio.wait_for(…, deadline_ms/1000 - 경과)`로 감싼다.
    3. `TimeoutError` → `hint=None`. `HTTPException`(401/403/422)은 그대로 올린다. 그 밖의 예외는 `log.warning("hint failed: %s", type(e).__name__)` 후 `hint=None`이다.

- [ ] **Step 1: claim** — `scripts/claim T-14 hint`

- [ ] **Step 2: 실패하는 테스트 작성** — `tests/test_context.py`, `tests/test_hint.py`, `tests/test_cors.py`

```python
# test_context.py (FakeRepo)
def test_group_labels_and_reply_first()    # A(요청자)·B·C·D 그룹, 최근 B,C,A,B → labels ["상대1","상대2","나","상대1"]; 9개 전 D 메시지에 reply_to → reply_to.label == "답장 대상 · 상대3", convo.last_them() == D의 text
def test_direct_labels_plain()             # 1:1 → "상대"
def test_reply_to_unknown_or_other_room_422()  # 없는 id, 다른 방 id → HTTPException.status_code == 422
def test_image_only_becomes_placeholder()  # turn.text == "(사진)"
def test_patterns_respect_active_from()    # active_from 내일 → store.patterns_for(pair) == {}
def test_relation_and_kind_from_room()

# test_hint.py (client + login + make_registry)
def test_light_message_no_hint()           # 상대 "내일 7시 맞지?" → "ㅇㅇ": 200, hint None, seq 7 그대로, trace_id는 UUID
def test_heavy_context_hint()              # 상대 "요즘 진짜 너무 힘들다... 취업도 안 되고 다 그만두고 싶어" → "ㅇㅇ": hint.title == "성의 없게 느껴질 수도 있어요"
def test_not_member_403(); def test_no_token_401()     # login 없음
def test_text_validation_422()             # "", "   ", 501자
def test_budget_timeout_returns_null()     # fake.recent_messages가 2초 잠, registry.cfg 실시간 deadline_ms=300 → 200, hint None, 경과 < 0.6초
def test_no_raw_pii_reaches_experts(spy)   # 멤버 "민수", 상대 말 "요즘 힘들다 민수야 010-1234-5678로 연락줘", 초안 "민수 ㅇㅇ" → spy.calls 1개 이상, spy.seen()에 "민수"·"010-1234" 없음
def test_openapi_snapshot_current()        # apps/mobile/lib/types/engine.openapi.json이 있으면 json.load(…) == json.loads(json.dumps(app.openapi())), 없으면 skip
def test_first_hint_after_startup_has_no_jwks_fetch(fake, registry, monkeypatch)  # tests/jwks.py의 make_signer() 토큰 + 호출 수 세는 TokenVerifier를 app.main.get_verifier와 dependency_overrides[get_verifier]에 넣고 `with TestClient(app)`(lifespan 실행) → 시작 직후 fetch 1번; 방 멤버로 POST /v1/hint → 200, fetch 여전히 1번

# test_cors.py (client)
def test_preflight_allowed_origin()         # OPTIONS /v1/hint, Origin = Settings.from_env().cors_origins[0], Access-Control-Request-Method POST, Access-Control-Request-Headers "authorization,content-type" → 200, access-control-allow-origin == 그 origin, allow-headers에 authorization·content-type, allow-methods에 POST
def test_preflight_disallowed_origin()      # Origin "https://evil.example" → access-control-allow-origin 헤더 없음(상태 400)
def test_cors_origins_env_parsed(monkeypatch)  # CORS_ORIGINS="https://a.example, https://b.example" → Settings.from_env().cors_origins == ("https://a.example", "https://b.example"); 없거나 "" → ("http://localhost:8081",)
```

- [ ] **Step 3: 실패 확인** — `cd engine && uv run pytest -q tests/test_context.py tests/test_hint.py tests/test_cors.py` → FAIL (`No module named 'app.context'`)

- [ ] **Step 4: 구현 + 프롬프트**

- `context.md` system의 "한국어 1:1 채팅의 흐름"을 "한국어 채팅(1:1 또는 그룹방)의 흐름"으로 바꾸고 한 줄을 더한다: "그룹방이면 이 방 사람들이 함께 읽는다고 보고 판단한다. 화자는 [나], [상대1], [상대2]…로 표시되고, [답장 대상 · …] 줄은 내가 답하려는 메시지다."
- `tone.md` system에 한 줄을 더한다: "그룹방이면 이 방 사람들이 읽을 때를 기준으로 한다."
- 두 파일 user 블록 맨 위에 `방: {room}`을 넣는다.

- [ ] **Step 5: 통과 확인 + 타입 생성**

Run: `cd engine && uv run pytest -q`
Expected: 실패 0
Run: 공통 흐름의 API 타입 생성 명령. 그다음 `cd engine && uv run pytest -q tests/test_hint.py::test_openapi_snapshot_current`
Expected: PASS
Run: `(cd engine && uv run uvicorn app.main:app --port 8787 & echo $! > "${TMPDIR:-/tmp}/eng.pid"); sleep 3; curl -s -o /dev/null -w '%{http_code}' -X POST localhost:8787/v1/hint -H 'content-type: application/json' -d '{}'; kill "$(cat "${TMPDIR:-/tmp}/eng.pid")"`
Expected: `401`

- [ ] **Step 6: 문서 + 완료 처리 + commit**

- `ARCHITECTURE.md` 4장: `/v1/hint`·`/v1/detail` 요청에 `reply_to?`(같은 방이 아니면 422)를 적고, 3-2에 "최근 8개 + 화자 표시 + 답장 대상 맨 앞"을 적는다.
- `ARCHITECTURE.md` 4장에 한 줄을 더한다: "CORS: 허용 origin은 `CORS_ORIGINS`(쉼표로 나눔, 기본 `http://localhost:8081`), 메서드 GET·POST·OPTIONS, 헤더 Authorization·Content-Type". 8장 엔진 행에 `CORS_ORIGINS`를 더하고, `.env.example` 엔진 블록에 `CORS_ORIGINS=`(주석: 비우면 `http://localhost:8081`, 배포 때 웹 origin을 쉼표로)를 더한다.
- `CLAUDE.md` 명령 표 타입 생성 칸(지금 `(T-14, T-03a)`)을 정확히 이 한 줄로 바꾼다(이미 이 값이면 앱 T-04b가 먼저 land된 것이니 그대로 둔다): `엔진: cd apps/mobile && npm run gen:engine:pull · DB: (cd apps/mobile && set -a; . ../../.env; set +a; npm run gen:db)`
- tasks.md T-14를 `완료`로 바꾼다. 확인 칸: mock 응답 시간, 타임아웃 시 null 테스트, CORS 사전 요청 테스트, 첫 힌트가 JWKS를 받지 않는 테스트.
```bash
git add -A && git commit -m "T-14: /v1/hint with room context, realtime pipeline, OpenAPI types"
```

---

### Task 8: T-28b 푸시 발송 (엔진)

**Files:**
- Create: `engine/jobs/push.py`, `engine/tests/test_push.py`
- Modify: `engine/app/settings.py`, `engine/app/routes/hooks.py`, `engine/pyproject.toml`(`pywebpush>=2.0`), `README.md`, `.env.example`, `docs/tasks.md`(T-27/T-28 행)

**Interfaces:**
- Consumes: Task 6 `MessageRecord`, Task 5 `get_queue`, Task 1 `Repo.push_targets`·`delete_push_token`·`room`·`member_names`.
- Produces:
  - `Settings`에 `expo_access_token`, `vapid_private_key`, `vapid_subject`를 더한다(env `EXPO_ACCESS_TOKEN`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, 기본값 ""). 엔진은 VAPID 공개키를 읽지 않는다(`VAPID_PUBLIC_KEY` 없음). 공개키는 `npx web-push generate-vapid-keys`가 개인키와 짝으로 내고 앱만 `EXPO_PUBLIC_VAPID_PUBLIC_KEY`로 받는다.
  - `build_notice(record: MessageRecord, room: Room, sender_name: str) -> dict` → `{"title", "body", "url"}`. 앱과 맞춘 모양이고 Expo·웹이 같다.
    - title: 1:1은 `sender_name`, 그룹은 `f"{room.title} · {sender_name}"`
    - body: 짧은 미리보기. `text[:100]`(넘으면 끝에 "…"), 사진만이면 `"사진을 보냈어요"`
    - url: `f"/room/{room_id}"`
  - `PUSH_HOST_EXACT = {"fcm.googleapis.com", "updates.push.services.mozilla.com"}`, `PUSH_HOST_SUFFIXES = (".push.apple.com", ".notify.windows.com")`, `push_host_allowed(endpoint: str) -> bool`: SSRF를 막으려고 웹 푸시 구독의 `endpoint`가 알려진 푸시 서비스일 때만 참이다. `urlparse` 결과가 `scheme == "https"`, 사용자 정보 없음, 포트 없음 또는 443이고, 소문자 `hostname`이 `PUSH_HOST_EXACT`에 있거나 `PUSH_HOST_SUFFIXES` 중 하나로 끝나야 한다(점을 포함해서 `evilpush.apple.com`은 안 된다). 파싱에 실패하면 False다.
  - `async send_push(repo: Repo, settings: Settings, record: MessageRecord, http: httpx.AsyncClient | None = None) -> None`
    - 대상은 `push_targets(room_id, sender_id)`다.
    - `ios`·`android`는 100개씩 묶어 `POST https://exp.host/--/api/v2/push/send`로 보낸다(본문은 `[{to, title, body, data: {url}}]`, `expo_access_token`이 있으면 `Authorization: Bearer`). 응답 `data[i]`가 `status == "error"`이고 `details.error == "DeviceNotRegistered"`이면 그 토큰을 `repo.delete_push_token(user_id, token)`으로 지운다.
    - `web`이 보내는 data는 `json.dumps(notice)`, 곧 `{title, body, url}`이다.
    - `web`은 하나씩 `await asyncio.to_thread(webpush, subscription_info=json.loads(token), data=json.dumps(notice), vapid_private_key=…, vapid_claims={"sub": settings.vapid_subject}, ttl=3600)`로 보낸다. 보내기 전에 구독 JSON의 `endpoint`를 `push_host_allowed`로 검사하고, 아니면 `webpush`를 부르지 않고 건너뛴다(로그에는 "push endpoint not allowed"만 남기고 endpoint 값은 쓰지 않는다. 토큰은 지우지 않는다). 푸시 서비스가 `WebPushException`으로 답했고 `getattr(e.response, "status_code", None)`이 404나 410이면 만료된 구독이므로 `repo.delete_push_token(user_id, token)`으로 지운다. 그 밖의 실패는 `type(e).__name__`만 로그에 남기고 다음으로 간다. `vapid_private_key`가 비면 web 대상을 건너뛴다.
    - DB 읽기 실패는 그대로 올려 큐가 재시도하게 한다. 보내기 단계의 실패와 토큰 삭제 실패는 삼켜서 재시도로 알림이 겹치지 않게 한다.
  - hooks: `queue.enqueue("push", send_push, repo, settings, record)`(`Depends(get_repo)`, `Depends(get_queue)`를 더함)

- [ ] **Step 1: claim** — `scripts/claim T-28b push-send`

- [ ] **Step 2: 실패하는 테스트 작성** — `tests/test_push.py` (`httpx.MockTransport`, `monkeypatch.setattr("jobs.push.webpush", fake)`)

```python
def test_webhook_enqueues_push(client, queue)     # queue.names() == ["push"]
def test_expo_request_shape()                     # android+ios 토큰 → POST 1번, 본문 길이 2, 각 항목 {to,title,body,data:{url:"/room/<id>"}}, Authorization 헤더; web data == {"title","body","url"}
def test_expo_batches_of_100()                    # 토큰 101개 → POST 2번
def test_one_bad_subscription_does_not_block_others()  # web 두 개(endpoint는 모두 허용 호스트 `https://fcm.googleapis.com/fcm/send/<id>`), 첫 번째 webpush가 응답 없는 WebPushException → 두 번째도 호출, send_push가 예외 없이 끝남, 토큰은 지워지지 않음
def test_send_failures_do_not_raise()             # Expo 500 → 예외 없음
def test_web_skipped_without_vapid()              # webpush 호출 0번
def test_notice_texts()                           # 그룹 title "팀플방 · 민수", 사진만 body "사진을 보냈어요", 120자 → 101자(…)
def test_muted_and_sender_get_nothing(fake)       # 보낸 사람·muted 토큰으로는 안 감
def test_web_endpoint_allowlist()                # push_host_allowed: https://fcm.googleapis.com/fcm/send/x, https://updates.push.services.mozilla.com/wpush/v2/x, https://web.push.apple.com/x, https://wns2-par02p.notify.windows.com/x → True. http://fcm.googleapis.com/x, https://127.0.0.1/x, https://localhost:8000/x, https://169.254.169.254/latest/meta-data, https://fcm.googleapis.com.evil.example/x, https://evilpush.apple.com/x, https://user@fcm.googleapis.com/x, https://fcm.googleapis.com:8443/x, "not a url", "" → False
def test_disallowed_endpoint_not_sent(fake)       # web 둘: 첫째 endpoint "https://169.254.169.254/x", 둘째 fcm 허용 호스트 → webpush 호출 1번(둘째 것만), 예외 없음, 첫째 토큰은 지워지지 않음
def test_dead_web_subscription_deleted(fake)      # webpush가 response.status_code 404, 그다음 410을 가진 WebPushException → 그 토큰 행이 push_tokens에서 삭제됨, 같은 사람의 다른 토큰은 남음; 500이면 지우지 않음
def test_expo_device_not_registered_deleted(fake)  # Expo 200 {"data": [{"status": "error", "details": {"error": "DeviceNotRegistered"}}, {"status": "ok"}]} → 첫 토큰만 삭제
```

- [ ] **Step 3: 실패 확인** — `cd engine && uv run pytest -q tests/test_push.py` → FAIL

- [ ] **Step 4: 구현**

- [ ] **Step 5: 통과 확인** — `cd engine && uv run pytest -q tests/test_push.py` → Expected: `12 passed`

- [ ] **Step 6: 문서 + 완료 처리 + commit**

- `README.md` 엔진 절에 VAPID 키 만들기를 적는다: `npx web-push generate-vapid-keys`를 한 번 실행한다(키가 각각 한 줄로 나온다). `Public Key`는 앱 `.env`의 `EXPO_PUBLIC_VAPID_PUBLIC_KEY`에, `Private Key`는 엔진 `.env`의 `VAPID_PRIVATE_KEY`에 넣고 `VAPID_SUBJECT=mailto:<연락 이메일>`을 적는다. pywebpush는 이 한 줄 base64url 개인키를 그대로 받는다. 엔진은 공개키를 읽지 않는다. 키를 커밋하지 않는다.
- `.env.example`의 `# 엔진 웹 푸시 (VAPID)` 블록 주석에 `npx web-push generate-vapid-keys`를 적는다. `VAPID_PUBLIC_KEY=` 줄은 만들지 않는다(공개키는 앱 블록의 `EXPO_PUBLIC_VAPID_PUBLIC_KEY`).
- `docs/tasks.md`: T-27/T-28 부모 행이 아직 있으면 그 행을 아래 네 행으로 바꾼다(상태는 모두 `대기`). 이미 나뉘어 있으면(앱 T-04b나 다른 작업이 먼저 land됐다) 자기 행만 고친다. T-30 행의 선행 칸 `T-28`은 `T-28a, T-28b`로 바꾼다(이미 바뀌었으면 그대로).
  ```text
  | T-27a | 앱 리포트 화면: 알림 수, 살펴보기 수, 고친 비율, 예측 차이 추이, 주별 힌트 수 | 앱 | T-34 | mock·엔진 숫자와 화면이 같음 | 대기 |
  | T-27b | `/v1/stats/me`(엔진): 알림 수, 살펴보기 수, 고친 비율, 주별 힌트 수, 예측 차이 추이 | 엔진 | T-14 | 이벤트·`mirror_attempts` 수와 응답 숫자가 일치 | 대기 |
  | T-28a | 앱 등록: Android 푸시 토큰, 웹 서비스 워커 + VAPID 구독, 로그아웃 시 해제 | 앱 | T-37, T-09a | `push_tokens`에 android·web 행, 웹 테스트 푸시 표시 | 대기 |
  | T-28b | 엔진 발송: 웹훅 → 방 멤버(보낸 사람·알림 끈 사람 제외)에게 Expo Push와 웹 푸시(`pywebpush`, VAPID). 웹 endpoint는 허용 호스트만, 만료 구독은 삭제 | 엔진 | T-10, T-23 | 대상 제외·묶음·실패 격리·SSRF 허용 목록·만료 삭제 테스트 | 대기 |
  ```
  - 그다음 이 작업의 행 T-28b를 `완료`로 바꾸고 완료 기준 칸 끝에 `확인: …`을 붙인다.
```bash
git add -A && git commit -m "T-28b: send Expo and web push from webhook"
```

---

### Task 9: T-21 `POST /v1/detail`

**Files:**
- Create: `engine/layers/rewrite.py`, `engine/app/routes/detail.py`, `engine/tests/test_detail.py`
- Modify: `engine/pipeline.py`, `engine/layers/guard.py`, `engine/app/contracts.py`, `engine/app/main.py`, `engine/prompts/judge.md`, `engine/prompts/rewrite.md`, 앱 타입(생성), `ARCHITECTURE.md` 3-3·4장

**Interfaces:**
- Consumes: Task 7의 `load_context`·`contracts`·`Masker` 사용 방식, Task 4의 `aggregate`·`merged`·`negative`, Task 2의 `run_all`, Task 5의 `get_queue`, `guard.render_detail`·`freq`·`FOOTNOTE`.
- Produces:
  - `contracts`:
    ```python
    Intent = Literal["단호하게", "미안하게", "가볍게"]
    class Readings(BaseModel): 차갑게: Freq; 성의없게: Freq; 화나게: Freq; 무난하게: Freq; 따뜻하게: Freq   # 다섯 키 모두 필수
    class DetailIn(BaseModel): room_id: UUID; text: Draft; intent: Intent | None = None; reply_to: int | None = None
    class OptionOut(BaseModel): label: str; text: str; keep: list[str]; change: list[str]
    class DetailOut(BaseModel): alert: bool; top_reading: Reading; readings: Readings; why: list[str]; options: list[OptionOut]; mismatch: str | None; footnote: str; trace_id: UUID
    ```
  - `guard`:
    - `MISMATCH = {"단호하게": {"화나게", "성의없게"}, "미안하게": {"차갑게", "화나게", "성의없게"}, "가볍게": {"차갑게", "화나게"}}`
    - `render_mismatch(intent: str | None, readings: dict[str, float]) -> str | None`: 가장 많이 읽힌 뜻(5개 중 최대)이 `MISMATCH[intent]`에 있을 때만 `guard(f"{intent} 말하려던 것과 달리 {PHRASE[top]} 읽힐 수도 있어요")`를 돌려준다. `PHRASE = {"차갑게": "차갑게", "성의없게": "성의 없게", "화나게": "화난 것처럼"}`.
    - `OPTION_LABELS = ("조금만 바꾼 문장", "가장 부드럽게 바꾼 문장")`
  - `layers.rewrite.surface_ok(draft: str, cand: str) -> bool`: 괄호 빈칸을 빼고 본다. 거절이 거절로 남고 존댓말·반말이 같아야 한다.
  - `async layers.rewrite.check(checker: Expert, req: ExpertRequest, options: list[RewriteOption], original_neg: float, deadline: float) -> list[tuple[int, RewriteOption]]`: `surface_ok`이고, 같은 checker로 후보를 읽은 neg가 `original_neg - 0.1` 이하인 것만 원래 순번과 함께 돌려준다. checker가 실패하면 탈락이다.
  - `pipeline.DetailOutcome(gate, verdict: Verdict | None, readings: dict[str, float] | None, report: DetailReport | None, mismatch: str | None, results: list[ExpertResult], outcome: Literal["ok", "no_result"])`
  - `async pipeline.detail(reg, draft, convo, store, user_id: str, names: list[str], intent: str | None, t0: float, path: Literal["detail", "mirror"] = "detail") -> DetailOutcome`. 순서:
    1. `Masker(names)`로 가린다. 그다음 `gate.score(…, 0.0, global_min_obs)`.
    2. `req = ExpertRequest.from_convo(path, …)`. intent는 넣지 않는다.
    3. `run_all(context + tone of path, req, t0 + deadline_ms/1000 - 0.3)`. 말투 결과가 없으면 `outcome="no_result"`.
    4. `aggregate`를 부른다. `abstain`이고 disagreement > max이면 judge 전문가에 `extra={"context": ctx json 또는 "{}", "tone_a": 첫 tone json, "tone_b": 마지막 tone json, "risk": verdict.risk}`로 묻는다. 결과로 `abstain=False`, `alert=out.alert`, `top_reading`을 같은 규칙으로 다시 정한다. judge가 실패하면 그대로 둔다.
    5. `readings = merged(tones)`, `mismatch = render_mismatch(intent, readings)`
    6. `alert` 또는 `mismatch`이면 `req.model_copy(update={"intent": intent})`로 rewrite 전문가를 부르고, 후보는 앞의 2개만 본다. `check`의 checker는 path의 첫 tone 전문가이고, `original_neg`는 그 전문가의 neg다. 통과한 후보는 `label=OPTION_LABELS[원래 순번]`, text·keep·change는 `m.restore`한다. keep·change가 `guard`에 걸리면 그 옵션을 버린다.
    7. `report = guard.render_detail(verdict, readings, options)`
  - `async pipeline.panel(reg, draft: str, relation: str, names: list[str], t0: float) -> dict[str, float] | None`: `Masker` → mirror 경로 tone 전문가만, turns 없이 → `merged`. 결과가 없으면 None.
  - `POST /v1/detail` → `DetailOut`
    - `ensure_member` → `load_context` → `pipeline.detail`을 `wait_for(paths.detail.deadline_ms/1000)`로 감싼다. 시간 초과나 `no_result`면 503이다.
    - `intent is None`일 때만 `queue.enqueue("event", repo.insert_event, user, room_id, "detail_opened", top_reading, {"signals": out.gate.signals, "trace_id": str(trace_id)})`를 넣는다. `tone_events.signals`는 jsonb 객체다(앱이 쓰는 `hint_shown`은 `{trace_id}`).

- [ ] **Step 1: claim** — `scripts/claim T-21 detail`

- [ ] **Step 2: 실패하는 테스트 작성** — `tests/test_detail.py`

시나리오 "마감": 팀원 1:1, 상대 말 "이번 주만 마감 하루 미뤄도 될까요? 집에 일이 생겨서요", 초안 "안 돼요.".
```python
def test_alert_with_readings_and_options()   # alert True; set(readings) == 다섯 키, 값 ∈ {자주,가끔,드물어요}; options 1~2개, label ∈ OPTION_LABELS; footnote == FOOTNOTE
def test_no_internal_scores_in_response()    # set(body) == {"alert","top_reading","readings","why","options","mismatch","footnote","trace_id"}; 재귀로 float 값 없음
def test_intent_recall_only_reruns_rewrite(spy)  # intent 없이 1번 → 다시 intent="미안하게" → 두 번째 호출의 spy.calls 모델 == ["mock:rewrite"]
def test_intent_not_in_judging_inputs(spy)   # rewrite 아닌 호출마다 payload["intent"] is None, user에 "미안하게" 없음
@pytest.mark.parametrize("bad", ["네 할게요.", "안 돼.", "안 돼요."])   # 거절→승낙, 반말, 덜 부정적 아님
def test_rewrite_checks_drop_bad_candidates(spy, bad)  # canned rewrite [bad, "지금은 어려울 것 같아요. (이유)"] → options 1개, label == OPTION_LABELS[1]
def test_rewrite_restores_masked_values(spy) # 멤버 "민수", 초안 "민수야 안 돼요. 010-1234-5678로 전화해" → options text에 "민수"·"010-1234-5678" 있고 "[이름"·"[전화번호" 없음
def test_mismatch_table()                    # parametrize: (단호하게, 차갑게 최대) → None; (단호하게, 화나게) → 문구; (미안하게, 차갑게) → 문구; (가볍게, 성의없게) → None; (None, 화나게) → None
def test_judge_called_on_disagreement(spy)   # canned tone neg .9 / tone_alt neg .1 → spy.calls에 "mock:judge", 결과 abstain 아님
def test_detail_opened_recorded_once(client, queue)  # intent 없이 → queue.names() == ["event"], 큐에 든 마지막 인자는 dict이고 키가 {"signals", "trace_id"}(signals는 list); intent 있게 → 추가 없음
def test_mismatch_in_response_body(spy)      # canned tone 읽힘의 화나게가 최대, intent "단호하게" → body["mismatch"]가 "단호하게 말하려던 것과 달리"로 시작; 같은 요청을 intent 없이 → body["mismatch"] is None(앱은 이 값을 그대로 보여 준다)
def test_no_tone_result_503(spy)             # canned tone·tone_alt가 "not json" → 503
def test_no_raw_pii_reaches_any_expert(spy)  # judge까지 부르는 canned에서 spy.seen()에 "민수"·"010-1234" 없음 (context, tone, judge, rewrite, 후보 재판정 모두)
def test_reply_to_other_room_422()
```

- [ ] **Step 3: 실패 확인** — `cd engine && uv run pytest -q tests/test_detail.py` → FAIL (404)

- [ ] **Step 4: 구현 + 프롬프트** — `judge.md`·`rewrite.md` user 블록에 `방: {room}`을 넣는다. `rewrite.md` system에 "내 의도가 '단호하게/미안하게/가볍게'로 주어지면 그 말투를 지키되 의도(거절이면 거절)는 바꾸지 않는다"를 한 줄 더한다.

- [ ] **Step 5: 통과 확인 + 타입 생성** — `cd engine && uv run pytest -q` → 실패 0. 공통 흐름의 타입 생성 → `test_openapi_snapshot_current` PASS.

- [ ] **Step 6: 문서 + 완료 처리 + commit**

`ARCHITECTURE.md` 3-3·4장에 넣을 것: `mismatch` 칸(엔진이 만든 문구를 앱이 그대로 보여 준다), 고쳐 쓰기 조건(alert 또는 어긋남), 칩을 다시 누르면 같은 API 재호출(판정은 캐시), `detail_opened`는 첫 호출만·risk 없음. 4장의 `/v1/detail` 응답 칸에도 `mismatch`를 더한다. 4장 오류 줄 `- 오류: 401(토큰), 403(방 멤버 아님 / 받은 메시지 아님), 422(형식), 429(사용자별 요청 한도).`를 `- 오류: 401(토큰), 403(방 멤버 아님 / 받은 메시지 아님), 422(형식), 503(엔진·모델 일시 불가); 429는 단계 1에서 미구현.`으로 바꾼다. tasks.md T-21을 `완료`로 바꾼다. 확인 칸: 내부 점수 없음, 재호출에서 rewrite만 다시 돎.
```bash
git add -A && git commit -m "T-21: /v1/detail with judge, intent-only rewrite, three checks, name restore"
```

---

### Task 10: T-24 털어놓기 → 보낸 사람·전체 패턴

**Files:**
- Create: `engine/jobs/feedback.py`, `engine/app/routes/feedback.py`, `engine/tests/test_feedback.py`, `supabase/migrations/20261028000002_sender_pattern_activations.sql`
- Modify: `engine/pipeline.py`(`feedback`), `engine/layers/guard.py`(`ACK`), `engine/app/contracts.py`, `engine/app/main.py`, `engine/app/db.py`·`engine/tests/fakes.py`·`engine/tests/pg.py`·`engine/tests/test_db.py`(`FeedbackWrite`, `apply_feedback`, `sender_patterns`, 값 검사), `supabase/tests/tone_rls.test.mjs`(기본 키 변경에 맞춤), `engine/harness/store.py`, 앱 타입(생성), `ARCHITECTURE.md` 5장·9장

**Interfaces:**
- Consumes: Task 1의 `Repo.apply_feedback`·`sender_patterns`·`weekly_feedback_count`·`FeedbackWrite`·`KST`·`week_start`. 이 중 `apply_feedback`·`sender_patterns`·`FeedbackWrite`는 이 Task가 바꾼다(아래 규칙). `weekly_feedback_count`·`KST`·`week_start`는 그대로 쓴다. 또 `app.db.GROUP_MIN_MEMBERS`·`check_patterns`를 쓴다. Task 2의 `TRIGGERS`·`FeedbackResult`(중복 제거·3개 상한), Task 5 `get_queue`.
- Produces:
  - `FeedbackIn(room_id: UUID, message_id: int, text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)])`, `FeedbackOut(ack: str)`
  - `guard.ACK`: 프로토타입 `layers/feedback.py`의 `ACK` 문장 그대로
  - `async pipeline.feedback(reg, complaint: str, about: str, relation: str, names: list[str]) -> FeedbackResult | None`: 입구에서 `Masker`로 가린다. `ExpertRequest(path="async", draft=about_m, relation, extra={"text": complaint_m, "about": about_m})`로 feedback 전문가를 부른다. `NoResult`면 None이다.
  - `jobs.feedback`:
    - 상수: `WEEKLY_CAP = 5`. `GROUP_MIN_MEMBERS`는 여기 두지 않고 `app.db`에서 가져온다(규칙 2, 정의는 한 곳).
    - `next_midnight_kst(now: datetime) -> datetime`
    - `async run(repo: Repo, reg: Registry, room_id: UUID, reporter_id: UUID, message_id: int, complaint: str, now: datetime | None = None) -> None`
  - `run` 순서:
    1. 메시지, 방, 이름을 읽는다.
    2. `pipeline.feedback(…)`를 부른다.
    3. usable이면 `patterns = [p for p in result.patterns if p.trigger in TRIGGERS and p.feeling in NEGATIVE]`. `TRIGGERS`는 Task 2의 고정 어휘다(gate 신호 이름 7개를 모두 포함하고, 프롬프트 태그 3개를 더한다). L4가 `trigger` 자리에 문장 조각을 내놓아도 여기서 걸러져 `sender_patterns`·`global_patterns`에 못 들어간다. 걸러진 뒤 `patterns`가 비면 usable을 False로 둔다(쓸모 없는 신고가 주간 상한을 쓰지 않게).
    4. 패턴이 있어도 `weekly_feedback_count(sender, relation, since=datetime.combine(week_start(now), time(0), KST)) >= WEEKLY_CAP`이면 usable False, 패턴 []다. 주간 상한은 ISO (연, 주)의 KST 시작 시각부터 센다. 주 번호만으로 세지 않는다.
    5. `to_sender = room.kind == "group" and room.member_count >= GROUP_MIN_MEMBERS`. 호출자의 요청일 뿐이다. 최종 판정은 `apply_feedback`가 SQL에서 다시 한다.
    6. `apply_feedback(FeedbackWrite(room_id, reporter_id, message_id, usable, patterns, to_sender, active_from=next_midnight_kst(now)))`. `sender_id`·`relation`은 넘기지 않는다(아래 규칙 2).
    7. complaint와 결과의 `dropped_reason`은 로그에 쓰지 않는다.
  - **`Repo.apply_feedback`·`sender_patterns` 규칙 (필수. 이 Task가 T-06a 구현을 바꾼다. `PgRepo`와 `FakeRepo`가 같이 지킨다)**
    1. **활성 시각별 행.** 마이그레이션 `20261028000002_sender_pattern_activations.sql`이 `tone.sender_patterns`의 기본 키를 `(sender_id, relation, trigger, active_from)`으로 바꾼다(`alter table tone.sender_patterns drop constraint sender_patterns_pkey; alter table tone.sender_patterns add primary key (sender_id, relation, trigger, active_from);`). 신고는 **자기 `active_from`(다음 KST 자정) 행만** upsert한다(`on conflict (sender_id, relation, trigger, active_from) do update`: count + 1, strength는 count 가중 누적 평균, feeling은 새 값). 이미 켜진 행(`active_from`이 지난 것)은 건드리지 않으므로 재신고가 켜진 패턴을 꺼 버리지 않는다. 같은 날 되풀이한 신고는 같은 행에 쌓인다. `Repo.sender_patterns(sender_id, relation, now)`는 `active_from <= now`인 행을 trigger별로 묶어 count는 합, strength는 count 가중 평균, feeling은 그중 `active_from`이 가장 늦은 행의 값으로 돌려준다(반환 모양이 그대로라 T-13 `aggregate`는 안 바뀐다). `FakeRepo`도 같은 키와 같은 읽기 규칙을 쓴다.
    2. **보낸 사람·관계는 호출자가 안 준다.** `FeedbackWrite`에서 `sender_id`·`relation`을 뺀다(남는 칸: `room_id, reporter_id, message_id, usable, patterns, to_sender, active_from`). `apply_feedback`가 같은 트랜잭션 안에서 `messages`(`id = message_id and room_id = room_id`)에서 `sender_id`를, `rooms`에서 `relation`·`kind`를, `room_members` 행 수를 읽는다. 행이 없으면(없는 메시지, 다른 방) `ValueError("unknown message")`이고 아무것도 쓰지 않는다. `sender_patterns` upsert는 `fb.to_sender`이고 **SQL이 읽은** `kind = 'group'`이며 멤버 수가 `GROUP_MIN_MEMBERS` 이상일 때만 한다(규칙 14를 DB 쪽에서도 지킨다). 호출자가 `to_sender=True`를 넘겨도 1:1이나 2명 방이면 `sender_patterns`는 그대로고 `global_patterns`만 는다. `GROUP_MIN_MEMBERS = 3`은 `app.db`에만 정의하고 `jobs.feedback`·`FakeRepo`·테스트는 거기서 import한다(숫자를 다시 쓰지 않는다).
    3. **값 검사는 SQL보다 먼저, 값을 메시지에 싣지 않는다.** `app.db.check_patterns(patterns)`를 `apply_feedback` 맨 앞(첫 쿼리·트랜잭션 전)에서 부른다. `trigger not in TRIGGERS` → `ValueError("unknown trigger")`, `feeling not in READINGS`(`harness.schemas`의 다섯 읽힘) → `ValueError("unknown feeling")`, `strength`가 정수 1~3이 아니면 → `ValueError("bad strength")`. 메시지는 고정 문구이고 값·`repr(pattern)`을 넣지 않으며 `raise … from None`으로 쓴다. 검사를 SQL 앞에 두는 이유: DB check 위반이 나면 Postgres DETAIL(`Failing row contains (...)`)이 asyncpg 예외의 `str(exc)`에 들어가 행 값(L4가 trigger 자리에 흘린 하소연 조각)이 로그로 샌다. 큐는 이미 `type(e).__name__`만 남기지만(Task 5), 이 검사로 DB 예외가 아예 나지 않게 한다. `usable=False`여도 `patterns`가 있으면 검사한다.
    4. **패턴은 `sorted(patterns, key=lambda p: p.trigger)` 순서로 쓴다.** 두 신고가 같은 `global_patterns`·`sender_patterns` 행을 반대 순서로 잠가 데드락 나는 것을 막는다. T-06a에서 이미 이 순서로 쓰게 했으니 여기서 다시 만들지 않고, 테스트로 고정만 한다.
  - `POST /v1/feedback` → 202 `FeedbackOut`
    - `ensure_member` 후 `msg = repo.message(id)`를 읽는다. `msg is None`이거나 `msg.room_id != room_id`이거나 `msg.sender_id == user`이면 403이다.
    - `queue.enqueue("feedback", jobs.feedback.run, repo, reg, room_id, user, message_id, body.text)`. False면 503이다.
  - `harness/store.py`: `ProfileStore`를 읽기 전용 스냅숏으로 줄인다(`pair_patterns`, `global_patterns`, `baselines`, `patterns_for`, `baseline`만 남김). `load`, `save`, `add_patterns`, `seed_global`, `update_baseline`, `weekly`, `WEEKLY_CAP_PER_PAIR`, ponytail 주석은 지운다.

- [ ] **Step 1: claim** — `scripts/claim T-24 feedback`

- [ ] **Step 2: 실패하는 테스트 작성** — `tests/test_feedback.py`

그룹 픽스처는 민수(보낸 사람)·지은·하늘 3명, 팀원이다. 민수의 메시지는 "ㅇㅇ"이다.
```python
def test_feedback_202_ack(client, queue)        # 202, body["ack"] == guard.ACK, queue.names() == ["feedback"]
def test_own_message_403(); def test_other_room_message_403(); def test_non_member_403(); def test_text_1001_422()
def test_group_feedback_to_sender_from_next_day(fake, registry)  # 지은이 "너무 단답이라 성의 없어 보였어" → sender_pats[(민수, 팀원, "짧은 답")].active_from == next_midnight_kst(now), 신고자(지은) 키 없음, global["짧은 답"] == 1
def test_direct_feedback_global_only()          # 1:1 → sender_pats 비어 있음, global += 1
def test_two_member_group_counts_as_direct()    # kind group, 멤버 2 → global만
def test_weekly_cap()                           # 같은 보낸 사람·관계로 6번째 → feedback_log usable False, 패턴 그대로
def test_same_reporter_repeats_count_once()     # 같은 (지은, 메시지) 두 번 → feedback_log 1행; 지은이 다른 메시지 5개로 "짧은 답" → global["짧은 답"] == 1
def test_duplicate_triggers_in_one_report()     # canned feedback patterns ["짧은 답","짧은 답","마침표로 끝남","이유 없는 거절","짧은 답"] → 각 trigger 1번, 최대 3개
def test_unknown_trigger_or_feeling_not_stored()  # canned trigger "민수가 안 된다고만 함", feeling "짜증" → sender_patterns·global_patterns 저장 0, feedback_log usable False·pattern_count 0
def test_rereport_next_day_keeps_yesterdays_pattern(fake, registry)  # 그룹방, 날짜 D 10:00 KST에 지은이 "짧은 답"으로 신고 → D+1 10:00에 하늘이 같은 신호로 신고(run의 now 인자). now=D+1 10:00에서 sender_patterns(민수, 팀원)["짧은 답"].count == 1(어제 행이 그대로 켜져 있음), now=D+2 0:00에서 count == 2; rows 2개(active_from D+1 0:00, D+2 0:00)
def test_same_day_rereport_stacks_in_one_row(fake, registry)  # 같은 날 두 사람 신고 → sender_patterns 행 1개, count 2, active_from 같음
def test_caller_cannot_force_sender_pattern(fake, registry)  # run()이 아니라 repo.apply_feedback(FeedbackWrite(…, to_sender=True))를 1:1 방·2명 그룹방 메시지에 직접 호출 → sender_patterns 0행, global += 1 (test_db의 SQL 규칙 테스트와 별개로 fake 경로 확인)
def test_bad_pattern_error_has_no_value(world, caplog)  # trigger/feeling 자리에 "보라색코끼리하소연"을 넣은 FeedbackPattern(model_construct) → ValueError, str(exc)·repr(exc)·caplog.text에 "보라색코끼리하소연" 없음, 네 표 모두 그대로
def test_known_triggers_all_storable()          # gate의 신호 7개 이름이 모두 TRIGGERS에 있음(어휘가 gate와 어긋나지 않음)
def test_kst_boundaries()                       # next_midnight_kst(2026-10-27T14:59Z) == 2026-10-28T00:00+09:00; (2026-10-27T15:01Z) == 2026-10-29T00:00+09:00; week_start(2027-01-01T01:00+09:00) == date(2026,12,28)
def test_complaint_never_stored_or_logged(client, fake, queue, caplog, spy, registry)  # 하소연 "민수가 보라색코끼리하소연 너무 단답이야": run_all 뒤 repr(fake.__dict__)·caplog.text·str(list(registry.router.traces))에 "보라색코끼리하소연" 없음; spy.seen()에는 하소연이 가지만 멤버 이름 "민수"는 없음
def test_complaint_never_persisted_pg(pg_dsn)   # PgRepo로 run() 뒤 public·tone·auth의 text/varchar/jsonb/배열 칸 전부 `c::text like '%보라색코끼리하소연%'` → 0행
```

`tests/test_db.py`에 더한다(`world` 픽스처라 `FakeRepo`·`PgRepo` 둘 다 돈다). 그룹방 픽스처는 위와 같고, 시각은 KST 자정 기준으로 고정한다.
```python
def test_rereport_keeps_active_pattern(world)   # 어제 0시 활성 행(count 1, strength 2.0) 시드 → 같은 (민수, 팀원, "짧은 답")을 내일 0시 active_from으로 apply_feedback → rows 2개; sender_patterns(now=지금)는 count 1·strength 2.0 그대로; now=내일 0시면 count 2·strength는 count 가중 평균; 같은 날 한 번 더 → 내일 행 count 2(행은 여전히 2개), now=내일 0시 이후 합산 읽기는 count 3
def test_sender_patterns_weighted_read(world)   # 행 (count 1, strength 1.0, 성의없게, 어제), (count 3, strength 3.0, 차갑게, 오늘 0시) → count 4, strength 2.5, feeling "차갑게"(가장 늦은 active_from); 내일 행은 제외
def test_apply_feedback_derives_sender_and_relation(world)  # FeedbackWrite 칸에 sender_id·relation이 없다(dataclasses.fields); 친구 관계 그룹방의 민수 메시지 → 저장된 sender_patterns 행의 sender_id == 민수, relation == "친구"; 다른 방의 message_id → ValueError("unknown message")이고 네 표 모두 그대로
def test_apply_feedback_group_rule_in_sql(world)  # to_sender=True로 직접 호출: 1:1 방, kind group이지만 멤버 2명인 방 → sender_patterns 0행, global_patterns += 1, feedback_log 1행; 멤버 3명 그룹방 → sender_patterns 1행
@pytest.mark.parametrize("bad", ["trigger", "feeling", "strength0", "strength4"])
def test_apply_feedback_rejects_bad_values(world, bad)  # trigger "민수가 안 된다고만 함" / feeling "짜증" / strength 0·4(FeedbackPattern.model_construct로 만듦) → ValueError, 메시지에 그 값이 없음, sender_patterns·global_patterns·pattern_reporters·feedback_log 모두 그대로; usable=False여도 같다
def test_apply_feedback_no_deadlock_with_reversed_triggers(world)  # PgRepo 전용(fake는 잠금이 없어 pytest.skip). 서로 다른 신고자·메시지 둘이 같은 패턴 두 개를 서로 반대 순서(`["짧은 답","마침표로 끝남"]` / 역순)로 `asyncio.gather(repo.apply_feedback(a), repo.apply_feedback(b))` — 새 신고자·메시지로 20번 반복. 매번 둘 다 예외 없이 끝나고(데드락이면 asyncpg가 DeadlockDetectedError), 끝난 뒤 두 trigger의 global count가 40 = 신고자 수. 데드락은 확률적이라 반복으로 잡는다. 정렬을 빼면 이 테스트가 간헐적으로 실패해야 한다
```

- [ ] **Step 3: 실패 확인** — `cd engine && uv run pytest -q tests/test_feedback.py` → FAIL

- [ ] **Step 4: 구현**

- [ ] **Step 5: 통과 확인 + 타입 생성** — `cd engine && uv run pytest -q` → 실패 0. `supabase/tests/tone_rls.test.mjs`의 `service_role can write tone tables`(:50-56)는 "같은 (sender, relation, trigger)를 active_from만 다르게 또 넣으면 `/duplicate key/`로 실패"를 단언하는데, 새 기본 키에서는 성공하므로 그대로 두면 깨진다. 그 단언을 이렇게 바꾼다: 고정 과거 시각 `'2026-10-01 00:00+09'`로 (a, '팀원', 'curt_reply')를 넣고, 같은 active_from으로 한 번 더 넣으면 `/duplicate key/`로 거부되며, active_from만 `'2026-10-02 00:00+09'`로 다른 행은 들어간다(둘 다 과거 시각이라 :81의 `active_from > now()` 행 수 1 검사는 그대로 둔다. 첫 줄 `now() + interval '1 day'` 행이 그 1행이다. `now()`는 문장마다 달라 "같은 키" 검사에 쓰지 않는다). 주석 `// PK(sender_id, relation, trigger)`도 `PK(…, active_from)`으로 고친다. `cd supabase && npm test` → 이 수정 + 새 마이그레이션과 함께 모두 통과. 타입 생성 → 스냅숏 테스트 PASS.

- [ ] **Step 6: 문서 + 완료 처리 + commit**

`ARCHITECTURE.md`를 고친다.
- 5장: `global_patterns.count` = 서로 다른 신고자 수, `pattern_reporters`. `tone.sender_patterns` 행의 PK를 `(sender_id, relation, trigger, active_from)`으로 고치고, "읽을 때 `active_from <= now`인 행의 count 합 · strength count 가중 평균"을 덧붙인다.
- 9장: `harness/store.py` → `app/db.py` 줄을 "`harness/store.py`는 `app/context.py`가 요청마다 `app/db.Repo`에서 채우는 읽기 전용 스냅숏, 쓰기는 `app/db.py`"로 바꾼다.

tasks.md T-24를 `완료`로 바꾼다. 확인 칸: 원문 미저장(fake·pg·로그), 1:1이 sender_patterns에 안 들어감.
```bash
git add -A && git commit -m "T-24: /v1/feedback → L4 → sender/global patterns, raw text never stored"
```

---

### Task 11: T-26 기준선

**Files:**
- Create: `engine/jobs/baseline.py`, `engine/tests/test_baseline.py`
- Modify: `engine/app/routes/hooks.py`

**Interfaces:**
- Consumes: Task 6 `MessageRecord`, Task 1 `Repo.update_baseline`, Task 7 `load_context`, Task 4 `gate.score`, `harness.korean.surface`.
- Produces:
  - `async jobs.baseline.update(repo: Repo, record: MessageRecord) -> None`: text가 비면(사진만) 건너뛴다. `s = surface(text)`로 `repo.update_baseline(sender_id, s["length"], s["polite"], s["softener"])`를 부른다.
  - hooks에 `queue.enqueue("baseline", baseline.update, repo, record)`를 더한다.

- [ ] **Step 1: claim** — `scripts/claim T-26 baseline`

- [ ] **Step 2: 실패하는 테스트 작성** — `tests/test_baseline.py`

```python
def test_webhook_enqueues_baseline(client, queue)   # "baseline" in queue.names()
def test_image_only_skipped(fake)                   # fake.baselines 비어 있음
def test_deviation_after_ten_messages(fake)
    # "회의 자료는 내일 오전까지 정리해서 올릴게요"로 update 9번 → load_context → gate.score("ㅇㅇ", …).signals에 "평소보다 짧음" 없음
    # 10번째 → "평소보다 짧음"과 "존댓말이 갑자기 빠짐" 둘 다 있음
```

- [ ] **Step 3: 실패 확인** — `cd engine && uv run pytest -q tests/test_baseline.py` → FAIL

- [ ] **Step 4: 구현**

- [ ] **Step 5: 통과 확인** — `cd engine && uv run pytest -q tests/test_baseline.py` → Expected: `3 passed`

- [ ] **Step 6: 완료 처리 + commit** — tasks.md T-26 `완료`. 확인 칸: 10개 뒤 이탈 신호.
```bash
git add -A && git commit -m "T-26: baselines from webhook feed L0"
```

---

### Task 12: T-27b `GET /v1/stats/me` (엔진)

**Files:**
- Create: `engine/app/routes/stats.py`, `engine/tests/test_stats.py`
- Modify: `engine/app/contracts.py`, `engine/app/main.py`, 앱 타입(생성), `docs/tasks.md`(T-27/T-28 행)

**Interfaces:**
- Consumes: Task 1의 `event_counts`·`hints_by_week`·`predict_gap_by_week`·`week_start`·`KST`.
- Produces:
  - `WeekCount(week: str, count: int)`, `WeekGap(week: str, avg_gap: float)`. `week`는 KST ISO 주 시작 날짜 `YYYY-MM-DD`(`week_start(...).isoformat()`)다.
  - `StatsOut(hints: int, details: int, fixed: int, fix_rate: float, hints_by_week: list[WeekCount], predict_gap_trend: list[WeekGap])`
  - `GET /v1/stats/me`
    - `hints` = `hint_shown`(앱이 `signals: {trace_id}`로 기록), `details` = `detail_opened`, `fixed` = `sent_after_fix`
    - `fix_rate = round(fixed / (fixed + sent_with_hint), 2)`. 분모가 0이면 0.0이다.
    - `hints_by_week`: 이번 주를 포함한 최근 5주, 오래된 것부터, 없는 주는 0으로 채운다.
    - `predict_gap_trend`: 같은 5주 안에서 기록이 있는 주만, 오래된 것부터.

- [ ] **Step 1: claim** — `scripts/claim T-27b stats-api`

- [ ] **Step 2: 실패하는 테스트 작성** — `tests/test_stats.py`

```python
def test_counts_and_fix_rate(client, fake)   # hint_shown 4, detail_opened 2, sent_with_hint 1, sent_after_fix 3 → fixed 3, fix_rate 0.75
def test_fix_rate_zero_without_sends()
def test_hints_by_week_five_zero_filled()    # len 5, 오래된 것부터, 마지막 week == 이번 주 월요일 "YYYY-MM-DD" 문자열, 이벤트 없는 주 count 0
def test_predict_gap_trend_matches_attempts()  # mirror_attempts predict gap 1, 3 같은 주 → [{"week": "2026-10-26", "avg_gap": 2.0}]
def test_other_users_not_counted(); def test_no_token_401()
```

- [ ] **Step 3: 실패 확인** — `cd engine && uv run pytest -q tests/test_stats.py` → FAIL (404)

- [ ] **Step 4: 구현**

- [ ] **Step 5: 통과 확인 + 타입 생성** — `cd engine && uv run pytest -q tests/test_stats.py` → `6 passed`. 타입 생성 → 스냅숏 PASS.

- [ ] **Step 6: 완료 처리 + commit** — `docs/tasks.md`: T-27/T-28 부모 행이 아직 있으면 그 행을 아래 네 행으로 바꾼다(상태는 모두 `대기`). 이미 나뉘어 있으면(앱 T-04b나 엔진 Task 8이 먼저 land됐다) 자기 행만 고친다. T-30 행의 선행 칸 `T-28`은 `T-28a, T-28b`로 바꾼다(이미 바뀌었으면 그대로).
  ```text
  | T-27a | 앱 리포트 화면: 알림 수, 살펴보기 수, 고친 비율, 예측 차이 추이, 주별 힌트 수 | 앱 | T-34 | mock·엔진 숫자와 화면이 같음 | 대기 |
  | T-27b | `/v1/stats/me`(엔진): 알림 수, 살펴보기 수, 고친 비율, 주별 힌트 수, 예측 차이 추이 | 엔진 | T-14 | 이벤트·`mirror_attempts` 수와 응답 숫자가 일치 | 대기 |
  | T-28a | 앱 등록: Android 푸시 토큰, 웹 서비스 워커 + VAPID 구독, 로그아웃 시 해제 | 앱 | T-37, T-09a | `push_tokens`에 android·web 행, 웹 테스트 푸시 표시 | 대기 |
  | T-28b | 엔진 발송: 웹훅 → 방 멤버(보낸 사람·알림 끈 사람 제외)에게 Expo Push와 웹 푸시(`pywebpush`, VAPID). 웹 endpoint는 허용 호스트만, 만료 구독은 삭제 | 엔진 | T-10, T-23 | 대상 제외·묶음·실패 격리·SSRF 허용 목록·만료 삭제 테스트 | 대기 |
  ```
  - 그다음 이 작업의 행 T-27b를 `완료`로 바꾸고 완료 기준 칸 끝에 `확인: …`을 붙인다.
```bash
git add -A && git commit -m "T-27b: /v1/stats/me with weekly hints and predict gap trend"
```

---

### Task 13: T-19 `tone.analysis_traces`

**Files:**
- Create: `engine/app/traces.py`, `engine/tests/test_traces.py`
- Modify: `engine/app/routes/hint.py`, `engine/app/routes/detail.py`

**Interfaces:**
- Consumes: `RealtimeOutcome`, `DetailOutcome`, `ExpertResult`, `Verdict.features`, `TraceRow`, `Repo.insert_trace`, `get_queue`.
- Produces:
  - `expert_summary(r: ExpertResult) -> dict`: 허용 목록만 담는다. 공통은 `expert_id, role, model, latency_ms`다. 역할별로 context는 `prev_act, partner_state, n_expect, confidence`, tone은 `readings, has_reason, confidence`, judge는 `alert`, rewrite는 `n_options`다. `cues`, `expectation_points`, `shared_context`, `reason`, 후보 문장은 넣지 않는다.
  - `build_trace(trace_id: UUID, path: Literal["realtime", "detail"], user_id: UUID, room_id: UUID, status: str, latency_ms: int, outcome: RealtimeOutcome | DetailOutcome | None = None) -> TraceRow`
    - `experts = {"status", "gate": {"prior", "signals"} 또는 None, "features": verdict.features 또는 {}, "results": [expert_summary…]}`
    - risk = verdict.risk 또는 None
    - status: hint는 `gated|abstain|alert|none|timeout|error`, detail은 `ok|no_result|timeout|error`
  - hint·detail 라우트는 응답을 돌려주기 직전에(401·403·422 제외 모든 경우) `queue.enqueue("trace", repo.insert_trace, row)`를 넣는다.

- [ ] **Step 1: claim** — `scripts/claim T-19 traces`

- [ ] **Step 2: 실패하는 테스트 작성** — `tests/test_traces.py`

```python
def test_one_trace_per_hint_request(client, fake, queue)  # 가벼운 말·무거운 말·느린 DB 세 요청 → run_all 뒤 fake.traces 3행, status {"gated","alert","timeout"}, path "realtime"
def test_trace_has_no_text(spy)            # 초안 "보라색코끼리 안 돼요.", 멤버 "민수", canned tone cues ["보라색코끼리"] → json.dumps(asdict(row))에 "보라색코끼리"·"안 돼요"·"민수"·"[이름" 없음
def test_detail_trace(client, fake, queue) # path "detail", status "ok", features 키 6개
def test_no_trace_for_403(client, queue)   # 비멤버 → "trace" not in queue.names()
```

- [ ] **Step 3: 실패 확인** — `cd engine && uv run pytest -q tests/test_traces.py` → FAIL

- [ ] **Step 4: 구현**

- [ ] **Step 5: 통과 확인** — `cd engine && uv run pytest -q` → 실패 0

- [ ] **Step 6: 완료 처리 + commit** — tasks.md T-19 `완료`. 확인 칸: 힌트 요청마다 trace 1행, 문장 조각 없음.
```bash
git add -A && git commit -m "T-19: analysis traces without raw text"
```

---

### Task 14: T-35 거울 엔진 API + 상황 카드 20장

**Files:**
- Create: `engine/mirror.py`, `engine/content/mirror_cards.yaml`, `engine/app/routes/mirror.py`, `engine/tests/test_mirror.py`
- Modify: `engine/app/settings.py`(`mirror_secret`, env `MIRROR_SECRET`), `.env.example`, `ARCHITECTURE.md` 8장, `engine/app/contracts.py`, `engine/app/main.py`, 앱 타입(생성)

**Interfaces:**
- Consumes: Task 9의 `pipeline.detail(…, path="mirror")`·`pipeline.panel`·`OptionOut`·`Readings`, Task 1의 `sent_messages`·`message`·`member_names`·`mirror_refs`·`insert_mirror_attempt`·`KST`, `guard.guard`·`freq`.
- Produces:
  - `mirror.Card(id, topic, persona, relation, situation, message, sample_reply)`, `mirror.Content(cards: list[Card], personas: list[dict], inner_voice: dict[str, str])`, `load_content(path: Path) -> Content`
  - `sign(payload: dict, key: bytes) -> str`: `b64url(json(sort_keys, 압축)) + "." + b64url(hmac_sha256(key, payload)[:16])`
  - `unsign(card_id: str, key: bytes) -> dict`: `compare_digest`로 비교하고, 실패하면 `ValueError`
  - `get_mirror_key() -> bytes`: `MIRROR_SECRET`이 있으면 그 값, 없으면 `secrets.token_bytes(32)`(`lru_cache`, `# ponytail: 재시작하면 그날 카드 무효, 여러 프로세스면 MIRROR_SECRET 필수`)
  - `panel_bin(neg: float) -> int = min(5, int(neg / 0.2) + 1)`
  - `relative_day(sent: date, today: date) -> str`: "오늘", "어제", 같은 ISO 주면 "이번 주 X요일", 바로 전 주면 "지난주 X요일", 그 밖엔 "N일 전"
  - `today_cards(user_id: UUID, today: date, sent: list[SentMsg], used: set[str], content: Content, key: bytes) -> list[MirrorCard]`
  - `contracts`:
    ```python
    class MirrorCard(BaseModel): card_id: str; kind: Literal["roleplay", "receive", "predict"]; persona: str; relation: str; situation: str; message: str
    class MirrorTodayOut(BaseModel): cards: list[MirrorCard]
    class MirrorAnswerIn(BaseModel): card_id: str; reply: Draft | None = None; score: int | None = Field(None, ge=1, le=5); predicted: int | None = Field(None, ge=1, le=5)
    class MirrorAnswerOut(BaseModel): readings: Readings; inner_voice: str | None = None; reveal: str | None = None; options: list[OptionOut] | None = None; gap: int | None = Field(None, ge=0, le=4)
    ```
- 카드 고르기(`today_cards`):
  - `rng = random.Random(f"{user_id}:{today.isoformat()}")`
  - roleplay: `used`에 `"roleplay|card:<id>"`가 없는 카드 중 하나(다 썼으면 전체에서)
  - receive·predict: `sent`(최근 30일, 50개)에서 `"<kind>|msg:<id>"`를 뺀 것 중 서로 다른 둘. 모자라면 카드의 `sample_reply`(`card:<id>`)로 채운다.
  - relation은 메시지면 그 방 관계, 카드면 카드 관계다. persona는 관계가 같은 첫 persona, 없으면 첫 persona다.
  - situation: receive는 `f"{persona}에게서 온 메시지"`, predict는 `f"{관계말}에게 보낸다면"`이다(관계말: 친구→친구, 팀원→팀원, 선후배→선후배, 기타→상대).
  - 서명 payload는 `{"u": user, "k": kind, "s": ref, "r": relation, "p": persona, "d": today}`다.
- `POST /v1/mirror/today`: `sent_messages(user, now-30일)`와 `mirror_refs`로 `today_cards`를 만든다. 같은 날 다시 부르면 같은 카드다.
- `POST /v1/mirror/answer`:
  1. 서명이 틀리면 422, `u`가 다른 사용자면 403, `d`가 오늘·어제(KST)가 아니면 422다.
  2. 종류별 필수 값이 없으면 422다(roleplay → `reply`, receive → `score`, predict → `predicted`).
  3. 문장을 정한다. `msg:<id>`면 `repo.message`의 보낸 사람이 본인이어야 하고(아니면 403), names는 그 방 `member_names`다. `card:<id>`면 names는 []다.
  4. roleplay: `pipeline.detail(reg, reply, Conversation(pair_id="mirror", relation=r, turns=[Turn(speaker="them", text=card.message, label=persona)]), ProfileStore(), user, [], None, t0, path="mirror")`를 부른다. `readings`(freq), `inner_voice = content.inner_voice[가장 많이 읽힌 뜻]`, `options = report.options[:1]`(If case의 A, 이미 복원됨)을 낸다.
  5. receive·predict: `p = pipeline.panel(reg, 문장, r, names, t0)`, `gap = |(score 또는 predicted) − panel_bin(negative(p))|`. receive이고 메시지 출처면 `reveal = guard(f"이건 {relative_day}에 당신이 {관계말}에게 보낸 문장이에요")`다.
  6. 결과가 None이면 503이다.
  7. `"{kind}|{ref}"`가 `mirror_refs`에 없을 때만 `insert_mirror_attempt(user, kind, ref, score, predicted, panel_bin, gap)`를 부른다. 응답에는 panel 칸·risk를 넣지 않는다. `mirror_attempts`는 엔진만 쓴다(`SUPABASE_DB_URL` 직접 연결 = 서비스 권한, RLS 밖). 앱은 쓰지 않고 읽기만 한다(리포트 숫자는 `/v1/stats/me`가 읽는다).
- `mirror_cards.yaml` 형식:
  - `personas`: 4명 이상, 지어낸 이름, 관계는 팀원·선후배
  - `inner_voice`: 읽힘 5키, 문장에 대한 느낌만 쓴다(사람 평가 금지)
  - `cards` 20장: topic ∈ {일정 조율, 역할 요청, 거절, 마감 독촉} 각 5장, id는 `sched-01…`, `role-01…`, `refuse-01…`, `due-01…`
  - 예: `{id: due-01, topic: 마감 독촉, persona: 민지, relation: 팀원, situation: "발표 자료 마감이 내일이다", message: "혹시 맡은 슬라이드 오늘 밤까지 될까요?", sample_reply: "아직이요."}`
  - 모든 문구는 합성 문장이고 `guard`를 통과해야 하며, 타 메신저 이름은 쓰지 않는다.

- [ ] **Step 1: claim** — `scripts/claim T-35 mirror`

- [ ] **Step 2: 실패하는 테스트 작성** — `tests/test_mirror.py`

```python
def test_cards_yaml_valid()                # 20장, topic별 5장, id 유일, 필수 칸, 모든 문구 guard 통과, inner_voice 5키
def test_today_three_kinds_deterministic(client, fake)  # kinds == ["roleplay","receive","predict"], 두 번 불러도 card_id 같음
def test_today_uses_own_messages()         # receive·predict message ∈ 본인이 보낸 text, 서로 다름; 남의 메시지 안 나옴
def test_today_falls_back_to_cards()       # 보낸 메시지 없음 → sample_reply
def test_today_skips_used_refs()
def test_tampered_card_422(); def test_other_users_card_403(); def test_expired_card_422()  # d = 3일 전
def test_kind_requires_its_field_422()     # predict에 predicted 없음
def test_answer_roleplay()                 # reply "안 돼요." → readings 다섯 키, inner_voice ∈ yaml 값, len(options) <= 1, gap None
def test_answer_predict_gap_and_record(fake)  # predicted 1 → gap == panel_bin(neg) - 1, mirror_attempts에 panel_bin·gap 저장, 응답 키에 panel 없음
def test_answer_receive_reveal()           # 지난주 목요일 팀원방 메시지 → reveal == "이건 지난주 목요일에 당신이 팀원에게 보낸 문장이에요"
def test_answer_twice_records_once(fake)
def test_panel_bin_edges()                 # 0.0→1, 0.19→1, 0.2→2, 0.79→4, 0.8→5, 1.0→5
def test_relative_day()                    # (2026-10-22, 2026-10-27) → "지난주 목요일"; 같은 날 "오늘"; 하루 전 "어제"; (10-26, 10-27) "어제"; 14일 전 "14일 전"
def test_mirror_never_gemini_and_masked(spy)  # 본인 메시지 "민수야 010-1234-5678로 연락줘"(민수는 멤버) predict 답 → spy.calls 모델이 전부 "mock:", spy.seen()에 "민수"·"010-1234" 없음; mirror 경로 전문가 사슬에 "gemini:" 없음
```

- [ ] **Step 3: 실패 확인** — `cd engine && uv run pytest -q tests/test_mirror.py` → FAIL

- [ ] **Step 4: 구현 + 카드 20장 작성**

- [ ] **Step 5: 통과 확인 + 타입 생성** — `cd engine && uv run pytest -q` → 실패 0. 타입 생성 → 스냅숏 PASS.

- [ ] **Step 6: 완료 처리 + commit** — `.env.example` 엔진 블록에 `MIRROR_SECRET=`(주석: `python -c "import secrets; print(secrets.token_urlsafe(32))"`)를 넣고, `ARCHITECTURE.md` 8장 엔진 행에 `MIRROR_SECRET`(선택, 없으면 프로세스마다 임의 키)을 더한다. tasks.md T-35를 `완료`로 바꾼다. 확인 칸: 위조 card_id 거부, 실제 대화 카드가 Gemini로 가지 않음.
```bash
git add -A && git commit -m "T-35: mirror today/answer with signed card ids and 20 cards"
```

---

### Task 15: T-17 평가 스크립트 + baseline

**Files:**
- Create: `eval/run_eval.py`, `eval/contrast_set.jsonl`(프로토타입에서 복사), `eval/baseline.json`, `engine/tests/test_eval.py`
- Modify: `CLAUDE.md` 명령 표, `docs/tasks.md`(T-17 행, T-17-live 행, T-20 선행 칸)

**Interfaces:**
- Consumes: `experts.registry.Registry`, `pipeline.realtime`, `pipeline.detail`, `harness.schemas.Conversation/Turn`, `harness.store.ProfileStore`, `app.settings.DEFAULT_MODELS_PATH`.
- Produces:
  - `eval/run_eval.py [--mock] [--detail] [--json]`: 저장소 루트에서 `uv run --project engine python eval/run_eval.py …`로 돈다(`scripts/check`가 이 형태로 부른다). 맨 위에서 `engine/`을 `sys.path`에 넣는다.
  - `async evaluate(force_mock: bool, detail: bool) -> dict`: 키는 `precision`(float, 알림 0개면 0.0), `recall`(float 또는 None), `abstain_rate`, `context_split`("k/n"), `mode`("mock" 또는 "live", 프로토타입과 같은 판정, `router.traces` 기준), `n`이다. 각 행은 `Conversation(pair_id=f"eval-{pair}", relation, turns=[Turn(speaker="them", text=them)])`, `ProfileStore()`, names []로 `realtime`(또는 `--detail`이면 `detail`)을 부른다.
  - `--json`이면 stdout에 JSON 한 줄만 낸다. 아니면 프로토타입 표 + JSON이다.
  - `eval/baseline.json`은 `--mock --json` 출력을 그대로 저장한 것이다.

- [ ] **Step 1: claim** — `scripts/claim T-17 eval`

- [ ] **Step 2: 실패하는 테스트 작성** — `engine/tests/test_eval.py`

```python
def test_eval_mock_json_meets_baseline()   # subprocess [sys.executable, REPO/"eval/run_eval.py", "--mock", "--json"], cwd=REPO → json.loads(stdout) 키 ⊇ {precision, recall, abstain_rate, context_split, mode, n}; isinstance(precision, float); mode == "mock"; precision >= baseline["precision"]
def test_eval_detail_mode_runs()           # "--mock --detail --json" → 종료 코드 0, n == 16
```

- [ ] **Step 3: 실패 확인** — `cd engine && uv run pytest -q tests/test_eval.py` → FAIL (파일 없음)

- [ ] **Step 4: 구현 + baseline 만들기**

Run: `cp prototype/tone-harness/eval/contrast_set.jsonl eval/` (이미 있으면 그대로)
Run: `uv run --project engine python eval/run_eval.py --mock --json > eval/baseline.json`

- [ ] **Step 5: 통과 확인 + 게이트 확인**

Run: `cd engine && uv run pytest -q tests/test_eval.py`
Expected: `2 passed`
Run: `uv run --project engine python eval/run_eval.py --mock --json | jq -e --slurpfile b eval/baseline.json '.precision >= $b[0].precision'`
Expected: `true`

- [ ] **Step 6: 실제 키 실행(있을 때만) + 행 나누기 + commit**

`.env`에 `NVIDIA_API_KEY`가 있으면 `uv run --project engine --env-file .env python eval/run_eval.py > eval/results/$(date +%F)-live.txt`를 실행하고, `--json` 결과도 같은 이름 `.json`으로 저장한다(이 결과는 T-17-live의 증거로 쓴다). `CLAUDE.md` 명령 표 평가 칸: `uv run --project engine python eval/run_eval.py --mock [--detail] [--json]`.

`scripts/land`는 `완료`만 받으므로 T-17을 `진행`으로 두지 않고, 완료 기준을 "mock/로컬 기준"과 live 후속 행으로 나눈다.
- T-17 행: 선행 칸에서 `T-16`을 빼고(`T-14`), 완료 기준을 "mock/로컬 기준: 프로토타입 8쌍으로 `eval/run_eval.py --mock --json`이 정밀도·재현율·기권률·맥락 구분을 내고 `eval/baseline.json`이 있음(test_eval.py 통과). 확인: …"으로 줄여 `완료`로 바꾼다.
- 새 행: `| T-17-live | 실제 키 평가: 사람이 라벨한 대조 세트 30쌍으로 실제 키 1회 실행, 결과표 저장, baseline 갱신 | 평가 | T-16, T-17 | 실제 키로 1회 실행한 결과표를 eval/results/에 저장하고 eval/baseline.json을 30쌍 세트로 다시 만듦 | 대기 |`
- T-20 행의 선행 칸 `T-17`은 `T-17-live`를 더해 `T-17, T-17-live, T-18, T-19`로 바꾼다(가중치 학습은 실제 평가 뒤에 한다).
```bash
git add -A && git commit -m "T-17: eval script (mock/live, --json) and baseline"
```

---

## 단계 1 엔진이 끝나면

- 남는 엔진 작업: T-18(로컬 SEED·분류기), T-20(trace로 가중치 학습), T-29(배포 + pilot Supabase), 선택 T-32·T-33.
- Supabase dev 키(T-02)를 받으면 할 일:
  1. `SUPABASE_DB_URL`로 엔진을 띄운다.
  2. README 절차로 웹훅을 연결하고 `T-10-live`를 `완료`로 바꾼다(웹훅은 마이그레이션이 아니라 대시보드 Database → Webhooks에서 만든다).
  3. 앱(T-15)에서 힌트가 보낸 사람에게만 뜨는지 본다.
  4. 확인한 것을 `.coord/log.md`에 남긴다.
- 사람이 대조 세트 30쌍을 라벨링하면(T-16) 실제 키로 평가를 돌려 `T-17-live`를 `완료`로 바꾼다.
