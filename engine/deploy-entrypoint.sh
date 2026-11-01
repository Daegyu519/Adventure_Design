#!/bin/sh
# 배포 전용 가드(개발 동작은 그대로): 필수 비밀값이 비면, 또는 FORCE_MOCK이 켜져 있으면 컨테이너가 뜨지 않는다.
# 값은 출력하지 않는다. 엔진 자체는 비어 있어도 경고만 하고 뜬다(개발용). MIRROR_SECRET 길이(32바이트)는 엔진이 시작 때 검사한다.
set -eu
for v in MIRROR_SECRET HOOK_SECRET SUPABASE_URL SUPABASE_DB_URL; do
  eval "val=\${$v:-}"
  if [ -z "$val" ]; then
    echo "FATAL: $v is empty. Set it in the engine env file (see docs/OPERATIONS.md 배포)." >&2
    exit 78
  fi
done
case "$(printf '%s' "${FORCE_MOCK:-}" | tr 'A-Z' 'a-z')" in
  1|true) echo "FATAL: FORCE_MOCK is set; mock mode is not allowed in production." >&2; exit 78 ;;
esac
exec "$@"
