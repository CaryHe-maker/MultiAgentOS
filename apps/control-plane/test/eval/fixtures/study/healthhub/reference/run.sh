#!/bin/bash
# ./run.sh start [service] | stop [service]
cd "$(dirname "$0")" || exit 1
DATA="${HH_DATA:-./data}"
mkdir -p "$DATA/pids"
ALL="gateway identity records ingest analytics notify"
BASE="${HH_PORT_BASE:-8700}"

port_of() {
  local i=0
  for s in $ALL; do
    [ "$s" = "$1" ] && echo $((BASE + i))
    i=$((i + 1))
  done
}

start_one() {
  local pidfile="$DATA/pids/$1.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then return; fi
  nohup python3 -m "healthhub.$1" >"$DATA/pids/$1.log" 2>&1 &
  echo $! >"$pidfile"
}

stop_one() {
  local pidfile="$DATA/pids/$1.pid"
  [ -f "$pidfile" ] || return
  local pid
  pid="$(cat "$pidfile")"
  kill "$pid" 2>/dev/null
  for _ in $(seq 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null
  rm -f "$pidfile"
}

up() {
  python3 - "$(port_of "$1")" <<'PY'
import sys, time, urllib.request
for _ in range(300):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/health", timeout=1)
        sys.exit(0)
    except Exception:
        time.sleep(0.1)
sys.exit(1)
PY
}

targets="${2:-$ALL}"
case "$1" in
  start)
    for s in $targets; do start_one "$s"; done
    for s in $targets; do up "$s" || exit 1; done
    ;;
  stop)
    for s in $targets; do stop_one "$s"; done
    ;;
  *)
    echo "usage: ./run.sh start|stop [service]" >&2
    exit 2
    ;;
esac
