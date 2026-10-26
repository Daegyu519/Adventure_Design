#!/usr/bin/env bash
# claim/land/check 하네스 테스트. 임시 저장소와 임시 TONE_WT_ROOT만 쓴다.
set -uo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export TONE_WT_ROOT="$TMP/wt" TONE_ACCOUNT=a
unset GIT_DIR GIT_WORK_TREE

assert() { if ! eval "$1"; then echo "FAIL: $2"; exit 1; fi; }

mkdir "$TMP/repo" && cd "$TMP/repo"
git init -q -b main
git config user.email t@t && git config user.name t
mkdir docs && printf '| ID | 작업 | 영역 | 선행 | 완료 기준 | 상태 |\n|---|---|---|---|---|---|\n| T-99 | 테스트 | 공통 | - | 기준 | 대기 |\n| T-98 | 게이트 | 공통 | - | 기준 | 완료 |\n' > docs/tasks.md
echo '.coord/' > .gitignore
cp -R "$SRC" scripts
git add -A && git commit -qm init
MAIN_BEFORE=$(git rev-parse main)
WT="$TONE_WT_ROOT/t99-race"

# 1) 동시 claim → 정확히 하나만 성공
( scripts/claim T-99 race >/dev/null 2>&1 & scripts/claim T-99 race >/dev/null 2>&1 & wait ) ; ok=$(ls .coord/claims | grep -c T-99)
assert "[ $ok -eq 1 ]" "claim must be exclusive"
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
(cd "$WT" && sed -i '' 's/| 대기 |/| 완료 |/' docs/tasks.md && git commit -qam done)
out=$(cd "$WT" && scripts/land T-99 2>&1); rc=$?
assert "[ $rc -ne 0 ] && echo \"\$out\" | grep -q 'not clean'" "land must refuse when root dirty"
assert "[ \"$(git rev-parse main)\" = \"$MAIN_BEFORE\" ]" "no merge when root dirty"
assert "[ ! -d .coord/merge.lock ]" "lock released after failed land"
rm dirty.txt

# 4) 정상 land → 합쳐지고 claim·worktree·잠금이 사라짐
(cd "$WT" && scripts/land T-99 >/dev/null 2>&1); assert "[ \"$(git rev-parse main)\" != \"$MAIN_BEFORE\" ]" "merged"
assert "[ ! -d .coord/claims/T-99 ] && [ ! -d .coord/merge.lock ] && [ ! -d \"$WT\" ]" "cleaned up"
assert "git rev-parse -q --verify t99-race >/dev/null; [ \$? -ne 0 ]" "branch deleted"
assert "grep -q '| T-99 | landed |' .coord/log.md" "logged"
assert "grep -q '| T-99 | claimed |' .coord/log.md" "claim logged"

# 5) 평가 게이트: engine/prompts를 바꾸고 정밀도가 baseline보다 낮으면 check 실패
WT2=$(scripts/claim T-98 gate | tail -1)
assert "[ \"$WT2\" = \"$TONE_WT_ROOT/t98-gate\" ]" "claim prints worktree path last"
( cd "$WT2"
  mkdir -p eval engine/prompts
  printf '%s\n' "print('{\"precision\": 0.5}')" > eval/run_eval.py
  echo '{"precision": 0.9}' > eval/baseline.json
  echo p > engine/prompts/p.md
  git add -A && git commit -qm prompt )
assert "! (cd \"$WT2\" && scripts/check >/dev/null 2>&1)" "check must fail when precision < baseline"
( cd "$WT2" && echo '{"precision": 0.4}' > eval/baseline.json && git commit -qam base )
assert "(cd \"$WT2\" && scripts/check >/dev/null 2>&1)" "check must pass when precision >= baseline"

echo ALL PASS
