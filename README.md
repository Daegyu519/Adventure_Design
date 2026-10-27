# tone-chat

1:1·그룹 채팅 앱(Expo)과, 보내려는 문장이 차갑게 읽힐 수 있으면 보내기 전에 나에게만 조용히 알려 주는 AI 엔진(FastAPI)이다. 수업 프로젝트다.

설계는 `ARCHITECTURE.md`, 규칙은 `CLAUDE.md`, 작업 목록은 `docs/tasks.md`에 있다.

## 폴더

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

## 실행

명령은 `CLAUDE.md`의 "명령" 표를 본다. 환경 변수 이름은 `.env.example`(엔진·협업)과 `apps/mobile/.env.example`(앱)에 있고, 값은 각각 `.env`·`apps/mobile/.env`(git에 넣지 않음)에 직접 넣는다.

## dev 웹훅 연결

DB 웹훅은 SQL 마이그레이션이 아니라 Supabase 대시보드에서 만든다. 엔진은 받는 쪽(`POST /hooks/message`)만 갖고 있다.

1. 엔진을 실행한다. `HOOK_SECRET`을 `.env`에 넣어 둔다. 값은 ASCII로, 예: `openssl rand -hex 32`(비어 있으면 모든 웹훅 요청을 401로 거절한다).
2. `cloudflared tunnel --url http://localhost:8000`으로 터널을 연다.
3. Supabase 대시보드 Database → Webhooks에서 만든다: 표 `public.messages`, 이벤트 Insert, HTTP POST `<터널 URL>/hooks/message`, 헤더 `X-Hook-Secret: <HOOK_SECRET>`.
4. 터널 URL은 실행할 때마다 바뀌므로 웹훅 URL도 고친다.

## 푸시 키 (엔진)

웹 푸시는 VAPID 키 한 쌍이 필요하다. 한 번만 만든다.

1. `npx web-push generate-vapid-keys`를 실행한다(키가 각각 한 줄로 나온다).
2. `Public Key`는 앱 `apps/mobile/.env`의 `EXPO_PUBLIC_VAPID_PUBLIC_KEY`에 넣는다.
3. `Private Key`는 엔진 `.env`의 `VAPID_PRIVATE_KEY`에 넣고, `VAPID_SUBJECT=mailto:<연락 이메일>`을 적는다. `pywebpush`는 이 한 줄 base64url 개인키를 그대로 받는다.

엔진은 공개키를 읽지 않는다(`VAPID_PUBLIC_KEY`는 없다). 키는 git에 넣지 않는다. `VAPID_PRIVATE_KEY`나 `VAPID_SUBJECT`가 비어 있으면 웹 푸시는 건너뛴다. Expo Push 보안을 켠 경우에만 `EXPO_ACCESS_TOKEN`을 넣는다.

## 협업

두 Claude 계정이 같은 맥에서 나눠 작업한다. 작업 잡기와 합치기는 `docs/COLLAB.md`를 따른다.
