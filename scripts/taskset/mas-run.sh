#!/usr/bin/env bash
# Runs MultiAgentOS (mas) once on designed or agentrun-format tasks of the M2 task sets (docs/M2/TaskSet.md),
# from the checkout at MAO_DIR, in the mode MAS_MODE (chat or mission). A task with a marker for the same
# label is never run again, also after a crash. Results go under $OUT (default ~/bench/p3mas).
#   MAS_MODE=mission LABEL=dev-mission-1 mas-run.sh designed/pyawk ...
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
META=${META:-$HOME/benchmeta}
OUT=${OUT:-$HOME/bench/p3mas}
LABEL=${LABEL:?set LABEL, for example dev-mission-1}
export MAO_DIR=${MAO_DIR:?set MAO_DIR to the mas checkout}
export MAS_MODE=${MAS_MODE:-mission}
export PATH="$HOME/.local/opt/node-v24.19.0-linux-x64/bin:$PATH"
export DOCKER_CONFIG=$HOME/.docker-nocreds
[ -n "${DEEPSEEK_API_KEY:-}" ] || [ -f "${MAO_ENV_FILE:-}" ] || { echo "set DEEPSEEK_API_KEY or MAO_ENV_FILE"; exit 1; }
mkdir -p "$OUT/started" "$OUT/results" "$OUT/logs"
commit=$(git -C "$MAO_DIR" rev-parse --short HEAD)
# bench.ts runs from source, but the packages it imports resolve to their dist: build first, or the
# run measures the code of the last build under the commit of this one.
(cd "$MAO_DIR" && corepack pnpm run build > "$OUT/logs/build-$commit.log" 2>&1) ||
  { echo "the build of $MAO_DIR failed: $OUT/logs/build-$commit.log"; exit 1; }

for id in "$@"; do
  marker="$OUT/started/${LABEL}__${id//\//__}"
  if [ -e "$marker" ]; then
    echo "skip $id: already started $(cat "$marker")"
    continue
  fi
  name=${id#*/}
  case ${id%%/*} in
    designed) dir=$HERE/designed/$name ;;
    tb2) dir=$META/tb2/$name ;;
    sbp) dir=$META/sbp/v2/tasks/$name ;;
    *) echo "not an agentrun task: $id"; continue ;;
  esac
  echo "$(date -Iseconds) mas $commit $MAS_MODE" > "$marker"
  cap=$(awk '/^\[agent\]/{a=1;next} /^\[/{a=0} a && /timeout_sec/{gsub(/[^0-9.]/,"",$0); print int($0); exit}' "$dir/task.toml")
  echo "start $id $(date +%H:%M:%S) ($MAS_MODE, mas $commit)"
  if [ "${MAS_UI:-}" = 1 ]; then
    # The console of the run takes this terminal: the result line goes to the record by --record.
    node "$HERE/agentrun.mjs" mas "$dir" "$OUT/results" --label "$LABEL" --cap "${cap:-900}" \
      --record "$OUT/$LABEL.jsonl" 2> "$OUT/logs/${LABEL}__${id//\//__}.log"
  else
    node "$HERE/agentrun.mjs" mas "$dir" "$OUT/results" --label "$LABEL" --cap "${cap:-900}" < /dev/null \
      >> "$OUT/$LABEL.jsonl" 2> "$OUT/logs/${LABEL}__${id//\//__}.log"
  fi
  echo "end $id $(date +%H:%M:%S) exit $?"
done
