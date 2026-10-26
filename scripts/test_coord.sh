#!/usr/bin/env bash
# claim/land/check 하네스 테스트. 임시 저장소와 임시 TONE_WT_ROOT만 쓴다.
set -uo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export TONE_WT_ROOT="$TMP/wt" TONE_ACCOUNT=a
mkdir "$TMP/bin" && printf '#!/bin/sh\necho "fake-uv: 7 passed"\n' > "$TMP/bin/uv" && chmod +x "$TMP/bin/uv"
export PATH="$TMP/bin:$PATH"
unset GIT_DIR GIT_WORK_TREE

assert() { if ! eval "$1"; then echo "FAIL: $2"; exit 1; fi; }

mkdir "$TMP/repo" && cd "$TMP/repo"
git init -q -b main
git config user.email t@t && git config user.name t
mkdir docs && cat > docs/tasks.md <<'MD'
# 작업 목록

지시는 ID로 한다. 상태는 `대기 / 진행 / 완료 / 보류`. | 가 들어간 설명 줄 | 도 있다.

## 단계 0. 기반

| ID | 작업 | 영역 | 선행 | 완료 기준 | 상태 |
|---|---|---|---|---|---|
| T-98 | 게이트 | 공통 | - | 기준 | 완료 |
| T-99 | 테스트 | 공통 | - | 기준 | 대기 |
| T-99a | 접두어 | 공통 | - | 기준 | 완료 |

## 단계 1. 채팅

| ID | 작업 | 영역 | 선행 | 완료 기준 | 상태 |
|---|---|---|---|---|---|
| T-97 | 다른 작업 | 앱 | T-98 | 기준 | 완료 |
MD
echo '.coord/' > .gitignore
cp -R "$SRC" scripts
git add -A && git commit -qm init
MAIN_BEFORE=$(git rev-parse main)
WT="$TONE_WT_ROOT/t99-race"

# 1) 동시 claim → 정확히 하나만 성공
scripts/claim T-99 race >/dev/null 2>&1 & p1=$!
scripts/claim T-99 race >/dev/null 2>&1 & p2=$!
wait $p1; r1=$?; wait $p2; r2=$?
assert "[ $(( r1 + r2 )) -eq 1 ] && [ $(( r1 * r2 )) -eq 0 ]" "exactly one concurrent claim exits 0, the other 1 (got $r1,$r2)"
assert "[ $(grep -c '| T-99 | claimed |' .coord/log.md) -eq 1 ]" "exactly one claimed log line"
assert "[ -f .coord/claims/T-99/owner ]" "owner file written"
assert "[ \"\$(cat .coord/claims/T-99/branch)\" = t99-race ] && [ -f .coord/claims/T-99/started ]" "branch/started files written"
assert "[ -d \"$WT\" ]" "worktree created"
out=$(scripts/claim T-99 other 2>&1); rc=$?
assert "[ $rc -eq 1 ] && echo \"\$out\" | grep -q 'taken by a'" "second claim says taken by a"

# 2) tasks.md 상태가 완료가 아니면 land 거부, main 그대로
out=$(cd "$WT" && scripts/land T-99 2>&1); rc=$?
assert "[ $rc -ne 0 ] && echo \"\$out\" | grep -q '완료'" "land must refuse when not 완료"
assert "[ \"$(git rev-parse main)\" = \"$MAIN_BEFORE\" ]" "no merge when not 완료"

# 3) 루트가 더러우면 land 거부
echo x > dirty.txt
# engine/pyproject.toml이 있으면 check가 가짜 uv를 돌려 출력(fake-uv: 7 passed)을 만든다.
(cd "$WT" && sed -i '' 's/| 대기 |/| 완료 |/' docs/tasks.md && mkdir engine && touch engine/pyproject.toml && git add engine && git commit -qam done)
out=$(cd "$WT" && scripts/land T-99 2>&1); rc=$?
assert "[ $rc -ne 0 ] && echo \"\$out\" | grep -q 'not clean'" "land must refuse when root dirty"
assert "[ \"$(git rev-parse main)\" = \"$MAIN_BEFORE\" ]" "no merge when root dirty"
assert "[ ! -d .coord/merge.lock ]" "lock released after failed land"
rm dirty.txt

# 3b) main이 앞서가면 land 거부, 합친 뒤에는 통과
echo y > other.txt && git add other.txt && git commit -qm advance
MAIN_BEFORE=$(git rev-parse main)
out=$(cd "$WT" && scripts/land T-99 2>&1); rc=$?
assert "[ $rc -ne 0 ] && echo \"\$out\" | grep -q 'main has moved'" "land must refuse when main is not an ancestor"
assert "[ \"$(git rev-parse main)\" = \"$MAIN_BEFORE\" ] && [ ! -d .coord/merge.lock ]" "no merge when main moved, lock released"
(cd "$WT" && git merge -q main -m sync)

# 3c) 잠금을 남이 쥐고 있으면 land 실패, 남의 잠금은 그대로
mkdir .coord/merge.lock
out=$(cd "$WT" && TONE_LOCK_TRIES=1 scripts/land T-99 2>&1); rc=$?
assert "[ $rc -ne 0 ] && echo \"\$out\" | grep -q 'could not get'" "land must fail when lock is held"
assert "[ \"$(git rev-parse main)\" = \"$MAIN_BEFORE\" ]" "no merge when lock is held"
assert "[ -d .coord/merge.lock ]" "foreign lock must be left alone"
rmdir .coord/merge.lock

# 4) 정상 land → 합쳐지고 claim·worktree·잠금이 사라짐
(cd "$WT" && scripts/land T-99 >/dev/null 2>&1); assert "[ \"$(git rev-parse main)\" != \"$MAIN_BEFORE\" ]" "merged"
assert "[ ! -d .coord/claims/T-99 ] && [ ! -d .coord/merge.lock ] && [ ! -d \"$WT\" ]" "cleaned up"
assert "git rev-parse -q --verify t99-race >/dev/null; [ \$? -ne 0 ]" "branch deleted"
assert "grep -q '| T-99 | landed |' .coord/log.md" "logged"
assert "git log -1 --format=%B main | grep -q 'fake-uv: 7 passed'" "merge commit body carries check output"
assert "grep -q '| T-99 | claimed |' .coord/log.md" "claim logged"

# 5) 평가 게이트: engine/prompts를 바꾸고 정밀도가 baseline보다 낮으면 check 실패
WT2=$(scripts/claim T-98 gate | tail -1)
assert "[ \"$WT2\" = \"$TONE_WT_ROOT/t98-gate\" ]" "claim prints worktree path last"
( cd "$WT2"
  git rm -q engine/pyproject.toml   # 가짜 uv는 pytest용이라 eval 게이트 테스트에서는 engine 영역을 뺀다
  mkdir -p eval engine/prompts
  printf '%s\n' "print('{\"precision\": 0.5}')" > eval/run_eval.py
  echo '{"precision": 0.9}' > eval/baseline.json
  echo p > engine/prompts/p.md
  git add -A && git commit -qm prompt )
assert "! (cd \"$WT2\" && scripts/check >/dev/null 2>&1)" "check must fail when precision < baseline"
( cd "$WT2" && echo '{"precision": 0.4}' > eval/baseline.json && git commit -qam base )
assert "(cd \"$WT2\" && scripts/check >/dev/null 2>&1)" "check must pass when precision >= baseline"

echo ALL PASS
