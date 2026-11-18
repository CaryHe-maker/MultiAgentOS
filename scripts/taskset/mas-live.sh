#!/usr/bin/env bash
# Starts one run of MultiAgentOS (mas) on one task, from the committed head of this checkout.
# Run it in WSL from the repository:
#   bash scripts/taskset/mas-live.sh designed/textutils tu-k4 --ui
#     the console of the run, as `mas run` draws it, in this terminal; nothing waits on you
#     (questions are answered by the harness, what you type is ignored, Ctrl+C stops the run).
#     The run lasts as long as this terminal: run it in tmux to be able to close the window.
#   bash scripts/taskset/mas-live.sh designed/textutils tu-k4
#     the run in the background; watch it with python3 scripts/taskset/mas-watch.py tu-k4
# The checkout at MAO_DIR (default ~/orch-exp) is set to this branch's last commit and built by
# mas-run.sh before the run; changes that are not committed are not in the run. A label runs
# once (mas-run.sh keeps a marker); results go under ~/bench/p3mas.
set -eu
TASK=${1:?give the task, for example designed/textutils}
LABEL=${2:?give a label, for example tu-k4}
UI=0
[ "${3:-}" = "--ui" ] && UI=1
MODE=${MAS_MODE:-mission}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
MAO_DIR=${MAO_DIR:-$HOME/orch-exp}
export PATH="$HOME/.local/opt/node-v24.19.0-linux-x64/bin:$PATH"
BRANCH=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
if [ -n "$(git -C "$REPO" status --porcelain -- packages apps scripts/taskset)" ]; then
  echo "note: packages/, apps/ or scripts/taskset have changes that are not committed; the run will not have them"
fi
git -C "$MAO_DIR" fetch -q "$REPO" "$BRANCH"
git -C "$MAO_DIR" checkout -q -f -B p3run FETCH_HEAD
(cd "$MAO_DIR" && corepack pnpm install --frozen-lockfile --silent > /dev/null)
echo "mas $(git -C "$MAO_DIR" log -1 --format='%h %s' | cut -c1-72)"
mkdir -p "$HOME/bench"
if [ "$UI" = 1 ]; then
  echo "building, then the console of $TASK ($LABEL) opens here; Ctrl+C stops the run"
  MAO_ENV_FILE="$REPO/.env" MAO_DIR="$MAO_DIR" MAS_MODE="$MODE" LABEL="$LABEL" MAS_UI=1 \
    bash "$HERE/mas-run.sh" "$TASK"
  echo "summary: python3 $HERE/mas-watch.py $LABEL --once"
else
  setsid nohup env MAO_ENV_FILE="$REPO/.env" MAO_DIR="$MAO_DIR" MAS_MODE="$MODE" LABEL="$LABEL" \
    bash "$HERE/mas-run.sh" "$TASK" >> "$HOME/bench/p3mas-queue.log" 2>&1 < /dev/null &
  echo "started $TASK as $LABEL ($MODE); it builds first, then runs"
  echo "watch it:  python3 $HERE/mas-watch.py $LABEL"
fi
