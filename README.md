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

명령은 `CLAUDE.md`의 "명령" 표를 본다. 환경 변수 이름은 `.env.example`에 있고, 값은 `.env`(git에 넣지 않음)에 직접 넣는다.

## 협업

두 Claude 계정이 같은 맥에서 나눠 작업한다. 작업 잡기와 합치기는 `docs/COLLAB.md`를 따른다.
