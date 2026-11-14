#!/usr/bin/env bash
# The dsh control of the phase-3 final set (docs/M2/Phase3Plan.md section 3.3): every task id given
# runs once with dsh in its official harness. A task with a `started` marker is never run again, also
# after a crash; a crash is reported, not retried.
#   phase3-dsh.sh <id>...        e.g. tb2/mailman lb/task_x deepswe/y sbp/instance_z
# Small tasks (tb2, sbp) use agentrun.mjs with the task's own agent timeout; large tasks use the
# LoopsBench harness or Pier with a 2.5-hour cap. Results go under $OUT (default ~/bench/p3dsh).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
META=${META:-$HOME/benchmeta}
OUT=${OUT:-$HOME/bench/p3dsh}
CAP_LARGE=9000
EFREE=${EFREE:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}
[ -n "${DEEPSEEK_API_KEY:-}" ] || [ -f "${MAO_ENV_FILE:-}" ] || { echo "set DEEPSEEK_API_KEY or MAO_ENV_FILE"; exit 1; }
export PATH="$HOME/.local/bin:$HOME/.local/opt/node-v24.19.0-linux-x64/bin:$PATH"
export PYTHONPATH=$HERE
# the Windows credential helper is not reachable from a detached WSL session; all images are public
export DOCKER_CONFIG=$HOME/.docker-nocreds
mkdir -p "$OUT/started" "$OUT/results" "$OUT/logs" "$DOCKER_CONFIG"
[ -f "$DOCKER_CONFIG/config.json" ] || echo '{}' > "$DOCKER_CONFIG/config.json"

# usage-proxy.mjs published on the host for the large tasks: 18099 for LoopsBench (reached through the
# Docker gateway), 80 for Pier (its egress proxy allows only ports 80 and 443); agentrun.mjs starts its own
if [ -z "$(docker ps -q -f name=^lbproxy$)" ]; then
  docker rm -f lbproxy > /dev/null 2>&1
  docker run -d --name lbproxy -p 18099:8099 -p 80:8099 -v "$HOME/.local/opt/node-v24.19.0-linux-x64:/opt/node:ro" \
    -v "$HERE:/lab:ro" -v "$HOME/bench/usage:/usage" python:3.12-slim \
    /opt/node/bin/node /lab/usage-proxy.mjs 8099 /usage > /dev/null
fi

for id in "$@"; do
  name=${id#*/}
  marker="$OUT/started/${id//\//__}"
  if [ -e "$marker" ]; then
    echo "skip $id: already started $(cat "$marker")"
    continue
  fi
  # On this machine the WSL and Docker disks live on E:, and a full E: crashed WSL; stop before a
  # task starts (it stays unmarked) when E: runs low.
  if [ -x "$EFREE" ]; then
    free=$("$EFREE" -NoProfile -Command "[math]::Floor((Get-PSDrive E).Free/1GB)" < /dev/null | tr -d '\r')
    [ "${free:-0}" -ge 20 ] || { echo "stop before $id: E: has ${free} GB free"; exit 2; }
  fi
  date -Iseconds > "$marker"
  log="$OUT/logs/${id//\//__}.log"
  echo "start $id $(date +%H:%M:%S)"
  case $id in
    tb2/* | sbp/*)
      [ "${id%%/*}" = tb2 ] && dir=$META/tb2/$name || dir=$META/sbp/v2/tasks/$name
      cap=$(awk '/^\[agent\]/{a=1;next} /^\[/{a=0} a && /timeout_sec/{gsub(/[^0-9.]/,"",$0); print int($0); exit}' "$dir/task.toml")
      node "$HERE/agentrun.mjs" dsh "$dir" "$OUT/results" --label p3dsh --cap "${cap:-900}" < /dev/null >> "$OUT/small.jsonl" 2> "$log"
      image=$(tail -1 "$OUT/small.jsonl" | sed -n 's/.*"image":"\([^"]*\)".*/\1/p')
      [ -n "$image" ] && docker rmi "$image" > /dev/null 2>&1
      ;;
    lb/*)
      (cd "$META/lb" && uv run loopsbench run -p "$META/lb-data/tasks" -t "$name" \
        --agent-import-path lb_dsh_agent:DshAgent --global-agent-timeout-sec $CAP_LARGE \
        --n-attempts 1 --n-concurrent 1 --output-path "$OUT/results" --run-id "p3dsh-$name" \
        --no-livestream --cleanup) < /dev/null > "$log" 2>&1
      ;;
    deepswe/*)
      pier run -p "$META/deepswe/tasks/$name" --agent-import-path pier_dsh_agent:DshAgent \
        --ak cap_sec=$CAP_LARGE --n-concurrent 1 --n-attempts 1 --jobs-dir "$OUT/results" \
        --job-name "p3dsh-$name" -y -q < /dev/null > "$log" 2>&1
      image=$(sed -n 's/^docker_image = "\([^"]*\)"/\1/p' "$META/deepswe/tasks/$name/task.toml" | head -1)
      [ -n "$image" ] && docker rmi "$image" > /dev/null 2>&1
      ;;
    *) echo "unknown source: $id" ;;
  esac
  echo "end $id $(date +%H:%M:%S) exit $?"
done
