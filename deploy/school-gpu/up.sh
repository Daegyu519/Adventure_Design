#!/usr/bin/env bash
# 서버에서 돌리는 스크립트. 서버에 복사하지 않고 stdin으로 보낸다:
#   ssh tone-gpu 'bash -s -- llm|engine|funnel|all|status|stop' < deploy/school-gpu/up.sh
# 멱등. 비밀값은 출력하지 않는다. 다른 사람의 프로세스·디렉터리(/root/alphaforge 등)는 건드리지 않는다.
set -euo pipefail
BASE=/root/tone-chat-deploy; LLM=/root/tone-chat-llm
PORT=11434; ENGINE_PORT=8000
TS="$BASE/tailscale_1.104.4_amd64"; SOCK="$BASE/tailscaled.sock"
MODEL_ID=naver-hyperclovax/HyperCLOVAX-SEED-Text-Instruct-1.5B   # models.yaml tone_hcx의 local: 뒤 이름과 같아야 한다
has() { tmux has-session -t "$1" 2>/dev/null; }
ts() { "$TS/tailscale" --socket="$SOCK" "$@"; }
logged_in() { ts status --json 2>/dev/null | grep -q '"BackendState": "Running"'; }
funnel_url() { ts funnel status 2>/dev/null | grep -o 'https://[^ ]*' | head -1 || true; }

llm() {
  has tone-llm && return 0
  cd "$LLM"
  G=$(nvidia-smi --query-gpu=index,memory.used --format=csv,noheader,nounits | sort -t, -k2 -n | head -1 | cut -d, -f1)
  # 기본 로그 수준은 요청 문장을 남기지 않는다 — -v·--verbose·--log-verbosity를 붙이지 않는다(문장이 server.log에 남음).
  tmux new-session -d -s tone-llm "CUDA_VISIBLE_DEVICES=$G ./llama.cpp/build/bin/llama-server -m hcx-seed-1.5b-q4_k_m.gguf --host 127.0.0.1 --port $PORT -ngl 99 -np 4 -c 16384 --no-slots --alias $MODEL_ID > server.log 2>&1"
  echo "llm started on GPU $G"
}

engine() {
  local f="$BASE/engine.env"
  [ -f "$f" ] || { echo "missing $f (scripts/deploy-school --env FILE)" >&2; exit 1; }
  [ "$(stat -c %a "$f")" = 600 ] || { echo "$f must be mode 600" >&2; exit 1; }
  has tone-engine && tmux kill-session -t tone-engine
  : > "$BASE/engine.log"
  # engine.env는 셸로 읽는다(값에 공백·특수문자가 있으면 따옴표로 감싼다). USE_LOCAL_MODEL은 항상 켠다.
  tmux new-session -d -s tone-engine "cd $BASE/app/engine && set -a && . $f && set +a && export USE_LOCAL_MODEL=1 && sh deploy-entrypoint.sh uv run uvicorn app.main:app --host 127.0.0.1 --port $ENGINE_PORT --workers 1 > $BASE/engine.log 2>&1"
  for _ in $(seq 30); do
    curl -sf "http://127.0.0.1:$ENGINE_PORT/health" >/dev/null && { echo "engine: ok"; return 0; }
    sleep 1
  done
  echo "engine not healthy after 30s; last log lines:" >&2; tail -n 20 "$BASE/engine.log" >&2; exit 1
}

funnel() {
  has tone-ts || tmux new-session -d -s tone-ts "$TS/tailscaled --tun=userspace-networking --statedir=$BASE/ts-state --socket=$SOCK"
  for _ in $(seq 10); do [ -S "$SOCK" ] && break; sleep 1; done
  if ! logged_in; then
    # up은 로그인 전까지 막히므로 백그라운드로 돌리고 로그에서 링크를 읽는다
    nohup "$TS/tailscale" --socket="$SOCK" up --hostname=tone-chat > "$BASE/ts-up.log" 2>&1 &
    for _ in $(seq 15); do grep -qo 'https://[^ ]*' "$BASE/ts-up.log" && break; sleep 1; done
    echo "Tailscale login needed. Open: $(grep -o 'https://[^ ]*' "$BASE/ts-up.log" | head -1)"
    echo "After login, run again: funnel"
    exit 3
  fi
  # Funnel이 꺼져 있으면 활성화 링크를 출력하고 기다리므로 시간 제한을 둔다
  timeout 20 "$TS/tailscale" --socket="$SOCK" funnel --bg "$ENGINE_PORT" || { echo "funnel not enabled? open the link above, then rerun" >&2; exit 4; }
  echo "public: $(funnel_url)"
}

status() {
  for s in tone-llm tone-engine tone-ts; do has "$s" && echo "$s: running" || echo "$s: stopped"; done
  echo "health: $(curl -sf "http://127.0.0.1:$ENGINE_PORT/health" | head -c 300 || echo 'not answering')"
  if [ -S "$SOCK" ] && logged_in; then echo "public: $(funnel_url)"; else echo "tailscale: not logged in"; fi
}

case "${1:-}" in
llm) llm ;;
engine) engine ;;
funnel) funnel ;;
all) llm; engine; funnel ;;
status) status ;;
stop) has tone-engine && tmux kill-session -t tone-engine; echo "engine stopped" ;;
*) echo "usage: up.sh llm|engine|funnel|all|status|stop" >&2; exit 2 ;;
esac
