# Adventure_Design — tone-chat

CNU 어드벤처디자인 수업 저장소다. 이 저장소의 프로젝트는 아래 tone-chat이다.

처음 보는 사람이나 AI 에이전트는 [`AGENTS.md`](AGENTS.md)부터 읽는다(흐름·현재 상태·결정·구조도).

## tone-chat

1:1·그룹 채팅 앱(Expo)과, 보내려는 문장이 차갑게 읽힐 수 있으면 보내기 전에 나에게만 조용히 알려 주는 AI 엔진(FastAPI)이다. 수업 프로젝트다.

설계는 `ARCHITECTURE.md`, 규칙은 `CLAUDE.md`, 작업 목록은 `docs/tasks.md`에 있다.

### 폴더

| 경로 | 내용 |
|---|---|
| `apps/mobile` | Expo 앱 (iOS · Android · 웹) |
| `engine` | AI 엔진 (FastAPI, Python 3.11+) |
| `supabase/migrations` | DB 표 · RLS · 함수 (SQL) |
| `eval` | 대조 세트, 평가 스크립트 |
| `design` | HTML 목업, 대비 검사 |
| `docs` | 작업 목록, 협업 규칙, 설계 보완과 계획(`superpowers/`) |
| `scripts` | `claim`, `land`, `check` |
| `prototype/tone-harness` | 참고용 기존 프로토타입 (수정하지 않음) |

### 실행

명령은 `CLAUDE.md`의 "명령" 표를 본다. 환경 변수 이름은 `.env.example`(엔진·협업)과 `apps/mobile/.env.example`(앱)에 있고, 값은 각각 `.env`·`apps/mobile/.env`(git에 넣지 않음)에 직접 넣는다.

엔진은 Supabase JWKS로 토큰을 검증한다. JWKS가 비어 있으면(예전 HS256 프로젝트) 대시보드 Settings → JWT Keys에서 비대칭 키로 바꾼다.

### dev 웹훅 연결

DB 웹훅은 SQL 마이그레이션이 아니라 Supabase 대시보드에서 만든다. 엔진은 받는 쪽(`POST /hooks/message`)만 갖고 있다.

1. 엔진을 실행한다. `HOOK_SECRET`을 `.env`에 넣어 둔다. 값은 ASCII로, 예: `openssl rand -hex 32`(비어 있으면 모든 웹훅 요청을 401로 거절한다).
2. `cloudflared tunnel --url http://localhost:8000`으로 터널을 연다.
3. Supabase 대시보드 Database → Webhooks에서 만든다: 표 `public.messages`, 이벤트 Insert, HTTP POST `<터널 URL>/hooks/message`, 헤더 `X-Hook-Secret: <HOOK_SECRET>`.
4. 터널 URL은 실행할 때마다 바뀌므로 웹훅 URL도 고친다.

### 푸시 키 (엔진)

웹 푸시는 VAPID 키 한 쌍이 필요하다. 한 번만 만든다.

1. `npx web-push generate-vapid-keys`를 실행한다(키가 각각 한 줄로 나온다).
2. `Public Key`는 앱 `apps/mobile/.env`의 `EXPO_PUBLIC_VAPID_PUBLIC_KEY`에 넣는다.
3. `Private Key`는 엔진 `.env`의 `VAPID_PRIVATE_KEY`에 넣고, `VAPID_SUBJECT=mailto:<연락 이메일>`을 적는다. `pywebpush`는 이 한 줄 base64url 개인키를 그대로 받는다.

엔진은 공개키를 읽지 않는다(`VAPID_PUBLIC_KEY`는 없다). 키는 git에 넣지 않는다. `VAPID_PRIVATE_KEY`나 `VAPID_SUBJECT`가 비어 있으면 웹 푸시는 건너뛴다. Expo Push 보안을 켠 경우에만 `EXPO_ACCESS_TOKEN`을 넣는다.

### 배포

서버(학교 서버 또는 VM)와 Cloudflare 계정·도메인이 생기면 바로 올릴 수 있게 준비해 두었다(T-29, 서버 없이 로컬에서 확인한 것만 완료). 이미지 빌드 컨텍스트는 `engine/`이다. **프로세스는 반드시 1개**(`--workers 1`, Dockerfile CMD에 고정): 한도·큐·중복 제거·거울 키가 프로세스 메모리에 있다. 복제본도 늘리지 않는다.

**환경 변수** (값은 저장소에 없다. 서버의 env 파일, 예 `/etc/tone/engine.env`, 권한 600에만 적는다. 이미지에도 들어가지 않는다)

| 이름 | 필수 | 용도 |
|---|---|---|
| `MIRROR_SECRET` | 필수(배포) | 거울 card_id 서명 키, 32바이트 이상. 엔트리포인트가 비면 컨테이너를 띄우지 않는다(`HOOK_SECRET`·`SUPABASE_URL`·`SUPABASE_DB_URL`도 같고, `FORCE_MOCK`이 켜져 있으면 거절)(코드 자체는 개발용으로 경고만). 짧으면 엔진이 시작하지 않는다 |
| `SUPABASE_URL` | 필수 | pilot Supabase 프로젝트 URL(JWKS로 토큰 검증) |
| `SUPABASE_DB_URL` | 필수 | Postgres 접속 문자열(비밀번호 포함) |
| `HOOK_SECRET` | 필수 | `X-Hook-Secret` 웹훅 인증. 비면 모든 웹훅 401 |
| `NVIDIA_API_KEY` | 필수 | 실제 모델 호출. 없으면 `/health`에서 `nvidia:*` down, 기권 |
| `CORS_ORIGINS` | 필수 | 앱 웹 origin(쉼표 구분). 비면 `http://localhost:8081` |
| `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | 웹 푸시 쓸 때 | 비면 웹 푸시 건너뜀. 위 "푸시 키" |
| `EXPO_ACCESS_TOKEN` | 선택 | Expo Push 보안을 켠 경우만 |
| `GITHUB_TOKEN` | 선택 | `nvidia` 실패 시 폴백 `github:openai/gpt-4.1-mini` |
| `GEMINI_API_KEY` | 쓰지 않음 | 합성 문장 평가 전용. 서버에 넣지 않는다 |
| `LOCAL_API_KEY`, `USE_LOCAL_MODEL` | 선택 | 로컬 모델(HyperCLOVA X, Ollama 등). `USE_LOCAL_MODEL=1`일 때만 |
| `MODELS_PATH` | 선택 | `models.yaml` 대체 경로(기본 이미지 안 `config/models.yaml`) |
| `FORCE_MOCK` | 쓰지 않음 | 테스트·평가용. 운영에서는 비운다 |

**1. 이미지** (Docker가 있는 서버에서)

```
docker build -t tone-engine engine
docker run --rm --env-file /etc/tone/engine.env -p 127.0.0.1:8000:8000 tone-engine
scripts/deploy-smoke http://localhost:8000
```

컨테이너는 비root(uid 10001)로 돌고 `.dockerignore`가 `.env`·`.venv`·`tests`를 뺀다. 의존성은 `uv.lock` 그대로(`uv sync --locked --no-dev`).

**2. Cloudflare Tunnel** (`deploy/cloudflared/config.example.yml` 참고)

```
cloudflared tunnel login
cloudflared tunnel create tone-engine            # UUID와 ~/.cloudflared/<UUID>.json 생성
cloudflared tunnel route dns tone-engine <engine.example.com>
cp deploy/cloudflared/config.example.yml ~/.cloudflared/config.yml   # UUID·hostname 채우고 credentials-file을 ~/.cloudflared/<UUID>.json 으로 고친다(호스트 실행)
cloudflared tunnel run tone-engine
```

컨테이너로 같이 띄우려면 `ENV_FILE=/etc/tone/engine.env CLOUDFLARED_DIR=/etc/tone/cloudflared docker compose -f deploy/compose.yml up -d --build`(config의 `credentials-file`은 `/etc/cloudflared/<UUID>.json`, `service`는 `http://engine:8000`; cloudflared 컨테이너는 uid 65532로 돌므로 자격 증명 JSON이 그 사용자에게 읽혀야 한다, 예 `chown 65532 <UUID>.json && chmod 400`). 엔진 포트는 밖에 열지 않고 터널로만 나간다.

**3. 요청 본문 64 KB 제한: 엔진과 가장자리 둘 다.** 엔진은 이미 `/v1/*`·`/hooks/*`에서 64 KB 초과를 413으로 거절한다(`app/limits.py`). 그래도 Cloudflare에서 한 번 더 막는다: 엔진까지 큰 본문이 도착하는 비용(터널 대역, 업로드 대기)을 줄이고, 엔진 버그나 우회가 있어도 바깥에서 막기 위해서다. Dashboard → Security → WAF → Custom rules에서 표현식 `(http.request.body.size gt 65536)` 동작 Block. 기본 응답은 403이다: 커스텀 응답을 413으로 정하거나 403을 그대로 받아들인다(`scripts/deploy-smoke`는 https에서 엔진이 제한하지 않는 `/nope`로 70 KB를 보내 403 또는 413이면 통과). 요금제에 따라 `http.request.body.size`를 못 쓰면 엔진 제한만 남으니, 그 사실을 기록한다. 

**4. 확인과 전환**

```
scripts/deploy-smoke https://<engine.example.com>   # /health 200, nvidia:* up, 413, 401, CORS
```

그다음 pilot Supabase 프로젝트의 DB 웹훅(`public.messages` Insert → `https://<engine.example.com>/hooks/message`, 헤더 `X-Hook-Secret`)을 만들고 앱의 `EXPO_PUBLIC_ENGINE_URL`을 공개 URL로 바꾼다("dev 웹훅 연결"과 같은 순서, 터널 URL은 고정).

사람이 해야 할 것: 서버/VM, Cloudflare 계정과 도메인, pilot Supabase 프로젝트, `NVIDIA_API_KEY`.

### 협업

두 Claude 계정이 같은 맥에서 나눠 작업한다. 작업 잡기와 합치기는 `docs/COLLAB.md`를 따른다.
