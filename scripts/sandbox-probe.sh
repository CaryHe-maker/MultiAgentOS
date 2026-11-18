#!/usr/bin/env bash
# The bubblewrap checks of M2TechStack 3.1 against the SandboxProfile of M2Design 6.1. Run as an
# unprivileged user; it needs bwrap, git, curl and python3 and touches only its own directories.
#
# Exit status: 0 all passed, 1 a check failed, 2 the sandbox cannot start here at all (the
# availability probe of M2Design 6.2 failed, so nothing else could be checked).
set -u

SUFFIX=$$
OUTSIDE_ROOT=/var/tmp/sandbox-probe-$SUFFIX
INSIDE_ROOT=$HOME/.sandbox-probe-$SUFFIX
TMP_ROOT=$(mktemp -d /tmp/sandbox-probe.XXXXXX)
WHITELIST=$HOME/.sandbox-probe-tools-$SUFFIX
SECRET=$HOME/.sandbox-probe-secret-$SUFFIX
EMPTY=$OUTSIDE_ROOT/empty
LOOPBACK_PORT=39517
LISTENER=

passed=0
failed=0

cleanup() {
  [ -z "$LISTENER" ] || kill "$LISTENER" 2>/dev/null
  rm -rf "$OUTSIDE_ROOT" "$INSIDE_ROOT" "$TMP_ROOT" "$WHITELIST" "$SECRET"
}
trap cleanup EXIT

pass() {
  echo "PASS  $1"
  passed=$((passed + 1))
}
fail() {
  echo "FAIL  $1${2:+  :: $2}"
  failed=$((failed + 1))
}
check() {
  local label=$1
  shift
  if "$@"; then pass "$label"; else fail "$label"; fi
}
refuses() {
  local label=$1
  shift
  if "$@" 2>/dev/null; then fail "$label"; else pass "$label"; fi
}

mkdir -p "$OUTSIDE_ROOT" "$INSIDE_ROOT" "$WHITELIST/bin"
: >"$EMPTY"
echo marker >"$SECRET"
echo tool >"$WHITELIST/bin/tool"
echo token >"$WHITELIST/credentials.toml"

make_repo() {
  local repo=$1
  mkdir -p "$repo/src" "$repo/.multiagentos" "$repo/secrets" "$repo/sub"
  git -C "$repo" init -q
  echo 'SECRET=1' >"$repo/.env"
  echo inner >"$repo/secrets/key"
  echo trusted >"$repo/AGENTS.md"
  echo trusted >"$repo/sub/AGENTS.md"
  echo config >"$repo/.multiagentos/config"
  echo code >"$repo/src/a.txt"
}

# The profile of M2Design 6.1, in mount order: $1 is the repository, $2 the writable root.
profile() {
  local repo=$1 writable=$2
  shift 2
  bwrap \
    --ro-bind / / \
    --dev /dev --proc /proc \
    --tmpfs /tmp \
    --tmpfs "$HOME" \
    --ro-bind "$WHITELIST" "$WHITELIST" \
    --ro-bind "$EMPTY" "$WHITELIST/credentials.toml" \
    --ro-bind "$repo" "$repo" \
    --bind "$writable" "$writable" \
    --ro-bind "$EMPTY" "$repo/.env" \
    --tmpfs "$repo/secrets" \
    --ro-bind "$repo/.git" "$repo/.git" \
    --ro-bind "$repo/.multiagentos" "$repo/.multiagentos" \
    --ro-bind "$repo/AGENTS.md" "$repo/AGENTS.md" \
    --ro-bind "$repo/sub/AGENTS.md" "$repo/sub/AGENTS.md" \
    --unshare-net --unshare-pid --die-with-parent --new-session \
    --clearenv --setenv PATH "$PATH" --setenv HOME "$HOME" --setenv LANG C.UTF-8 --setenv TERM xterm \
    --chdir "$repo" \
    "$@"
}

layout() {
  local name=$1 repo=$2/repo
  make_repo "$repo"
  local before after
  before=$(find "$repo" -not -path '*/.git/*' | sort)

  if ! profile "$repo" "$repo" /bin/true; then
    fail "1 full profile runs /bin/true [$name]"
    return 1
  fi
  pass "1 full profile runs /bin/true [$name]"

  refuses "2 rest of HOME hidden [$name]" profile "$repo" "$repo" cat "$SECRET"
  check "2 whitelist mounted back [$name]" profile "$repo" "$repo" grep -q tool "$WHITELIST/bin/tool"
  refuses "2 whitelist read-only [$name]" profile "$repo" "$repo" sh -c "echo x >'$WHITELIST/bin/new'"
  check "2 credential reads empty [$name]" profile "$repo" "$repo" sh -c "[ ! -s '$WHITELIST/credentials.toml' ]"
  check "2 writable root [$name]" profile "$repo" "$repo" sh -c 'echo x >src/new.txt'
  rm -f "$repo/src/new.txt"
  check "2 narrow root writes inside [$name]" profile "$repo" "$repo/src" sh -c 'echo x >src/new.txt'
  rm -f "$repo/src/new.txt"
  refuses "2 narrow root blocks outside [$name]" profile "$repo" "$repo/src" sh -c 'echo x >outside.txt'

  check "3 masked file reads empty with status 0 [$name]" profile "$repo" "$repo" sh -c '[ -z "$(cat .env)" ]'
  refuses "3 masked file write fails [$name]" profile "$repo" "$repo" sh -c 'echo y >.env'
  check "3 host file unchanged [$name]" grep -q 'SECRET=1' "$repo/.env"
  check "3 masked directory empty [$name]" profile "$repo" "$repo" sh -c '[ -z "$(ls secrets)" ]'

  local path
  for path in .git/config .multiagentos/config AGENTS.md sub/AGENTS.md; do
    refuses "4 $path read-only [$name]" profile "$repo" "$repo" sh -c "echo z >>'$path'"
  done
  after=$(find "$repo" -not -path '*/.git/*' | sort)
  if [ "$before" = "$after" ]; then
    pass "4 no new files on the host [$name]"
  else
    fail "4 no new files on the host [$name]" "$(diff <(echo "$before") <(echo "$after") | tr '\n' ' ')"
  fi

  # Absent protected paths get no placeholder mount, so a command can create them (6.1).
  local fresh=$2/fresh
  mkdir -p "$fresh"
  bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --bind "$fresh" "$fresh" \
    --unshare-net --unshare-pid --die-with-parent --new-session --chdir "$fresh" \
    sh -c 'mkdir -p .git/hooks && echo x >.git/hooks/x && echo x >AGENTS.md'
  if [ -f "$fresh/.git/hooks/x" ] && [ -f "$fresh/AGENTS.md" ]; then
    pass "5 new protected paths reach the host, for the check afterwards [$name]"
  else
    fail "5 new protected paths reach the host, for the check afterwards [$name]"
  fi
}

echo '== environment'
bwrap --version
uname -r
grep PRETTY_NAME /etc/os-release
echo "user: $(id -un)"
echo "apparmor enabled: $(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || echo absent)"
echo "restrict_unprivileged_userns: $(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent)"

echo '== repository outside HOME'
if ! layout outside-home "$OUTSIDE_ROOT"; then
  echo 'UNAVAILABLE: the sandbox cannot start here'
  exit 2
fi
echo '== repository inside HOME'
layout inside-home "$INSIDE_ROOT"
echo '== repository under /tmp'
layout under-tmp "$TMP_ROOT"

echo '== network'
repo=$OUTSIDE_ROOT/repo
python3 -m http.server "$LOOPBACK_PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
LISTENER=$!
sleep 1
check '6 loopback reachable on the host (control)' curl -s -o /dev/null -m 3 "http://127.0.0.1:$LOOPBACK_PORT"
refuses '6 loopback blocked' profile "$repo" "$repo" curl -s -o /dev/null -m 3 "http://127.0.0.1:$LOOPBACK_PORT"
check '6 external reachable on the host (control)' curl -s -o /dev/null -m 10 https://github.com
refuses '6 external blocked' profile "$repo" "$repo" curl -s -o /dev/null -m 3 https://github.com

echo '== processes'
marks=$OUTSIDE_ROOT/marks
mkdir -p "$marks"

# Starts `sh -c $1` in a sandbox and prints the outer and inner process groups (M2Design 4.7).
start_sandboxed() {
  local status=$marks/status
  rm -f "$status"
  setsid bwrap --ro-bind / / --dev /dev --proc /proc --bind "$marks" "$marks" \
    --unshare-pid --die-with-parent --new-session --json-status-fd 8 \
    sh -c "$1" 8>"$status" &
  OUTER=$!
  sleep 1
  INNER=$(grep -o '"child-pid": *[0-9]*' "$status" | grep -o '[0-9]*$')
}
wait_gone() {
  local index
  for index in $(seq 1 100); do
    pgrep -g "$1" >/dev/null || return 0
    sleep 0.05
  done
  return 1
}

start_sandboxed "sleep 300 & sleep 300 & wait"
kill -KILL "$OUTER"
check '7 killing bwrap leaves no process behind' wait_gone "$INNER"
wait "$OUTER" 2>/dev/null

start_sandboxed "trap 'echo term >$marks/outer; exit 0' TERM; sleep 300 & wait"
kill -TERM -- "-$OUTER"
sleep 0.5
if [ -f "$marks/outer" ]; then
  fail '8 TERM to the outer group does not reach the command' 'behaviour changed from M2TechStack 3.1'
else
  pass '8 TERM to the outer group does not reach the command'
fi
kill -KILL -- "-$OUTER" 2>/dev/null
wait "$OUTER" 2>/dev/null

start_sandboxed "trap 'echo term >$marks/inner; exit 0' TERM; sleep 300 & wait"
started=$(date +%s%3N)
kill -TERM -- "-$INNER"
check '8 TERM to the inner group runs the handler' wait_gone "$INNER"
check '8 handler left its mark' test -f "$marks/inner"
echo "cooperative stop: $(($(date +%s%3N) - started)) ms"
kill -KILL -- "-$OUTER" 2>/dev/null
wait "$OUTER" 2>/dev/null

start_sandboxed "trap '' TERM; while :; do sleep 1; done"
kill -TERM -- "-$INNER"
sleep 2
if wait_gone "$INNER"; then
  fail '8 a command ignoring TERM survives it'
else
  pass '8 a command ignoring TERM survives it'
fi
started=$(date +%s%3N)
kill -KILL -- "-$OUTER"
check '8 KILL to the outer group ends it' wait_gone "$INNER"
echo "forced stop: $(($(date +%s%3N) - started)) ms"
wait "$OUTER" 2>/dev/null

echo '== environment variables'
names=$(FAKE_API_KEY=x MY_SECRET=x profile "$repo" "$repo" env | cut -d= -f1 | sort | tr '\n' ' ')
echo "names: $names"
case "$names" in
  *KEY* | *SECRET*) fail '9 environment whitelist' "$names" ;;
  *) pass '9 environment whitelist' ;;
esac

echo "== summary: passed=$passed failed=$failed"
[ "$failed" -eq 0 ]
