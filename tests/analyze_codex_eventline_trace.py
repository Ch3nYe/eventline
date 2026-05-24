from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
TRACE_PATH = ROOT / "tests" / "codex-eventline-trace.jsonl"
EVENTS_PATH = ROOT / "data" / "events.jsonl"
NOTICE_MARKERS = (
    "## notices",
    "edge skipped",
    "node reference not found",
    "node reference tree mismatch",
    "delete node not found",
    "delete edge not found",
)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for index, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            value = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path} line {index} is not valid JSON: {exc}") from exc
        if isinstance(value, dict):
            rows.append(value)
    return rows


def decode_tool_params(item: dict[str, Any]) -> dict[str, Any]:
    arguments = item.get("arguments")
    if not isinstance(arguments, dict):
        return {}
    params = arguments.get("params")
    if isinstance(params, str):
        try:
            parsed = json.loads(params)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return params if isinstance(params, dict) else {}


def tool_result_text(item: dict[str, Any]) -> str:
    result = item.get("result")
    if not isinstance(result, dict):
        return ""
    chunks = result.get("content")
    if not isinstance(chunks, list):
        return ""
    texts = [chunk.get("text") for chunk in chunks if isinstance(chunk, dict) and isinstance(chunk.get("text"), str)]
    return "\n".join(texts)


def main() -> int:
    trace_rows = load_jsonl(TRACE_PATH)
    events = load_jsonl(EVENTS_PATH)
    trace_tool_counter: Counter[str] = Counter()
    trace_failures: list[str] = []
    access_notices: list[str] = []

    for row in trace_rows:
        item = row.get("item")
        if not isinstance(item, dict) or item.get("type") != "mcp_tool_call":
            continue
        server = item.get("server")
        tool = item.get("tool")
        if server != "eventline" or not isinstance(tool, str):
            continue
        trace_tool_counter[f"eventline.{tool}"] += 1
        error = item.get("error")
        status = item.get("status")
        result_text = tool_result_text(item)
        if error or status == "failed":
            trace_failures.append(json.dumps(item, ensure_ascii=False)[:1200])
        if any(marker in result_text for marker in NOTICE_MARKERS):
            access_notices.append(result_text[:1600])

    event_tools = Counter(event.get("tool", "") for event in events)
    delete_nodes = [
        event.get("arguments", {}).get("nodeId")
        for event in events
        if event.get("tool") == "eventline.delete" and event.get("arguments", {}).get("nodeId")
    ]
    delete_edges = [
        event.get("arguments", {}).get("edgeId")
        for event in events
        if event.get("tool") == "eventline.delete" and event.get("arguments", {}).get("edgeId")
    ]
    edge_refs_with_slash = [
        event
        for event in events
        if event.get("tool") == "eventline.connect_events"
        and (
            "/" in str(event.get("arguments", {}).get("source", ""))
            or "/" in str(event.get("arguments", {}).get("target", ""))
        )
    ]

    print("Trace MCP tool calls:")
    for tool, count in sorted(trace_tool_counter.items()):
        print(f"- {tool}: {count}")
    print("\nEvent JSONL tools:")
    for tool, count in sorted(event_tools.items()):
        print(f"- {tool}: {count}")
    print(f"\nTotal events: {len(events)}")
    print(f"Deleted nodes: {', '.join(delete_nodes) if delete_nodes else '(none)'}")
    print(f"Deleted edges: {', '.join(delete_edges) if delete_edges else '(none)'}")
    print(f"Edges with unnormalized tree/node refs in JSONL: {len(edge_refs_with_slash)}")
    print(f"MCP failed tool calls: {len(trace_failures)}")
    print(f"Access notices: {len(access_notices)}")

    if trace_failures:
        print("\nFailed tool call snippets:")
        for snippet in trace_failures[:5]:
            print(f"- {snippet}")
    if access_notices:
        print("\nAccess notice snippets:")
        for snippet in access_notices[:3]:
            print(f"- {snippet}")

    return 1 if trace_failures or access_notices or edge_refs_with_slash else 0


if __name__ == "__main__":
    sys.exit(main())
