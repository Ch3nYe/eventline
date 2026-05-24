# An implementation of event line graph for agentic system, through MCP protocol.

<p align="center">
  <a href="https://modelcontextprotocol.io/"><img alt="MCP compatible" src="https://img.shields.io/badge/MCP-compatible-7c3aed"></a>
  <a href="https://react.dev/"><img alt="React 19" src="https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white"></a>
  <a href="https://vite.dev/"><img alt="Vite 6" src="https://img.shields.io/badge/Vite-6-646cff?logo=vite&logoColor=white"></a>
  <br>
  <a href="https://xyflow.com/"><img alt="XYFlow 12" src="https://img.shields.io/badge/XYFlow-12-ff0072"></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript 5" src="https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white"></a>
  <a href="./LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
</p>

![Eventline screenshot](./image.png)

Eventline is a compact event graph demo for agentic systems. It lets agents maintain project-level progress as append-only events, then renders the latest state as an interactive directed graph.

## Features

- MCP tools for creating trees, upserting nodes, connecting events, deleting rendered state, and reading graph state.
- Append-only JSONL event storage with replay-based rendering.
- Interactive XYFlow UI with tree filtering, multi-tree highlighting, zoom, fit, reset, playback, and Markdown access output.
- Node details with versions, timestamps, agent attribution, emoji/icon support, and file/image attachments.

## Quick Start

```bash
npm install
npm run dev -- --port 5174
```

Open `http://localhost:5174/`.

## MCP Server

Run the standalone MCP server:

```bash
uv run python mcp_server.py --events data/events.jsonl
```

Available tools:

- `eventline.create_tree`
- `eventline.upsert_node`
- `eventline.connect_events`
- `eventline.delete`
- `eventline.access`

The UI can also read the live tool schema from:

```text
/eventline-data/tool-schema.json
```

## Data Model

Eventline stores every write as one JSON object per line in `data/events.jsonl`. The UI rebuilds the graph by replaying those events in sequence, so deletes and updates are preserved as history rather than rewriting past records.

## Development

```bash
npm run build
```

The demo is intentionally standalone. It can be used to test how agents write and inspect event graphs before integrating the workflow into a larger system.
