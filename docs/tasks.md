# 작업 목록

지시는 ID로 한다(예: "T-14 해줘"). 상태는 `대기 / 진행 / 완료 / 보류`. 영역: 앱, 엔진, DB, 평가, 배포, 공통.

- 끝나면 상태를 `완료`로 바꾸고, 완료 기준 칸 끝에 `확인:`으로 어떻게 확인했는지 한 줄 붙인다. 칸은 늘리지 않는다(`scripts/land`가 첫 칸 ID와 마지막 칸 `완료`를 본다).
- `보류`는 하려다 뺀 기능이다. 작업 칸에 이유를 적는다.

순서는 단계 0 → 5지만, 선행 작업만 끝나 있으면 영역이 다른 작업은 동시에 해도 된다. 날짜는 정하지 않는다. 우선순위(채팅 기본 → 실시간 힌트 → 살펴보기 → 털어놓기 → 거울 → 리포트) 순서로 만들고, 하다가 안 될 것 같은 기능은 그때 빼서 `보류`로 남긴다.

## 단계 0. 기반

| ID | 작업 | 영역 | 선행 | 완료 기준 | 상태 |
|---|---|---|---|---|---|
| T-00 | 협업 하네스: `docs/COLLAB.md`, `scripts/claim`·`land`·`check`, `.coord/`(git 밖) | 공통 | - | 두 계정이 같은 작업을 동시에 잡으면 하나만 성공, 루트가 더럽거나 check가 실패하면 land가 합치지 않음. 확인: `scripts/test_coord.sh` ALL PASS | 완료 |
| T-01 | 모노레포 초기화: 폴더 구조(ARCHITECTURE 2장), `.gitignore`, `README`, `.env.example`, 프로토타입을 `prototype/`에 둠. 범위 보완(그룹방, 거울, 웹 푸시, land)을 기준 문서에 반영 | 공통 | T-00 | 폴더 구조가 ARCHITECTURE와 같다. 확인: `find . -path ./prototype -prune -o -type d -print`에 최상위 폴더 apps/mobile, engine, supabase/migrations, eval, docs, design이 모두 있고 prototype/tone-harness가 있음 | 완료 |
| D-01 | 디자인 시스템 + HTML 목업 | 앱 | T-01 | MASTER.md, tokens.json 대비 검사 통과, 목업을 사용자가 승인. 확인: 대비 검사 통과(자가 검사 포함), 목업 사용자 승인 2026-10-27 | 완료 |
| P-01 | 단계 1 계획 두 개(엔진·앱) 작성, 교차 검토 반영 | 공통 | T-01 | `docs/superpowers/plans/2026-10-27-phase1-{engine,app}.md`, 교차 검토 16건 반영 확인: 계획 작성 에이전트 2 + 교차 검토 1 + 수정 1, 앱은 네이티브 개발 빌드 기준 | 완료 |
| P-02 | 단계 0 최종 검토 후속 정리 | 공통 | P-01 | 계획 수정(공감 upsert, env, 안전망 문구, T-24 규칙), claim이 .env 연결, guard 오류 문구, radius.input, T-02 수동 단계. 확인: scripts/test_coord.sh ALL PASS(.env 심볼릭 링크 검사 포함), engine pytest 80 passed(guard 오류 문구 테스트 포함), design/check_contrast.py contrast OK, apps/mobile tsc --noEmit 0 | 완료 |
| T-02 | Supabase dev 프로젝트(클라우드, 서울) 생성, Supabase CLI 연결. pilot 프로젝트는 나중에 따로 만든다(T-29에서 전환) | DB | T-01 | `supabase link`로 dev 연결. 수동 단계: `supabase db push`로 _platform 포함 모든 마이그레이션 적용, Realtime "Allow public access" 끄기, push 전에 대시보드에서 `messages`·`reactions`·`room_members`의 Realtime을 켜지 않기(_platform이 켠다), DB 웹훅은 대시보드에서 설정(README "dev 웹훅 연결", T-10 land됨) | 대기 |
| T-03a | 채팅 스키마: `profiles`, `rooms`, `room_members`, `messages`, `reactions`, `invites`, 함수(`is_member`, `create_group`, `create_invite`, `accept_invite`), RLS | DB | T-01 | PGlite RLS 테스트 통과. 확인: PGlite(node --test) 16 pass — RLS·초대·멤버 상한·메시지 제약. 동시성은 실제 Postgres에서 T-02 이후 재확인 | 완료 |
| T-03b | `tone` 스키마(API 비공개), `tone_events`, `mirror_attempts`, `push_tokens`, Realtime·Storage(`chat-images`) platform 마이그레이션 | DB | T-03a | PGlite RLS 테스트 통과. 확인: PGlite 24 pass — tone 비공개, 본인 행 전용 표, 푸시 upsert·updated_at 트리거. _platform.sql(Storage·Realtime·typing 정책)은 T-02 이후 실제 프로젝트에서 재확인 | 완료 |
| T-04 | Expo 앱 초기화: expo-router, TypeScript strict, Supabase 클라이언트, 환경 변수 | 앱 | T-01, D-01 | 웹·iOS·Android에서 빈 화면 실행. 확인: `tsc --noEmit` 0 오류, `npm run lint` 오류 0, `expo export --platform web` 성공, `expo-doctor` 20/20, 웹에서 탭 4개(대화·거울·리포트·설정) 라이트·다크 스크린샷. iOS·Android 실행은 개발 빌드가 필요해 T-28에서 확인한다(`eas.json`·`expo-dev-client`·`expo-notifications` 설정만 해 둠) | 완료 |
| T-04b | 앱 바탕: 테스트 러너, 생성 타입 자리(engine OpenAPI, db seed), 엔진 클라이언트 + mock | 앱 | T-04 | `npm test` 통과, `scripts/check`가 앱 테스트·색 리터럴 검사를 돌림. 확인: npm test 20개(시간 초과·abort가 토큰 대기까지 덮음, hint 1700·detail 9000·나머지 10000 기본값, baseUrl 공백·끝 / 정리, 빈 URL이면 mock + 개발 경고, 성공 뒤 타이머·listener 정리), scripts/check 통과(앱 tsc → lint → jest → 색 리터럴 grep: 따옴표·템플릿 hex, rgb(a)·hsl(a), __tests__ 제외 · 대비 검사 · lockfile 스탬프 npm ci · `uv run --locked`), 색 리터럴을 넣으면 check 실패, `bash scripts/test_coord.sh` ALL PASS(스탬프 테스트 추가). 생성 스크립트는 .tmp에 쓰고 성공해야 mv(실패해도 기존 파일 그대로 확인). engine.openapi.json은 ARCHITECTURE 4장 seed(엔진 T-14 land 뒤 `gen:engine:pull`), db.ts seed, T-02 대기 | 완료 |
| T-05 | 엔진 초기화: FastAPI, `settings.py`, `models.yaml` 로딩, `/health`, pytest | 엔진 | T-01 | `/health` 200, 테스트 1개 통과. 확인: uv run pytest -q 6 passed(경고 없음), /health 200 curl 확인. 컨테이너는 T-29 | 완료 |
| T-06a | 엔진 DB 접근 계층: asyncpg Repo, FakeRepo 계약 테스트, 엔진 색인·pattern_reporters 마이그레이션 | 엔진, DB | T-03b, T-05 | 같은 계약 테스트가 FakeRepo와 임시 Postgres 둘 다 통과. 확인: `cd engine && uv run pytest -q tests/test_db.py` 24 passed(fake 12 + 임시 Postgres 16 클러스터 12, postgres 없으면 12 passed 12 skipped), 엔진 전체 106 passed, `cd supabase && npm test` 24 pass | 완료 |
| T-06b | 엔진 인증: Supabase JWKS로 토큰 검증하는 의존성, 방 멤버 확인 헬퍼(room_members) | 엔진 | T-06a | 정상·만료·위조 토큰, 비참여자 403 테스트. 확인: `cd engine && uv run pytest -q tests/test_auth.py` 43 passed (정상 ES256·만료·위조 서명·aud/iss 불일치·HS256 혼동·alg none·kid 없음·필수 claim 누락·빈 JWKS 거절, role이 authenticated가 아니거나 익명 로그인이면 401, 캐시 10분·새 kid 60초 간격 재요청, 동시 요청 10개는 JWKS를 1번만 받고 실패 뒤 3초 backoff 후 재시도, 키를 못 받으면 503 `auth_unavailable`(나쁜 토큰은 401), 받기 전체 1초 제한, 비멤버 403, warm 미리 받기·실패 삼킴), 엔진 전체 185 passed(main 병합 후), 검사를 빼 보는 변조 실험으로 서명·exp·aud·iss·role·backoff·세대 공유·전체 시간 제한·503 매핑 테스트가 실패함을 확인, 로컬 HTTP 서버로 실제 httpx 가져오기 확인 | 완료 |

## 단계 1. 채팅

| ID | 작업 | 영역 | 선행 | 완료 기준 | 상태 |
|---|---|---|---|---|---|
| T-07 | 로그인 화면(이메일 OTP 또는 매직링크), 첫 로그인 시 `profiles` 생성 | 앱 | T-03a, T-04 | mock/로컬 기준: auth·gate 순수 함수 테스트 통과, 키 없이 웹에서 동의 뒤 바로 탭(로그인 화면 없음), tsc·web export 성공. 확인: jest 110개(gate 9 + auth 15 + session 19 + _layout 게이트 6 + useConsented 1 + 로그인 화면 12 + 프로필 화면 10 + 앞 작업 38), 변이 시험으로 경합·가드(getSession 경합, 로그아웃 시 행 삭제, 읽기 실패 구분, 이중 제출 막기, 빈 화면)가 실제로 깨짐 확인, tsc 0·lint 0·expo export web 성공, 키 없이 웹: 동의 뒤 바로 탭·새로고침해도 유지. 가짜 Supabase(로컬)로 웹 전 과정: 동의 → 로그인 화면(번쩍임 없음) → 잘못된 이메일·429·틀린 코드 문구 → 이메일 다시 적기 → 올바른 코드 → 이름(빈 값·21자 오류) → 탭, 새로고침해도 로그인 유지, 세션 지우고 새로고침하면 로그인 화면, 375·390px 가로 스크롤 없음. 프로필 읽기 실패(500): '프로필을 불러오지 못했어요' + 다시 불러오기(이름 입력 없음) → 복구 후 다시 불러오기로 이름 화면, 저장 직후 읽기 실패도 같은 안내 → 복구 후 탭. 실제 확인은 T-07-live | 완료 |
| T-07-live | 로그인 실제 확인: 웹과 폰에서 이메일 코드로 로그인 후 profiles 행 생성(Auth 이메일 템플릿에 {{ .Token }} 필요) | 앱 | T-02, T-07 | 웹과 폰에서 로그인 후 프로필 행 생성, 로그아웃 상태로 새로고침하면 로그인 화면 | 대기 |
| T-08 | 방 만들기·초대 화면: 초대 코드 만들기·입력, `accept_invite`로 1:1 방 생성 또는 그룹 참여, 그룹 만들기(3~8명), 관계(친구·팀원 등) 선택 | 앱, DB | T-07 | 두 계정이 초대 코드로 연결되어 1:1 방 1개 생성, 세 계정이 그룹방 하나에 참여 | 대기 |
| T-09a | 대화 목록(안 읽은 수) + 대화방 기본: 보내기, Realtime 수신, 과거 불러오기, 읽음 처리 | 앱 | T-08, T-03b | 두 기기에서 서로 보낸 메시지가 1초 안에 보임 | 대기 |
| T-09b | 답장 · 공감 · 메시지별 읽음 수 | 앱 | T-09a | 1:1·그룹에서 답장 인용, 공감 토글, 읽음 수가 줄어듦 | 대기 |
| T-09c | 입력 중(Presence) · 사진 · 멘션 | 앱 | T-09b | 두 기기에서 입력 중 표시, 사진 전송, 그룹 멘션 강조 | 대기 |
| T-09d | 방 정보(멤버, 관계, 알림 끄기, 그룹 초대) · 방 안 검색 | 앱 | T-09a | 알림 끈 방이 목록에 표시, 검색 결과에 원문 강조 | 대기 |
| T-10 | DB 웹훅 → `POST /hooks/message`, `X-Hook-Secret` 검증 | 엔진, DB | T-03a, T-05 | mock/로컬 기준: TestClient로 INSERT 수신 로그, 비밀값 틀리면 401, 다른 이벤트 무시(test_hooks.py 통과). 확인: `cd engine && uv run pytest -q tests/test_hooks.py` 17개 통과(브리프의 6개 + 비ASCII 비밀값·UPDATE/DELETE/다른 스키마 무시·422·id 범위·거절 로그 구분), 전체 `uv run pytest -q` 123개 통과; 비밀값 비교는 `hmac.compare_digest`(bytes), 설정값이 비면 항상 401, 로그에는 id·room만(본문 없음), 변이 4건(빈 비밀값 허용, str 비교, text 로깅, 무시 검사 제거)이 각각 테스트에 걸림 | 완료 |
| T-10-live | 웹훅 실제 연결: Supabase 대시보드 Webhooks(public.messages INSERT) → cloudflared 터널 → 엔진, README 절차대로 | 엔진, DB | T-02, T-10 | 실제 메시지를 보내면 엔진 로그에 수신 기록, 비밀값 틀리면 401 | 대기 |
| T-34 | 첫 실행 동의 화면: 파일럿 동의, AI 데이터 처리(하소연 원문 미저장 등 개인정보 규칙), iOS 홈 화면 추가 안내(웹 푸시는 iOS 16.4 이상) | 앱 | T-04 | 첫 실행에만 뜨고, 동의해야 로그인으로 넘어감. 확인: jest 9개(gate 3 + iosWeb 6) + consent 5 + 읽기·저장 경합 1 + 동의 화면 6, expo export web 성공, 웹에서 첫 방문에 동의 화면 → 체크 전 시작하기 비활성 → 동의 후 탭 화면, 새로고침해도 유지, localStorage consent 지우면 다시 동의 화면, 다크 모드·키보드(Tab·Space·Enter, primary 포커스 링) 확인. 로그인 게이트는 Task 4(GateState를 넓힌다) | 완료 |
| T-37 | 설정 화면: 힌트 끄기, 테마(시스템·밝게·어둡게), 계정(로그아웃) | 앱 | T-07 | 힌트를 끄면 엔진 요청이 없음, 테마가 바로 바뀌고 다시 열어도 유지 |확인: 키 없이 웹(8085)에서 테마 칩이 즉시 바뀌고 새로고침 후에도 유지, jest 통과. 힌트 스위치로 profiles.tone_hint_on 변경과 로그아웃은 T-02 대기, 힌트 끄면 엔진 요청 없음은 값을 읽는 T-15에서 | 완료 |

## 단계 2. AI 엔진 핵심 (실시간 힌트)

| ID | 작업 | 영역 | 선행 | 완료 기준 | 상태 |
|---|---|---|---|---|---|
| T-11 | 프로토타입 하네스 이전: router, providers, schemas, korean, pii, prompts, mock_rules, gate, guard | 엔진 | T-05 | 프로토타입의 해당 테스트가 `engine`에서 통과. 확인: uv run pytest -q 12 passed, 1 skipped(경고 없음) — 프로토타입 test_basic 5개 + Gemini 금지 테스트 + health 6개. 6번째(단일 신고 부스트 없음)는 judge가 T-13에서 `layers/aggregate.py`로 옮겨질 때 켜지도록 importorskip 처리(judge.py를 임시로 두면 13 passed 확인) | 완료 |
| T-12 | 전문가 인터페이스(`experts/base.py`), 레지스트리, `LLMExpert`. `models.yaml`의 `experts` 형식. `pii.mask` 입구 한 곳 + 이름 복원 | 엔진 | T-11 | 설정만 바꿔 전문가를 추가·제거할 수 있음, 전문가에는 가린 문장만 가고 응답의 이름은 복원되며 대응표가 로그·trace에 없음을 테스트로 확인. 확인: uv run pytest -q 53 passed, 1 skipped(-W error, 경고 없음, conftest가 네트워크 차단) — test_experts.py 40개 통과: 설정만으로 추가·제거(test_add_remove_expert_by_config_only), 가린 문장만 감(test_name_survives_rewrite_round_trip의 spy.seen()에 이름 없음, test_router_masks_before_third_party의 외부 공급자 안전망), 이름 복원(test_masker_tokens_and_restore, rewrite 왕복), trace에 이름 없음, pii import는 router만, 캐시는 복사본을 돌려줌(test_router_cache_returns_copies), 패턴 확장(test_pii_patterns) | 완료 |
| T-13 | 집계기: 말투 전문가 N개 가중 평균, 의견 차이, 늦은 전문가 제외, 기권, 보낸 사람 패턴 조건(`sender_patterns`, `active_from`, `global_min_obs`) | 엔진 | T-12 | 전문가 1개·2개·0개, 의견 갈림 케이스 테스트. 확인: uv run pytest -q 79 passed, skipped 0 — 전문가 1·2·0개, 의견 갈림, 알림이면 부정 셋 중 최대 읽힘, 읽힘에 Infinity·NaN이 오면 스키마 실패로 폴백, z ±1e4에서도 넘침 없음, α=0 제외, confidence 범위 밖은 [0,1]로 자르고 NaN·무한대는 0, 신고 하나(전체 1·4건)로는 L0·L3 둘 다 안 오르고 5건부터 오름 통과. `test_single_report_alone_does_not_boost`가 aggregate로 켜짐. `active_from`은 저장소 조회(T-06a·T-14)에서 거른다 | 완료 |
| T-14 | `POST /v1/hint`: 토큰 → 방 확인 → 최근 대화 8개 → 실시간 경로 → 문구 검사. OpenAPI 타입 생성 | 엔진 | T-06b, T-13 | mock으로 1.5초 안 응답, 시간 초과 시 `hint=null`. 확인: `cd engine && uv run --locked pytest -q` 290 passed(main 병합 후, T-14 새 46: test_context 8, test_hint 23, test_cors 3, 날짜·시각 가리기 예외 10, 날짜 모양 주민번호 2), mock 응답 시간 중앙값 2.0ms·최대 14.8ms(30회, 전문가까지 도는 무거운 맥락)이고 test_heavy_context_hint가 1.5초 안을 단언, 시간 초과 시 null(test_budget_timeout_returns_null: recent_messages 2초·deadline 300ms → 200, hint null, 0.6초 안), CORS 사전 요청(test_preflight_allowed_origin 200·allow-origin·authorization·content-type·POST, 다른 origin은 400에 allow-origin 없음, credentials 없음), 첫 힌트가 JWKS를 받지 않음(test_first_hint_after_startup_has_no_jwks_fetch: lifespan 뒤 fetch 1번, 첫 POST 200 뒤에도 1번), 비멤버 403·읽기 전 멤버 확인(room_id 받는 /v1/* 라우트를 모두 돌며 Repo 읽기 0회), reply_to 다른 방 422, 401·503 auth_unavailable은 그대로, 전문가로 간 문장(최근 8개 밖 답장 대상 포함)에 이름·전화번호 없음, global_min_obs 4건이면 L0 미반영·5건이면 반영, 변이 14건(멤버 확인·global_min_obs·가리기·답장 대상 가리기·HTTPException 삼킴·예산·active_from·reply_to 방·동시 읽기·credentials·예외 메시지 로그·날짜 규칙·그룹 화자·사진)이 각각 테스트에 걸림, uvicorn 8787에 토큰 없이 POST {} → 401, `npm run gen:engine:pull` 두 번 같은 결과 + 앱 tsc·lint·jest 20 통과, `scripts/check` 통과 | 완료 |
| T-15 | 앱 입력 중 힌트: 0.5초 디바운스, seq, AbortController, 입력창 위 힌트 영역, `hint_shown`·`sent_with_hint`·`sent_after_fix` 기록 | 앱 | T-09c, T-14, T-03b | 지은·민수 시나리오에서 힌트가 보낸 사람에게만 뜸 | 대기 |
| T-16 | 대조 세트 30쌍 라벨링 (같은 문장, 다른 맥락). 팀원이 각자 블라인드로 라벨 후 합의 | 평가 | - | `eval/contrast_set.jsonl` 30쌍 이상, 라벨 일치율 기록 | 대기 |
| T-17 | 평가 스크립트: 엔진 실시간·상세 경로로 정밀도·재현율·기권률·맥락 구분 계산. `scripts/check`(land)에서 mock으로 실행, `eval/baseline.json` 생성 | 평가 | T-14 | mock/로컬 기준: 프로토타입 8쌍으로 `eval/run_eval.py --mock --json`이 정밀도·재현율·기권률·맥락 구분을 내고 `eval/baseline.json`이 있음(test_eval.py 통과). 확인: `cd engine && uv run pytest -q tests/test_eval.py` 2 passed, mock 기준 정밀도 0.83·재현율 0.62·맥락 구분 4/8 | 완료 |
| T-17-live | 실제 키 평가: 사람이 라벨한 대조 세트 30쌍으로 실제 키 1회 실행, 결과표 저장, baseline 갱신 | 평가 | T-16, T-17 | 실제 키로 1회 실행한 결과표를 eval/results/에 저장하고 eval/baseline.json을 30쌍 세트로 다시 만듦 | 대기 |

## 단계 3. 앙상블과 살펴보기

| ID | 작업 | 영역 | 선행 | 완료 기준 | 상태 |
|---|---|---|---|---|---|
| T-18 | 전문가 추가: 상세 경로의 두 번째 말투 전문가(NVIDIA 다른 계열 모델, Gemini 아님), 로컬 SEED 1.5B(Ollama), 선택으로 KcELECTRA 분류기 | 엔진 | T-12 | 각 전문가가 단독으로 대조 세트를 돌릴 수 있음 | 대기 |
| T-19 | `tone.analysis_traces` 저장(문장 원문 제외) | 엔진 | T-14 | 힌트 요청마다 trace 1행. 확인: tests/test_traces.py, 힌트·상세 요청마다 trace 1행(503 포함, 401·403·422 제외), 문장 조각 없음 | 완료 |
| T-20 | 가중치 학습: trace에서 특징을 뽑아 로지스틱 회귀, 정밀도 0.8 기준값. "전문가 하나 vs 앙상블" 비교표 | 평가, 엔진 | T-17, T-17-live, T-18, T-19 | 비교표와 학습된 가중치가 `models.yaml`에 반영 | 대기 |
| T-21 | `POST /v1/detail`: 큰 맥락 전문가, 말투 전문가 여러 개, 심판, 고쳐 쓰기 + 세 가지 확인, `detail_opened` 기록. `intent`(의도 칩)는 고쳐 쓰기에만 넣음 | 엔진 | T-13 | mock으로 8초 안 응답, 응답에 내부 점수 없음, `intent`만 바꾼 재호출에서 판정 전문가는 캐시로 다시 불리지 않음. 확인: `cd engine && uv run --locked pytest -q` 359 passed(main 병합 후: T-27b·T-26·T-27a·T-07 포함, T-21 새 50: test_detail. 리뷰 수정: 기록 작업 제한 시간, 어긋남은 칩 원래 값, 번호 없는·기호 붙은 자리표시도 버림(원문에 직접 쓴 대괄호 말은 제외), 심판 관문은 반올림 전 값), mock 응답 중앙값 6.4ms·최대 61.7ms(30회, 캐시 없이 맥락·말투 2·고쳐 쓰기·후보 재판정까지), 내부 점수 없음(응답 키 8개 고정, 재귀로 float 0개), intent만 바꾼 재호출에서 판정 전문가(맥락·말투·심판)는 라우터 캐시로 다시 불리지 않음(mock에서는 후보도 같아 두 번째 호출의 모델 호출 = [rewrite]. 실제 모델은 후보가 바뀌면 후보 재판정도 다시 돎), 판정 입력에 intent 없음(심판 포함), 세 가지 확인(거절→승낙·반말·덜 부정적 아님 탈락, 괄호 빈칸 제외, checker 실패 탈락, 앞 2개만), 이름·전화번호 복원 + 되돌리지 못한 자리표시·금지어 keep/change 후보 버림, 어긋남 표 7건 + 응답 `mismatch`, 어긋남만으로도 고쳐 쓰기, 심판은 의견 갈린 기권만(자신 없는 기권은 그대로, 심판 실패도 그대로), `detail_opened`는 첫 호출만·큐 인자에 문장 없음·risk 없음, 말투 결과 없음·시간 초과·엔진 오류 503(로그는 예외 종류만), reply_to 다른 방 422, 전문가로 간 문장(심판·고쳐 쓰기·후보 재판정·답장 대상 포함)에 이름·전화번호 없음, 변이 25건 중 24건이 테스트에 걸림(남은 1건은 LLMExpert가 판정 intent를 이미 지워 동작이 같음), `npm run gen:engine:pull` 뒤 앱 타입의 `mismatch`는 선택 칸·null 허용, `scripts/check` 통과 | 완료 |
| T-22 | 살펴보기 시트: 의도 칩(단호하게/미안하게/가볍게, 어긋남 한 줄), 읽힘(자주/가끔/드물어요), 이유, A/B 문장(바뀐 어절 강조), 그대로 두기, 입력창에 적용, `option_chosen` 기록 | 앱 | T-15, T-21 | 시트에서 고른 문장이 입력창에 들어감, 칩을 바꾸면 후보 문장이 바뀜, 원문과 달라진 어절만 강조됨 | 대기 |

## 단계 4. 털어놓기, 거울, 측정

| ID | 작업 | 영역 | 선행 | 완료 기준 | 상태 |
|---|---|---|---|---|---|
| T-23 | 작업 큐: asyncio 기반, Redis로 바꿀 수 있는 인터페이스 | 엔진 | T-05 | 작업 넣기·실패 재시도 테스트. 확인: `cd engine && uv run pytest -q tests/test_queue.py` 18 passed(넣기, 두 번 실패 뒤 성공, 백오프 2배, 버릴 때 로그에 작업 이름·예외 타입만 있고 인자·메시지 없음, 끝난·재시도된 작업 인자 해제, 가득 차면 거절, 가득 찬 큐를 만난 재시도는 버려지지 않음, stop이 대기 작업을 비우고 타이머·워커를 정리, lifespan이 루프 스레드에서 실제로 작업을 돌림) | 완료 |
| T-24 | `POST /v1/feedback` → 큐 → L4 → 그룹방(3명 이상) 하소연은 `sender_patterns`(보낸 사람·관계·신호, 다음 날 0시부터 반영), 1:1 하소연은 `global_patterns`에만. `feedback_log`, 관계별 주간 상한 | 엔진 | T-03b, T-12, T-23 | 원문이 어디에도 저장되지 않음, 1:1 하소연이 `sender_patterns`에 들어가지 않음을 테스트로 확인. 확인: `cd engine && uv run --locked pytest -q -W error` 449 passed 1 skipped(검토 수정 1차 + main 병합(T-17·T-19·T-21) 후; test_feedback 41, test_db 45+1 skipped, test_queue 26), 원문 미저장(라우트가 Masker 하나로 가린 하소연·대상 메시지만 메모리 큐 인자로(두 문장에서 같은 사람은 같은 자리표시): _Job repr·DEBUG 로그·라우터 trace·캐시·fake 상태에 원문·가린 문장 없음, 모델엔 이름·전화번호 가린 문장만 / test_complaint_never_persisted_pg: public·tone·auth 모든 표 행 텍스트에 0건 / dropped_reason·L4가 trigger에 흘린 문장도 미저장, 털어놓기는 라우터 캐시 안 씀), 202는 전문가가 돌기 전에 나감, 1:1·2명 그룹방은 global_patterns에만(to_sender=True 직접 호출도 SQL·fake가 막음), 보낸 사람 패턴 count는 서로 다른 신고자 수(sender_pattern_reporters: 한 사람 ×5 → 1, 세 사람 → 3), 재신고가 켜진 패턴을 끄지 않음(활성 시각별 행), 값 검사는 SQL 앞·메시지에 값 없음, 같은 (신고자, 메시지)는 작업 하나·이미 신고했거나 주간 상한이면 큐 안 넣음·재시도 없음, 작업 안에서도 주간 상한이면 L4 안 부름, 털어놓기 전용 큐(워커 1개·대기 20개)가 꽉 차도 공유 큐(push·기준선)는 받음, 큐가 안 받거나 터져도 같은 202·로그는 예외 종류만, L4 출력은 TRIGGERS·부정 읽힘으로 먼저 거른 뒤 3개, 작업 자체 제한 시간, 정렬을 빼면 교착 테스트 3/3 실패, 변이 15건이 각각 테스트에 걸림, `cd supabase && npm test` 24 pass, `npm run gen:engine:pull` 후 `scripts/check` 통과(앱 jest 170). 한계: 털어놓기 큐는 메모리·워커 1개·대기 20개라 꽉 차면 신고가 같은 202를 받고 조용히 버려지고(재시도 없음, 사용자는 모름) 재시작하면 대기 중인 신고가 사라짐. 한 사람이 서로 다른 메시지로 몰아치면 다른 사람의 신고가 밀려날 수 있음(사용자별 한도는 T-38). 주간 상한은 워커 1개라 넘치지 않지만, 워커나 엔진 프로세스를 늘리면 동시 작업 수만큼 넘칠 수 있음 | 완료 |
| T-25 | 털어놓기 시트: 받은 메시지에만 "⋯", 안내 문구 표시 | 앱 | T-09b, T-24 | 내가 보낸 메시지에는 버튼이 없음 | 대기 |
| T-26 | 기준선 갱신: 웹훅 → 큐 → `tone.baselines`, L0에 반영 | 엔진 | T-10, T-23 | 메시지 10개 이후 기준선 이탈 신호가 동작. 같은 message_id 웹훅 두 번 → 작업 1개. 확인: `cd engine && uv run pytest -q tests/test_baseline.py` 12 passed(10개 뒤 `gate.score`에 "평소보다 짧음"·"존댓말이 갑자기 빠짐"이 나오고 9개까지는 안 나옴, 웹훅이 `baseline` 작업을 넣되 큐 인자는 message_id뿐이고 키는 `baseline:<id>`라 같은 웹훅 두 번 → 작업 1개, enqueue가 거절돼도 202, push·baseline 중 하나의 enqueue가 예외를 던져도 다른 하나는 들어가고 로그에는 예외 타입만, 사진만 있는 메시지(빈 본문·공백)와 지워진 메시지는 건너뜀, DB 호출이 멈추면 작업이 `BASELINE_DEADLINE_S`(10초) 안에 TimeoutError로 끝나 워커를 안 붙듦(읽기·쓰기 각각), 웹훅 → 작업 실행 → `tone.baselines`에 길이·존댓말·완화 표현 평균만 쌓임(본문 저장 없음), 웹훅 401·무시·422에서는 작업이 안 들어감은 `test_hooks.py`). 한계: 멱등 키는 프로세스 메모리라 재시작하면 같은 웹훅이 기준선에 한 번 더 더해질 수 있음(평균이라 영향 작음). 커밋 뒤 시간 초과 재시도도 같은 한도. `n`에 상한이 없어 평생 평균(느리면 EWMA·창으로) | 완료 |
| T-27a | 앱 리포트 화면: 알림 수, 살펴보기 수, 고친 비율, 예측 차이 추이, 주별 힌트 수 | 앱 | T-34 | mock·엔진 숫자와 화면이 같음. 확인: mock 엔진 기준 웹(390px, 라이트·다크)에서 MASTER 5장·승인 목업대로 타일 "0.8칸(10/26 주 예측과의 차이)" · "3번(이번 주 힌트)" · "33%(스스로 고친 비율)", 막대 5개(이번 주 primary, 지난 주 textMuted), 가로 스크롤 없음. jest 27개(순수 함수 17 + 화면 8 + mock 주 경계 2; KST 주 경계, 겹친 요청, 불러오기 실패·다시 시도 포함. TZ=UTC·뉴욕·서울·오클랜드에서 통과). 엔진 숫자와 `tone_events` 집계 비교는 T-02 대기 | 완료 |
| T-27b | `/v1/stats/me`(엔진): 알림 수, 살펴보기 수, 고친 비율, 주별 힌트 수, 예측 차이 추이 | 엔진 | T-14 | 이벤트·`mirror_attempts` 수와 응답 숫자가 일치. 확인: `cd engine && uv run pytest -q tests/test_stats.py` 7 passed(`hint_shown` 4·`detail_opened` 2·`sent_with_hint` 1·`sent_after_fix` 3 → 응답 4·2·3, `fix_rate` 0.75, 1/3은 0.33, 보낸 것이 없으면 0.0, `hints_by_week`는 5개·오래된 것부터·없는 주 0·마지막이 이번 주 월요일·5주 밖 이벤트는 합계에만, `predict_gap_trend`는 `predict`만 평균(1, 3 → 2.0)·기록 있는 주만, 다른 사용자 이벤트·시도는 안 셈, 토큰 없으면 401). 앱 타입 `gen:engine:pull`로 다시 생성 | 완료 |
| T-28a | 앱 등록: Android 푸시 토큰, 웹 서비스 워커 + VAPID 구독, 로그아웃 시 해제 | 앱 | T-37, T-09a | `push_tokens`에 android·web 행, 웹 테스트 푸시 표시 | 대기 |
| T-28b | 엔진 발송: 웹훅 → 방 멤버(보낸 사람·알림 끈 사람 제외)에게 Expo Push와 웹 푸시(`pywebpush`, VAPID). 웹 endpoint는 허용 호스트만, 만료 구독은 삭제 | 엔진 | T-10, T-23 | 대상 제외·묶음·실패 격리·SSRF 허용 목록·만료 삭제 테스트. 같은 message_id 웹훅 두 번 → 작업 1개. 확인: `cd engine && uv run pytest -q tests/test_push.py` 54 passed(큐 인자는 message_id뿐이고 키 `push:<id>`로 같은 웹훅 두 번 → 작업 1개, enqueue가 거절돼도 202, 워커가 DB에서 메시지를 다시 읽음, 보낸 사람·알림 끈 멤버 제외, Expo 요청 모양과 100개 묶음, 한 구독 실패가 다른 구독을 막지 않음, endpoint 허용 목록 28개 경우와 허용 안 된 endpoint는 `webpush` 미호출·토큰 유지, 허용 호스트의 리다이렉트는 안 따라감, 웹 404·410·Expo `DeviceNotRegistered`만 토큰 삭제, 로그에 본문·토큰·endpoint 없음, `Settings` repr에 비밀값 없음, 웹훅 401·무시·422에서는 작업이 안 들어감(`test_hooks.py`), 보내기 전체 제한 시간), `tests/test_queue.py` 23 passed(멱등 키: 같은 키 한 번, 키 메모리 상한, 거절된 작업은 키 안 남김). 한계: 멱등 키는 프로세스 메모리라 재시작하면 같은 웹훅이 알림을 한 번 더 보낼 수 있음 | 완료 |
| T-35 | 거울 엔진 API: `/v1/mirror/today`, `/v1/mirror/answer`, 엔진 서명 `card_id`, 상황 카드 20장(`engine/content/mirror_cards.yaml`) | 엔진 | T-03b, T-21 | mock 테스트 통과, 위조한 `card_id`는 거부, 실제 대화에서 뽑은 카드는 Gemini로 가지 않음. 확인: `tests/test_mirror.py` 47개 통과 — 위조 card_id(본문·서명 변조, 서명 없음, 다른 키, 엉터리) 422, 남의 카드 403, 남의 메시지를 가리키는 서명 403, 3일 전 카드 422; 본인 메시지 예측 답에서 spy 호출 모델이 모두 `mock:`, 이름·전화번호가 모델 입력에 없음, 거울 경로 전문가 사슬에 `gemini:` 없음 | 완료 |
| T-36 | 거울 화면 3종: 역할극, 되돌려 받기, 예측 맞히기 | 앱 | T-07, T-35 | 카드 3장을 끝까지 풀 수 있고, 점수는 차이로만 보임("예측과 한 칸 차이"), `mirror_attempts`에 기록됨 | 대기 |

## 단계 5. 파일럿과 발표

| ID | 작업 | 영역 | 선행 | 완료 기준 | 상태 |
|---|---|---|---|---|---|
| T-29 | 엔진 배포: Dockerfile, 서버(학교 서버 또는 VM), 공개 HTTPS(Cloudflare Tunnel 등), pilot Supabase로 전환 | 배포 | T-24 | 컨테이너 실행, 외부 네트워크에서 `/health` 200, 웹훅 수신 | 대기 |
| T-30 | 웹 빌드 배포(`npx expo export --platform web`, HTTPS, 웹 푸시 서비스 워커 포함), Android = EAS preview APK 배포, iOS 네이티브(TestFlight) = 선택(Apple 개발자 계정 필요) | 배포 | T-22, T-28a, T-28b | 참가자가 링크·APK로 접속, 아이폰은 홈 화면에 추가해서 실행, 배포 빌드에서 `engine.isMock === false` 확인 | 대기 |
| T-31 | 파일럿: 동의서, 10~15쌍 + 팀 그룹방 모집, 1주 운영, 이벤트 집계(알림 수 변화, 고친 비율) | 공통 | T-29, T-30 | 집계표와 발표용 그래프 | 대기 |

## 선택

| ID | 작업 | 영역 | 선행 | 완료 기준 | 상태 |
|---|---|---|---|---|---|
| T-32 | 디스코드 사용자 설치 앱: `/말투 문장`(나만 보이는 응답), 메시지 우클릭 털어놓기. 엔진 API 재사용 | 엔진 | T-21, T-24 | 디스코드 DM에서 힌트와 털어놓기 동작 | 대기 |
| T-33 | 실시간 경로 헤지 요청(빠른 모델 2개 동시, 먼저 온 답 사용) | 엔진 | T-13 | 지연 p95 비교표 | 대기 |
| T-38 | /v1/* 사용자별 요청 한도(429) | 엔진 | T-14 | 한 사용자가 분당 한도를 넘으면 429(ARCHITECTURE 4장), 다른 사용자는 영향 없음, 한도 값은 models.yaml/env | 대기 |
