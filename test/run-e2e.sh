#!/usr/bin/env bash
#
# Full check: unit tests, then a real browser driving the real UI, then an
# independent Python parse of whatever the browser exported.
#
# Nothing here is optional scaffolding - each stage grades a different thing:
#   node --test   the format and playback logic, in isolation
#   e2e.mjs       that the page actually loads, paints and responds
#   fixture.py    that the exported bytes are a correct WAV, judged by code
#                 that shares no lines with the code that wrote them
#
# Requires: node, python3, a chromium binary, and a playwright install.
# Override the last two with CHROMIUM= and PLAYWRIGHT_DIR=.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD
WORK=${WORK:-/tmp/loopedit}
PORT=${PORT:-8123}
CHROMIUM=${CHROMIUM:-/usr/bin/chromium}
PLAYWRIGHT_DIR=${PLAYWRIGHT_DIR:-}

rc=0
step() { printf '\n=== %s ===\n' "$1"; }

step "unit tests"
node --test test/test.mjs 2>&1 | tail -12 || rc=1

if [ -z "$PLAYWRIGHT_DIR" ]; then
  printf '\nPLAYWRIGHT_DIR not set and no default known; skipping browser stage.\n'
  printf 'Set it to a directory whose node_modules contains playwright.\n'
  exit $rc
fi
if [ ! -x "$CHROMIUM" ]; then
  printf '\nNo chromium at %s; skipping browser stage.\n' "$CHROMIUM"
  exit $rc
fi

rm -rf "$WORK/out"
mkdir -p "$WORK/out"

step "fixture"
python3 test/fixture.py make "$WORK/fixture.wav" || rc=1

step "serve"
python3 -m http.server "$PORT" --bind 127.0.0.1 >"$WORK/http.log" 2>&1 &
SERVER=$!
trap 'kill '"$SERVER"' 2>/dev/null' EXIT
for _ in $(seq 1 40); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/index.html" && break
  sleep 0.25
done
echo "serving $ROOT on 127.0.0.1:$PORT (pid $SERVER)"

step "browser"
node test/e2e.mjs "http://127.0.0.1:$PORT/" "$PLAYWRIGHT_DIR" "$CHROMIUM" \
  "$WORK/fixture.wav" "$WORK/out" || rc=1

step "independent verification of the exported file"
if [ -f "$WORK/out/exported.wav" ]; then
  python3 test/fixture.py verify "$WORK/out/exported.wav" "$WORK/out/expected.json" \
    "$WORK/fixture.wav" || rc=1
else
  echo "  FAIL no exported.wav to verify"
  rc=1
fi

printf '\n=== %s ===\n' "$([ $rc -eq 0 ] && echo 'ALL STAGES PASSED' || echo 'FAILURES ABOVE')"
exit $rc
