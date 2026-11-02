#!/usr/bin/env bash
# Start, stop or report the gaze (8766) and depth (8765) workers on the GPU host. Both listen on 127.0.0.1 only and are
# reached through the SSH tunnel opened by scripts/gpu-host/start-ssh-host.ps1.
set -uo pipefail

ROOT="${PROMETHEUS_GPU_ROOT:-$HOME/prometheus-gpu}"
SERVICES=("gaze:8766" "depth:8765")

pid_of() { local file="$ROOT/run/$1.pid"; [ -f "$file" ] && kill -0 "$(cat "$file")" 2>/dev/null && cat "$file"; }

start_one() {
  local name=$1
  if pid_of "$name" >/dev/null; then echo "$name already running"; return 0; fi
  # setsid puts the worker in its own process group so stop can end it with every child it started.
  env PROMETHEUS_BACKEND_LABEL=ssh_remote PROMETHEUS_XFORMERS=0 \
      PROMETHEUS_GAZE_HOME="$ROOT/gaze" PROMETHEUS_DEPTH_HOME="$ROOT/depth" \
      setsid nohup "$ROOT/$name/venv/bin/python" -u "$ROOT/run_service.py" "$ROOT/$name/app/${name}_service.py" "$name" \
      >"$ROOT/logs/$name.log" 2>&1 </dev/null &
  echo $! >"$ROOT/run/$name.pid"
}

wait_ready() {
  local name=$1 port=$2
  for _ in $(seq 1 300); do
    if curl -fs --max-time 3 "http://127.0.0.1:$port/health" >/dev/null; then
      echo "$name ready: $(curl -fs --max-time 3 "http://127.0.0.1:$port/health" | head -c 400)"
      return 0
    fi
    if ! pid_of "$name" >/dev/null; then echo "$name exited during startup:"; tail -n 40 "$ROOT/logs/$name.log"; return 1; fi
    sleep 2
  done
  echo "$name not ready after 10 minutes:"; tail -n 40 "$ROOT/logs/$name.log"; return 1
}

stop_one() {
  local name=$1 pid
  if pid=$(pid_of "$name"); then
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -9 -- "-$pid" 2>/dev/null || true
    echo "$name stopped"
  else
    echo "$name not running"
  fi
  rm -f "$ROOT/run/$name.pid"
}

case "${1:-}" in
  start)
    mkdir -p "$ROOT/logs" "$ROOT/run"
    for entry in "${SERVICES[@]}"; do start_one "${entry%%:*}"; done
    status=0
    for entry in "${SERVICES[@]}"; do wait_ready "${entry%%:*}" "${entry##*:}" || status=1; done
    if [ "$status" -ne 0 ]; then for entry in "${SERVICES[@]}"; do stop_one "${entry%%:*}"; done; fi
    exit "$status" ;;
  stop)
    for entry in "${SERVICES[@]}"; do stop_one "${entry%%:*}"; done ;;
  status)
    for entry in "${SERVICES[@]}"; do
      name=${entry%%:*}
      if pid=$(pid_of "$name"); then echo "$name running (pid $pid)"; else echo "$name not running"; fi
    done
    nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader ;;
  *) echo "usage: host-service.sh start|stop|status" >&2; exit 2 ;;
esac
