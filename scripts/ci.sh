#!/usr/bin/env bash
#
# Every quality gate, in one command: `bun run ci`.
#
# Gates run cheapest-first, but all of them run — one invocation should surface
# every problem, not just the first, because the expensive part is the human
# round-trip, not the 25 seconds. Exit status is non-zero if any gate failed.
#
# Also the body of the pre-push hook (.githooks/pre-push) and of the GitHub
# Actions workflow (.github/workflows/ci.yml), so all three agree by
# construction.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

command -v bun >/dev/null || {
  echo "ci: bun is not on PATH (this project uses bun, never npm)" >&2
  exit 127
}

if [ -t 1 ]; then
  bold=$'\033[1m' red=$'\033[31m' green=$'\033[32m' dim=$'\033[2m' reset=$'\033[0m'
else
  bold='' red='' green='' dim='' reset=''
fi

results=()
failures=0

gate() {
  local name=$1
  shift
  printf '\n%s━━ %s %s(%s)%s\n' "$bold" "$name" "$dim" "$*" "$reset"
  local started=$SECONDS
  if "$@"; then
    results+=("  ${green}pass${reset}  ${name} ${dim}($((SECONDS - started))s)${reset}")
  else
    local status=$?
    results+=("  ${red}FAIL${reset}  ${name} ${dim}(exit ${status}, $((SECONDS - started))s)${reset}")
    failures=$((failures + 1))
  fi
}

# biome lint + format, tsc --noEmit across the workspace, svelte-check.
gate 'check' bun run check
# Tracker bundles, SPA, esbuild server bundle — a break here is invisible to tsc.
gate 'build' bun run build
# vitest: units, the golden matomo corpus, the replay assertions, and the
# tracker + web bundle-size ratchets (CLAUDE.md invariant 6).
gate 'test' bun run test
# Replay perf budget from docs/02, thresholds in apps/server/test/replay/
# bench-thresholds.json. Runs under Node, not Bun: better-sqlite3 dies with a
# NAPI fatal error under Bun 1.3.4.
gate 'bench' bun run bench

printf '\n%s━━ summary%s\n' "$bold" "$reset"
printf '%s\n' "${results[@]}"

if [ "$failures" -gt 0 ]; then
  printf '\n%s%d gate(s) failed.%s\n' "$red" "$failures" "$reset"
  exit 1
fi
printf '\n%sall gates passed.%s\n' "$green" "$reset"
