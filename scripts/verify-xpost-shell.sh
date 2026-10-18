#!/usr/bin/env bash
# Verify the x-post workflow's shell logic OFFLINE.
#
# WHY THIS EXISTS: .github/workflows/x-post.yml's cursor parsing, batching and posting loop are CI-only. No test in
# `npm test` loads them, so a green suite proves nothing about this path -- that blind spot already shipped a
# `set -eo pipefail` abort and an illegal `max_results=1` undetected, and it is how the build-note tier came to
# share the science tier's cursor and get starved by it (see CHANGELOG "The X digest's build-note tier was
# starved by its own science tier"). Run this BEFORE editing x-post.yml and after, read the next scheduled run's
# job log -- the cursor is echoed on every run precisely so it can be checked from a run where the dev tier never
# fires.
#
# Sections 1-8 mirror the workflow's logic against fixed inputs. Section 9 is stronger and is the one to trust: it
# EXTRACTS the real `run:` block out of the YAML and executes it with the network-touching scripts stubbed, so the
# mirrors cannot drift from what CI actually runs. Nothing is ever posted -- `npm run x:post` is intercepted and
# recorded to a temp dir, the X_API_* variables are empty (post-x-text.ts dry-runs without them anyway), and curl
# is stubbed so no GitHub API call is made.
#
# Usage:  bash scripts/verify-xpost-shell.sh          (exit 0 = SHELL_LOGIC_PASS)
# Requires GNU date, sed, tac, split, sha256sum and node/npm (the ubuntu runner has all; Git-for-Windows bash too).
set -eo pipefail
fail=0
chk() { # chk <label> <actual> <expected>
  if [ "$2" = "$3" ]; then echo "OK   $1 = [$2]"; else echo "FAIL $1 = [$2] expected [$3]"; fail=$((fail+1)); fi
}

printf 'last_post=2026-10-17T19:00:33.000Z\nlast_build_note=2026-10-17T16:37:02.000Z\nlast_science=2026-10-17T19:00:33.000Z\n' > /tmp/lp_new.txt
printf '2026-10-17T19:00:33.000Z\n' > /tmp/lp_legacy.txt
printf 'last_post=2026-10-17T19:00:33.000Z\nlast_build_note=\nlast_science=\n' > /tmp/lp_nonote.txt
printf 'last_post=2026-10-17T19:00:33.000Z\nlast_build_note=2026-10-17T16:37:02.000Z\nlast_science=2026-10-17T15:00:00.000Z\n' > /tmp/lp_split.txt
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
parse_science() { sed -n 's/^last_science=//p' "$1" | tail -1 || true; }
# The science cursor falls back to the newest tweet of any kind when the page holds no science post: a WIDER window
# re-reports nothing (the science tiers filter on record timestamps) and drops nothing.
science_cursor() { local S; S="$(parse_science "$1")"; if [ -z "$S" ]; then S="$(parse_post "$1")"; fi; printf '%s' "$S"; }

echo "--- 1. new labelled stdout shape ---"
chk "last_post"       "$(parse_post /tmp/lp_new.txt)" "2026-10-17T19:00:33.000Z"
chk "last_build_note" "$(parse_note /tmp/lp_new.txt)" "2026-10-17T16:37:02.000Z"
chk "last_science"    "$(parse_science /tmp/lp_new.txt)" "2026-10-17T19:00:33.000Z"

echo "--- 1b. the science cursor is its own value, and degrades to last_post ---"
chk "science cursor (a build note is the newest tweet)" "$(science_cursor /tmp/lp_split.txt)" "2026-10-17T15:00:00.000Z"
chk "science cursor (no science post on the page)"      "$(science_cursor /tmp/lp_nonote.txt)" "2026-10-17T19:00:33.000Z"
chk "science cursor (read failed entirely)"             "$(science_cursor /tmp/lp_empty.txt)" ""
if [ "$(science_cursor /tmp/lp_split.txt)" = "$(parse_post /tmp/lp_split.txt)" ]; then
  echo "FAIL science cursor collapsed onto last_post -- a build note would then advance the science window"; fail=$((fail+1))
else
  echo "OK   science cursor differs from last_post when the newest tweet is a build note"
fi

echo "--- 2. legacy bare-ISO stdout (back-compat for an older ref) ---"
chk "last_post(legacy)" "$(parse_post /tmp/lp_legacy.txt)" "2026-10-17T19:00:33.000Z"

echo "--- 3. no build note on the feed -> empty, not a bogus value ---"
chk "last_post(note absent)"   "$(parse_post /tmp/lp_nonote.txt)" "2026-10-17T19:00:33.000Z"
chk "last_build_note(absent)"  "$(parse_note /tmp/lp_nonote.txt)" ""

echo "--- 4. read failed entirely -> all empty (consumers must fall back) ---"
chk "last_post(read fail)"       "$(parse_post /tmp/lp_empty.txt)" ""
chk "last_build_note(read fail)" "$(parse_note /tmp/lp_empty.txt)" ""
chk "last_science(read fail)"    "$(parse_science /tmp/lp_empty.txt)" ""

echo "--- 5. DEV_SINCE derivation (mirrors the workflow: note time MINUS the overlap) ---"
dev_since() { # $1=note-iso  $2=fallback(SINCE)
  local B="$1" D="" E=""
  if [ -n "$B" ]; then
    E="$(date -u -d "$B" +%s 2>/dev/null || true)"
    if [ -n "$E" ]; then D="$(date -u -d "@$(( E - ${DEV_OVERLAP_MIN:-10} * 60 ))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"; fi
  fi
  if [ -z "$D" ]; then D="$(date -u -d "${BUILD_NOTE_LOOKBACK_H:-48} hours ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"; fi
  if [ -z "$D" ]; then D="$2"; fi
  printf '%s' "$D"
}
chk "DEV_SINCE(note found, default 10m overlap)" "$(dev_since "2026-10-17T16:37:02.000Z" "2026-10-17T19:00:33Z")" "2026-10-17T16:27:02Z"
chk "DEV_SINCE(overlap 0 -> exactly the note time)" "$(DEV_OVERLAP_MIN=0 dev_since "2026-10-17T16:37:02.000Z" "X")" "2026-10-17T16:37:02Z"
chk "DEV_SINCE(overlap 30)" "$(DEV_OVERLAP_MIN=30 dev_since "2026-10-17T16:37:02.000Z" "X")" "2026-10-17T16:07:02Z"
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

# The backlog pipeline: filter subjects, cap the look-back, reverse to OLDEST FIRST, then batch. Mirrors the
# workflow exactly -- including the ordering, which is load-bearing: the posting loop breaks on the first failure,
# so the newest work must be posted LAST or an interrupted run would leave it behind the cursor and lose it.
echo "--- 7. backlog filtering + oldest-first batching ---"
plan_notes() { # $1=subjects-file (newest first, as git log emits)  $2=exclude  $3=batch  $4=cap
  local EX="$2" B="$3" C="$4" N
  head -n "$C" "$1" > /tmp/vx_capped.txt
  if [ -n "$EX" ]; then grep -Evi "$EX" /tmp/vx_capped.txt > /tmp/vx_new.txt || true
  else cp /tmp/vx_capped.txt /tmp/vx_new.txt; fi
  N="$(wc -l < /tmp/vx_new.txt | tr -d ' ')"
  rm -f /tmp/vxchunk-* 2>/dev/null || true
  if [ "$N" -eq 0 ]; then return; fi
  tac /tmp/vx_new.txt > /tmp/vx_oldest.txt
  split -l "$B" -d -a 3 /tmp/vx_oldest.txt /tmp/vxchunk-
}
printf 's5\ns4\nchore(deps): bump x\ndocs: explain the cursor\ns2\n' > /tmp/vx_log.txt
plan_notes /tmp/vx_log.txt '^chore\(deps' 2 200
chk "batch count" "$(ls /tmp/vxchunk-* | wc -l | tr -d ' ')" "2"
chk "chunk 00 holds the OLDEST subjects" "$(tr '\n' ',' < /tmp/vxchunk-000)" "s2,docs: explain the cursor,"
chk "chunk 01 holds the NEWEST" "$(tr '\n' ',' < /tmp/vxchunk-001)" "s4,s5,"
chk "docs: is NOT filtered out" "$(grep -c '^docs:' /tmp/vx_new.txt | tr -d ' ')" "1"
chk "chore(deps) IS filtered out" "$(grep -c 'chore(deps)' /tmp/vx_new.txt | tr -d ' ')" "0"
plan_notes /tmp/vx_log.txt '' 2 200
chk "empty exclude keeps every subject" "$(wc -l < /tmp/vx_new.txt | tr -d ' ')" "5"
plan_notes /tmp/vx_log.txt '^chore\(deps' 2 2
chk "the look-back cap limits how many subjects are considered" "$(wc -l < /tmp/vx_new.txt | tr -d ' ')" "2"
printf 'chore(deps): bump a\nchore(deps): bump b\n' > /tmp/vx_noise.txt
plan_notes /tmp/vx_noise.txt '^chore\(deps' 2 200
chk "an all-noise backlog batches nothing (no empty note is posted)" "$(ls /tmp/vxchunk-* 2>/dev/null | wc -l | tr -d ' ')" "0"

# The posting loop: a runaway ceiling, byte-identical de-duplication, and BREAK-on-failure. Mirrors the workflow.
echo "--- 8. posting loop (ceiling, de-duplication, break-on-failure) ---"
post_loop() { # $1=dir  $2=cap  $3=fail when the filename contains this
  local CAP="$2" FAILPAT="$3" SENT=0 SEEN=/tmp/vx_seen.txt f TEXT KEY QUEUED
  : > "$SEEN"
  QUEUED="$(find "$1" -type f -name '*.txt' -size +0c 2>/dev/null | sort)"
  for f in $QUEUED; do
    if [ "$SENT" -ge "$CAP" ]; then printf 'CAPPED '; break; fi
    TEXT="$(printf '%s' "$(cat "$f")" | tr -cd '\11\12\15\40-\176')"
    if [ -z "$TEXT" ]; then continue; fi
    KEY="$(printf '%s' "$TEXT" | sha256sum | cut -d' ' -f1)"
    if grep -qxF "$KEY" "$SEEN" 2>/dev/null; then printf 'DUP '; continue; fi
    printf '%s\n' "$KEY" >> "$SEEN"
    if [ -n "$FAILPAT" ] && printf '%s' "$f" | grep -q "$FAILPAT"; then printf 'FAILED '; break; fi
    printf '%s ' "$(basename "$f")"
    SENT=$((SENT + 1))
  done
  printf '| sent=%s' "$SENT"
}
PD=/tmp/vx_posts; rm -rf "$PD"; mkdir -p "$PD"
printf 'alpha\n' > "$PD/00-a.txt"; printf 'beta\n' > "$PD/10-b.txt"; printf 'gamma\n' > "$PD/11-c.txt"
: > "$PD/12-empty.txt"
chk "every non-empty item is posted, in filename order" "$(post_loop "$PD" 25 '')" "00-a.txt 10-b.txt 11-c.txt | sent=3"
printf 'alpha\n' > "$PD/13-dup.txt"
chk "a byte-identical item is not posted twice" "$(post_loop "$PD" 25 '')" "00-a.txt 10-b.txt 11-c.txt DUP | sent=3"
rm -f "$PD/13-dup.txt"
chk "the runaway ceiling stops the loop" "$(post_loop "$PD" 2 '')" "00-a.txt 10-b.txt CAPPED | sent=2"
chk "a posting failure BREAKS the loop (later items are left ahead of the cursor, not skipped over)" \
  "$(post_loop "$PD" 25 '10-b')" "00-a.txt FAILED | sent=1"

# Section 9: run the REAL workflow shell, extracted from the YAML, with sending stubbed out. The mirrors above can
# drift from the file; this cannot, because it IS the file.
echo "--- 9. the real run: block, extracted from the YAML and executed with posting stubbed ---"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
YML="$ROOT/.github/workflows/x-post.yml"
if [ ! -f "$YML" ]; then
  echo "FAIL cannot find $YML"; fail=$((fail+1))
else
  # The step's script is the single `run: |` block in the file; every line of it is indented exactly 10 spaces.
  awk 'f && /^ {10}/ { print substr($0, 11) } /^        run: \|$/ { f=1 }' "$YML" > /tmp/vx_run.sh
  LINES="$(wc -l < /tmp/vx_run.sh | tr -d ' ')"
  if [ "$LINES" -lt 40 ]; then
    echo "FAIL extracted only $LINES line(s) from the YAML -- the awk anchor no longer matches"; fail=$((fail+1))
  else
    echo "OK   extracted $LINES line(s) of real workflow shell"
    VX_SENT=/tmp/vx_sent; rm -rf "$VX_SENT"; mkdir -p "$VX_SENT"
    cat > /tmp/vx_wrap.sh <<'WRAP'
set -uo pipefail
VX_SENT="${VX_SENT:?}"
npm() { # intercept the two scripts that touch the network; everything else runs for real
  if [ "${1:-}" = "run" ] && [ "${2:-}" = "x:post" ]; then
    local t=""; shift 2
    while [ $# -gt 0 ]; do case "$1" in --text) t="${2:-}"; shift 2;; *) shift;; esac; done
    local n; n="$(ls -1 "$VX_SENT" 2>/dev/null | wc -l | tr -d ' ')"
    printf '%s' "$t" > "$VX_SENT/$(printf '%03d' $((n + 1))).txt"
    echo "x:post: STUBBED, nothing sent (length=${#t})"
    return 0
  fi
  if [ "${1:-}" = "run" ] && [ "${2:-}" = "--silent" ]; then
    # x:lastpost: emit the labelled cursor lines with NO build note and NO science post, so BOTH fallbacks run.
    local out=""
    while [ $# -gt 0 ]; do case "$1" in --reported-out) out="${2:-}"; shift 2;; *) shift;; esac; done
    [ -n "$out" ] && : > "$out"
    printf 'last_post=2026-10-18T01:00:00.000Z\nlast_build_note=\nlast_science=\n'
    return 1
  fi
  command npm "$@"
}
curl() { echo "STUBBED_CURL" >&2; return 1; } # no GitHub API call from a local rehearsal
# The run block executes in a CHILD bash, and shell functions are not inherited unless exported.
export -f npm curl
bash /tmp/vx_run.sh
WRAP
    cd "$ROOT"
    VX_SENT="$VX_SENT" \
    OVERRIDE_TEXT="" OVERRIDE_SINCE="" OVERRIDE_MAXLEN="" DRY_HEARTBEAT="" \
    GH_TOKEN="" CUR="0" REPO="SpaceDataRig/space-data-rig" \
    X_API_KEY="" X_API_SECRET="" X_ACCESS_TOKEN="" X_ACCESS_TOKEN_SECRET="" \
    HEARTBEAT_AFTER_MIN="45" DEV_COMMITS_MAX="200" DEV_BATCH="24" MAX_POSTS_PER_RUN="25" \
    POST_DELAY_S="0" DEV_OVERLAP_MIN="10" BUILD_NOTE_LOOKBACK_H="48" DEV_COMMIT_EXCLUDE='^chore\(deps' \
      bash /tmp/vx_wrap.sh > /tmp/vx_out.txt 2>&1 || true
    set +u
    RC_LINES="$(wc -l < /tmp/vx_out.txt | tr -d ' ')"
    SENT_N="$(ls -1 "$VX_SENT" 2>/dev/null | wc -l | tr -d ' ')"
    if grep -q 'OK posted' /tmp/vx_out.txt; then
      echo "FAIL the rehearsal reached a REAL post -- the npm stub did not intercept"; fail=$((fail+1))
    else
      echo "OK   nothing was sent to X (stub intercepted; $SENT_N item(s) recorded, $RC_LINES log line(s))"
    fi
    # Every recorded item must be non-empty, pure ASCII, and within the long-post ceiling.
    BAD_ITEMS=0
    for p in "$VX_SENT"/*.txt; do
      [ -e "$p" ] || continue
      SZ="$(wc -c < "$p" | tr -d ' ')"
      NONASCII="$(LC_ALL=C tr -d '\11\12\15\40-\176' < "$p" | wc -c | tr -d ' ')"
      if [ "$SZ" -eq 0 ] || [ "$SZ" -gt 25000 ] || [ "$NONASCII" != "0" ]; then
        echo "     bad item $(basename "$p"): bytes=$SZ nonascii=$NONASCII"
        BAD_ITEMS=$((BAD_ITEMS + 1))
      fi
    done
    chk "recorded items are non-empty, ASCII-only and within the ceiling" "$BAD_ITEMS" "0"
    # The run must reach its own summary line: proves the loop completed rather than aborting mid-script.
    if grep -Eq 'posted [0-9]+ item\(s\) this run|nothing reportable in this window' /tmp/vx_out.txt; then
      echo "OK   the real script ran to its summary line: $(grep -Eo 'posted [0-9]+ item\(s\) this run|nothing reportable in this window.*' /tmp/vx_out.txt | tail -1)"
    else
      echo "FAIL the real script never reached its summary line (aborted early?)"; fail=$((fail+1))
      tail -20 /tmp/vx_out.txt | sed 's/^/     | /'
    fi
    # Both cursors must be echoed even though the science tier composed nothing here.
    chk "the science cursor is echoed" "$(grep -c 'digest window since:' /tmp/vx_out.txt | tr -d ' ')" "1"
    chk "the dev cursor is echoed"     "$(grep -c 'build-note cursor:' /tmp/vx_out.txt | tr -d ' ')" "1"
    chk "the backlog count is echoed"  "$(grep -c 'build-note backlog:' /tmp/vx_out.txt | tr -d ' ')" "1"
  fi
fi

echo ""
if [ "$fail" = "0" ]; then echo "SHELL_LOGIC_PASS"; else echo "SHELL_LOGIC_FAIL count=$fail"; fi
exit "$fail"
