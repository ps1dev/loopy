#!/bin/bash
# Double-clickable on macOS: starts a local server in this folder and opens it.
# The editor cannot run from a file:// address because browsers block ES
# modules there, so this exists to make the correct way the easy way.
cd "$(dirname "$0")" || exit 1
PORT=8080
while lsof -i ":$PORT" >/dev/null 2>&1; do PORT=$((PORT+1)); done
echo "Serving $(pwd) on http://localhost:$PORT/"
echo "Leave this window open while you use the editor. Ctrl-C to stop."
( sleep 1; open "http://localhost:$PORT/" 2>/dev/null || xdg-open "http://localhost:$PORT/" 2>/dev/null ) &
exec python3 -m http.server "$PORT"
