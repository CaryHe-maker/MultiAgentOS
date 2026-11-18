#!/usr/bin/env bash
# The whole gate of a phase on this checkout, as the acceptance platform runs it
# (docs/M2/M2FrozenTests.md 8): install, build, format, lint, typecheck and every test, then the
# frozen system tests that must neither fail nor be skipped. Run it on Ubuntu 24.04 with
# bubblewrap and ripgrep installed.
#
#   bash scripts/gate.sh
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm install --frozen-lockfile
pnpm run build
pnpm run check
git diff --check
node scripts/phase-gate.mjs
