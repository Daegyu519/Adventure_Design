#!/bin/sh
# 배포 전용 가드(개발 동작은 그대로): MIRROR_SECRET이 비면 컨테이너가 뜨지 않는다.
# 엔진 자체는 비어 있어도 임의 키로 경고만 하고 뜬다(개발용). 길이(32바이트)는 엔진이 시작 때 검사한다.
if [ -z "${MIRROR_SECRET:-}" ]; then
  echo "FATAL: MIRROR_SECRET is empty. Set a 32+ byte secret (python -c \"import secrets; print(secrets.token_urlsafe(32))\") in the env file." >&2
  exit 78
fi
exec "$@"
