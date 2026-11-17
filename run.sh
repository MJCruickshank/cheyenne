#!/bin/sh
# Start the Cheyenne tracking board. Needs only Python 3.9+.
# If a .venv folder exists (see README, "Optional extras"), its Python is used for the Intel and AIS features.
cd "$(dirname "$0")" || exit 1
if [ -x .venv/bin/python ]; then exec .venv/bin/python server.py "$@"; fi
exec python3 server.py "$@"
