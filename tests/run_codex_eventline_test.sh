#!/usr/bin/env bash
set -euo pipefail

EVENTLINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVENTS_PATH="$EVENTLINE_DIR/data/events.jsonl"
PROMPT_PATH="$EVENTLINE_DIR/tests/codex-eventline-prompt.md"
TRACE_PATH="$EVENTLINE_DIR/tests/codex-eventline-trace.jsonl"
LAST_MESSAGE_PATH="$EVENTLINE_DIR/tests/codex-eventline-last-message.md"
CODEX_CONFIG_PATH="$EVENTLINE_DIR/codex-eventline.config.toml"

config_value() {
  local key="$1"
  uv run python - "$CODEX_CONFIG_PATH" "$key" <<'PY'
from __future__ import annotations

import sys
import tomllib
from pathlib import Path

path = Path(sys.argv[1])
key = sys.argv[2]
value = tomllib.loads(path.read_text(encoding="utf-8"))
for part in key.split("."):
    value = value[part]
if isinstance(value, str):
    print(f"{value!r}")
else:
    print(value)
PY
}

mkdir -p "$EVENTLINE_DIR/data" "$EVENTLINE_DIR/tests"
: > "$EVENTS_PATH"
rm -f "$TRACE_PATH" "$LAST_MESSAGE_PATH"

codex exec \
  --json \
  --cd "$EVENTLINE_DIR" \
  --sandbox danger-full-access \
  --skip-git-repo-check \
  -c "mcp_servers.eventline.command=$(config_value "mcp_servers.eventline.command")" \
  -c "mcp_servers.eventline.args=$(config_value "mcp_servers.eventline.args")" \
  -o "$LAST_MESSAGE_PATH" \
  "$(cat "$PROMPT_PATH")" | tee "$TRACE_PATH"

echo
echo "events: $EVENTS_PATH"
echo "trace: $TRACE_PATH"
echo "last_message: $LAST_MESSAGE_PATH"
