# 단계 0 · 기반 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 두 계정이 충돌 없이 나눠 일할 수 있는 저장소 규칙, 확정된 디자인 시스템과 목업, 테스트되는 DB 스키마, 실행되는 엔진·앱 뼈대를 만든다.

**Architecture:** 모노레포 `~/Projects/tone-chat`. `engine/`(FastAPI, 프로토타입 하네스 이전), `supabase/`(SQL 마이그레이션 + PGlite로 RLS 테스트, Docker 불필요), `apps/mobile/`(Expo + expo-router), `design/`(목업·대비 검사). 협업은 `.coord/`(git 밖) 파일 잠금 + 작업별 worktree + `scripts/land`.

**Tech Stack:** Python 3.11 + uv + FastAPI + pydantic v2 + httpx + pytest · Postgres SQL + `@electric-sql/pglite` + `node --test` · Expo(expo-router, TypeScript strict) + `@supabase/supabase-js` + `lucide-react-native` + Pretendard · bash

**Spec:** `docs/superpowers/specs/2026-10-27-tone-chat-scope-design.md` (기준 문서 `ARCHITECTURE.md`, `CLAUDE.md`, `docs/tasks.md`를 보완)

**이 계획의 범위:** 단계 0만. 채팅 기능(T-07~T-10), 힌트(T-12~T-15) 이후는 이 계획이 끝난 뒤 다음 계획에서 쓴다. T-02(Supabase 프로젝트 생성)는 사용자 작업이라 여기 없다.

## Global Constraints

- 저장소는 `~/Projects/tone-chat`. Desktop(iCloud)에 코드·node_modules·.venv를 두지 않는다.
- Task 1이 끝난 뒤에는 루트 체크아웃(`~/Projects/tone-chat`, `main`)에서 직접 고치지 않는다. 모든 작업은 `scripts/claim`으로 만든 worktree에서 하고 `scripts/land`로 합친다.
- 앱에는 모델 API 키와 Supabase service role 키를 넣지 않는다.
- 모델 이름과 키는 `engine/config/models.yaml`과 환경 변수에만 둔다.
- 실제 대화 문장이 지나가는 경로(실시간·상세·털어놓기·거울)와 그 폴백 목록에 Gemini를 넣지 않는다.
- 외부 모델로 보내는 문장(초안·최근 대화·의도·하소연)은 파이프라인 입구에서 한 번 `pii.mask`(참여자 이름 포함)를 거친 것만 쓴다. 프로토타입 `layers/judge.py`·`rewrite.py`는 이걸 빠뜨렸으니 옮길 때 고친다(보안 리뷰 지적).
- `tone` 스키마는 `anon`·`authenticated` 역할이 접근할 수 없다.
- 하소연 원문은 DB·로그·trace 어디에도 저장하지 않는다.
- 사용자에게 보이는 문구는 한국어, "~일 수도 있어요"처럼 확정하지 않는 말투.
- 카카오톡·인스타그램·디스코드의 이름·로고·색·에셋을 쓰지 않는다. 노란색·갈색 계열 금지.
- Python: 타입 힌트, pydantic v2, httpx + asyncio, pytest. TypeScript: strict.
- 서브에이전트 모델은 `sonnet` 또는 `opus`만. 각 작업 머리의 "권장 모델"을 따른다.

## Review Focus

- 두 계정이 같은 작업을 동시에 `claim` → 정확히 하나만 성공해야 한다 (Task 1 테스트).
- 루트 체크아웃이 더럽거나 `main`이 아닐 때 `land` → 아무것도 합치지 않고 거부해야 한다 (Task 1 테스트).
- 초대 코드: 만료·이미 쓴 1:1 코드·자기 초대·9번째 그룹 참여는 거부, 이미 멤버가 다시 수락하면 같은 방을 돌려주고 중복 행이 없어야 한다 (Task 6 테스트).
- 다른 방 메시지를 `reply_to`로 가리키는 insert는 거부해야 한다 (Task 6 테스트).
- 로그인한 사용자가 `tone.*`을 조회하면 권한 오류여야 한다 (Task 7 테스트).

## 작업 순서와 담당

| Task | 작업 ID | 기본 담당 | 선행 | 권장 모델 |
|---|---|---|---|---|
| 1 | T-00 협업 하네스 | A | - | sonnet |
| 2 | T-01 모노레포 + 문서 반영 | A | 1 | opus |
| 3 | D-01 디자인 시스템 + 목업 | A | 2 | opus |
| 4 | T-05 엔진 초기화 | B | 2 | sonnet |
| 5 | T-11 하네스 이전 | B | 4 | sonnet |
| 6 | T-03a 채팅 스키마 + RLS | B | 2 | opus |
| 7 | T-03b tone·이벤트·거울·푸시 스키마 | B | 6 | sonnet |
| 8 | T-04 앱 초기화 | A | 3 | sonnet |

B 계정이 아직 없으면 A가 B 작업도 잡는다. 3·4·6은 서로 독립이라 동시에 해도 된다.

---

### Task 1: T-00 협업 하네스

Task 1은 하네스를 만드는 작업이라 예외로 루트 체크아웃 `main`에서 직접 한다.

**Files:**
- Create: `scripts/claim`, `scripts/land`, `scripts/check`, `docs/COLLAB.md`, `.gitignore`
- Test: `scripts/test_coord.sh`

**Interfaces:**
- Produces:
  - `scripts/claim <TASK_ID> <slug>` → `.coord/claims/<TASK_ID>/`에 `owner`, `branch`, `started` 파일을 만들고, `main`에서 브랜치 `<id 소문자·숫자만>-<slug>`(예: `T-07 login` → `t07-login`)로 worktree `${TONE_WT_ROOT:-~/Projects/tone-chat-wt}/<branch>`를 만든 뒤 그 경로를 stdout 마지막 줄에 출력. 이미 잡혀 있으면 exit 1 + "taken by <owner>".
  - `scripts/land <TASK_ID>` → worktree 안에서 실행. `scripts/check` 통과, `docs/tasks.md`에서 그 ID 행의 상태가 `완료`인지 확인, 루트가 깨끗한 `main`인지 확인, `.coord/merge.lock` 획득 → 루트에서 `git merge --no-ff <branch>` → claim 삭제, worktree·브랜치 삭제, 잠금 해제. 하나라도 실패하면 exit 1, 아무것도 합치지 않음.
  - `scripts/check` → 존재하는 영역만 검사: `engine/pyproject.toml` 있으면 `cd engine && uv run pytest -q`; `supabase/package.json` 있으면 `cd supabase && npm test --silent`; `apps/mobile/package.json` 있으면 `cd apps/mobile && npx tsc --noEmit`; `eval/run_eval.py`가 있고 브랜치가 `main` 대비 `engine/prompts/` 또는 `engine/config/models.yaml`을 바꿨으면 `eval/run_eval.py --mock --json`의 precision이 `eval/baseline.json`보다 낮을 때 실패.
  - 계정 표시는 환경 변수 `TONE_ACCOUNT`(`a` 또는 `b`, 없으면 `a`).
  - `.coord/log.md` 한 줄 형식: `<ISO8601 시각> | <account> | <TASK_ID> | <claimed|landed|released> | <branch> | <메모>`
  - 메인 저장소 경로는 worktree 안에서도 `dirname "$(git rev-parse --path-format=absolute --git-common-dir)"`로 찾는다.

- [ ] **Step 1: 실패하는 테스트 작성** — `scripts/test_coord.sh`

임시 디렉터리에 git 저장소를 만들고(`main`, `docs/tasks.md`에 `| T-99 | 테스트 | 공통 | - | 기준 | 대기 |` 한 행), 이 저장소의 `scripts/`를 복사한 뒤 `TONE_WT_ROOT`를 임시 디렉터리로 두고 다음을 `assert` 함수(실패 시 메시지 출력 + exit 1)로 확인한다.

```bash
# 1) 동시 claim → 정확히 하나만 성공
( scripts/claim T-99 race & scripts/claim T-99 race & wait ) ; ok=$(ls .coord/claims | grep -c T-99)
assert "[ $ok -eq 1 ]" "claim must be exclusive"
assert "[ -f .coord/claims/T-99/owner ]" "owner file written"
# 2) tasks.md 상태가 완료가 아니면 land 거부, main 그대로
(cd "$WT" && ! scripts/land T-99); assert "[ \"$(git rev-parse main)\" = \"$MAIN_BEFORE\" ]" "no merge when not 완료"
# 3) 루트가 더러우면 land 거부
echo x > dirty.txt; (cd "$WT" && sed -i '' 's/| 대기 |/| 완료 |/' docs/tasks.md && git commit -qam done && ! scripts/land T-99)
assert "[ \"$(git rev-parse main)\" = \"$MAIN_BEFORE\" ]" "no merge when root dirty"; rm dirty.txt
# 4) 정상 land → 합쳐지고 claim·worktree·잠금이 사라짐
(cd "$WT" && scripts/land T-99); assert "[ \"$(git rev-parse main)\" != \"$MAIN_BEFORE\" ]" "merged"
assert "[ ! -d .coord/claims/T-99 ] && [ ! -d .coord/merge.lock ] && [ ! -d \"$WT\" ]" "cleaned up"
assert "grep -q '| T-99 | landed |' .coord/log.md" "logged"
echo ALL PASS
```

- [ ] **Step 2: 실행해서 실패 확인**

Run: `bash scripts/test_coord.sh`
Expected: FAIL (`scripts/claim: No such file or directory`)

- [ ] **Step 3: `scripts/claim`, `scripts/land`, `scripts/check` 구현**

`#!/usr/bin/env bash`, `set -euo pipefail`. macOS 기본 bash 3.2에서 돌아야 한다(연관 배열 금지). 배타성은 `mkdir`의 원자성으로만 보장한다. 잠금 획득은 `mkdir .coord/merge.lock`을 1초 간격으로 최대 60회 재시도하고, `trap`으로 종료 시 해제한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `bash scripts/test_coord.sh`
Expected: 마지막 줄 `ALL PASS`

- [ ] **Step 5: `docs/COLLAB.md`와 `.gitignore` 작성**

`docs/COLLAB.md`에 들어갈 것(스펙 9장 그대로): 두 번째 계정 실행 `alias claude-b='CLAUDE_CONFIG_DIR=~/.claude-b claude'`와 `TONE_ACCOUNT=b` 설정, 세션 시작 시 읽을 순서(`.coord/log.md` 끝 20줄 → `docs/tasks.md` → 해당 계획 파일), claim/land 사용법, 기본 분담(A=앱·디자인, B=엔진·DB·평가), "루트 체크아웃에서 직접 고치지 않는다", 뺀 기능은 tasks.md에 `보류`와 이유. `.gitignore`: `.coord/`, `node_modules/`, `.venv/`, `__pycache__/`, `.pytest_cache/`, `.env`, `.expo/`, `dist/`, `web-build/`, `.DS_Store`.

- [ ] **Step 6: Commit (루트 main에서)**

```bash
git add scripts docs/COLLAB.md .gitignore
git commit -m "T-00: add claim/land coordination for two accounts"
```

---

### Task 2: T-01 모노레포 + 문서 반영

**Files:**
- Create: `README.md`, `.env.example`, 빈 폴더 표시용 `apps/mobile/.gitkeep`, `engine/.gitkeep`, `supabase/migrations/.gitkeep`, `eval/.gitkeep`, `design/.gitkeep`
- Modify: `ARCHITECTURE.md`, `CLAUDE.md`, `docs/tasks.md`

**Interfaces:**
- Produces: ARCHITECTURE 2장 폴더 구조, 갱신된 문서. 이후 모든 작업이 이 문서를 기준으로 삼는다.

- [ ] **Step 1: claim**

Run: `scripts/claim T-01 monorepo` → 출력된 worktree로 이동.

- [ ] **Step 2: 폴더와 `.env.example`, `README.md` 작성**

`.env.example`은 ARCHITECTURE 8장 변수 전부 + `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`(웹 푸시), `TONE_ACCOUNT`. 값은 비워 둔다. `README.md`는 한 화면 분량: 무엇인지 한 줄, 폴더 표, 명령은 `CLAUDE.md` 명령 표를 가리킴, 협업은 `docs/COLLAB.md`를 가리킴.

- [ ] **Step 3: `ARCHITECTURE.md`에 스펙 변경분 반영**

스펙 4장(그룹방: `rooms.kind/title`, `room_members`, `reactions`, `messages.reply_to/image_path/mentions`, `invites.room_id/max_uses`, Storage, `is_member`, Presence), 4장 하소연 반영 규칙(`tone.sender_patterns`), 5장(거울 API 두 개, `mirror_attempts`, 의도 칩 어긋남 표, 칩 재호출은 캐시), 8장(Gemini 제외, 웹 푸시, Supabase 클라우드 서울 + dev 웹훅 cloudflared, 저장소 위치)을 해당 장에 녹인다. `models.yaml` 예시에서 `tone_gem`과 Gemini 폴백을 지우고 상세 경로 두 번째 말투 전문가를 `nvidia:<다른 계열 모델>` 자리표시로 바꾼다. 6-4 라우터 절에 "pii.mask는 파이프라인 입구에서 한 번, 모든 레이어는 가린 문장만 받는다"를 명시한다. 10장 결정 표에 "그룹방 도입", "Gemini 실제 문장 금지", "PR 대신 land" 행을 추가한다.

- [ ] **Step 4: `CLAUDE.md` 갱신**

"한 작업 = 한 브랜치 = 한 PR" → "한 작업 = 한 브랜치(worktree) = 한 번의 `scripts/land`. 사용법은 `docs/COLLAB.md`". "어기면 안 되는 규칙"에 스펙 10장 4개 추가(사진은 모델에 안 보냄, 거울 카드도 Gemini 금지, 1:1 하소연은 보낸 사람 패턴에 안 넣음, 타 메신저 이름·로고·색·에셋 금지)와 "외부 모델로 가는 문장은 파이프라인 입구에서 한 번 pii.mask". 프롬프트·모델·가중치 PR 규칙은 "`land`가 평가 게이트를 돌린다"로 바꾼다. 명령 표에 `DB 테스트 | (T-03a)` 행 추가.

- [ ] **Step 5: `docs/tasks.md` 갱신**

상태 값에 `보류` 추가. 행 추가: `T-00`(완료, Task 1 결과), `D-01 디자인 시스템 + HTML 목업 | 앱 | T-01 | MASTER.md, tokens.json 대비 검사 통과, 목업을 사용자가 승인 | 대기`, `T-34 첫 실행 동의 화면(파일럿 동의, AI 데이터 처리, iOS 홈 화면 추가 안내)`, `T-35 거울 엔진 API + 상황 카드 20장`, `T-36 거울 화면 3종`. 기존 행 수정: T-03을 `T-03a`(채팅 스키마)·`T-03b`(tone·이벤트·거울·푸시) 둘로 나누고 완료 기준을 "PGlite RLS 테스트 통과"로, T-05 완료 기준에서 "컨테이너 실행"을 T-29로 옮김(로컬 Docker 없음), T-08·T-09·T-21·T-22·T-24·T-27·T-28·T-30을 스펙 13장대로 고침. 이 행(T-01)의 상태를 `완료`로 바꾸고 확인 방법 한 줄.

- [ ] **Step 6: 확인 후 land**

Run: `find . -path ./prototype -prune -o -type d -print | sort` 결과가 ARCHITECTURE 2장 최상위 폴더(apps/mobile, engine, supabase/migrations, eval, docs, prototype)를 모두 포함하는지 확인.
Commit: `git add -A && git commit -m "T-01: monorepo layout and docs updated for scope addendum"`
Run: `scripts/land T-01`
Expected: `landed`

---

### Task 3: D-01 디자인 시스템 + 목업

**Files:**
- Create: `design-system/tone-chat/MASTER.md`, `apps/mobile/lib/tokens.json`, `design/check_contrast.py`, `design/mockups/index.html`
- Test: `design/check_contrast.py` (자체 assert)

**Interfaces:**
- Produces: `apps/mobile/lib/tokens.json` — `{"light": {...}, "dark": {...}, "radius": {...}, "space": [...], "font": {...}}`. 색 키(두 모드 동일): `primary, onPrimary, bubbleOther, onBubbleOther, background, surface, text, textMuted, border, hintBg, hintText, mirror, onMirror, danger`. `radius`: `{bubble: 18, sheet: 20, chip: 999, card: 16}`. `space`: `[4,8,12,16,20,24,32]`. `font`: `{family: "Pretendard", body: 16, lineHeight: 1.5, small: 13, title: 20}`. Task 8이 이 파일을 그대로 import한다.

- [ ] **Step 1: claim** — `scripts/claim D-01 design`

- [ ] **Step 2: ui-ux-pro-max로 MASTER 생성**

Run:
```bash
python3 "$HOME/.claude/plugins/cache/ui-ux-pro-max-skill/ui-ux-pro-max/2.11.0/.claude/skills/ui-ux-pro-max/scripts/search.py" "chat messaging app minimal micro-interactions calm" --design-system --persist -p "tone-chat" --output-dir . --variance 3 --motion 3 --density 5
```
그다음 `MASTER.md`를 스펙 7장 결정으로 고친다: 글꼴은 Pretendard, 색은 스펙 7장 표, 랜딩 패턴·Exaggerated Minimalism·Lora/Raleway·GSAP 부분 삭제, 말풍선 꼬리 없음, 힌트 모양·움직임 규칙 추가. 도구 원본 추천에서 무엇을 왜 버렸는지 맨 아래 한 단락.

- [ ] **Step 3: 실패하는 대비 검사 작성** — `design/check_contrast.py`

WCAG 상대 휘도 공식으로 대비비를 계산하고, 두 모드 각각 다음 쌍을 assert 한다: `(text, background) ≥ 4.5`, `(textMuted, background) ≥ 4.5`, `(onPrimary, primary) ≥ 4.5`, `(onBubbleOther, bubbleOther) ≥ 4.5`, `(hintText, hintBg) ≥ 4.5`, `(onMirror, mirror) ≥ 4.5`, `(danger, background) ≥ 4.5`. 또 노란·갈색 금지: 모든 색 중 HSL 색상각 35°~65°이면서 채도 > 0.5인 것이 없어야 한다(`hintBg`처럼 명도 > 0.9인 아주 옅은 배경은 제외). 표준 라이브러리만 쓴다. 통과하면 `contrast OK` 출력.

Run: `python3 design/check_contrast.py` → Expected: FAIL (`tokens.json` 없음)

- [ ] **Step 4: `tokens.json` 작성 → 검사 통과까지 값 보정**

시작 값은 스펙 7장 표. `onBubbleOther`=`text`, `onMirror`는 라이트 `#FFFFFF`/다크 `#1E1B2E`, `border`는 라이트 `#E2E8E6`/다크 `#26332F`. 통과하지 못하는 쌍은 명도만 조정한다(색상각 유지).
Run: `python3 design/check_contrast.py` → Expected: `contrast OK`

- [ ] **Step 5: HTML 목업 작성** — `design/mockups/index.html`

한 파일, 외부 의존은 Pretendard 웹폰트 CDN(`cdn.jsdelivr.net/gh/orioncactus/pretendard`)과 인라인 Lucide SVG만. 상단 라이트/다크 토글. 폰 프레임(390×844) 6개를 가로로 나열, 좁은 화면에서는 세로로 쌓임: ① 대화 목록(1:1·그룹 섞임, 안 읽은 수) ② 대화방 + 입력창 위 힌트("차갑게 느껴질 수도 있어요 · 살펴보기 ›", 답장 인용·공감·읽음 숫자·입력 중 표시 포함) ③ 살펴보기 시트(의도 칩 3개, 읽힘 자주/가끔/드물어요, 이유 2줄, A/B 후보에서 바뀐 어절 강조, "그대로 보낼게요", "입력창에 적용") ④ 털어놓기 시트(받은 메시지 인용 + 입력 + 안내 문구) ⑤ 거울 카드(예측 맞히기: 1~5칸 선택 → 결과 "예측과 한 칸 차이") ⑥ 리포트(세 숫자 + 주별 막대). 문구는 스펙·기획서 예시(민수·지은, "안 돼요. 다들 맞춰서 하는 중이에요.")를 쓴다. 색은 `tokens.json` 값과 같은 CSS 변수.

- [ ] **Step 6: 사용자 검토용으로 게시**

`artifact-design` 스킬을 먼저 불러 규칙을 확인하고, Artifact 도구로 `design/mockups/index.html`을 게시한 뒤 링크를 사용자에게 준다. 사용자 피드백을 반영해 Step 4~5를 반복한다. **사용자가 승인해야 이 작업이 완료된다.**

- [ ] **Step 7: 완료 처리 후 land**

`docs/tasks.md`의 D-01 상태 `완료` + "대비 검사 통과, 목업 승인(날짜)". Commit → `scripts/land D-01`.

---

### Task 4: T-05 엔진 초기화

**Files:**
- Create: `engine/pyproject.toml`, `engine/app/__init__.py`, `engine/app/settings.py`, `engine/app/main.py`, `engine/config/models.yaml`(Task 5에서 교체, 여기서는 최소 `providers`·`roles`)
- Test: `engine/tests/test_health.py`

**Interfaces:**
- Produces:
  - `app.settings.Settings` (frozen dataclass) + `Settings.from_env() -> Settings`. 필드: `supabase_url: str`, `supabase_service_role_key: str`, `supabase_db_url: str`, `hook_secret: str`, `force_mock: bool`(env `FORCE_MOCK` in `{"1","true"}`), `models_path: Path`(기본 `engine/config/models.yaml`). 빈 값 허용(키가 없어도 서버는 뜬다).
  - `app.main.app: FastAPI`, `app.main.model_status(cfg: dict, env: Mapping[str, str]) -> dict[str, str]` — `cfg["roles"]`의 모든 `provider:model` 항목을 키로, 공급자가 `mock`이거나 `allow_no_key`이거나 `api_key_env`가 env에 있으면 `"up"`, 아니면 `"down"`.
  - `GET /health` → `{"ok": true, "models": model_status(...)}`

- [ ] **Step 1: claim** — `scripts/claim T-05 engine-init`

- [ ] **Step 2: 실패하는 테스트 작성** — `engine/tests/test_health.py`

```python
def test_health_ok_without_any_keys(monkeypatch):
    for k in ("NVIDIA_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    r = TestClient(app).get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["models"]["mock:context"] == "up"
    assert all(v == "down" for k, v in body["models"].items() if k.startswith("nvidia:"))

def test_model_status_up_when_key_present():
    cfg = {"providers": {"nvidia": {"api_key_env": "NVIDIA_API_KEY"}, "mock": {}},
           "roles": {"x": ["nvidia:m1", "mock:context"]}}
    assert model_status(cfg, {"NVIDIA_API_KEY": "k"}) == {"nvidia:m1": "up", "mock:context": "up"}
```

- [ ] **Step 3: 실패 확인**

Run: `cd engine && uv run pytest -q tests/test_health.py`
Expected: FAIL (`ModuleNotFoundError: app.main`)

- [ ] **Step 4: 구현**

`pyproject.toml`: `requires-python = ">=3.11"`, 의존성 `fastapi>=0.115`, `uvicorn[standard]>=0.30`, `pydantic>=2.6`, `pyyaml>=6.0`, `httpx>=0.27`; dev 그룹 `pytest>=8.0`; `[tool.pytest.ini_options] pythonpath = ["."]`. `uv sync`로 `engine/.venv` 생성. `models.yaml` 최소본은 `providers: {nvidia: {...}, mock: {}}`, `roles: {context_fast: [nvidia:deepseek-ai/deepseek-v4.1-flash, mock:context]}`.

- [ ] **Step 5: 통과 확인 + 실제 실행**

Run: `cd engine && uv run pytest -q` → Expected: `2 passed`
Run: `cd engine && (uv run uvicorn app.main:app --port 8787 & echo $! > /tmp/tone-engine.pid); sleep 3; curl -s localhost:8787/health; kill "$(cat /tmp/tone-engine.pid)"`
Expected: `{"ok":true,...}`

- [ ] **Step 6: 완료 처리 후 land**

`CLAUDE.md` 명령 표: 엔진 실행 `cd engine && uv run uvicorn app.main:app --reload --env-file ../.env`, 엔진 테스트 `cd engine && uv run pytest -q`. tasks.md T-05 `완료` + 확인 한 줄. Commit → `scripts/land T-05`.

---

### Task 5: T-11 프로토타입 하네스 이전

**Files:**
- Create (복사 후 수정): `engine/harness/{__init__,router,providers,schemas,korean,pii,prompts,mock_rules,store}.py`, `engine/layers/{__init__,gate,guard}.py`(`guard.py` = 프로토타입 `layers/hint.py`), `engine/prompts/*.md`, `engine/config/models.yaml`(프로토타입 것으로 교체)
- Test: `engine/tests/test_harness.py`

**Interfaces:**
- Consumes: Task 4의 `engine/` 패키지 구조(`pythonpath = ["."]`).
- Produces: 프로토타입과 같은 공개 이름 — `harness.router.Router.from_file(path=..., force_mock: bool)`, `Router.call(role, system, user, payload, schema, deadline) -> (obj, model)`, `harness.router.NoResult`, `harness.pii.mask(text, names=None)`, `harness.schemas.*`, `layers.gate.score(draft, convo, store, user_id, threshold) -> GateResult`, `layers.guard.guard(text) -> str`, `layers.guard.render_hint(v) -> Hint | None`, `layers.guard.render_detail(...)`. `harness.store.ProfileStore`는 메모리 전용으로 남긴다(`# ponytail: 메모리 저장소, T-24/T-26에서 tone 스키마로 교체`). 프로토타입의 `judge`·`rewrite`·`context`·`tone`·`feedback` 레이어는 이 작업에서 옮기지 않는다(T-12/T-13/T-21/T-24에서 전문가 인터페이스로 감싸며 옮김).

- [ ] **Step 1: claim** — `scripts/claim T-11 harness-port`

- [ ] **Step 2: 테스트 이전**

`prototype/tone-harness/tests/test_basic.py`의 6개 테스트를 `engine/tests/test_harness.py`로 복사하고 `from layers import gate, hint` → `from layers import gate, guard`, `hint.guard` → `guard.guard`로 바꾼다. 테스트 하나 추가:

```python
def test_no_gemini_on_real_text_roles():
    cfg = yaml.safe_load((ROOT / "config" / "models.yaml").read_text(encoding="utf-8"))
    for role, chain in cfg["roles"].items():
        assert not any(e.startswith("gemini:") for e in chain), role
```

- [ ] **Step 3: 실패 확인** — `cd engine && uv run pytest -q tests/test_harness.py` → FAIL (`No module named 'harness'`)

- [ ] **Step 4: 코드 복사·수정**

`prototype/`은 고치지 않는다(복사만). 바꿀 것: `layers/hint.py` → `layers/guard.py` 이름 변경과 import 수정, `models.yaml`의 모든 `roles`에서 `gemini:` 항목 삭제(공급자 정의는 합성 문장 평가용으로 남기고 주석으로 이유), `local.base_url`을 `http://localhost:11434/v1`(Ollama)로. `harness/router.py`의 `ROOT`, `harness/prompts.py`의 `DIR`은 `engine/` 기준으로 그대로 동작한다.

- [ ] **Step 5: 통과 확인** — `cd engine && uv run pytest -q` → Expected: `9 passed` (health 2 + 하네스 7)

- [ ] **Step 6: 완료 처리 후 land** — tasks.md T-11 `완료` + "프로토타입 test_basic 6개 + Gemini 금지 테스트 통과". Commit → `scripts/land T-11`.

---

### Task 6: T-03a 채팅 스키마 + RLS

**Files:**
- Create: `supabase/package.json`, `supabase/migrations/20261027000001_chat.sql`, `supabase/tests/shim.sql`, `supabase/tests/helpers.mjs`, `supabase/tests/chat_rls.test.mjs`

**Interfaces:**
- Produces (SQL, 이후 앱·엔진이 씀):
  - `public.profiles(id uuid pk → auth.users, name text 1~20자, tone_hint_on bool default true, created_at)`
  - `public.rooms(id uuid pk default gen_random_uuid(), kind text in ('direct','group'), title text null(그룹만), relation text in ('친구','팀원','선후배','기타'), created_by uuid, created_at)`
  - `public.room_members(room_id, user_id, joined_at, last_read_at timestamptz null, muted bool default false, pk(room_id,user_id))` — `authenticated`에는 `update(last_read_at, muted)` 칼럼 권한만
  - `public.messages(id bigint generated always as identity pk, room_id, sender_id, text text ≤2000자, image_path text null, reply_to bigint null, mentions uuid[] default '{}', created_at)`, 체크 `text <> '' or image_path is not null`. 수정·삭제 권한 없음
  - `public.reactions(message_id bigint, user_id uuid, emoji text in ('👍','❤️','😂','😮','😢','🙏'), created_at, pk(message_id,user_id))`
  - `public.invites(code text pk, inviter_id, room_id uuid null, relation text, max_uses int, uses int default 0, expires_at)`
  - 함수(모두 `security definer`, `set search_path = public`): `is_member(room uuid) returns boolean`, `create_group(title text, relation text) returns uuid`, `create_invite(room uuid default null, relation text default '친구') returns text`(6자리 대문자+숫자, 72시간, 1:1은 `max_uses=1`, 그룹은 `7`, 그룹 초대는 멤버만), `accept_invite(code text) returns uuid`
- 테스트 도구: `helpers.mjs`의 `async function freshDb() -> PGlite`(shim + `migrations/*.sql` 중 이름에 `_platform`이 없는 파일을 이름순 실행), `async function as(db, userId, sql, params?)`(트랜잭션 안에서 `set local role authenticated; set local request.jwt.claim.sub = '<uuid>'` 후 실행, `userId`가 `'service'`면 `service_role`), `async function newUser(db, name) -> uuid`(auth.users + profiles 행 생성).

- [ ] **Step 1: claim** — `scripts/claim T-03a chat-schema`

- [ ] **Step 2: 테스트 도구 작성**

`package.json`: `"type": "module"`, `"scripts": {"test": "node --test tests/"}`, devDependency `@electric-sql/pglite`(설치 시점 최신). `shim.sql`은 Supabase가 제공하는 것을 흉내 낸다: `create schema auth; create table auth.users(id uuid primary key);`, `auth.uid()`(= `nullif(current_setting('request.jwt.claim.sub', true), '')::uuid`), 역할 `anon`, `authenticated`, `service_role`(`nologin`), `grant usage on schema public to anon, authenticated, service_role`, `alter default privileges in schema public grant all on tables to anon, authenticated, service_role`, 같은 내용을 functions·sequences에도.

PGlite에서 `set role`로 RLS가 적용되지 않으면(슈퍼유저 우회) 대안: `brew install postgresql@16`으로 임시 클러스터(`initdb` → `pg_ctl -o "-p 54329"`)를 띄우고 `pg` 클라이언트로 같은 테스트를 돌린다. 어느 쪽인지 tasks.md 확인 한 줄에 적는다.

- [ ] **Step 3: 실패하는 테스트 작성** — `chat_rls.test.mjs`

```js
test('non-member sees no messages', ...)             // A·B 1:1 방, C로 select → 0행
test('cannot insert as someone else', ...)            // sender_id = B로 A가 insert → 에러
test('non-member cannot insert', ...)                 // C가 A·B 방에 insert → 에러
test('reply_to must be in same room', ...)            // 방1 메시지를 방2에서 reply_to → 에러
test('messages cannot be updated or deleted', ...)    // 작성자 본인 update/delete → 0행 또는 에러, 내용 그대로
test('direct invite: accept creates room with both', ...) // 멤버 2명, kind='direct', relation 유지
test('direct invite cannot be reused or self-accepted', ...)
test('expired invite rejected', ...)                  // service 역할로 expires_at을 과거로 → 에러
test('re-accepting returns same room, no duplicates', ...)
test('group: 9th member rejected', ...)               // create_group + 초대로 8명까지 OK, 9번째 에러
test('reactions: one per user, members only, own only', ...)
test('room_members: can update own last_read_at/muted only', ...) // 남의 행 update → 0행, joined_at update → 에러
test('profiles visible to self and co-members only', ...)
```
각 테스트는 `freshDb()`로 시작하고 assert는 `node:assert/strict`.

Run: `cd supabase && npm install && npm test` → Expected: FAIL (마이그레이션 없음)

- [ ] **Step 4: 마이그레이션 작성** — `20261027000001_chat.sql`

Interfaces 블록의 표·함수·RLS를 만든다. `reply_to` 같은 방 검사는 `before insert` 트리거(security definer 함수). `accept_invite`는 `for update`로 초대 행을 잠가 동시 수락에도 `uses`가 넘지 않게 한다. 1:1 수락 시 두 사람 사이에 이미 direct 방이 있으면 그 방을 돌려준다.

- [ ] **Step 5: 통과 확인** — `cd supabase && npm test` → Expected: 13 pass, 0 fail

- [ ] **Step 6: 완료 처리 후 land** — `CLAUDE.md` 명령 표: `DB 테스트 | cd supabase && npm test`. tasks.md T-03a `완료` + 확인 한 줄. Commit → `scripts/land T-03a`.

---

### Task 7: T-03b tone · 이벤트 · 거울 · 푸시 스키마

**Files:**
- Create: `supabase/migrations/20261027000002_tone.sql`, `supabase/migrations/20261027000003_platform.sql`, `supabase/tests/tone_rls.test.mjs`

**Interfaces:**
- Consumes: Task 6의 `is_member`, `helpers.mjs`.
- Produces:
  - `public.push_tokens(user_id, token text, platform text in ('ios','android','web'), updated_at, pk(user_id, token))` — 본인만. `web`이면 token은 웹 푸시 구독 JSON 문자열
  - `public.tone_events(id bigint identity pk, room_id, user_id, kind text in ('hint_shown','detail_opened','option_chosen','sent_with_hint','sent_after_fix'), risk real, top_reading text, signals jsonb, choice text in ('A','B','original') null, created_at)` — 본인 행 insert(방 멤버일 때)·select만
  - `public.mirror_attempts(id bigint identity pk, user_id, kind text in ('roleplay','receive','predict'), card_ref text, answer_score smallint null check 1~5, predicted smallint null check 1~5, panel_bin smallint null check 1~5, gap smallint null check 0~4, created_at)` — 본인만. 문장 원문 칸 없음
  - `tone` 스키마: `feedback_log`, `sender_patterns`(pk(sender_id, relation, trigger), `active_from timestamptz`), `global_patterns`, `baselines`, `analysis_traces` — 칸은 ARCHITECTURE 5장 + 스펙 4장. `anon`·`authenticated`는 스키마 사용 권한 없음, `service_role`만 전체 권한. 하소연 원문 칸 없음
  - `_platform.sql`(실제 Supabase에서만 실행, 테스트 제외): `alter publication supabase_realtime add table public.messages, public.reactions, public.room_members;`, Storage 버킷 `chat-images`(비공개) + `storage.objects` 정책(`bucket_id = 'chat-images' and is_member(((storage.foldername(name))[1])::uuid)`)

- [ ] **Step 1: claim** — `scripts/claim T-03b tone-schema`

- [ ] **Step 2: 실패하는 테스트 작성** — `tone_rls.test.mjs`

```js
test('authenticated cannot read tone schema', ...)      // as(A, 'select * from tone.baselines') → /permission denied/
test('service_role can write tone tables', ...)         // as('service', insert sender_patterns) OK
test('tone_events: own insert only, member room only', ...)
test('mirror_attempts: own rows only, gap range enforced', ...) // gap=5 → 에러
test('push_tokens: own rows only, platform web accepted', ...)
test('no column stores raw complaint text', ...)        // information_schema.columns의 tone.feedback_log 칸 목록 == ['id','room_id','reporter_id','message_id','usable','pattern_count','created_at']
```

Run: `cd supabase && npm test` → Expected: 새 테스트 FAIL

- [ ] **Step 3: 마이그레이션 작성** — `_tone.sql`, `_platform.sql`

- [ ] **Step 4: 통과 확인** — `cd supabase && npm test` → Expected: 19 pass

- [ ] **Step 5: 완료 처리 후 land** — tasks.md T-03b `완료`. Commit → `scripts/land T-03b`.

---

### Task 8: T-04 Expo 앱 초기화

**Files:**
- Create: `apps/mobile/` (create-expo-app 결과), `apps/mobile/lib/supabase.ts`, `apps/mobile/lib/theme.ts`, `apps/mobile/app/_layout.tsx`, `apps/mobile/app/(tabs)/_layout.tsx`, `apps/mobile/app/(tabs)/{index,mirror,report,settings}.tsx`, `apps/mobile/assets/fonts/Pretendard-{Regular,Medium,SemiBold,Bold}.otf`
- Modify: `apps/mobile/tsconfig.json`(`"strict": true`)

**Interfaces:**
- Consumes: Task 3의 `apps/mobile/lib/tokens.json`.
- Produces:
  - `lib/theme.ts`: `type Colors = typeof tokens.light`, `useTheme(): { colors: Colors; radius; space; font }` — `useColorScheme()`로 라이트/다크 선택
  - `lib/supabase.ts`: `export const supabase: SupabaseClient | null` — `EXPO_PUBLIC_SUPABASE_URL`·`EXPO_PUBLIC_SUPABASE_ANON_KEY`가 없으면 `null`(`// ponytail: 키 없이 화면 작업용, T-07에서 필수로 바꿈`). 네이티브에서는 AsyncStorage로 세션 저장
  - 하단 탭 4개: `index`=대화, `mirror`=거울, `report`=리포트, `settings`=설정. 각 화면은 제목만. 아이콘은 Lucide(대화·거울·막대 차트·톱니 의미의 아이콘), 탭 색은 `colors.primary`/`colors.textMuted`

- [ ] **Step 1: claim** — `scripts/claim T-04 app-init`

- [ ] **Step 2: 앱 생성**

Run: `cd apps && rm -f mobile/.gitkeep && rmdir mobile && npx create-expo-app@latest mobile --template default --yes && cd mobile && npm run reset-project` (예제 폴더를 지우는 질문에는 삭제를 고른다). Task 3이 먼저 land됐다면 `lib/tokens.json`을 생성 후 다시 둔다(`git checkout main -- apps/mobile/lib/tokens.json`). 그다음 `npx expo install @supabase/supabase-js @react-native-async-storage/async-storage expo-font react-native-svg lucide-react-native`.

- [ ] **Step 3: 글꼴·테마·탭·Supabase 클라이언트 작성**

Pretendard OTF 4개는 공식 저장소(orioncactus/pretendard, OFL) 릴리스에서 받고 라이선스 파일을 `assets/fonts/OFL.txt`로 함께 둔다. `app/_layout.tsx`에서 `useFonts`로 불러오고 로딩 중에는 스플래시를 유지한다.

- [ ] **Step 4: 확인**

Run: `cd apps/mobile && npx tsc --noEmit` → Expected: 오류 0
Run: `cd apps/mobile && npx expo export --platform web` → Expected: `dist/` 생성, 오류 0
`run` 스킬로 웹을 띄워 탭 4개와 다크 모드 전환을 스크린샷으로 확인한다.

- [ ] **Step 5: 완료 처리 후 land** — `CLAUDE.md` 명령 표: 앱 실행 `cd apps/mobile && npx expo start`. tasks.md T-04 `완료` + "tsc 0, 웹 export 성공, 탭 4개 스크린샷". Commit → `scripts/land T-04`.

---

## 단계 0이 끝나면

- 다음 계획: 단계 1 채팅(T-07 로그인, T-08 초대·그룹, T-09 대화방 + 기본기, T-10 웹훅) — Supabase dev 프로젝트(T-02, 사용자) 키가 필요하다. 키가 없으면 엔진 쪽 단계 2(T-12 전문가 인터페이스 — 여기서 `pii.mask`를 파이프라인 입구 한 곳으로 모은다, T-13 집계기, T-14 `/v1/hint` mock)를 먼저 한다.
- 각 계정은 자기 영역의 다음 계획을 `docs/superpowers/plans/`에 쓰고 `.coord/log.md`에 남긴다.
