#!/usr/bin/env bash
# Run the browser talk UI after ./start_local_server.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
exec "$ROOT/.venv/bin/python" -u "$ROOT/talk_server.py"
