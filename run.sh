#!/bin/sh
# Start the Cheyenne tracking board. Needs only Python 3.9+.
# If a .venv folder exists (see README, "Intel"), its Python is used so the Intel tab can locate posts.
cd "$(dirname "$0")" || exit 1
if [ -x .venv/bin/python ]; then exec .venv/bin/python server.py "$@"; fi
exec python3 server.py "$@"
