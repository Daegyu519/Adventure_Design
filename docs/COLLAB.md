# 두 계정 협업

같은 맥에서 Claude 계정 두 개가 저장소 하나를 나눠 쓴다. 원격 저장소는 없다. 규칙은 이 문서 한 장과 `scripts/claim`, `scripts/land`, `scripts/check`로 끝난다.

## 두 번째 계정 켜기

한 설정 폴더에서는 로그인이 하나만 유지된다. 두 번째 계정은 설정 폴더를 따로 쓴다.

```bash
alias claude-b='CLAUDE_CONFIG_DIR=~/.claude-b claude'
export TONE_ACCOUNT=b   # B 계정 셸에서. 없으면 a로 본다.
```

`~/.claude-b`는 비어 있다. 스킬, 플러그인, MCP는 B 계정에서 따로 설치한다. 그래서 프로젝트 규칙과 진행 상황은 저장소 안(`CLAUDE.md`, `docs/`)에 둔다.

## 세션을 시작할 때 읽는 순서

1. `.coord/log.md` 끝 20줄 (`tail -20 .coord/log.md`). 누가 뭘 했는지 본다.
2. `docs/tasks.md`. 내 작업의 범위, 선행, 완료 기준을 본다.
3. 해당 계획 파일 (`docs/superpowers/plans/`).

세션이 끊겨도 이 순서로 읽으면 이어받을 수 있다.

## 작업 흐름

1. 잡기: `scripts/claim T-07 login`. 마지막 줄에 worktree 경로가 나온다. 거기로 `cd` 해서 일한다.
2. 일하기: worktree 안에서만 고친다. 브랜치 이름은 `t07-login`처럼 자동으로 붙는다.
3. 끝내기: `docs/tasks.md`의 상태를 `완료`로 바꾸고, 완료 기준을 어떻게 확인했는지 한 줄 적는다. 커밋까지 한다.
4. 합치기: worktree 안에서 `scripts/land T-07`.

이미 누가 잡은 작업이면 `T-07 taken by a`처럼 말하고 멈춘다. 다른 작업을 고른다.

### claim이 하는 일

- `.coord/claims/T-07/`을 만든다. `mkdir`이라서 동시에 잡아도 하나만 성공한다.
- 안에 `owner`(a 또는 b), `branch`, `started` 파일을 적는다.
- `main`에서 브랜치를 따서 worktree를 `~/Projects/tone-chat-wt/<브랜치>`에 만든다.
- ID에 글자가 있어도 된다. `T-03a chat-schema`는 `t03a-chat-schema`, `D-01 design`은 `d01-design`이 된다.

### land가 하는 일

아래 중 하나라도 실패하면 아무것도 합치지 않고 멈춘다.

- 작업 폴더에 커밋하지 않은 변경이 없다.
- `scripts/check` 통과. 있는 영역만 검사한다 (엔진 pytest, supabase 테스트, 앱 `tsc`).
- `engine/prompts/`나 `engine/config/models.yaml`을 바꿨으면 `eval/run_eval.py --mock --json`의 정밀도가 `eval/baseline.json`보다 낮지 않다.
- `docs/tasks.md`에서 그 ID 행의 상태가 `완료`다.
- 루트 체크아웃이 깨끗한 `main`이다.
- `.coord/merge.lock`을 잡았다. 한 번에 한 계정만 합친다. 1초마다 60번까지 기다린다.

통과하면 루트에서 `git merge --no-ff`로 합치고, claim, worktree, 브랜치, 잠금을 지운다. 로그에 `landed`를 남긴다.

잠금이 안 풀리면(프로세스가 죽었을 때) `rmdir .coord/merge.lock`으로 직접 푼다.

## 기록

`.coord/log.md`에 한 줄씩 덧붙는다. 스크립트가 `claimed`, `landed`를 알아서 적는다. 작업을 놓을 때는 직접 `released`를 적는다.

```
<ISO8601 시각> | <계정> | <TASK_ID> | <claimed|landed|released> | <브랜치> | <메모>
```

작업을 놓는 법: `.coord/claims/<ID>`를 지우고, worktree와 브랜치를 지우고(`git worktree remove`, `git branch -D`), 로그에 `released`와 이유를 적는다.

## 분담

- A = 앱, 디자인
- B = 엔진, DB, 평가

자기 영역이 비면 다른 영역 작업도 잡는다. 선행 작업은 `docs/tasks.md`의 '선행' 칸을 따른다.

## 지킬 것

- **루트 체크아웃(`~/Projects/tone-chat`)에서 직접 고치지 않는다.** 모든 작업은 `claim`으로 만든 worktree에서 하고 `land`로 합친다. (T-00만 예외였다.)
- `.coord/`는 git에 넣지 않는다. 같은 맥의 파일로 공유한다.
- 한 작업은 한 브랜치, 한 번의 `land`다. 원격이 없으니 PR은 쓰지 않는다.
- 하려다 뺀 기능은 `docs/tasks.md`에 상태 `보류`로 두고 이유를 적는다.
- 사람 팀원이 다른 컴퓨터에서 같이 쓰게 되면 그때 GitHub 비공개 저장소로 옮기고, `claim` 대신 PR을 쓴다.
