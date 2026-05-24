from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from mcp.server.fastmcp import FastMCP
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, model_validator


PROJECT_ID = "eventline-demo"
DEFAULT_ICON = "default"
EVENTLINE_TOOLS = {
    "eventline.create_tree",
    "eventline.upsert_node",
    "eventline.connect_events",
    "eventline.delete",
    "eventline.access",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize_text(value: Any, fallback: str = "") -> str:
    return value.strip() if isinstance(value, str) and value.strip() else fallback


def normalize_after(value: str | list[str] | None) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [item.strip() for item in value if isinstance(item, str) and item.strip()]
    return [value.strip()] if value.strip() else []


def flatten_nested_payload(value: Any, keys: tuple[str, ...]) -> Any:
    if not isinstance(value, dict):
        return value
    flattened = dict(value)
    for key in keys:
        nested = flattened.get(key)
        if isinstance(nested, dict):
            flattened.pop(key, None)
            flattened = {**nested, **flattened}
            break
    return flattened


def fast_hash(value: str) -> str:
    data = value.encode("utf-8")
    hash_value = 0
    blocks = len(data) - (len(data) & 3)
    for index in range(0, blocks, 4):
        chunk = data[index] | (data[index + 1] << 8) | (data[index + 2] << 16) | (data[index + 3] << 24)
        chunk = (chunk * 0xCC9E2D51) & 0xFFFFFFFF
        chunk = ((chunk << 15) | (chunk >> 17)) & 0xFFFFFFFF
        chunk = (chunk * 0x1B873593) & 0xFFFFFFFF
        hash_value ^= chunk
        hash_value = ((hash_value << 13) | (hash_value >> 19)) & 0xFFFFFFFF
        hash_value = (hash_value * 5 + 0xE6546B64) & 0xFFFFFFFF

    tail = 0
    remainder = len(data) & 3
    if remainder == 3:
        tail ^= data[blocks + 2] << 16
    if remainder >= 2:
        tail ^= data[blocks + 1] << 8
    if remainder >= 1:
        tail ^= data[blocks]
        tail = (tail * 0xCC9E2D51) & 0xFFFFFFFF
        tail = ((tail << 15) | (tail >> 17)) & 0xFFFFFFFF
        tail = (tail * 0x1B873593) & 0xFFFFFFFF
        hash_value ^= tail

    hash_value ^= len(data)
    hash_value ^= hash_value >> 16
    hash_value = (hash_value * 0x85EBCA6B) & 0xFFFFFFFF
    hash_value ^= hash_value >> 13
    hash_value = (hash_value * 0xC2B2AE35) & 0xFFFFFFFF
    hash_value ^= hash_value >> 16
    return f"{hash_value & 0xFFFFFFFF:08x}"


def version_id_for(payload: dict[str, Any]) -> str:
    return fast_hash(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def edge_id_for(source: str, target: str, label: str) -> str:
    return f"edge_{source}_{target}_{fast_hash(label or f'{source}:{target}')}"


class AttachmentInput(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    type: Literal["file", "image"] = Field(default="file", description="Attachment type.")
    label: str = Field(
        ...,
        validation_alias=AliasChoices("label", "title", "name"),
        min_length=1,
        description="Short attachment label. Common aliases accepted: title, name.",
    )
    uri: str = Field(
        ...,
        validation_alias=AliasChoices("uri", "path", "url"),
        min_length=1,
        description="File path, image path, or URI. Common aliases accepted: path, url.",
    )


class CreateTreeInput(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    tree_id: str = Field(
        ...,
        validation_alias=AliasChoices("tree_id", "treeId"),
        min_length=1,
        description="Stable tree id, for example 'project-main'. Alias accepted: treeId.",
    )
    title: str = Field(..., min_length=1, description="Human-readable tree title.")
    from_agent: str = Field(..., min_length=1, description="Agent name that created this tree.")
    at: str | None = Field(default=None, description="Optional ISO timestamp. Defaults to current time.")
    description: str | None = Field(default=None, description="Optional tree note. Stored later when RA supports tree descriptions.")


class UpsertNodeInput(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    @model_validator(mode="before")
    @classmethod
    def flatten_common_nested_shapes(cls, value: Any) -> Any:
        return flatten_nested_payload(value, ("event", "node", "payload", "detail"))

    id: str = Field(
        ...,
        validation_alias=AliasChoices("id", "node_id", "nodeId"),
        min_length=1,
        description="Stable event node id. Common aliases accepted: node_id, nodeId.",
    )
    tree_id: str = Field(
        ...,
        validation_alias=AliasChoices("tree_id", "treeId"),
        min_length=1,
        description="Owning tree id. Alias accepted: treeId.",
    )
    title: str = Field(..., min_length=1, description="Short event title.")
    detail: str = Field(
        ...,
        validation_alias=AliasChoices("detail", "summary", "description", "body", "content", "text"),
        min_length=1,
        description="Full event detail for agent/user reading. Common aliases accepted: summary, description, body, content, text.",
    )
    from_agent: str = Field(..., min_length=1, description="Agent name that created or updated this event.")
    icon: str | None = Field(default=None, description="Icon name or 1-2 emoji string. Defaults to 'default'.")
    after: str | list[str] | None = Field(
        default=None,
        description="Prior node id or tree_id/node_id reference, or a list of such references, to connect from.",
    )
    edge_label: str | None = Field(
        default=None,
        validation_alias=AliasChoices("edge_label", "edgeLabel"),
        description="Label used for implicit edges from 'after'. Alias accepted: edgeLabel.",
    )
    attachments: list[AttachmentInput] = Field(default_factory=list, description="Optional file/image attachments.")
    at: str | None = Field(default=None, description="Optional ISO timestamp. Defaults to current time.")


class ConnectEventsInput(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    source: str = Field(
        ...,
        validation_alias=AliasChoices("source", "source_id", "sourceId", "from_node_id", "fromNodeId", "from"),
        min_length=1,
        description=(
            "Source node id or tree_id/node_id reference. Common aliases accepted: source_id, sourceId, "
            "from_node_id, fromNodeId, from."
        ),
    )
    target: str = Field(
        ...,
        validation_alias=AliasChoices("target", "target_id", "targetId", "to_node_id", "toNodeId", "to"),
        min_length=1,
        description=(
            "Target node id or tree_id/node_id reference. Common aliases accepted: target_id, targetId, "
            "to_node_id, toNodeId, to."
        ),
    )
    from_agent: str = Field(..., min_length=1, description="Agent name that created this edge.")
    tree_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("tree_id", "treeId"),
        description="Owning tree id for this edge. Alias accepted: treeId.",
    )
    label: str | None = Field(default=None, description="Optional edge label.")
    id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("id", "edge_id", "edgeId"),
        description="Optional stable edge id. Common aliases accepted: edge_id, edgeId.",
    )
    at: str | None = Field(default=None, description="Optional ISO timestamp. Defaults to current time.")


class DeleteInput(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    from_agent: str = Field(..., min_length=1, description="Agent name that requested deletion.")
    node_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("node_id", "nodeId", "id"),
        description=(
            "Node id or tree_id/node_id reference to delete. Deletes only this node plus incoming/outgoing edges. "
            "Common aliases accepted: nodeId, id."
        ),
    )
    edge_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("edge_id", "edgeId"),
        description="Edge id to delete. Exclusive with node_id. Alias accepted: edgeId.",
    )
    reason: str | None = Field(default=None, description="Short reason for deletion.")
    at: str | None = Field(default=None, description="Optional ISO timestamp. Defaults to current time.")

    @model_validator(mode="after")
    def exactly_one_target(self) -> "DeleteInput":
        if bool(self.node_id) == bool(self.edge_id):
            raise ValueError("Provide exactly one of node_id or edge_id.")
        return self


class AccessInput(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    mode: Literal["full", "brief"] = Field(default="full", description="full includes details; brief includes ids/titles/edges only.")
    tree_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("tree_id", "treeId"),
        description="Optional tree id to inspect. Alias accepted: treeId.",
    )
    node_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("node_id", "nodeId", "id"),
        description="Optional node id to inspect. Node access is always full. Aliases accepted: nodeId, id.",
    )
    from_agent: str | None = Field(default=None, description="Accepted for consistency with write tools, but ignored.")

    @model_validator(mode="after")
    def validate_scope(self) -> "AccessInput":
        if self.tree_id and self.node_id:
            raise ValueError("tree_id and node_id are mutually exclusive.")
        if self.node_id and self.mode == "brief":
            raise ValueError("node_id lookup only supports full mode.")
        return self


@dataclass(frozen=True)
class ToolDefinition:
    id: str
    name: str
    title: str
    kind: Literal["read", "write"]
    description: str
    input_model: type[BaseModel]
    test_input: dict[str, Any]


TOOL_DEFINITIONS: tuple[ToolDefinition, ...] = (
    ToolDefinition(
        id="access",
        name="eventline.access",
        title="eventline.access",
        kind="read",
        description="Return the current eventline graph as agent-readable Markdown.",
        input_model=AccessInput,
        test_input={
            "tool": "eventline.access",
            "from": "manual_reader",
            "arguments": {
                "mode": "full",
            },
        },
    ),
    ToolDefinition(
        id="create-tree",
        name="eventline.create_tree",
        title="eventline.create_tree",
        kind="write",
        description="Create a project-level event tree. Use this before adding nodes to a new tree.",
        input_model=CreateTreeInput,
        test_input={
            "tool": "eventline.create_tree",
            "from": "manual_orchestrator",
            "arguments": {
                "treeId": "manual-tree",
                "title": "Manual Test Tree",
            },
        },
    ),
    ToolDefinition(
        id="upsert-node",
        name="eventline.upsert_node",
        title="eventline.upsert_node",
        kind="write",
        description="Create or update an event node. Existing node ids preserve prior versions in replayed state.",
        input_model=UpsertNodeInput,
        test_input={
            "tool": "eventline.upsert_node",
            "from": "manual_agent",
            "arguments": {
                "id": "manual-node",
                "treeId": "project-main",
                "icon": "🧪",
                "title": "Manual node",
                "detail": "A node created from the schema test box.",
                "after": "project-kickoff",
                "edgeLabel": "manual test",
            },
        },
    ),
    ToolDefinition(
        id="connect-events",
        name="eventline.connect_events",
        title="eventline.connect_events",
        kind="write",
        description="Create a directed edge between two existing event nodes.",
        input_model=ConnectEventsInput,
        test_input={
            "tool": "eventline.connect_events",
            "from": "manual_reviewer",
            "arguments": {
                "source": "project-kickoff",
                "target": "prototype-ready",
                "treeId": "project-main",
                "label": "manual link",
            },
        },
    ),
    ToolDefinition(
        id="delete",
        name="eventline.delete",
        title="eventline.delete",
        kind="write",
        description=(
            "Record a deletion event. Deleting a node removes only that node and its incident edges, "
            "not successor nodes."
        ),
        input_model=DeleteInput,
        test_input={
            "tool": "eventline.delete",
            "from": "manual_critic",
            "arguments": {
                "edgeId": "edge_project-kickoff_prototype-ready_9835e8d2",
                "reason": "schema test edge delete",
            },
        },
    ),
)


def tool_schema_payload() -> dict[str, Any]:
    return {
        "source": "eventline.mcp_server",
        "tools": [
            {
                "id": definition.id,
                "name": definition.name,
                "title": definition.title,
                "kind": definition.kind,
                "description": definition.description,
                "inputSchema": definition.input_model.model_json_schema(mode="validation"),
                "testInput": definition.test_input,
            }
            for definition in TOOL_DEFINITIONS
        ],
    }


@dataclass
class EventVersion:
    version_id: str
    title: str
    detail: str
    icon: str
    attachments: list[dict[str, str]]
    updated_at: str
    updated_by: str


@dataclass
class EventNode:
    id: str
    tree_id: str
    title: str
    detail: str
    icon: str
    attachments: list[dict[str, str]]
    updated_at: str
    updated_by: str
    versions: list[EventVersion] = field(default_factory=list)


@dataclass
class EventEdge:
    id: str
    source: str
    target: str
    label: str
    tree_id: str
    created_at: str
    created_by: str


@dataclass
class EventTree:
    id: str
    title: str
    created_at: str
    created_by: str


@dataclass
class EventGraph:
    trees: dict[str, EventTree] = field(default_factory=dict)
    tree_order: list[str] = field(default_factory=list)
    nodes: dict[str, EventNode] = field(default_factory=dict)
    edges: dict[str, EventEdge] = field(default_factory=dict)
    notices: list[str] = field(default_factory=list)


def event_path() -> Path:
    path = os.environ.get("EVENTLINE_EVENTS_PATH")
    if path:
        return Path(path).expanduser().resolve()
    return Path(__file__).resolve().parent / "data" / "events.jsonl"


def read_events() -> list[dict[str, Any]]:
    path = event_path()
    if not path.exists():
        return []
    events: list[dict[str, Any]] = []
    for index, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        event = json.loads(stripped)
        if not isinstance(event, dict):
            raise ValueError(f"{path} line {index} must be a JSON object")
        events.append(event)
    return sorted(events, key=lambda event: int(event.get("seq") or 0))


def write_events(events: list[dict[str, Any]]) -> None:
    path = event_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    content = "\n".join(json.dumps(event, ensure_ascii=False, separators=(",", ":")) for event in events)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(content + ("\n" if content else ""), encoding="utf-8")
    tmp_path.replace(path)


def append_event(tool: str, from_agent: str, arguments: dict[str, Any], at: str | None = None) -> dict[str, Any]:
    events = read_events()
    next_seq = max((int(event.get("seq") or 0) for event in events), default=0) + 1
    event = {
        "seq": next_seq,
        "project_id": PROJECT_ID,
        "at": at or now_iso(),
        "from": from_agent,
        "tool": tool,
        "arguments": arguments,
    }
    events.append(event)
    write_events(events)
    return event


def clear_events_file() -> None:
    write_events([])


def current_graph() -> EventGraph:
    return replay_events(read_events())


def ensure_tree(graph: EventGraph, tree_id: str, from_agent: str, at: str, title: str | None = None) -> None:
    if tree_id in graph.trees:
        return
    graph.trees[tree_id] = EventTree(
        id=tree_id,
        title=title or tree_id,
        created_at=at,
        created_by=from_agent,
    )
    graph.tree_order.append(tree_id)


def resolve_node_ref(graph: EventGraph, ref: str) -> str | None:
    ref = normalize_text(ref)
    if not ref:
        return None
    if ref in graph.nodes:
        return ref
    if "/" not in ref:
        return None
    tree_id, node_id = ref.rsplit("/", 1)
    node = graph.nodes.get(node_id)
    if node and node.tree_id == tree_id:
        return node_id
    return None


def node_ref_error(graph: EventGraph, field: str, ref: str) -> str:
    if "/" in ref:
        tree_id, node_id = ref.rsplit("/", 1)
        node = graph.nodes.get(node_id)
        if node and node.tree_id != tree_id:
            return f"{field} node reference tree mismatch: {ref}; node '{node_id}' belongs to tree '{node.tree_id}'"
    available = ", ".join(sorted(graph.nodes)[:20])
    suffix = f" Available node ids: {available}" if available else " No nodes exist yet."
    return f"{field} node reference not found: {ref}. Use an existing node id or tree_id/node_id.{suffix}"


def require_node_ref(graph: EventGraph, field: str, ref: str) -> str:
    resolved = resolve_node_ref(graph, ref)
    if not resolved:
        raise ValueError(node_ref_error(graph, field, ref))
    return resolved


def require_edge_id(graph: EventGraph, edge_id: str) -> str:
    edge_id = normalize_text(edge_id)
    if edge_id in graph.edges:
        return edge_id
    available = ", ".join(sorted(graph.edges)[:20])
    suffix = f" Available edge ids: {available}" if available else " No edges exist yet."
    raise ValueError(f"edge_id not found: {edge_id}.{suffix}")


def apply_event(graph: EventGraph, event: dict[str, Any]) -> None:
    tool = normalize_text(event.get("tool"))
    at = normalize_text(event.get("at"), now_iso())
    from_agent = normalize_text(event.get("from"), "unknown_agent")
    args = event.get("arguments") if isinstance(event.get("arguments"), dict) else {}

    if tool == "eventline.create_tree":
        tree_id = normalize_text(args.get("treeId"), "main")
        title = normalize_text(args.get("title"), tree_id)
        ensure_tree(graph, tree_id, from_agent, at, title)
        return

    if tool == "eventline.upsert_node":
        node_id = normalize_text(args.get("id"))
        if not node_id:
            graph.notices.append(f"seq {event.get('seq')}: eventline.upsert_node requires id")
            return
        existing = graph.nodes.get(node_id)
        tree_id = normalize_text(args.get("treeId"), existing.tree_id if existing else "main")
        ensure_tree(graph, tree_id, from_agent, at)
        title = normalize_text(args.get("title"), existing.title if existing else node_id)
        detail = normalize_text(args.get("detail"), existing.detail if existing else "No detail was provided.")
        icon = normalize_text(args.get("icon"), existing.icon if existing else DEFAULT_ICON)
        attachments = args.get("attachments")
        normalized_attachments = (
            [item for item in attachments if isinstance(item, dict)]
            if isinstance(attachments, list)
            else (existing.attachments if existing else [])
        )
        version_id = normalize_text(
            args.get("versionId"),
            version_id_for(
                {
                    "id": node_id,
                    "treeId": tree_id,
                    "title": title,
                    "detail": detail,
                    "icon": icon,
                    "attachments": normalized_attachments,
                    "at": at,
                    "from": from_agent,
                }
            ),
        )
        version = EventVersion(
            version_id=version_id,
            title=title,
            detail=detail,
            icon=icon,
            attachments=normalized_attachments,
            updated_at=at,
            updated_by=from_agent,
        )
        graph.nodes[node_id] = EventNode(
            id=node_id,
            tree_id=tree_id,
            title=title,
            detail=detail,
            icon=icon,
            attachments=normalized_attachments,
            updated_at=at,
            updated_by=from_agent,
            versions=[*(existing.versions if existing else []), version],
        )
        edge_label = normalize_text(args.get("edgeLabel"))
        for source_ref in normalize_after(args.get("after")):
            source = resolve_node_ref(graph, source_ref)
            if not source:
                graph.notices.append(f"seq {event.get('seq')}: {node_ref_error(graph, 'after', source_ref)}")
                continue
            add_edge(graph, source, node_id, tree_id, edge_label, from_agent, at)
        return

    if tool == "eventline.connect_events":
        source_ref = normalize_text(args.get("source"))
        target_ref = normalize_text(args.get("target"))
        if not source_ref or not target_ref:
            graph.notices.append(f"seq {event.get('seq')}: eventline.connect_events requires source and target")
            return
        source = resolve_node_ref(graph, source_ref)
        target = resolve_node_ref(graph, target_ref)
        if not source or not target:
            missing = []
            if not source:
                missing.append(node_ref_error(graph, "source", source_ref))
            if not target:
                missing.append(node_ref_error(graph, "target", target_ref))
            graph.notices.append(f"seq {event.get('seq')}: eventline.connect_events skipped; {'; '.join(missing)}")
            return
        tree_id = normalize_text(
            args.get("treeId"),
            graph.nodes[target].tree_id if target in graph.nodes else graph.nodes[source].tree_id if source in graph.nodes else "main",
        )
        ensure_tree(graph, tree_id, from_agent, at)
        add_edge(graph, source, target, tree_id, normalize_text(args.get("label")), from_agent, at, normalize_text(args.get("id")))
        return

    if tool == "eventline.delete":
        node_ref = normalize_text(args.get("nodeId"))
        edge_id = normalize_text(args.get("edgeId"))
        if node_ref and edge_id:
            graph.notices.append(f"seq {event.get('seq')}: eventline.delete accepts nodeId or edgeId, not both")
            return
        if node_ref:
            node_id = resolve_node_ref(graph, node_ref)
            if node_id not in graph.nodes:
                graph.notices.append(f"seq {event.get('seq')}: {node_ref_error(graph, 'nodeId', node_ref)}")
                return
            del graph.nodes[node_id]
            graph.edges = {
                key: edge for key, edge in graph.edges.items() if edge.source != node_id and edge.target != node_id
            }
            return
        if edge_id:
            if edge_id not in graph.edges:
                graph.notices.append(f"seq {event.get('seq')}: eventline.delete edge not found: {edge_id}")
                return
            del graph.edges[edge_id]
            return
        graph.notices.append(f"seq {event.get('seq')}: eventline.delete requires nodeId or edgeId")


def add_edge(
    graph: EventGraph,
    source: str,
    target: str,
    tree_id: str,
    label: str,
    from_agent: str,
    at: str,
    edge_id: str | None = None,
) -> None:
    if not edge_id:
        edge_id = edge_id_for(source, target, label)
    if source not in graph.nodes or target not in graph.nodes:
        graph.notices.append(
            f"eventline edge skipped because source or target is missing: {source} -> {target}; edge_id={edge_id}"
        )
        return
    if edge_id in graph.edges:
        return
    graph.edges[edge_id] = EventEdge(
        id=edge_id,
        source=source,
        target=target,
        label=label,
        tree_id=tree_id,
        created_at=at,
        created_by=from_agent,
    )


def replay_events(events: list[dict[str, Any]]) -> EventGraph:
    graph = EventGraph()
    for event in events:
        apply_event(graph, event)
    return graph


def edge_line(edge: EventEdge) -> str:
    return f"{edge.source} --({edge.label})--> {edge.target}" if edge.label else f"{edge.source} --> {edge.target}"


def full_node_lines(node: EventNode, primary_tree_id: str | None = None) -> list[str]:
    tree_marker = f" (from-tree: {node.tree_id})" if primary_tree_id and node.tree_id != primary_tree_id else ""
    lines = [
        f"### {node.id}{tree_marker}",
        f"tree: {node.tree_id}",
        f"title: {node.title}",
        f"icon: {node.icon}",
        f"edited_by: {node.updated_by}",
        f"updated_at: {node.updated_at}",
        f"detail: {node.detail}",
    ]
    if node.attachments:
        lines.append("attachments:")
        lines.extend(f"  - {item.get('type', 'file')}: {item.get('label', '')} -> {item.get('uri', '')}" for item in node.attachments)
    if len(node.versions) > 1:
        lines.append(f"previous_versions: {len(node.versions) - 1}")
    return lines


def ordered_nodes(graph: EventGraph, node_ids: set[str]) -> list[EventNode]:
    def key(node: EventNode) -> tuple[int, str]:
        tree_index = graph.tree_order.index(node.tree_id) if node.tree_id in graph.tree_order else len(graph.tree_order)
        return tree_index, node.id

    return sorted((node for node in graph.nodes.values() if node.id in node_ids), key=key)


def access_markdown(graph: EventGraph, params: AccessInput) -> str:
    if params.node_id:
        resolved_node_id = resolve_node_ref(graph, params.node_id)
        node = graph.nodes.get(resolved_node_id) if resolved_node_id else None
        lines = ["# Eventline State", "", "## nodes"]
        lines.extend(full_node_lines(node) if node else [f"Node not found: {params.node_id}"])
        return "\n".join(lines)

    if params.tree_id:
        visible_ids = {node.id for node in graph.nodes.values() if node.tree_id == params.tree_id}
        for edge in graph.edges.values():
            source_tree = graph.nodes[edge.source].tree_id if edge.source in graph.nodes else None
            target_tree = graph.nodes[edge.target].tree_id if edge.target in graph.nodes else None
            if source_tree == params.tree_id or target_tree == params.tree_id:
                visible_ids.add(edge.source)
                visible_ids.add(edge.target)
        visible_edges = [
            edge
            for edge in graph.edges.values()
            if edge.source in visible_ids
            and edge.target in visible_ids
            and (
                graph.nodes.get(edge.source, EventNode("", "", "", "", "", [], "", "")).tree_id == params.tree_id
                or graph.nodes.get(edge.target, EventNode("", "", "", "", "", [], "", "")).tree_id == params.tree_id
            )
        ]
        tree = graph.trees.get(params.tree_id)
        lines = ["# Eventline State", "", "## trees"]
        lines.extend(
            [
                f"### {tree.id}",
                f"title: {tree.title}",
                f"created_by: {tree.created_by}",
                f"created_at: {tree.created_at}",
            ]
            if tree
            else [f"- {params.tree_id}: (tree not found)"]
        )
        lines.extend(["", "## nodes"])
        if params.mode == "brief":
            for node in ordered_nodes(graph, visible_ids):
                marker = f" (from-tree: {node.tree_id})" if node.tree_id != params.tree_id else ""
                lines.append(f"- {node.id}{marker}: {node.title}")
        else:
            for node in ordered_nodes(graph, visible_ids):
                lines.extend(["", *full_node_lines(node, params.tree_id)])
        lines.extend(["", "## edges"])
        lines.extend(f"- {edge_line(edge)}" for edge in visible_edges) if visible_edges else lines.append("(no edges)")
        return "\n".join(lines)

    lines = ["# Eventline State", "", "## trees"]
    for tree_id in graph.tree_order:
        tree = graph.trees[tree_id]
        lines.extend([f"### {tree.id}", f"title: {tree.title}", f"created_by: {tree.created_by}", f"created_at: {tree.created_at}"])
    lines.extend(["", "## nodes"])
    for tree_id in graph.tree_order:
        lines.append(f"### {tree_id}")
        nodes = [node for node in ordered_nodes(graph, {node.id for node in graph.nodes.values() if node.tree_id == tree_id})]
        if params.mode == "brief":
            lines.extend(f"- {node.id}: {node.title}" for node in nodes)
        else:
            for node in nodes:
                lines.extend(["", *full_node_lines(node)])
    lines.extend(["", "## edges"])
    for tree_id in graph.tree_order:
        tree_edges = [
            edge
            for edge in graph.edges.values()
            if edge.tree_id == tree_id
            and graph.nodes.get(edge.source)
            and graph.nodes.get(edge.target)
            and graph.nodes[edge.source].tree_id == tree_id
            and graph.nodes[edge.target].tree_id == tree_id
        ]
        lines.append(f"### {tree_id}")
        lines.extend(f"- {edge_line(edge)}" for edge in tree_edges) if tree_edges else lines.append("(no edges)")
    cross_tree_edges = [
        edge
        for edge in graph.edges.values()
        if graph.nodes.get(edge.source)
        and graph.nodes.get(edge.target)
        and graph.nodes[edge.source].tree_id != graph.nodes[edge.target].tree_id
    ]
    if cross_tree_edges:
        lines.extend(["", "### cross-tree", *[f"- {edge_line(edge)}" for edge in cross_tree_edges]])
    return "\n".join(lines)


mcp = FastMCP("eventline_mcp")


@mcp.tool(name="create_tree", annotations={"title": "Create Eventline Tree", "readOnlyHint": False})
async def create_tree(params: CreateTreeInput) -> str:
    """Create a project-level event tree. Use this before adding nodes to a new tree."""

    event = append_event(
        "eventline.create_tree",
        params.from_agent,
        {"treeId": params.tree_id, "title": params.title},
        params.at,
    )
    return json.dumps({"ok": True, "seq": event["seq"], "tree_id": params.tree_id}, ensure_ascii=False)


@mcp.tool(name="upsert_node", annotations={"title": "Create Or Update Eventline Node", "readOnlyHint": False})
async def upsert_node(params: UpsertNodeInput) -> str:
    """Create or update an event node. Existing node ids preserve prior versions in replayed state."""

    arguments: dict[str, Any] = {
        "id": params.id,
        "treeId": params.tree_id,
        "title": params.title,
        "detail": params.detail,
    }
    if params.icon:
        arguments["icon"] = params.icon
    if params.after:
        graph = current_graph()
        arguments["after"] = [
            require_node_ref(graph, "after", source_ref)
            for source_ref in normalize_after(params.after)
        ]
    if params.edge_label:
        arguments["edgeLabel"] = params.edge_label
    if params.attachments:
        arguments["attachments"] = [item.model_dump() for item in params.attachments]
    event = append_event("eventline.upsert_node", params.from_agent, arguments, params.at)
    return json.dumps({"ok": True, "seq": event["seq"], "node_id": params.id}, ensure_ascii=False)


@mcp.tool(name="connect_events", annotations={"title": "Connect Eventline Events", "readOnlyHint": False})
async def connect_events(params: ConnectEventsInput) -> str:
    """Create a directed edge between two existing event nodes."""

    graph = current_graph()
    source = require_node_ref(graph, "source", params.source)
    target = require_node_ref(graph, "target", params.target)
    arguments: dict[str, Any] = {"source": source, "target": target}
    if params.id:
        arguments["id"] = params.id
    if params.tree_id:
        arguments["treeId"] = params.tree_id
    if params.label:
        arguments["label"] = params.label
    event = append_event("eventline.connect_events", params.from_agent, arguments, params.at)
    return json.dumps({"ok": True, "seq": event["seq"], "source": source, "target": target}, ensure_ascii=False)


@mcp.tool(name="delete", annotations={"title": "Delete Eventline Node Or Edge", "readOnlyHint": False, "destructiveHint": True})
async def delete(params: DeleteInput) -> str:
    """Record a deletion event. Deleting a node removes only that node and its incident edges, not successor nodes."""

    arguments: dict[str, Any] = {}
    if params.node_id:
        arguments["nodeId"] = require_node_ref(current_graph(), "node_id", params.node_id)
    if params.edge_id:
        arguments["edgeId"] = require_edge_id(current_graph(), params.edge_id)
    if params.reason:
        arguments["reason"] = params.reason
    event = append_event("eventline.delete", params.from_agent, arguments, params.at)
    return json.dumps({"ok": True, "seq": event["seq"], **arguments}, ensure_ascii=False)


@mcp.tool(name="access", annotations={"title": "Access Eventline State", "readOnlyHint": True})
async def access(params: AccessInput) -> str:
    """Return the current eventline graph as agent-readable Markdown."""

    graph = replay_events(read_events())
    markdown = access_markdown(graph, params)
    if graph.notices:
        markdown += "\n\n## notices\n" + "\n".join(f"- {notice}" for notice in graph.notices)
    return markdown

def main() -> None:
    parser = argparse.ArgumentParser(description="Standalone Eventline MCP server.")
    parser.add_argument("--events", help="Path to events.jsonl. Defaults to eventline/data/events.jsonl.")
    parser.add_argument("--print-tool-schema", action="store_true", help="Print MCP tool schema metadata as JSON and exit.")
    args = parser.parse_args()
    if args.events:
        os.environ["EVENTLINE_EVENTS_PATH"] = str(Path(args.events).expanduser().resolve())
    if args.print_tool_schema:
        print(json.dumps(tool_schema_payload(), ensure_ascii=False, indent=2))
        return
    try:
        mcp.run(transport="stdio")
    except BrokenPipeError:
        sys.exit(0)


if __name__ == "__main__":
    main()
