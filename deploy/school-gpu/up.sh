#!/usr/bin/env bash
# 서버에서 돌리는 스크립트. 서버에 복사하지 않고 stdin으로 보낸다:
#   ssh tone-gpu 'bash -s -- llm|engine|funnel|all|status|stop|gpu-off|gpu-on' < deploy/school-gpu/up.sh
# 멱등. 비밀값은 출력하지 않는다. 다른 프로세스·디렉터리는 건드리지 않는다.
set -euo pipefail
BASE=/root/tone-chat-deploy; LLM=/root/tone-chat-llm
PORT=11434; ENGINE_PORT=8000
TS="$BASE/tailscale_1.104.4_amd64"; SOCK="$BASE/tailscaled.sock"
MODEL_ID=naver-hyperclovax/HyperCLOVAX-SEED-Text-Instruct-1.5B   # SEED는 이제 models.yaml 어디에도 안 쓴다(옛 전문가 흔적, 11434는 그대로 띄움)
DETAIL_PORT=11436; DETAIL_ID=qwen3-30b-a3b; DETAIL_GGUF=qwen3-30b-a3b-2507-iq3xxs.gguf   # tone_hcx의 local_detail: 뒤 이름과 같아야 한다(P-24)
FAST_PORT=11435; FAST_ID=gemma-3-4b-it; FAST_GGUF=gemma-3-4b-it-q4_k_m.gguf   # tone_fast의 local_fast: 뒤 이름과 같아야 한다(P-12)
CLF_PORT=11481; CLF_DIR=$LLM/clf/kcelectra-p14b   # 학습 판별기(P-14b 내보내기, P-28). 코드는 deploy-school이 올리는 $BASE/app/ml, python은 팀원 ML venv
CLF_PY=/root/p14-work/source/ml/.venv-demo/bin/python
GPU_OFF="$BASE/gpu.off"   # 이 파일이 있으면 GPU 모델을 띄우지 않는다(사용자가 학습 등에 GPU를 쓸 때). gpu-off / gpu-on
has() { tmux has-session -t "$1" 2>/dev/null; }
ts() { "$TS/tailscale" --socket="$SOCK" "$@"; }
logged_in() { ts status --json 2>/dev/null | grep -q '"BackendState": "Running"'; }
funnel_url() { ts funnel status 2>/dev/null | grep -o 'https://[^ ]*' | head -1 || true; }

serve() {   # serve <tmux> <gguf> <port> <alias> [추가 옵션]. 환경변수 MIN_FREE_MIB(기본 0)보다 여유 메모리가 큰 GPU만 쓴다(없으면 건너뜀)
  has "$1" && return 0
  cd "$LLM"
  [ -f "$2" ] || { echo "$1: $2 missing, skipped"; return 0; }
  # 가장 한가한 GPU: 사용률 50% 초과는 뒤로, 그다음 메모리 사용량, 사용률 순(호스트는 여러 사람이 공유)
  export CUDA_DEVICE_ORDER=PCI_BUS_ID
  G=$(nvidia-smi --query-gpu=index,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits | awk -F', *' -v min="${MIN_FREE_MIB:-0}" '$2-$3>=min && (min==0 || $4<=50) {print ($4>50), $3, $4, $1}' | sort -n -k1,1 -k2,2 -k3,3 | head -1 | awk '{print $4}')
  [ -n "$G" ] || { echo "$1: no GPU with >= ${MIN_FREE_MIB:-0} MiB free and util <= 50%, skipped"; return 0; }
  # 기본 로그 수준은 요청 문장을 남기지 않는다 — -v·--verbose·--log-verbosity를 붙이지 않는다(문장이 <세션>.log에 남음).
  tmux new-session -d -s "$1" "CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=$G ./llama.cpp/build/bin/llama-server -m $2 --host 127.0.0.1 --port $3 -ngl 99 -np 4 -c ${CTX:-16384} --no-slots --alias $4 ${5:-} > $1.log 2>&1"
  echo "$1 started on GPU $G"
}

llm() {
  if [ -f "$GPU_OFF" ]; then echo "GPU off ($GPU_OFF): model servers not started (up.sh gpu-on to allow)"; return 0; fi
  serve tone-llm hcx-seed-1.5b-q4_k_m.gguf "$PORT" "$MODEL_ID"
  # Gemma는 SWA라 --swa-full이 있어야 고정 프롬프트 캐시를 다시 쓴다(없으면 요청마다 1초 더)
  serve tone-llm-fast "$FAST_GGUF" "$FAST_PORT" "$FAST_ID" --swa-full
  # Qwen3-30B-A3B: GPU 메모리 ~13.5GB. 여유 14000MiB 이상·사용률 50% 이하인 카드가 없으면 건너뛴다(선택 전문가라 엔진은 그대로 돈다)
  MIN_FREE_MIB=14000 CTX=8192 serve tone-llm-detail "$DETAIL_GGUF" "$DETAIL_PORT" "$DETAIL_ID"
  clf
}

clf() {   # tone-clf: ml/classifier_shim.py, 127.0.0.1:$CLF_PORT. 여유 1500MiB 이상인 가장 한가한 GPU, 없으면 cpu(경고). 선택 서비스라 없으면 건너뛴다(엔진은 clf 항을 뺀다)
  if [ -f "$GPU_OFF" ]; then return 0; fi
  has tone-clf && return 0
  [ -f "$CLF_DIR/model.ts" ] || { echo "tone-clf: $CLF_DIR missing, skipped"; return 0; }
  [ -d "$BASE/app/ml" ] && [ -x "$CLF_PY" ] || { echo "tone-clf: $BASE/app/ml or $CLF_PY missing, skipped (scripts/deploy-school uploads ml/)"; return 0; }
  export CUDA_DEVICE_ORDER=PCI_BUS_ID
  G=$(nvidia-smi --query-gpu=index,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits | awk -F', *' '$2-$3>=1500 {print ($4>50), $3, $4, $1}' | sort -n -k1,1 -k2,2 -k3,3 | head -1 | awk '{print $4}')
  if [ -n "$G" ]; then DEV=cuda; ENVV="CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=$G"
  else DEV=cpu; ENVV=""; echo "tone-clf: warning, no GPU with >= 1500 MiB free; using cpu (p95 ~200ms, over the 150ms timeout: the clf term will mostly be missing)"; fi
  # 로그에 요청 문장을 남기지 않는다(shim은 요청 로그를 끈다)
  tmux new-session -d -s tone-clf "cd $BASE/app && $ENVV $CLF_PY -m ml.classifier_shim --export $CLF_DIR --port $CLF_PORT --device $DEV > $LLM/tone-clf.log 2>&1"
  echo "tone-clf started on $([ -n "$G" ] && echo "GPU $G" || echo cpu)"
}

engine() {
  local f="$BASE/engine.env"
  [ -f "$f" ] || { echo "missing $f (scripts/deploy-school --env FILE)" >&2; exit 1; }
  [ "$(stat -c %a "$f")" = 600 ] || { echo "$f must be mode 600" >&2; exit 1; }
  # 형식 검사: 빈 줄, 주석, KEY=값(값에 따옴표·공백·$·&·; 없음. DB 비밀번호는 퍼센트 인코딩). docker --env-file과 같은 형식.
  if grep -qvE '^(#.*|[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9._:/@%+=,?_-]*)?$' "$f"; then
    echo "engine.env format error: only KEY=value lines (no quotes, spaces, \$, &, ;)" >&2; exit 1
  fi
  has tone-engine && tmux kill-session -t tone-engine
  # 검사한 파일만 셸로 읽는다. USE_LOCAL_MODEL은 GPU off가 아니면 켠다(꺼져 있으면 실시간 힌트는 기권, 상세는 NVIDIA만). 죽으면 5초 뒤 다시 띄운다(컨테이너 재시작 후엔 up.sh all을 다시 실행).
  : > "$BASE/engine.log"   # 세션을 (재)만들 때 한 번만 비운다
  tmux new-session -d -s tone-engine "exec >>$BASE/engine.log 2>&1; cd $BASE/app/engine && set -a && . $f && set +a && export USE_LOCAL_MODEL=$([ -f "$GPU_OFF" ] && echo 0 || echo 1); while :; do sh deploy-entrypoint.sh uv run --frozen --no-dev uvicorn app.main:app --host 127.0.0.1 --port $ENGINE_PORT --workers 1; echo 'engine exited, restarting in 5s'; sleep 5; done"
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
  for s in tone-llm tone-llm-fast tone-llm-detail tone-clf tone-engine tone-ts; do has "$s" && echo "$s: running" || echo "$s: stopped"; done
  echo "health: $(curl -sf "http://127.0.0.1:$ENGINE_PORT/health" | head -c 300 || echo 'not answering')"
  if [ -S "$SOCK" ] && logged_in; then echo "public: $(funnel_url)"; else echo "tailscale: not logged in"; fi
}

case "${1:-}" in
llm) llm ;;
engine) engine ;;
funnel) funnel ;;
all) llm; engine; funnel ;;
status) status; [ -f "$GPU_OFF" ] && echo "gpu: off (model servers not allowed)" || echo "gpu: on" ;;
gpu-off) touch "$GPU_OFF"; for s in tone-llm tone-llm-fast tone-llm-detail tone-clf; do has "$s" && tmux kill-session -t "$s"; done
         has tone-engine && { tmux kill-session -t tone-engine; engine; }; echo "gpu off: model servers stopped, engine uses no local model" ;;
gpu-on) rm -f "$GPU_OFF"; llm; has tone-engine && { tmux kill-session -t tone-engine; engine; }; echo "gpu on" ;;
stop) has tone-engine && tmux kill-session -t tone-engine; echo "engine stopped" ;;
*) echo "usage: up.sh llm|engine|funnel|all|status|stop|gpu-off|gpu-on" >&2; exit 2 ;;
esac
