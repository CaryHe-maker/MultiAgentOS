#!/usr/bin/env bash
# Runs the gate of a commit in a clone inside WSL (Ubuntu 24.04), for a developer whose checkout
# lives on Windows. The clone's `origin` is the Windows checkout, so nothing has to be pushed.
#
#   wsl.exe -d Ubuntu-24.04 -- bash -l /mnt/d/<path to this checkout>/scripts/wsl-gate.sh <commit> [patch]
#
# `<commit>` is checked out in `$MAO_CLONE` (default `~/MultiAgentOS`, created on first use from
# `$MAO_ORIGIN`, which has to be given then). `[patch]` is a file made on Windows with
# `git add -A && git diff --cached HEAD --binary > wip.patch && git reset -q`, to try changes that
# are not committed yet. Start the command through `bash -l <script>`: written inline through
# PowerShell, a `$` is mangled.
set -euo pipefail

commit="${1:?usage: wsl-gate.sh <commit> [patch]}"
patch="${2:-}"
clone="${MAO_CLONE:-$HOME/MultiAgentOS}"

if [ ! -d "$clone/.git" ]; then
  : "${MAO_ORIGIN:?the clone does not exist yet: set MAO_ORIGIN to the Windows checkout, as /mnt/d/...}"
  git clone "$MAO_ORIGIN" "$clone"
fi
cd "$clone"
git reset -q --hard
git clean -fdq -e node_modules -e dist
git fetch -q origin
git checkout -q -B wsl-gate "$commit"
if [ -n "$patch" ] && [ -s "$patch" ]; then git apply --whitespace=nowarn "$patch"; fi
bash scripts/gate.sh
