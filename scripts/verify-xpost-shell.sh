#!/usr/bin/env bash
# Verify the x-post workflow's shell logic OFFLINE.
#
# WHY THIS EXISTS: .github/workflows/x-post.yml's cursor parsing and fallback chain are CI-only. No test in
# `npm test` loads them, so a green suite proves nothing about this path -- that blind spot already shipped a
# `set -eo pipefail` abort and an illegal `max_results=1` undetected, and it is how the build-note tier came to
# share the science tier's cursor and get starved by it (see CHANGELOG "The X digest's build-note tier was
# starved by its own science tier"). Run this BEFORE editing x-post.yml and after, read the next scheduled run's
# job log -- the cursor is echoed on every run precisely so it can be checked from a run where the dev tier never
# fires.
#
# Usage:  bash scripts/verify-xpost-shell.sh          (exit 0 = SHELL_LOGIC_PASS)
# Requires GNU date and sed (the ubuntu runner has both; Git-for-Windows bash does too).
set -eo pipefail
fail=0
chk() { # chk <label> <actual> <expected>
  if [ "$2" = "$3" ]; then echo "OK   $1 = [$2]"; else echo "FAIL $1 = [$2] expected [$3]"; fail=$((fail+1)); fi
}

printf 'last_post=2026-10-17T19:00:33.000Z\nlast_build_note=2026-10-17T16:37:02.000Z\n' > /tmp/lp_new.txt
printf '2026-10-17T19:00:33.000Z\n' > /tmp/lp_legacy.txt
printf 'last_post=2026-10-17T19:00:33.000Z\nlast_build_note=\n' > /tmp/lp_nonote.txt
: > /tmp/lp_empty.txt

parse_post() { # $1=file -- mirrors the workflow exactly
  local L
  L="$(sed -n 's/^last_post=//p' "$1" | tail -1 || true)"
  if [ -z "$L" ]; then
    L="$(grep -Eo '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[^ "]*Z' "$1" | head -1 || true)"
  fi
  printf '%s' "$L"
}
parse_note() { sed -n 's/^last_build_note=//p' "$1" | tail -1 || true; }

echo "--- 1. new labelled stdout shape ---"
chk "last_post"       "$(parse_post /tmp/lp_new.txt)" "2026-10-17T19:00:33.000Z"
chk "last_build_note" "$(parse_note /tmp/lp_new.txt)" "2026-10-17T16:37:02.000Z"

echo "--- 2. legacy bare-ISO stdout (back-compat for an older ref) ---"
chk "last_post(legacy)" "$(parse_post /tmp/lp_legacy.txt)" "2026-10-17T19:00:33.000Z"

echo "--- 3. no build note on the feed -> empty, not a bogus value ---"
chk "last_post(note absent)"   "$(parse_post /tmp/lp_nonote.txt)" "2026-10-17T19:00:33.000Z"
chk "last_build_note(absent)"  "$(parse_note /tmp/lp_nonote.txt)" ""

echo "--- 4. read failed entirely -> both empty (consumers must fall back) ---"
chk "last_post(read fail)"       "$(parse_post /tmp/lp_empty.txt)" ""
chk "last_build_note(read fail)" "$(parse_note /tmp/lp_empty.txt)" ""

echo "--- 5. DEV_SINCE derivation (mirrors the workflow) ---"
dev_since() { # $1=note-iso  $2=fallback(SINCE)
  local B="$1" D=""
  if [ -n "$B" ]; then D="$(date -u -d "$B" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"; fi
  if [ -z "$D" ]; then D="$(date -u -d "${BUILD_NOTE_LOOKBACK_H:-48} hours ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"; fi
  if [ -z "$D" ]; then D="$2"; fi
  printf '%s' "$D"
}
chk "DEV_SINCE(note found)" "$(dev_since "2026-10-17T16:37:02.000Z" "2026-10-17T19:00:33Z")" "2026-10-17T16:37:02Z"
LB="$(dev_since "" "2026-10-17T19:00:33Z")"
if [ -n "$LB" ] && [ "$LB" != "2026-10-17T19:00:33Z" ]; then
  echo "OK   DEV_SINCE(no note) = [$LB] -> bounded look-back used, NOT the shared science cursor"
else
  echo "FAIL DEV_SINCE(no note) = [$LB] -> fell through to the science cursor or date failed"; fail=$((fail+1))
fi
# A malformed note must fall through to the look-back, never to the science cursor and never a crash.
chk "DEV_SINCE(malformed note -> lookback, not the science cursor)" "$(dev_since "not-a-date" "SENTINEL" | grep -c SENTINEL || true)" "0"

echo "--- 6. the look-back honours BUILD_NOTE_LOOKBACK_H ---"
O="$(BUILD_NOTE_LOOKBACK_H=1 dev_since "" "X")"
if [ -n "$O" ] && [ "$O" != "X" ]; then echo "OK   1h look-back = [$O]"; else echo "FAIL 1h look-back = [$O]"; fail=$((fail+1)); fi

echo ""
if [ "$fail" = "0" ]; then echo "SHELL_LOGIC_PASS"; else echo "SHELL_LOGIC_FAIL count=$fail"; fi
exit "$fail"
