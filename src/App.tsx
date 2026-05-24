import {
  Background,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  AlertTriangle,
  BadgeCheck,
  Binary,
  Bug,
  CalendarClock,
  CheckCircle2,
  FileText,
  Flag,
  GitBranch,
  Image as ImageIcon,
  Network,
  Palette,
  Play,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Workflow,
  ZoomIn,
} from 'lucide-react';
import type { ComponentType, CSSProperties } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

type EventAttachment = {
  type: 'file' | 'image';
  label: string;
  uri: string;
};

type EventVersion = {
  versionId: string;
  title: string;
  detail: string;
  icon?: string;
  attachments: EventAttachment[];
  updatedAt: string;
  updatedBy: string;
};

type EventNodeRecord = EventVersion & {
  id: string;
  treeId: string;
  position: { x: number; y: number };
  versions: EventVersion[];
};

type EventEdgeRecord = {
  id: string;
  source: string;
  target: string;
  label: string;
  treeId: string;
  createdAt: string;
  createdBy: string;
};

type TreeRecord = {
  id: string;
  title: string;
  createdAt: string;
  createdBy: string;
};

type EventlineGraph = {
  trees: Record<string, TreeRecord>;
  treeOrder: string[];
  nodes: Record<string, EventNodeRecord>;
  edges: Record<string, EventEdgeRecord>;
};

type ToolName =
  | 'eventline.create_tree'
  | 'eventline.upsert_node'
  | 'eventline.connect_events'
  | 'eventline.delete';

type LegacyToolName =
  | 'eventline.move_node'
  | 'eventline.clear_canvas';

type JsonlToolName = ToolName | LegacyToolName;

type EventlineToolCall = {
  tool: ToolName;
  from: string;
  at?: string;
  arguments: Record<string, unknown>;
};

type EventlineJsonlEvent = {
  seq: number;
  project_id: string;
  at: string;
  from: string;
  tool: JsonlToolName;
  arguments: Record<string, unknown>;
};

type EventlineReplayCall = Omit<EventlineToolCall, 'tool'> & {
  tool: JsonlToolName;
};

type AccessMode = 'full' | 'brief';

type EventlineAccessArgs = {
  mode?: AccessMode;
  treeId?: string;
  nodeId?: string;
};

type ApplyResult = {
  graph: EventlineGraph;
  changedNodeIds: string[];
  notice?: string;
};

type EventNodeData = EventNodeRecord & {
  isChanged: boolean;
  isPinned: boolean;
  isTreeHighlighted: boolean;
  treeHighlightColor: string;
  onTogglePinned: (nodeId: string) => void;
};

type EventFlowNode = Node<EventNodeData, 'eventNode'>;
type EventlineTheme = 'DARK' | 'LIGHT' | 'HACKER';
type EdgeSide = 'left' | 'right' | 'top' | 'bottom';
type EdgeRouteMode = 'horizontal' | 'vertical';
type EventEdgeRenderData = EventEdgeRecord & {
  bridgeDirection: 1 | -1;
  bridgeYs: number[];
  routeX: number;
  routeMode: EdgeRouteMode;
};
type EventFlowEdge = Edge<EventEdgeRenderData, 'eventEdge'>;
type ToolSchemaKind = 'read' | 'write';
type ToolSchemaItemDefinition = {
  id: string;
  kind: ToolSchemaKind;
  title: string;
  description?: string;
  schema: string;
  testInput: string;
};
type TooltipPlacement =
  | 'bottom-right'
  | 'top-right'
  | 'right'
  | 'bottom-left'
  | 'top-left'
  | 'left'
  | 'bottom'
  | 'top';
type TooltipPosition = {
  left: number;
  top: number;
  placement: TooltipPlacement;
};
type RectLike = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

const NODE_WIDTH = 58;
const NODE_HEIGHT = 58;
const TREE_GAP = 420;
const DEPTH_GAP = 260;
const LANE_GAP = 168;
const DEFAULT_LAYOUT_RIGHT_EDGE = 1450;
const TOOLTIP_GAP = 14;
const ATTACHMENT_URI_PREFIX = '...';
const DEFAULT_TOOLTIP_POSITION: TooltipPosition = {
  left: NODE_WIDTH - 12,
  top: NODE_HEIGHT - 12,
  placement: 'bottom-right',
};
const EMPTY_GRAPH: EventlineGraph = {
  trees: {},
  treeOrder: [],
  nodes: {},
  edges: {},
};
const EVENTLINE_PROJECT_ID = 'eventline-demo';
const EVENTLINE_JSONL_STORAGE_KEY = 'eventline:demo:events.jsonl';
const EVENTLINE_JSONL_ENDPOINT = '/eventline-data/events.jsonl';
const EVENTLINE_TOOL_SCHEMA_ENDPOINT = '/eventline-data/tool-schema.json';
const EVENTLINE_LAYOUT_STORAGE_KEY = 'eventline:demo:layout.json';
const TREE_HIGHLIGHT_COLORS = ['#38bdf8', '#f43f5e', '#a78bfa', '#22c55e', '#f59e0b', '#06b6d4', '#ec4899'];
const EVENTLINE_TOOL_NAMES: ToolName[] = [
  'eventline.create_tree',
  'eventline.upsert_node',
  'eventline.connect_events',
  'eventline.delete',
];
const LEGACY_EVENTLINE_TOOL_NAMES: LegacyToolName[] = ['eventline.move_node', 'eventline.clear_canvas'];
const TOOL_SCHEMA_ITEMS: ToolSchemaItemDefinition[] = [
  {
    id: 'access',
    kind: 'read',
    title: 'eventline.access',
    schema: `{
  "tool": "eventline.access",
  "from": "orchestrator",
  "arguments": {
    "mode": "full | brief; defaults to full",
    "treeId": "optional tree id; exclusive with nodeId",
    "nodeId": "optional node id; full mode only"
  }
}`,
    testInput: `{
  "tool": "eventline.access",
  "from": "manual_reader",
  "arguments": {
    "mode": "full"
  }
}`,
  },
  {
    id: 'create-tree',
    kind: 'write',
    title: 'eventline.create_tree',
    schema: `{
  "tool": "eventline.create_tree",
  "from": "orchestrator",
  "at": "optional ISO timestamp",
  "arguments": {
    "treeId": "project-main",
    "title": "Project Progress"
  }
}`,
    testInput: `{
  "tool": "eventline.create_tree",
  "from": "manual_orchestrator",
  "arguments": {
    "treeId": "manual-tree",
    "title": "Manual Test Tree"
  }
}`,
  },
  {
    id: 'upsert-node',
    kind: 'write',
    title: 'eventline.upsert_node',
    schema: `{
  "tool": "eventline.upsert_node",
  "from": "agent",
  "at": "optional ISO timestamp",
  "arguments": {
    "id": "event-id",
    "treeId": "project-main",
    "title": "short title",
    "detail": "long detail",
    "icon": "bug | file | branch | ... | 🧪 | 🧪🔍",
    "after": "previous-event-id",
    "edgeLabel": "line label",
    "attachments": [
      { "type": "file", "label": "trace", "uri": "/path/file.md" },
      { "type": "image", "label": "snapshot", "uri": "/image.svg" }
    ]
  }
}`,
    testInput: `{
  "tool": "eventline.upsert_node",
  "from": "manual_agent",
  "arguments": {
    "id": "manual-node",
    "treeId": "project-main",
    "icon": "🧪",
    "title": "Manual node",
    "detail": "A node created from the schema test box.",
    "after": "task-received",
    "edgeLabel": "manual test"
  }
}`,
  },
  {
    id: 'connect-events',
    kind: 'write',
    title: 'eventline.connect_events',
    schema: `{
  "tool": "eventline.connect_events",
  "from": "retrospector",
  "at": "optional ISO timestamp",
  "arguments": {
    "id": "optional edge id",
    "source": "source-node-id",
    "target": "target-node-id",
    "treeId": "edge owner tree id",
    "label": "line label"
  }
}`,
    testInput: `{
  "tool": "eventline.connect_events",
  "from": "manual_reviewer",
  "arguments": {
    "source": "project-kickoff",
    "target": "prototype-ready",
    "treeId": "project-main",
    "label": "manual link"
  }
}`,
  },
  {
    id: 'delete',
    kind: 'write',
    title: 'eventline.delete',
    schema: `{
  "tool": "eventline.delete",
  "from": "critic",
  "at": "optional ISO timestamp",
  "arguments": {
    "nodeId": "optional node id; deletes this node and its incoming/outgoing edges",
    "edgeId": "optional edge id; exclusive with nodeId",
    "reason": "optional deletion reason"
  }
}`,
    testInput: `{
  "tool": "eventline.delete",
  "from": "manual_critic",
  "arguments": {
    "edgeId": "edge_project-kickoff_prototype-ready_9835e8d2",
    "reason": "schema test edge delete"
  }
}`,
  },
];
const THEME_ORDER: EventlineTheme[] = ['DARK', 'LIGHT', 'HACKER'];
const THEME_RENDERING: Record<EventlineTheme, {
  backgroundColor: string;
  minimapDefault: string;
  minimapAlert: string;
  minimapVerified: string;
  edgeStops: [string, string, string];
  arrow: string;
}> = {
  DARK: {
    backgroundColor: 'rgba(129, 140, 248, 0.16)',
    minimapDefault: '#818cf8',
    minimapAlert: '#f43f5e',
    minimapVerified: '#a78bfa',
    edgeStops: ['#f43f5e', '#8b5cf6', '#38bdf8'],
    arrow: '#38bdf8',
  },
  LIGHT: {
    backgroundColor: 'rgba(37, 99, 235, 0.16)',
    minimapDefault: '#2563eb',
    minimapAlert: '#e11d48',
    minimapVerified: '#7c3aed',
    edgeStops: ['#e11d48', '#7c3aed', '#2563eb'],
    arrow: '#2563eb',
  },
  HACKER: {
    backgroundColor: 'rgba(34, 197, 94, 0.16)',
    minimapDefault: '#22c55e',
    minimapAlert: '#84cc16',
    minimapVerified: '#14b8a6',
    edgeStops: ['#84cc16', '#22c55e', '#14b8a6'],
    arrow: '#22c55e',
  },
};

const IconByName: Record<string, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  alert: AlertTriangle,
  binary: Binary,
  branch: GitBranch,
  bug: Bug,
  check: CheckCircle2,
  clock: CalendarClock,
  default: Sparkles,
  file: FileText,
  flag: Flag,
  image: ImageIcon,
  network: Network,
  search: Search,
  shield: ShieldCheck,
  verified: BadgeCheck,
  workflow: Workflow,
};

const sampleScript: EventlineToolCall[] = [
  {
    tool: 'eventline.create_tree',
    from: 'orchestrator',
    at: '2026-05-24T08:54:57.524Z',
    arguments: {
      treeId: 'eventline-session-history',
      title: '当前会话事件历史浓缩',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'orchestrator',
    at: '2026-05-24T08:55:04.660Z',
    arguments: {
      id: 'esh-01-request-project-eventline-demo',
      treeId: 'eventline-session-history',
      icon: '🧭',
      title: '提出项目级 eventline demo 需求',
      detail: '用户要求构建基于 XYFlow 的 project-level eventline demo，让 multi-agent 能通过 MCP 工具维护事件脉络图。',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'frontend-agent',
    at: '2026-05-24T08:55:15.602Z',
    arguments: {
      id: 'esh-02-ui-dag-baseline',
      treeId: 'eventline-session-history',
      icon: 'workflow',
      title: '完成横向 DAG 基线',
      detail: '前端先实现横向 DAG 画布，把事件节点和依赖关系可视化为可拖拽、可浏览的 eventline 原型。',
      after: 'esh-01-request-project-eventline-demo',
      edgeLabel: 'prototype',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'frontend-agent',
    at: '2026-05-24T08:55:26.526Z',
    arguments: {
      id: 'esh-03-ui-hover-versions-attachments',
      treeId: 'eventline-session-history',
      icon: '🧩✨',
      title: '补齐 hover card、版本与附件',
      detail: 'UI 分支加入 hover card、节点版本记录、attachments 展示，让节点能承载更完整的上下文。',
      after: 'esh-02-ui-dag-baseline',
      edgeLabel: 'ui iteration',
      attachments: [{ type: 'file', label: 'eventline UI implementation', uri: 'src/App.tsx' }],
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'frontend-agent',
    at: '2026-05-24T08:55:34.486Z',
    arguments: {
      id: 'esh-04-playback-jsonl-access-view',
      treeId: 'eventline-session-history',
      icon: '▶️',
      title: '加入播放、JSONL 持久化与 access 文本视图',
      detail: '主线继续扩展为可回放、可持久化的事件图，并提供 eventline.access 的 agent-readable 文本视图。',
      after: 'esh-03-ui-hover-versions-attachments',
      edgeLabel: 'state view',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'tooling-agent',
    at: '2026-05-24T08:55:43.013Z',
    arguments: {
      id: 'esh-05-mcp-server-real-tools',
      treeId: 'eventline-session-history',
      icon: '🔧',
      title: '实现 MCP server 真实工具',
      detail: 'MCP 分支把 eventline 从前端原型推进为真实 server 工具，支持 create_tree、upsert_node、connect_events、delete 与 access。',
      after: 'esh-04-playback-jsonl-access-view',
      edgeLabel: 'tooling',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'tooling-agent',
    at: '2026-05-24T08:55:52.152Z',
    arguments: {
      id: 'esh-06-codex-headless-agent-test',
      treeId: 'eventline-session-history',
      icon: '🤖',
      title: '用 Codex headless 验证 agent 工具链',
      detail: '通过 Codex headless 模式测试 agent 是否能创建 tree、node、edge，执行 delete，并读取 access 状态。',
      after: 'esh-05-mcp-server-real-tools',
      edgeLabel: 'validate',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'schema-agent',
    at: '2026-05-24T08:55:59.705Z',
    arguments: {
      id: 'esh-07-web-ui-auto-schema',
      treeId: 'eventline-session-history',
      icon: '📐',
      title: 'Web UI Tool Schema 改为读取 MCP schema',
      detail: 'Web UI 的 Tool Schema 面板从手写说明改为自动读取 MCP schema，减少重复维护并贴近真实工具定义。',
      after: 'esh-06-codex-headless-agent-test',
      edgeLabel: 'schema sync',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'frontend-agent',
    at: '2026-05-24T08:56:07.493Z',
    arguments: {
      id: 'esh-08-tree-filter-multiselect-highlight',
      treeId: 'eventline-session-history',
      icon: '🔎',
      title: '加入 tree 过滤与多选高亮',
      detail: 'UI/交互分支新增 tree 过滤和多选高亮，使多棵事件树能在同一画布中被筛选、对比和定位。',
      after: 'esh-07-web-ui-auto-schema',
      edgeLabel: 'ui refinement',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'frontend-agent',
    at: '2026-05-24T08:56:15.317Z',
    arguments: {
      id: 'esh-09-fix-access-dialog-tree-defaults',
      treeId: 'eventline-session-history',
      icon: '🛠️',
      title: '修复默认 access 弹窗与 tree 默认可见状态',
      detail: '修正默认 access 弹窗行为和 tree 初始可见状态，避免打开页面时误导用户或隐藏关键事件线。',
      after: 'esh-08-tree-filter-multiselect-highlight',
      edgeLabel: 'fix',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'doc-agent',
    at: '2026-05-24T08:56:23.306Z',
    arguments: {
      id: 'esh-10-readme-created',
      treeId: 'eventline-session-history',
      icon: '📘',
      title: '创建 README 说明文档',
      detail: '文档分支整理 eventline 原型的目标、运行方式、MCP 工具能力和交互说明，形成 README。',
      after: 'esh-09-fix-access-dialog-tree-defaults',
      edgeLabel: 'document',
      attachments: [{ type: 'file', label: 'README', uri: 'README.md' }],
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'doc-agent',
    at: '2026-05-24T08:56:31.766Z',
    arguments: {
      id: 'esh-11-readme-screenshot-top',
      treeId: 'eventline-session-history',
      icon: '🖼️📘',
      title: '把截图放入 README 顶部',
      detail: '将 eventline UI 截图放到 README 顶部，方便读者先看到最终视觉效果再阅读工具说明。',
      after: 'esh-10-readme-created',
      edgeLabel: 'illustrate',
      attachments: [{ type: 'image', label: 'eventline UI screenshot', uri: 'image.png' }],
    },
  },
  {
    tool: 'eventline.create_tree',
    from: 'writing-agent',
    at: '2026-05-24T08:56:38.514Z',
    arguments: {
      treeId: 'academic-writing-process',
      title: '学术写作过程虚构线',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'writing-agent',
    at: '2026-05-24T08:56:45.656Z',
    arguments: {
      id: 'awp-01-topic-selected',
      treeId: 'academic-writing-process',
      icon: '💡',
      title: '确定论文主题',
      detail: '研究者确定论文主题：用 agent-readable event graph 支持复杂项目写作与工程过程追踪。',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'writing-agent',
    at: '2026-05-24T08:56:54.435Z',
    arguments: {
      id: 'awp-02-related-work-mapped',
      treeId: 'academic-writing-process',
      icon: '📚',
      title: '整理 related work',
      detail: '作者梳理 event sourcing、provenance graph、multi-agent collaboration 和 research workflow tooling 四类相关工作。',
      after: 'awp-01-topic-selected',
      edgeLabel: 'survey',
      attachments: [{ type: 'file', label: 'related work notes', uri: 'notes/related-work.md' }],
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'writing-agent',
    at: '2026-05-24T08:57:01.882Z',
    arguments: {
      id: 'awp-03-problem-statement',
      treeId: 'academic-writing-process',
      icon: '❓',
      title: '形成 problem statement',
      detail: '论文把问题收敛为：现有协作工具缺少可回放、可审计、可被 agent 直接读取的项目级事件状态。',
      after: 'awp-02-related-work-mapped',
      edgeLabel: 'synthesize',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'writing-agent',
    at: '2026-05-24T08:57:10.010Z',
    arguments: {
      id: 'awp-04-method-framework',
      treeId: 'academic-writing-process',
      icon: '🧱✨',
      title: '设计方法框架',
      detail: '方法框架采用事件树、版本化节点、显式边、附件和 access 文本视图，把可视化与 agent 状态读取统一起来。',
      after: 'awp-03-problem-statement',
      edgeLabel: 'design',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'writing-agent',
    at: '2026-05-24T08:57:18.792Z',
    arguments: {
      id: 'awp-05-experiment-plan',
      treeId: 'academic-writing-process',
      icon: '🧪',
      title: '写出实验计划',
      detail: '实验计划覆盖 UI 可读性、agent 工具调用成功率、删除后继保留、跨 tree 引用和长会话可恢复性。',
      after: 'awp-04-method-framework',
      edgeLabel: 'evaluate',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'review-agent',
    at: '2026-05-24T08:58:11.272Z',
    arguments: {
      id: 'awp-06-feedback-plan-too-broad',
      treeId: 'academic-writing-process',
      icon: '💬',
      title: '收到反馈：实验计划过宽',
      detail: '内部反馈指出实验计划同时覆盖 UI、agent、持久化和恢复性，评估范围偏宽，需要优先定义核心证据。',
      after: 'awp-05-experiment-plan',
      edgeLabel: 'feedback',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'writing-agent',
    at: '2026-05-24T08:58:19.585Z',
    arguments: {
      id: 'awp-05-experiment-plan',
      treeId: 'academic-writing-process',
      icon: '🧪',
      title: '写出实验计划',
      detail: '实验计划经反馈后收敛为三项核心验证：agent 工具调用完整性、删除后继保留语义、access 文本视图对 checklist 的可用性。',
      attachments: [{ type: 'file', label: 'experiment plan draft', uri: 'experiments/plan.md' }],
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'experiment-agent',
    at: '2026-05-24T08:58:29.087Z',
    arguments: {
      id: 'awp-07-experiment-results-added',
      treeId: 'academic-writing-process',
      icon: '📊',
      title: '补充实验结果',
      detail: '作者补充结果：agent 能稳定构造事件树，删除错误节点不会级联删除后继，access 视图适合生成提交前状态摘要。',
      after: 'awp-06-feedback-plan-too-broad',
      edgeLabel: 'add evidence',
      attachments: [{ type: 'image', label: 'result chart', uri: '/sample-evidence.svg' }],
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'review-agent',
    at: '2026-05-24T08:58:36.291Z',
    arguments: {
      id: 'awp-08-overclaim-error',
      treeId: 'academic-writing-process',
      icon: '⚠️',
      title: '错误事件：早期 claim 过强',
      detail: '作者曾写下过强 claim：系统完全解决所有 multi-agent 项目协作可解释性问题。该说法超出证据范围，需要删除。',
      after: 'awp-07-experiment-results-added',
      edgeLabel: 'overclaim',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'writing-agent',
    at: '2026-05-24T08:58:43.669Z',
    arguments: {
      id: 'awp-09-revision-note-after-overclaim',
      treeId: 'academic-writing-process',
      icon: '✍️',
      title: '保留 revision note：收敛 claim 范围',
      detail: '后继修订说明保留：将 claim 改为系统提供可审计的事件状态表示，并在特定 agent workflow 中验证其可用性。',
      after: 'awp-08-overclaim-error',
      edgeLabel: 'revise',
    },
  },
  {
    tool: 'eventline.delete',
    from: 'review-agent',
    at: '2026-05-24T08:58:53.082Z',
    arguments: {
      nodeId: 'awp-08-overclaim-error',
      reason: '测试删除错误事件本身，并确认后继 revision note 节点仍保留。',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'writing-agent',
    at: '2026-05-24T08:58:59.369Z',
    arguments: {
      id: 'awp-10-introduction-rewritten',
      treeId: 'academic-writing-process',
      icon: '📝',
      title: '重写 introduction',
      detail: '作者根据修订说明重写 introduction，弱化万能化表述，突出 project-level event state 对 agent 协作的具体价值。',
      after: 'awp-09-revision-note-after-overclaim',
      edgeLabel: 'rewrite',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'writing-agent',
    at: '2026-05-24T08:59:10.036Z',
    arguments: {
      id: 'awp-11-limitation-added',
      treeId: 'academic-writing-process',
      icon: '🚧',
      title: '补充 limitation',
      detail: '论文新增 limitation：当前验证集中在小规模 agent 写作/工程任务，对大规模长期项目和生产环境协作仍需更多评估。',
      after: 'awp-10-introduction-rewritten',
      edgeLabel: 'qualify',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'writing-agent',
    at: '2026-05-24T08:59:24.707Z',
    arguments: {
      id: 'awp-12-rebuttal-draft',
      treeId: 'academic-writing-process',
      icon: '🧾',
      title: '完成 rebuttal draft',
      detail: 'rebuttal draft 回应审稿人对 novelty、evidence scope 和 agent-readable 状态可复现性的质疑，并引用修订后的实验结果。',
      after: 'awp-11-limitation-added',
      edgeLabel: 'respond',
    },
  },
  {
    tool: 'eventline.upsert_node',
    from: 'writing-agent',
    at: '2026-05-24T08:59:34.492Z',
    arguments: {
      id: 'awp-13-submission-checklist',
      treeId: 'academic-writing-process',
      icon: '✅📋',
      title: '准备 submission checklist',
      detail: '作者准备提交清单：核对 claims 与证据一致性、related work 覆盖、实验 artifact、limitations、rebuttal 口径和 agent-readable 状态摘要。',
      after: 'awp-12-rebuttal-draft',
      edgeLabel: 'finalize',
    },
  },
  {
    tool: 'eventline.connect_events',
    from: 'schema-agent',
    at: '2026-05-24T09:00:06.223Z',
    arguments: {
      source: 'esh-04-playback-jsonl-access-view',
      target: 'awp-13-submission-checklist',
      treeId: 'eventline-session-history',
      label: 'agent-readable state',
    },
  },
];

function cloneGraph(graph: EventlineGraph): EventlineGraph {
  return {
    trees: { ...graph.trees },
    treeOrder: [...graph.treeOrder],
    nodes: Object.fromEntries(
      Object.entries(graph.nodes).map(([id, node]) => [
        id,
        {
          ...node,
          position: { ...node.position },
          attachments: [...node.attachments],
          versions: node.versions.map((version) => ({ ...version, attachments: [...version.attachments] })),
        },
      ]),
    ),
    edges: { ...graph.edges },
  };
}

function ensureTree(graph: EventlineGraph, treeId: string, from: string, at: string, title?: string): EventlineGraph {
  if (graph.trees[treeId]) {
    return graph;
  }
  return {
    ...graph,
    trees: {
      ...graph.trees,
      [treeId]: {
        id: treeId,
        title: title || treeId,
        createdAt: at,
        createdBy: from,
      },
    },
    treeOrder: [...graph.treeOrder, treeId],
  };
}

function normalizeString(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function readAlias(record: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = normalizeString(record[key]);
    if (value) {
      return value;
    }
  }
  return fallback;
}

function normalizeAttachments(value: unknown, fallback: EventAttachment[] = []): EventAttachment[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value
    .map((item): EventAttachment | null => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const record = item as Record<string, unknown>;
      const type = record.type === 'image' ? 'image' : 'file';
      const label = readAlias(record, ['label', 'title', 'name'], type === 'image' ? 'image evidence' : 'file reference');
      const uri = readAlias(record, ['uri', 'path', 'url']);
      if (!uri) {
        return null;
      }
      return { type, label, uri };
    })
    .filter((item): item is EventAttachment => Boolean(item));
}

function normalizeAfter(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeString(item)).filter(Boolean);
  }
  const single = normalizeString(value);
  return single ? [single] : [];
}

function normalizeIcon(value: unknown, fallback = 'default'): string {
  if (Array.isArray(value)) {
    const icons = value.map((item) => normalizeString(item)).filter(Boolean).slice(0, 2);
    return icons.length > 0 ? icons.join(' ') : fallback;
  }
  return normalizeString(value, fallback);
}

function normalizePosition(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return { x, y };
}

function treeHighlightColor(index = 0): string {
  if (index < TREE_HIGHLIGHT_COLORS.length) {
    return TREE_HIGHLIGHT_COLORS[index];
  }
  const hue = Math.round((index * 137.508) % 360);
  return `hsl(${hue} 84% 58%)`;
}

function fastHash(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let hash = 0;
  const remainder = bytes.length & 3;
  const blocks = bytes.length - remainder;

  for (let index = 0; index < blocks; index += 4) {
    let chunk =
      bytes[index] |
      (bytes[index + 1] << 8) |
      (bytes[index + 2] << 16) |
      (bytes[index + 3] << 24);

    chunk = Math.imul(chunk, 0xcc9e2d51);
    chunk = (chunk << 15) | (chunk >>> 17);
    chunk = Math.imul(chunk, 0x1b873593);

    hash ^= chunk;
    hash = (hash << 13) | (hash >>> 19);
    hash = Math.imul(hash, 5) + 0xe6546b64;
  }

  let tail = 0;
  if (remainder === 3) {
    tail ^= bytes[blocks + 2] << 16;
  }
  if (remainder >= 2) {
    tail ^= bytes[blocks + 1] << 8;
  }
  if (remainder >= 1) {
    tail ^= bytes[blocks];
    tail = Math.imul(tail, 0xcc9e2d51);
    tail = (tail << 15) | (tail >>> 17);
    tail = Math.imul(tail, 0x1b873593);
    hash ^= tail;
  }

  hash ^= bytes.length;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;

  return (hash >>> 0).toString(16).padStart(8, '0');
}

function versionIdFor(payload: unknown): string {
  return fastHash(JSON.stringify(payload));
}

function displayDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function emojiIconsFor(icon?: string): string[] {
  if (!icon || IconByName[icon]) {
    return [];
  }
  const matches = icon.match(/\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*(?:\uFE0F|\uFE0E)?/gu);
  return (matches || []).filter((item) => !IconByName[item]).slice(0, 2);
}

function getTreeIndex(graph: EventlineGraph, treeId: string): number {
  const index = graph.treeOrder.indexOf(treeId);
  return index >= 0 ? index : graph.treeOrder.length;
}

function getNodeDepth(graph: EventlineGraph, nodeId: string, seen = new Set<string>()): number {
  if (seen.has(nodeId)) {
    return 0;
  }
  seen.add(nodeId);
  const nodeTreeId = graph.nodes[nodeId]?.treeId;
  const incoming = Object.values(graph.edges).filter(
    (edge) => edge.target === nodeId && graph.nodes[edge.source]?.treeId === nodeTreeId,
  );
  if (incoming.length === 0) {
    return 0;
  }
  return 1 + Math.max(...incoming.map((edge) => getNodeDepth(graph, edge.source, seen)));
}

function autoPosition(graph: EventlineGraph, treeId: string, after: string[]): { x: number; y: number } {
  const treeIndex = getTreeIndex(graph, treeId);
  const depth = after.length > 0
    ? Math.max(...after.map((nodeId) => (graph.nodes[nodeId] ? getNodeDepth(graph, nodeId) + 1 : 1)))
    : 0;
  const sameLevelCount = Object.values(graph.nodes).filter(
    (node) => node.treeId === treeId && getNodeDepth(graph, node.id) === depth,
  ).length;
  return positionForLayout(treeIndex, depth, sameLevelCount);
}

function positionForLayout(
  treeIndex: number,
  depth: number,
  lane: number,
): { x: number; y: number } {
  const treeTop = 90 + treeIndex * TREE_GAP;
  return {
    x: 80 + depth * DEPTH_GAP,
    y: treeTop + lane * LANE_GAP,
  };
}

function positionForWrappedLayout(
  treeIndex: number,
  depth: number,
  lane: number,
  useWrappedMainline: boolean,
): { x: number; y: number } {
  const treeTop = 90 + treeIndex * TREE_GAP;
  if (!useWrappedMainline || lane > 0) {
    return positionForLayout(treeIndex, depth, lane);
  }

  const maxDepthInRow = getWrappedMaxDepthInRow();
  const row = Math.floor(depth / (maxDepthInRow + 1));
  const indexInRow = depth % (maxDepthInRow + 1);
  const isReverseRow = row % 2 === 1;
  const xDepth = isReverseRow ? maxDepthInRow - indexInRow : indexInRow;

  return {
    x: 80 + xDepth * DEPTH_GAP,
    y: treeTop + row * LANE_GAP * 2,
  };
}

function getWrappedMaxDepthInRow(): number {
  return Math.max(1, Math.floor((DEFAULT_LAYOUT_RIGHT_EDGE - 80) / DEPTH_GAP));
}

function applyTreeAutoLayout(graph: EventlineGraph, treeId: string): EventlineGraph {
  const treeNodes = Object.values(graph.nodes).filter((node) => node.treeId === treeId);
  if (treeNodes.length === 0) {
    return graph;
  }

  const depthByNode = new Map(treeNodes.map((node) => [node.id, getNodeDepth(graph, node.id)] as const));
  const treeIndex = getTreeIndex(graph, treeId);
  const treeNodeIds = new Set(treeNodes.map((node) => node.id));
  const childrenByNode = new Map<string, string[]>();
  const incomingCountByNode = new Map(treeNodes.map((node) => [node.id, 0]));

  for (const edge of Object.values(graph.edges)) {
    if (edge.treeId !== treeId || !treeNodeIds.has(edge.source) || !treeNodeIds.has(edge.target)) {
      continue;
    }
    childrenByNode.set(edge.source, [...(childrenByNode.get(edge.source) || []), edge.target]);
    incomingCountByNode.set(edge.target, (incomingCountByNode.get(edge.target) || 0) + 1);
  }

  for (const [nodeId, children] of childrenByNode) {
    childrenByNode.set(
      nodeId,
      children.slice().sort((left, right) => {
        const leftDepth = depthByNode.get(left) || 0;
        const rightDepth = depthByNode.get(right) || 0;
        if (leftDepth !== rightDepth) {
          return leftDepth - rightDepth;
        }
        return left.localeCompare(right);
      }),
    );
  }

  const downstreamDepth = new Map<string, number>();
  const getDownstreamDepth = (nodeId: string, seen = new Set<string>()): number => {
    if (seen.has(nodeId)) {
      return 0;
    }
    const cached = downstreamDepth.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    seen.add(nodeId);
    const children = childrenByNode.get(nodeId) || [];
    const value = children.length === 0
      ? 0
      : 1 + Math.max(...children.map((childId) => getDownstreamDepth(childId, new Set(seen))));
    downstreamDepth.set(nodeId, value);
    return value;
  };

  const primaryChildByNode = new Map<string, string>();
  for (const node of treeNodes) {
    const children = childrenByNode.get(node.id) || [];
    if (children.length === 0) {
      continue;
    }
    const [primaryChild] = children.slice().sort((left, right) => {
      const scoreDelta = getDownstreamDepth(right) - getDownstreamDepth(left);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      const depthDelta = (depthByNode.get(left) || 0) - (depthByNode.get(right) || 0);
      if (depthDelta !== 0) {
        return depthDelta;
      }
      return left.localeCompare(right);
    });
    primaryChildByNode.set(node.id, primaryChild);
  }

  const roots = treeNodes
    .filter((node) => (incomingCountByNode.get(node.id) || 0) === 0)
    .sort((left, right) => {
      const scoreDelta = getDownstreamDepth(right.id) - getDownstreamDepth(left.id);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return left.id.localeCompare(right.id);
    });
  const traversalRoots = roots.length > 0 ? roots : treeNodes;
  const laneByNode = new Map<string, number>();
  const mainlineNodeIds = new Set<string>();
  const maxDepth = Math.max(...Array.from(depthByNode.values()));
  const useWrappedMainline = 80 + maxDepth * DEPTH_GAP + NODE_WIDTH > DEFAULT_LAYOUT_RIGHT_EDGE;
  const maxDepthInWrappedRow = getWrappedMaxDepthInRow();
  const usedWrappedBranchLanes = new Set<number>();
  let nextLane = 0;

  const allocateBranchLane = (parentNodeId: string): number => {
    if (!useWrappedMainline) {
      nextLane += 1;
      return nextLane;
    }

    const parentDepth = depthByNode.get(parentNodeId) || 0;
    const parentRow = Math.floor(parentDepth / (maxDepthInWrappedRow + 1));
    let lane = parentRow * 2 + 1;
    while (usedWrappedBranchLanes.has(lane)) {
      lane += 2;
    }
    usedWrappedBranchLanes.add(lane);
    return lane;
  };

  const assignLane = (nodeId: string, lane: number, seen = new Set<string>()) => {
    if (seen.has(nodeId) || laneByNode.has(nodeId)) {
      return;
    }
    seen.add(nodeId);
    laneByNode.set(nodeId, lane);
    if (lane === 0) {
      mainlineNodeIds.add(nodeId);
    }

    const primaryChild = primaryChildByNode.get(nodeId);
    const children = (childrenByNode.get(nodeId) || []).slice().sort((left, right) => {
      if (left === primaryChild) return -1;
      if (right === primaryChild) return 1;
      return left.localeCompare(right);
    });

    for (const childId of children) {
      const childLane = childId === primaryChild ? lane : allocateBranchLane(nodeId);
      assignLane(childId, childLane, new Set(seen));
    }
  };

  traversalRoots.forEach((node, index) => {
    const lane = index === 0 ? 0 : allocateBranchLane(node.id);
    assignLane(node.id, lane);
  });

  const nextNodes = { ...graph.nodes };

  for (const node of treeNodes.sort((left, right) => {
    const leftDepth = depthByNode.get(left.id) || 0;
    const rightDepth = depthByNode.get(right.id) || 0;
    if (leftDepth !== rightDepth) {
      return leftDepth - rightDepth;
    }
    if (left.position.y !== right.position.y) {
      return left.position.y - right.position.y;
    }
    return left.id.localeCompare(right.id);
  })) {
    const depth = depthByNode.get(node.id) || 0;
    const lane = laneByNode.get(node.id) || 0;
    nextNodes[node.id] = {
      ...node,
      position: positionForWrappedLayout(treeIndex, depth, lane, useWrappedMainline && mainlineNodeIds.has(node.id)),
    };
  }

  return { ...graph, nodes: nextNodes };
}

function addEdgeIfNeeded(
  graph: EventlineGraph,
  source: string,
  target: string,
  treeId: string,
  label: string,
  from: string,
  at: string,
  edgeId?: string,
): EventlineGraph {
  const id = edgeId || `edge_${source}_${target}_${fastHash(label || `${source}:${target}`)}`;
  if (graph.edges[id]) {
    return graph;
  }
  if (!graph.nodes[source] || !graph.nodes[target]) {
    return graph;
  }
  return {
    ...graph,
    edges: {
      ...graph.edges,
      [id]: {
        id,
        source,
        target,
        label,
        treeId,
        createdAt: at,
        createdBy: from,
      },
    },
  };
}

function deleteEdgeProjection(graph: EventlineGraph, edgeId: string): EventlineGraph {
  if (!graph.edges[edgeId]) {
    return graph;
  }
  const nextEdges = { ...graph.edges };
  delete nextEdges[edgeId];
  return { ...graph, edges: nextEdges };
}

function deleteNodeProjection(graph: EventlineGraph, nodeId: string): { graph: EventlineGraph; deletedNodeIds: string[] } {
  if (!graph.nodes[nodeId]) {
    return { graph, deletedNodeIds: [] };
  }
  const nextNodes = { ...graph.nodes };
  delete nextNodes[nodeId];
  const nextEdges = Object.fromEntries(
    Object.entries(graph.edges).filter(([, edge]) => edge.source !== nodeId && edge.target !== nodeId),
  );
  return {
    graph: {
      ...graph,
      nodes: nextNodes,
      edges: nextEdges,
    },
    deletedNodeIds: [nodeId],
  };
}

function applyToolCallToGraph(baseGraph: EventlineGraph, call: EventlineReplayCall): ApplyResult {
  const at = call.at || new Date().toISOString();
  const from = normalizeString(call.from, 'unknown_agent');
  const args = call.arguments || {};
  let graph = cloneGraph(baseGraph);

  if (call.tool === 'eventline.clear_canvas') {
    return { graph, changedNodeIds: [], notice: 'legacy eventline.clear_canvas ignored; agent-facing clear is disabled' };
  }

  if (call.tool === 'eventline.create_tree') {
    const treeId = readAlias(args, ['treeId', 'tree_id'], 'main');
    const title = normalizeString(args.title, treeId);
    graph = ensureTree(graph, treeId, from, at, title);
    return { graph, changedNodeIds: [] };
  }

  if (call.tool === 'eventline.upsert_node') {
    const id = readAlias(args, ['id', 'node_id', 'nodeId']);
    if (!id) {
      return { graph, changedNodeIds: [], notice: 'eventline.upsert_node requires arguments.id' };
    }
    const existing = graph.nodes[id];
    const treeId = readAlias(args, ['treeId', 'tree_id'], existing?.treeId || 'main');
    const after = normalizeAfter(args.after);
    graph = ensureTree(graph, treeId, from, at);

    const title = normalizeString(args.title, existing?.title || id);
    const detail = readAlias(
      args,
      ['detail', 'summary', 'description', 'body', 'content', 'text'],
      existing?.detail || 'No detail was provided.',
    );
    const icon = normalizeIcon(args.icon, existing?.icon || 'default');
    const attachments = normalizeAttachments(args.attachments ?? args.refs, existing?.attachments || []);
    const versionId = normalizeString(
      args.versionId,
      versionIdFor({ id, treeId, title, detail, icon, attachments, at, from }),
    );
    const version: EventVersion = {
      versionId,
      title,
      detail,
      icon,
      attachments,
      updatedAt: at,
      updatedBy: from,
    };
    const position = normalizePosition(args.position) || existing?.position || autoPosition(graph, treeId, after);
    graph = {
      ...graph,
      nodes: {
        ...graph.nodes,
        [id]: {
          ...version,
          id,
          treeId,
          position,
          versions: [...(existing?.versions || []), version],
        },
      },
    };

    const edgeLabel = readAlias(args, ['edgeLabel', 'edge_label']);
    for (const source of after) {
      graph = addEdgeIfNeeded(graph, source, id, treeId, edgeLabel, from, at);
    }
    graph = applyTreeAutoLayout(graph, treeId);

    return { graph, changedNodeIds: [id] };
  }

  if (call.tool === 'eventline.connect_events') {
    const source = readAlias(args, ['source', 'source_id', 'sourceId', 'from_node_id', 'fromNodeId', 'from']);
    const target = readAlias(args, ['target', 'target_id', 'targetId', 'to_node_id', 'toNodeId', 'to']);
    if (!source || !target) {
      return { graph, changedNodeIds: [], notice: 'eventline.connect_events requires source and target' };
    }
    const treeId = readAlias(args, ['treeId', 'tree_id'], graph.nodes[target]?.treeId || graph.nodes[source]?.treeId || 'main');
    const label = normalizeString(args.label, '');
    const edgeId = readAlias(args, ['id', 'edge_id', 'edgeId']);
    graph = ensureTree(graph, treeId, from, at);
    graph = addEdgeIfNeeded(graph, source, target, treeId, label, from, at, edgeId || undefined);
    graph = applyTreeAutoLayout(graph, treeId);
    return { graph, changedNodeIds: [source, target].filter((nodeId) => Boolean(graph.nodes[nodeId])) };
  }

  if (call.tool === 'eventline.delete') {
    const nodeId = readAlias(args, ['nodeId', 'node_id', 'id']);
    const edgeId = readAlias(args, ['edgeId', 'edge_id']);
    if (nodeId && edgeId) {
      return { graph, changedNodeIds: [], notice: 'eventline.delete accepts either nodeId or edgeId, not both' };
    }
    if (nodeId) {
      const result = deleteNodeProjection(graph, nodeId);
      return {
        graph: result.graph,
        changedNodeIds: result.deletedNodeIds,
        notice: result.deletedNodeIds.length > 0 ? undefined : `eventline.delete node not found: ${nodeId}`,
      };
    }
    if (edgeId) {
      const existed = Boolean(graph.edges[edgeId]);
      return {
        graph: deleteEdgeProjection(graph, edgeId),
        changedNodeIds: [],
        notice: existed ? undefined : `eventline.delete edge not found: ${edgeId}`,
      };
    }
    return { graph, changedNodeIds: [], notice: 'eventline.delete requires nodeId or edgeId' };
  }

  if (call.tool === 'eventline.move_node') {
    return { graph, changedNodeIds: [], notice: 'legacy eventline.move_node ignored; UI layout is stored outside events.jsonl' };
  }

  return { graph, changedNodeIds: [], notice: `Unsupported tool: ${String(call.tool)}` };
}

function parseToolCalls(raw: string): EventlineToolCall[] {
  const parsed = JSON.parse(raw) as unknown;
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).calls)
      ? ((parsed as Record<string, unknown>).calls as unknown[])
      : [parsed];

    return list.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('Each call must be an object.');
    }
    const record = item as Record<string, unknown>;
    const tool = normalizeString(record.tool) as ToolName;
    if (!EVENTLINE_TOOL_NAMES.includes(tool)) {
      throw new Error(`Unsupported tool: ${String(record.tool)}`);
    }
    const args = record.arguments;
    return {
      tool,
      from: normalizeString(record.from, 'manual_agent'),
      at: normalizeString(record.at) || undefined,
      arguments: args && typeof args === 'object' ? (args as Record<string, unknown>) : {},
    };
  });
}

function toolSchemaItemsFromPayload(payload: unknown): ToolSchemaItemDefinition[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as Record<string, unknown>).tools)) {
    throw new Error('tool schema payload must include a tools array.');
  }
  return ((payload as Record<string, unknown>).tools as unknown[]).map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('each tool schema item must be an object.');
    }
    const record = item as Record<string, unknown>;
    const id = normalizeString(record.id);
    const kind = normalizeString(record.kind, 'write');
    const title = normalizeString(record.title, normalizeString(record.name, id));
    if (!id || !title || !['read', 'write'].includes(kind)) {
      throw new Error('tool schema item requires id, title/name, and read/write kind.');
    }
    const inputSchema = record.inputSchema ?? record.schema ?? {};
    const testInput = record.testInput;
    return {
      id,
      kind: kind as ToolSchemaKind,
      title,
      description: normalizeString(record.description) || undefined,
      schema: JSON.stringify(inputSchema, null, 2),
      testInput: JSON.stringify(testInput && typeof testInput === 'object' ? testInput : {}, null, 2),
    };
  });
}

async function readToolSchemaItems(): Promise<ToolSchemaItemDefinition[]> {
  const response = await fetch(`${EVENTLINE_TOOL_SCHEMA_ENDPOINT}?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to read MCP tool schema: ${response.status}`);
  }
  return toolSchemaItemsFromPayload(await response.json());
}

function parseAccessToolCall(raw: string): EventlineAccessArgs {
  const parsed = JSON.parse(raw || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('eventline.access call must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  const tool = normalizeString(record.tool);
  if (tool && tool !== 'eventline.access') {
    throw new Error(`Expected eventline.access, got: ${String(record.tool)}`);
  }
  const args = record.arguments;
  return parseAccessArgs(args && typeof args === 'object' ? JSON.stringify(args) : '{}');
}

function jsonlEventToToolCall(event: EventlineJsonlEvent): EventlineReplayCall {
  return {
    tool: event.tool,
    from: event.from,
    at: event.at,
    arguments: event.arguments,
  };
}

function toolCallToJsonlEvent(call: EventlineToolCall, seq: number): EventlineJsonlEvent {
  return {
    seq,
    project_id: EVENTLINE_PROJECT_ID,
    at: call.at || new Date().toISOString(),
    from: normalizeString(call.from, 'unknown_agent'),
    tool: call.tool,
    arguments: call.arguments || {},
  };
}

function parseJsonlEvents(jsonl: string): EventlineJsonlEvent[] {
  return jsonl
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        throw new Error(`events.jsonl line ${index + 1} must be an object`);
      }
      const record = parsed as Record<string, unknown>;
      const tool = normalizeString(record.tool) as JsonlToolName;
      if (!EVENTLINE_TOOL_NAMES.includes(tool as ToolName) && !LEGACY_EVENTLINE_TOOL_NAMES.includes(tool as LegacyToolName)) {
        throw new Error(`events.jsonl line ${index + 1} has unsupported tool: ${String(record.tool)}`);
      }
      const args = record.arguments;
      return {
        seq: Number.isFinite(Number(record.seq)) ? Number(record.seq) : index + 1,
        project_id: normalizeString(record.project_id, EVENTLINE_PROJECT_ID),
        at: normalizeString(record.at) || new Date().toISOString(),
        from: normalizeString(record.from, 'unknown_agent'),
        tool,
        arguments: args && typeof args === 'object' ? (args as Record<string, unknown>) : {},
      };
    })
    .sort((left, right) => left.seq - right.seq);
}

function eventsToJsonl(events: EventlineJsonlEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

function replayJsonlEvents(events: EventlineJsonlEvent[]): { graph: EventlineGraph; notices: string[] } {
  let graph = EMPTY_GRAPH;
  const notices: string[] = [];
  for (const event of events) {
    const result = applyToolCallToGraph(graph, jsonlEventToToolCall(event));
    graph = result.graph;
    if (result.notice) {
      notices.push(`seq ${event.seq}: ${result.notice}`);
    }
  }
  return { graph, notices };
}

function readStoredEvents(): EventlineJsonlEvent[] {
  const raw = window.localStorage.getItem(EVENTLINE_JSONL_STORAGE_KEY);
  return raw
    ? parseJsonlEvents(raw).filter((event) => EVENTLINE_TOOL_NAMES.includes(event.tool as ToolName))
    : [];
}

async function readEventFile(): Promise<EventlineJsonlEvent[]> {
  const response = await fetch(`${EVENTLINE_JSONL_ENDPOINT}?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to read events.jsonl: ${response.status}`);
  }
  const raw = await response.text();
  window.localStorage.setItem(EVENTLINE_JSONL_STORAGE_KEY, raw);
  return raw
    ? parseJsonlEvents(raw).filter((event) => EVENTLINE_TOOL_NAMES.includes(event.tool as ToolName))
    : [];
}

async function writeEventFile(jsonl: string): Promise<void> {
  const response = await fetch(EVENTLINE_JSONL_ENDPOINT, {
    method: 'PUT',
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    body: jsonl,
  });
  if (!response.ok) {
    throw new Error(`Failed to write events.jsonl: ${response.status}`);
  }
}

function writeStoredEvents(events: EventlineJsonlEvent[]): string {
  const jsonl = eventsToJsonl(events);
  window.localStorage.setItem(EVENTLINE_JSONL_STORAGE_KEY, jsonl);
  void writeEventFile(jsonl).catch((error) => console.warn(error));
  return jsonl;
}

function readStoredLayout(): Record<string, { x: number; y: number }> {
  const raw = window.localStorage.getItem(EVENTLINE_LAYOUT_STORAGE_KEY);
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const layout: Record<string, { x: number; y: number }> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const position = normalizePosition(value);
    if (position) {
      layout[id] = position;
    }
  }
  return layout;
}

function applyStoredLayout(graph: EventlineGraph, layout: Record<string, { x: number; y: number }>): EventlineGraph {
  const entries = Object.entries(layout).filter(([id]) => Boolean(graph.nodes[id]));
  if (entries.length === 0) {
    return graph;
  }
  const nodes = { ...graph.nodes };
  for (const [id, position] of entries) {
    nodes[id] = {
      ...nodes[id],
      position,
    };
  }
  return { ...graph, nodes };
}

function writeStoredLayout(layout: Record<string, { x: number; y: number }>): void {
  window.localStorage.setItem(EVENTLINE_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
}

function clearStoredLayout(): void {
  window.localStorage.removeItem(EVENTLINE_LAYOUT_STORAGE_KEY);
}

function jsonlLines(jsonl: string): string[] {
  return jsonl.split(/\r?\n/).filter(Boolean);
}

function parseAccessArgs(raw: string): EventlineAccessArgs {
  const parsed = JSON.parse(raw || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('eventline.access arguments must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  const mode = normalizeString(record.mode, 'full');
  if (!['full', 'brief'].includes(mode)) {
    throw new Error('eventline.access mode must be "full" or "brief".');
  }
  const treeId = readAlias(record, ['treeId', 'tree_id']) || undefined;
  const nodeId = readAlias(record, ['nodeId', 'node_id', 'id']) || undefined;
  if (treeId && nodeId) {
    throw new Error('eventline.access accepts either treeId or nodeId, not both.');
  }
  if (nodeId && mode === 'brief') {
    throw new Error('eventline.access nodeId lookup only supports mode "full".');
  }
  return {
    mode: mode as AccessMode,
    treeId,
    nodeId,
  };
}

function edgeLine(edge: EventEdgeRecord): string {
  return edge.label
    ? `${edge.source} --(${edge.label})--> ${edge.target}`
    : `${edge.source} --> ${edge.target}`;
}

function formatTreeSummary(tree: TreeRecord): string {
  return `${tree.id}: ${tree.title}`;
}

function formatTreeDetails(tree: TreeRecord): string[] {
  return [
    `### ${tree.id}`,
    `title: ${tree.title}`,
    `created_by: ${tree.createdBy}`,
    `created_at: ${tree.createdAt}`,
  ];
}

function formatExternalTreeMarker(node: EventNodeRecord, primaryTreeId?: string): string {
  return primaryTreeId && node.treeId !== primaryTreeId ? ` (from-tree: ${node.treeId})` : '';
}

function formatNodeRef(node: EventNodeRecord, primaryTreeId?: string): string {
  return `${node.id}${formatExternalTreeMarker(node, primaryTreeId)}: ${node.title}`;
}

function formatAttachment(attachment: EventAttachment): string {
  return `  - ${attachment.type}: ${attachment.label} -> ${attachment.uri}`;
}

function formatFullNode(node: EventNodeRecord, primaryTreeId?: string): string[] {
  const lines = [
    `### ${node.id}${formatExternalTreeMarker(node, primaryTreeId)}`,
    `tree: ${node.treeId}`,
    `title: ${node.title}`,
    `icon: ${node.icon || 'default'}`,
    `edited_by: ${node.updatedBy}`,
    `updated_at: ${node.updatedAt}`,
    `detail: ${node.detail}`,
  ];
  if (node.attachments.length > 0) {
    lines.push('attachments:', ...node.attachments.map(formatAttachment));
  }
  if (node.versions.length > 1) {
    lines.push(`previous_versions: ${node.versions.length - 1}`);
  }
  return lines;
}

function reachableNodeIdsForTree(graph: EventlineGraph, treeId: string): Set<string> {
  const ids = new Set(Object.values(graph.nodes).filter((node) => node.treeId === treeId).map((node) => node.id));
  for (const edge of Object.values(graph.edges)) {
    const sourceInTree = graph.nodes[edge.source]?.treeId === treeId;
    const targetInTree = graph.nodes[edge.target]?.treeId === treeId;
    if (sourceInTree || targetInTree) {
      ids.add(edge.source);
      ids.add(edge.target);
    }
  }
  return ids;
}

function orderedNodesForIds(graph: EventlineGraph, ids: Set<string>): EventNodeRecord[] {
  return Object.values(graph.nodes)
    .filter((node) => ids.has(node.id))
    .sort((left, right) => {
      if (left.treeId !== right.treeId) {
        return graph.treeOrder.indexOf(left.treeId) - graph.treeOrder.indexOf(right.treeId);
      }
      if (left.position.y !== right.position.y) {
        return left.position.y - right.position.y;
      }
      if (left.position.x !== right.position.x) {
        return left.position.x - right.position.x;
      }
      return left.id.localeCompare(right.id);
    });
}

function formatTreeNodeSection(
  graph: EventlineGraph,
  treeId: string,
  nodes: EventNodeRecord[],
  mode: AccessMode,
  primaryTreeId?: string,
): string[] {
  const lines = [`### ${treeId}`];
  if (mode === 'brief') {
    lines.push(...nodes.map((node) => `- ${formatNodeRef(node, primaryTreeId)}`));
    return lines;
  }
  for (const node of nodes) {
    lines.push('', ...formatFullNode(node, primaryTreeId));
  }
  return lines;
}

function formatEdgeSection(edges: EventEdgeRecord[], heading?: string): string[] {
  const lines: string[] = [];
  if (heading) {
    lines.push(`### ${heading}`);
  }
  lines.push(...(edges.length > 0 ? edges.map((edge) => `- ${edgeLine(edge)}`) : ['(no edges)']));
  return lines;
}

function accessNodeMarkdown(graph: EventlineGraph, nodeId: string): string {
  const node = graph.nodes[nodeId];
  const lines = ['# Eventline State', '', '## nodes'];
  if (!node) {
    lines.push(`Node not found: ${nodeId}`);
    return lines.join('\n');
  }
  lines.push(...formatFullNode(node));
  return lines.join('\n');
}

function accessTreeMarkdown(graph: EventlineGraph, treeId: string, mode: AccessMode): string {
  const tree = graph.trees[treeId];
  const visibleNodeIds = reachableNodeIdsForTree(graph, treeId);
  const visibleEdges = Object.values(graph.edges).filter(
    (edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)
      && (graph.nodes[edge.source]?.treeId === treeId || graph.nodes[edge.target]?.treeId === treeId),
  );
  const visibleNodes = orderedNodesForIds(graph, visibleNodeIds);
  const lines = ['# Eventline State', ''];
  lines.push('## trees');
  if (tree) {
    lines.push(...formatTreeDetails(tree));
  } else {
    lines.push(`- ${treeId}: (tree not found)`);
  }
  lines.push('', '## nodes');
  if (mode === 'brief') {
    lines.push(...visibleNodes.map((node) => `- ${formatNodeRef(node, treeId)}`));
  } else {
    for (const node of visibleNodes) {
      lines.push('', ...formatFullNode(node, treeId));
    }
  }
  lines.push('', '## edges', ...formatEdgeSection(visibleEdges));
  return lines.join('\n');
}

function accessFullMarkdown(graph: EventlineGraph, mode: AccessMode): string {
  const lines = ['# Eventline State', '', '## trees'];
  for (const treeId of graph.treeOrder) {
    const tree = graph.trees[treeId];
    lines.push(...(tree ? formatTreeDetails(tree) : [`### ${treeId}`, `title: ${treeId}`]));
  }
  lines.push('', '## nodes');
  for (const treeId of graph.treeOrder) {
    const treeNodeIds = new Set(Object.values(graph.nodes).filter((node) => node.treeId === treeId).map((node) => node.id));
    const treeNodes = orderedNodesForIds(graph, treeNodeIds);
    lines.push(...formatTreeNodeSection(graph, treeId, treeNodes, mode));
  }
  const sameTreeEdgesByTree = graph.treeOrder.map((treeId) => ({
    treeId,
    edges: Object.values(graph.edges).filter(
      (edge) => edge.treeId === treeId && graph.nodes[edge.source]?.treeId === treeId && graph.nodes[edge.target]?.treeId === treeId,
    ),
  }));
  const crossTreeEdges = Object.values(graph.edges).filter(
    (edge) => graph.nodes[edge.source]?.treeId !== graph.nodes[edge.target]?.treeId,
  );
  lines.push('', '## edges');
  for (const { treeId, edges } of sameTreeEdgesByTree) {
    lines.push(...formatEdgeSection(edges, treeId));
  }
  if (crossTreeEdges.length > 0) {
    lines.push('', ...formatEdgeSection(crossTreeEdges, 'cross-tree'));
  }
  return lines.join('\n');
}

function accessEventline(graph: EventlineGraph, args: EventlineAccessArgs): string {
  if (args.nodeId) {
    return accessNodeMarkdown(graph, args.nodeId);
  }
  const mode = args.mode || 'full';
  if (args.treeId) {
    return accessTreeMarkdown(graph, args.treeId, mode);
  }
  return accessFullMarkdown(graph, mode);
}

function AccessMarkdownView({ markdown }: { markdown: string }) {
  const lines = markdown.split(/\r?\n/);
  return (
    <div className="access-markdown">
      {lines.map((line, index) => {
        const key = `access-line-${index}`;
        const trimmed = line.trim();
        if (!trimmed) {
          return <div key={key} className="access-md-space" />;
        }
        if (trimmed.startsWith('### ')) {
          return <h3 key={key}>{trimmed.slice(4)}</h3>;
        }
        if (trimmed.startsWith('## ')) {
          return <h2 key={key}>{trimmed.slice(3)}</h2>;
        }
        if (trimmed.startsWith('# ')) {
          return <h1 key={key}>{trimmed.slice(2)}</h1>;
        }
        if (trimmed.startsWith('- ')) {
          return (
            <div key={key} className={`access-md-list-item${line.startsWith('  ') ? ' is-nested' : ''}`}>
              <span className="access-md-bullet" />
              <span>{trimmed.slice(2)}</span>
            </div>
          );
        }
        const keyValue = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
        if (keyValue) {
          return (
            <div key={key} className="access-md-kv">
              <span>{keyValue[1]}</span>
              <strong>{keyValue[2]}</strong>
            </div>
          );
        }
        return <p key={key}>{trimmed}</p>;
      })}
    </div>
  );
}

function AccessResultPanel({ markdown, onClose }: { markdown: string; onClose: () => void }) {
  return (
    <section className="access-result-panel" aria-label="eventline access result">
      <div className="access-result-head">
        <span>eventline.access result</span>
        <button type="button" aria-label="Close eventline access result" onClick={onClose}>×</button>
      </div>
      <AccessMarkdownView markdown={markdown} />
    </section>
  );
}

function isPositionNodeChange(change: NodeChange<EventFlowNode>): change is Extract<NodeChange<EventFlowNode>, { type: 'position' }> {
  return change.type === 'position' && Boolean(change.position);
}

function overlapArea(left: RectLike, right: RectLike): number {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  return width * height;
}

function overflowPenalty(rect: RectLike, boundary: RectLike): number {
  return Math.max(0, boundary.left - rect.left)
    + Math.max(0, rect.right - boundary.right)
    + Math.max(0, boundary.top - rect.top)
    + Math.max(0, rect.bottom - boundary.bottom);
}

function handleId(type: 'source' | 'target', side: EdgeSide): string {
  return `${type}-${side}`;
}

function nodeCenter(node: EventNodeRecord): { x: number; y: number } {
  return {
    x: node.position.x + NODE_WIDTH / 2,
    y: node.position.y + NODE_HEIGHT / 2,
  };
}

function hasVerticalNodeCollision(
  graph: EventlineGraph,
  edge: EventEdgeRecord,
  routeX: number,
  sourceY: number,
  targetY: number,
): boolean {
  const top = Math.min(sourceY, targetY) + NODE_HEIGHT / 2;
  const bottom = Math.max(sourceY, targetY) - NODE_HEIGHT / 2;
  return Object.values(graph.nodes).some((node) => {
    if (node.id === edge.source || node.id === edge.target) {
      return false;
    }
    const nodeLeft = node.position.x - 16;
    const nodeRight = node.position.x + NODE_WIDTH + 16;
    const nodeTop = node.position.y - 16;
    const nodeBottom = node.position.y + NODE_HEIGHT + 16;
    return routeX >= nodeLeft && routeX <= nodeRight && bottom >= nodeTop && top <= nodeBottom;
  });
}

function chooseVerticalRouteX(
  graph: EventlineGraph,
  edge: EventEdgeRecord,
  sourceCenterX: number,
  sourceCenterY: number,
  targetCenterX: number,
  targetCenterY: number,
): number {
  const midX = (sourceCenterX + targetCenterX) / 2;
  const nearOffset = NODE_WIDTH + 28;
  const farOffset = NODE_WIDTH + 78;
  const candidates = Array.from(new Set([
    Math.round(midX),
    Math.round(sourceCenterX),
    Math.round(targetCenterX),
    Math.round(Math.max(sourceCenterX, targetCenterX) + nearOffset),
    Math.round(Math.min(sourceCenterX, targetCenterX) - nearOffset),
    Math.round(Math.max(sourceCenterX, targetCenterX) + farOffset),
    Math.round(Math.min(sourceCenterX, targetCenterX) - farOffset),
  ]));

  return candidates
    .map((candidate, index) => {
      const collision = hasVerticalNodeCollision(graph, edge, candidate, sourceCenterY, targetCenterY);
      const detour = Math.abs(candidate - sourceCenterX) + Math.abs(candidate - targetCenterX);
      return {
        candidate,
        index,
        score: (collision ? 100000 : 0) + detour + index * 0.01,
      };
    })
    .sort((left, right) => left.score - right.score)[0]?.candidate || midX;
}

function findVerticalBridgeYs(graph: EventlineGraph, edge: EventEdgeRecord, routeX: number): number[] {
  const sourceNode = graph.nodes[edge.source];
  const targetNode = graph.nodes[edge.target];
  if (!sourceNode || !targetNode) {
    return [];
  }

  const sourceCenter = nodeCenter(sourceNode);
  const targetCenter = nodeCenter(targetNode);
  const top = Math.min(sourceCenter.y, targetCenter.y) + NODE_HEIGHT;
  const bottom = Math.max(sourceCenter.y, targetCenter.y) - NODE_HEIGHT;
  const values: number[] = [];

  for (const otherEdge of Object.values(graph.edges)) {
    if (otherEdge.id === edge.id) {
      continue;
    }
    const otherSource = graph.nodes[otherEdge.source];
    const otherTarget = graph.nodes[otherEdge.target];
    if (!otherSource || !otherTarget) {
      continue;
    }
    const otherSourceCenter = nodeCenter(otherSource);
    const otherTargetCenter = nodeCenter(otherTarget);
    if (Math.abs(otherSourceCenter.y - otherTargetCenter.y) > 8) {
      continue;
    }
    const horizontalY = otherSourceCenter.y;
    const horizontalLeft = Math.min(otherSourceCenter.x, otherTargetCenter.x) + NODE_WIDTH / 2;
    const horizontalRight = Math.max(otherSourceCenter.x, otherTargetCenter.x) - NODE_WIDTH / 2;
    if (routeX > horizontalLeft && routeX < horizontalRight && horizontalY > top && horizontalY < bottom) {
      values.push(horizontalY);
    }
  }

  return values
    .sort((left, right) => left - right)
    .filter((value, index, list) => index === 0 || Math.abs(value - list[index - 1]) > 18);
}

function buildEdgeRenderData(graph: EventlineGraph, edge: EventEdgeRecord): EventEdgeRenderData {
  const sourceNode = graph.nodes[edge.source];
  const targetNode = graph.nodes[edge.target];
  if (!sourceNode || !targetNode) {
    return {
      ...edge,
      bridgeDirection: 1,
      bridgeYs: [],
      routeMode: 'horizontal',
      routeX: 0,
    };
  }

  const sourceCenter = nodeCenter(sourceNode);
  const targetCenter = nodeCenter(targetNode);
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const routeMode: EdgeRouteMode = sourceNode.treeId !== targetNode.treeId || Math.abs(dy) > Math.abs(dx) * 1.2
    ? 'vertical'
    : 'horizontal';
  if (routeMode === 'horizontal') {
    return {
      ...edge,
      bridgeDirection: 1,
      bridgeYs: [],
      routeMode,
      routeX: 0,
    };
  }

  const routeX = chooseVerticalRouteX(graph, edge, sourceCenter.x, sourceCenter.y, targetCenter.x, targetCenter.y);
  return {
    ...edge,
    bridgeDirection: routeX >= (sourceCenter.x + targetCenter.x) / 2 ? 1 : -1,
    bridgeYs: findVerticalBridgeYs(graph, edge, routeX),
    routeMode,
    routeX,
  };
}

function EventNodeComponent({ data }: { data: EventNodeData }) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<TooltipPosition>(DEFAULT_TOOLTIP_POSITION);
  const emojiIcons = emojiIconsFor(data.icon);
  const Icon = emojiIcons.length === 0 ? (IconByName[data.icon || 'default'] || IconByName.default) : null;
  const updateTooltipPlacement = useCallback(() => {
    const nodeElement = nodeRef.current;
    const tooltipElement = tooltipRef.current;
    if (!nodeElement || !tooltipElement) {
      return;
    }

    const nodeRect = nodeElement.getBoundingClientRect();
    const canvasRect = nodeElement.closest<HTMLElement>('.flow-shell')?.getBoundingClientRect() || {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      width: window.innerWidth,
      height: window.innerHeight,
    };
    const scale = nodeElement.offsetWidth > 0 ? nodeRect.width / nodeElement.offsetWidth : 1;
    const tooltipWidth = tooltipElement.offsetWidth || 360;
    const tooltipHeight = tooltipElement.offsetHeight || 220;
    const nodeWidth = nodeElement.offsetWidth || NODE_WIDTH;
    const nodeHeight = nodeElement.offsetHeight || NODE_HEIGHT;
    const candidates: TooltipPosition[] = [
      DEFAULT_TOOLTIP_POSITION,
      { left: nodeWidth - 12, top: -tooltipHeight - TOOLTIP_GAP, placement: 'top-right' },
      { left: nodeWidth + TOOLTIP_GAP, top: (nodeHeight - tooltipHeight) / 2, placement: 'right' },
      { left: 12 - tooltipWidth, top: nodeHeight - 12, placement: 'bottom-left' },
      { left: 12 - tooltipWidth, top: -tooltipHeight - TOOLTIP_GAP, placement: 'top-left' },
      { left: -tooltipWidth - TOOLTIP_GAP, top: (nodeHeight - tooltipHeight) / 2, placement: 'left' },
      { left: (nodeWidth - tooltipWidth) / 2, top: nodeHeight + TOOLTIP_GAP, placement: 'bottom' },
      { left: (nodeWidth - tooltipWidth) / 2, top: -tooltipHeight - TOOLTIP_GAP, placement: 'top' },
    ];
    const visibleTooltips = Array.from(
      document.querySelectorAll<HTMLElement>('.event-node.is-pinned .event-tooltip, .event-node:hover .event-tooltip'),
    )
      .filter((element) => element !== tooltipElement)
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const best = candidates
      .map((candidate, index) => {
        const screenRect: RectLike = {
          left: nodeRect.left + candidate.left * scale,
          top: nodeRect.top + candidate.top * scale,
          right: nodeRect.left + (candidate.left + tooltipWidth) * scale,
          bottom: nodeRect.top + (candidate.top + tooltipHeight) * scale,
          width: tooltipWidth * scale,
          height: tooltipHeight * scale,
        };
        const overlap = visibleTooltips.reduce((sum, rect) => sum + overlapArea(screenRect, rect), 0);
        const overflow = overflowPenalty(screenRect, canvasRect);
        return {
          candidate,
          index,
          score: overlap * 8 + overflow * 1200,
        };
      })
      .sort((left, right) => left.score - right.score || left.index - right.index)[0]?.candidate || DEFAULT_TOOLTIP_POSITION;

    setTooltipPosition(best);
  }, []);
  const scheduleTooltipPlacement = useCallback(() => {
    window.requestAnimationFrame(updateTooltipPlacement);
  }, [updateTooltipPlacement]);
  useLayoutEffect(() => {
    if (!data.isPinned) {
      return undefined;
    }
    const frameId = window.requestAnimationFrame(updateTooltipPlacement);
    window.addEventListener('resize', updateTooltipPlacement);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', updateTooltipPlacement);
    };
  }, [data.detail, data.isPinned, data.attachments.length, updateTooltipPlacement]);
  const tooltipStyle = {
    '--event-tooltip-left': `${Math.round(tooltipPosition.left)}px`,
    '--event-tooltip-top': `${Math.round(tooltipPosition.top)}px`,
  } as CSSProperties;
  const nodeStyle = {
    '--event-tree-highlight': data.treeHighlightColor,
  } as CSSProperties;
  return (
    <div
      ref={nodeRef}
      className={`event-node ${data.isPinned ? 'is-pinned' : ''} ${data.isChanged ? 'is-changed' : ''} ${data.isTreeHighlighted ? 'is-tree-highlighted' : ''}`}
      style={nodeStyle}
      aria-label={`${data.title} ${data.updatedBy} ${data.versionId}`}
      onMouseEnter={scheduleTooltipPlacement}
      onClick={(event) => {
        event.stopPropagation();
        data.onTogglePinned(data.id);
      }}
    >
      <div className="event-node-shell">
        <div className="event-node-inner">
          <Handle id="target-left" type="target" position={Position.Left} className="event-handle event-handle-left" />
          <Handle id="source-left" type="source" position={Position.Left} className="event-handle event-handle-left" />
          <Handle id="target-top" type="target" position={Position.Top} className="event-handle event-handle-top" />
          <Handle id="source-top" type="source" position={Position.Top} className="event-handle event-handle-top" />
          <div className="event-node-body">
            <div className={`event-node-icon ${emojiIcons.length > 0 ? 'is-emoji' : ''}`}>
              {Icon ? <Icon size={22} strokeWidth={2.4} /> : (
                <div className={`event-emoji-stack emoji-count-${emojiIcons.length}`} aria-hidden="true">
                  {emojiIcons.map((emoji, index) => (
                    <span key={`${emoji}:${index}`} className="event-emoji">
                      {emoji}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <Handle id="target-right" type="target" position={Position.Right} className="event-handle event-handle-right" />
          <Handle id="source-right" type="source" position={Position.Right} className="event-handle event-handle-right" />
          <Handle id="target-bottom" type="target" position={Position.Bottom} className="event-handle event-handle-bottom" />
          <Handle id="source-bottom" type="source" position={Position.Bottom} className="event-handle event-handle-bottom" />
        </div>
      </div>
      <div
        ref={tooltipRef}
        className="event-tooltip nodrag nowheel"
        data-placement={tooltipPosition.placement}
        style={tooltipStyle}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="event-tooltip-head">
          <span>{data.title}</span>
          <span className="event-tooltip-agent">{data.updatedBy}</span>
        </div>
        <div className="event-tooltip-detail">{data.detail}</div>
        {data.attachments.length > 0 ? (
          <div className="event-tooltip-attachments">
            {data.attachments.map((attachment) => (
              attachment.type === 'image' ? (
                <figure key={`${attachment.type}:${attachment.uri}`} className="event-attachment-image">
                  <img src={attachment.uri} alt={attachment.label} />
                  <figcaption>{attachment.label}</figcaption>
                </figure>
              ) : (
                <div key={`${attachment.type}:${attachment.uri}`} className="event-attachment-file">
                  <FileText size={13} />
                  <span>{attachment.label}</span>
                  <AttachmentUri uri={attachment.uri} />
                </div>
              )
            ))}
          </div>
        ) : null}
        <div className="event-tooltip-foot">
          <span>更新 {displayDate(data.updatedAt)} ({data.id}::{data.versionId})</span>
        </div>
      </div>
    </div>
  );
}

function AttachmentUri({ uri }: { uri: string }) {
  const codeRef = useRef<HTMLElement | null>(null);
  const [displayUri, setDisplayUri] = useState(uri);

  const updateDisplayUri = useCallback(() => {
    const element = codeRef.current;
    if (!element) {
      return;
    }

    const availableWidth = element.clientWidth;
    if (availableWidth <= 0) {
      return;
    }

    const style = window.getComputedStyle(element);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    context.font = style.font;
    if (context.measureText(uri).width <= availableWidth) {
      setDisplayUri(uri);
      return;
    }

    const prefixWidth = context.measureText(ATTACHMENT_URI_PREFIX).width;
    let low = 0;
    let high = uri.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = uri.slice(-mid);
      const width = prefixWidth + context.measureText(candidate).width;
      if (width <= availableWidth) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    setDisplayUri(`${ATTACHMENT_URI_PREFIX}${uri.slice(-low)}`);
  }, [uri]);

  useLayoutEffect(() => {
    updateDisplayUri();
    const element = codeRef.current;
    if (!element) {
      return undefined;
    }

    const observer = new ResizeObserver(updateDisplayUri);
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateDisplayUri]);

  return (
    <code ref={codeRef} title={uri}>
      {displayUri}
    </code>
  );
}

function EventEdgeComponent(props: EdgeProps<EventFlowEdge>) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    markerEnd,
    data,
  } = props;
  const edgePath = data?.routeMode === 'vertical'
    ? buildVerticalEdgePath(sourceX, sourceY, targetX, targetY, data.routeX, data.bridgeYs, data.bridgeDirection)
    : buildHorizontalEdgePath(sourceX, sourceY, targetX, targetY);
  const labelX = data?.routeMode === 'vertical' ? data.routeX : (sourceX + targetX) / 2;
  const labelY = (sourceY + targetY) / 2;

  return (
    <>
      <path id={`${id}-base`} className="event-edge-base" d={edgePath} markerEnd={markerEnd} />
      <path id={id} className="event-edge-flow" d={edgePath} markerEnd={markerEnd} />
      {data?.label ? (
        <EdgeLabelRenderer>
          <div
            className="event-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

function buildHorizontalEdgePath(sourceX: number, sourceY: number, targetX: number, targetY: number): string {
  const horizontalDirection = targetX >= sourceX ? 1 : -1;
  const horizontalGap = Math.max(Math.abs(targetX - sourceX), 24);
  const verticalGap = targetY - sourceY;
  const isSameLane = Math.abs(verticalGap) < 8;
  const controlRadius = Math.min(Math.max(horizontalGap * 0.42, 24), 96);
  const cornerRadius = Math.min(32, Math.abs(verticalGap) / 2, Math.max(horizontalGap / 3, 16));
  const routeX = sourceX
    + horizontalDirection * Math.min(Math.max(horizontalGap * 0.45, 38), Math.max(horizontalGap - cornerRadius, 38));
  const verticalDirection = verticalGap >= 0 ? 1 : -1;
  return isSameLane
    ? [
        `M ${sourceX},${sourceY}`,
        `C ${sourceX + horizontalDirection * controlRadius},${sourceY}`,
        `${targetX - horizontalDirection * controlRadius},${targetY}`,
        `${targetX},${targetY}`,
      ].join(' ')
    : [
        `M ${sourceX},${sourceY}`,
        `L ${routeX - horizontalDirection * cornerRadius},${sourceY}`,
        `Q ${routeX},${sourceY} ${routeX},${sourceY + verticalDirection * cornerRadius}`,
        `L ${routeX},${targetY - verticalDirection * cornerRadius}`,
        `Q ${routeX},${targetY} ${routeX + horizontalDirection * cornerRadius},${targetY}`,
        `L ${targetX},${targetY}`,
      ].join(' ');
}

function buildVerticalEdgePath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  routeX: number,
  bridgeYs: number[],
  bridgeDirection: 1 | -1,
): string {
  const verticalDirection = targetY >= sourceY ? 1 : -1;
  const sourceLead = Math.min(68, Math.max(34, Math.abs(targetY - sourceY) * 0.12));
  const targetLead = Math.min(68, Math.max(34, Math.abs(targetY - sourceY) * 0.12));
  const bridgeHalfHeight = 9;
  const bridgeWidth = 11;
  const sortedBridgeYs = bridgeYs
    .filter((bridgeY) => verticalDirection > 0 ? bridgeY > sourceY + sourceLead && bridgeY < targetY - targetLead : bridgeY < sourceY - sourceLead && bridgeY > targetY + targetLead)
    .sort((left, right) => verticalDirection > 0 ? left - right : right - left);

  const path = [
    `M ${sourceX},${sourceY}`,
    `C ${sourceX},${sourceY + verticalDirection * sourceLead}`,
    `${routeX},${sourceY + verticalDirection * sourceLead}`,
    `${routeX},${sourceY + verticalDirection * sourceLead * 2}`,
  ];

  for (const bridgeY of sortedBridgeYs) {
    path.push(`L ${routeX},${bridgeY - verticalDirection * bridgeHalfHeight}`);
    path.push(`Q ${routeX + bridgeDirection * bridgeWidth},${bridgeY} ${routeX},${bridgeY + verticalDirection * bridgeHalfHeight}`);
  }

  path.push(`L ${routeX},${targetY - verticalDirection * targetLead * 2}`);
  path.push(
    `C ${routeX},${targetY - verticalDirection * targetLead}`,
    `${targetX},${targetY - verticalDirection * targetLead}`,
    `${targetX},${targetY}`,
  );

  return path.join(' ');
}

const nodeTypes = {
  eventNode: EventNodeComponent,
};

const edgeTypes = {
  eventEdge: EventEdgeComponent,
};

function buildFlowNodes(
  graph: EventlineGraph,
  changedNodeIds: Set<string>,
  pinnedNodeIds: Set<string>,
  visibleTreeIds: Set<string>,
  highlightedTreeIds: Set<string>,
  onTogglePinned: (nodeId: string) => void,
): EventFlowNode[] {
  return Object.values(graph.nodes).filter((node) => visibleTreeIds.has(node.treeId)).map((node) => ({
    id: node.id,
    type: 'eventNode',
    position: node.position,
    data: {
      ...node,
      isChanged: changedNodeIds.has(node.id),
      isPinned: pinnedNodeIds.has(node.id),
      isTreeHighlighted: highlightedTreeIds.has(node.treeId),
      treeHighlightColor: treeHighlightColor(graph.treeOrder.indexOf(node.treeId)),
      onTogglePinned,
    },
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    zIndex: pinnedNodeIds.has(node.id) ? 2000 : 10,
    draggable: true,
    deletable: false,
    selectable: true,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  }));
}

function buildFlowEdges(graph: EventlineGraph, visibleTreeIds: Set<string>): EventFlowEdge[] {
  return Object.values(graph.edges).filter((edge) => {
    const sourceNode = graph.nodes[edge.source];
    const targetNode = graph.nodes[edge.target];
    return Boolean(sourceNode && targetNode && visibleTreeIds.has(sourceNode.treeId) && visibleTreeIds.has(targetNode.treeId));
  }).map((edge) => ({
    ...(() => {
      const sourceNode = graph.nodes[edge.source];
      const targetNode = graph.nodes[edge.target];
      const renderData = buildEdgeRenderData(graph, edge);
      const sourceCenter = sourceNode ? nodeCenter(sourceNode) : { x: 0, y: 0 };
      const targetCenter = targetNode ? nodeCenter(targetNode) : { x: 0, y: 0 };
      let sourceSide: EdgeSide = 'right';
      let targetSide: EdgeSide = 'left';
      if (renderData.routeMode === 'vertical') {
        sourceSide = targetCenter.y >= sourceCenter.y ? 'bottom' : 'top';
        targetSide = targetCenter.y >= sourceCenter.y ? 'top' : 'bottom';
      } else if (targetCenter.x < sourceCenter.x) {
        sourceSide = 'left';
        targetSide = 'right';
      }
      return {
        id: edge.id,
        type: 'eventEdge',
        source: edge.source,
        target: edge.target,
        sourceHandle: handleId('source', sourceSide),
        targetHandle: handleId('target', targetSide),
        data: renderData,
        animated: true,
        deletable: false,
        focusable: false,
        markerEnd: 'eventline-arrow',
      };
    })(),
  }));
}

function TreeFilterMenu({
  graph,
  visibleTreeIds,
  highlightedTreeIds,
  onToggleVisible,
  onToggleAllVisible,
  onToggleHighlight,
}: {
  graph: EventlineGraph;
  visibleTreeIds: Set<string>;
  highlightedTreeIds: Set<string>;
  onToggleVisible: (treeId: string) => void;
  onToggleAllVisible: () => void;
  onToggleHighlight: (treeId: string) => void;
}) {
  const treeItems = graph.treeOrder
    .map((treeId) => graph.trees[treeId])
    .filter((tree): tree is TreeRecord => Boolean(tree));
  const allVisible = treeItems.length > 0 && treeItems.every((tree) => visibleTreeIds.has(tree.id));
  return (
    <details className="tree-filter-menu">
      <summary>
        <GitBranch size={14} />
        Tree
      </summary>
      <div className="tree-filter-list">
        <label className="tree-filter-all">
          <input
            type="checkbox"
            checked={allVisible}
            onChange={onToggleAllVisible}
          />
          <span>Show all trees</span>
        </label>
        {treeItems.length > 0 ? treeItems.map((tree) => {
          const nodeCount = Object.values(graph.nodes).filter((node) => node.treeId === tree.id).length;
          const highlightColor = treeHighlightColor(graph.treeOrder.indexOf(tree.id));
          const itemStyle = { '--event-tree-highlight': highlightColor } as CSSProperties;
          return (
            <div
              key={tree.id}
              className={`tree-filter-item ${highlightedTreeIds.has(tree.id) ? 'is-highlighted' : ''}`}
              style={itemStyle}
              role="button"
              tabIndex={0}
              onClick={() => onToggleHighlight(tree.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onToggleHighlight(tree.id);
                }
              }}
            >
              <input
                type="checkbox"
                checked={visibleTreeIds.has(tree.id)}
                aria-label={`Show ${tree.title}`}
                onClick={(event) => event.stopPropagation()}
                onChange={() => onToggleVisible(tree.id)}
              />
              <span className="tree-filter-copy">
                <strong>{tree.title}</strong>
                <code>{tree.id}</code>
              </span>
              <span className="tree-filter-count">{nodeCount}</span>
            </div>
          );
        }) : (
          <div className="tree-filter-empty">No trees</div>
        )}
      </div>
    </details>
  );
}

function ToolSchemaItem({
  item,
  value,
  error,
  onChange,
  onRun,
}: {
  item: ToolSchemaItemDefinition;
  value: string;
  error: string;
  onChange: (value: string) => void;
  onRun: () => void;
}) {
  return (
    <details className="schema-tool">
      <summary>
        <span>{item.title}</span>
        <span>{item.kind}</span>
      </summary>
      <div className="schema-tool-body">
        {item.description ? <p className="schema-description">{item.description}</p> : null}
        <pre className="schema-block">{item.schema}</pre>
        <div className="schema-test-head">
          <h3>Test Call</h3>
          <button type="button" onClick={onRun}>Run</button>
        </div>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          className="schema-test-input"
        />
        {error ? <div className="tool-error schema-test-error">{error}</div> : null}
      </div>
    </details>
  );
}

function ToolPanel({
  graph,
  script,
  eventJsonl,
  selectedNode,
  toolSchemaItems,
  schemaTestInputs,
  schemaTestErrors,
  isPlaying,
  playIndex,
  onSchemaTestInputChange,
  onRunSchemaTest,
  onReplaySample,
  onReplayCurrent,
  onStopPlayback,
  onResetLayout,
}: {
  graph: EventlineGraph;
  script: EventlineReplayCall[];
  eventJsonl: string;
  selectedNode: EventNodeRecord | null;
  toolSchemaItems: ToolSchemaItemDefinition[];
  schemaTestInputs: Record<string, string>;
  schemaTestErrors: Record<string, string>;
  isPlaying: boolean;
  playIndex: number;
  onSchemaTestInputChange: (toolId: string, value: string) => void;
  onRunSchemaTest: (toolId: string) => void;
  onReplaySample: () => void;
  onReplayCurrent: () => void;
  onStopPlayback: () => void;
  onResetLayout: () => void;
}) {
  const eventLines = jsonlLines(eventJsonl);
  const eventCount = eventLines.length;

  return (
    <aside className="tool-panel">
      <div className="tool-panel-section tool-panel-top">
        <div>
          <h1>Eventline</h1>
          <p>project-level event graph demo</p>
        </div>
        <div className="tool-stat-row">
          <span>{Object.keys(graph.nodes).length} nodes</span>
          <span>{Object.keys(graph.edges).length} lines</span>
          <span>{graph.treeOrder.length} trees</span>
        </div>
      </div>

      <div className="tool-panel-section">
        <div className="section-head">
          <h2>Playback</h2>
          {isPlaying ? <span className="playback-index">step {playIndex + 1}</span> : null}
        </div>
        <div className="tool-actions">
          <button type="button" className="primary-action" onClick={onReplaySample} disabled={isPlaying}>
            <Play size={14} />
            Sample
          </button>
          <button type="button" onClick={onReplayCurrent} disabled={isPlaying || script.length === 0}>
            <RotateCcw size={14} />
            Current
          </button>
          <button type="button" onClick={onStopPlayback} disabled={!isPlaying}>
            <Square size={14} />
            Stop
          </button>
          <button type="button" onClick={onResetLayout}>
            Reset Layout
          </button>
        </div>
      </div>

      <div className="tool-panel-section jsonl-panel">
        <input id="eventline-jsonl-toggle" className="jsonl-checkbox" type="checkbox" />
        <label className="jsonl-toggle" htmlFor="eventline-jsonl-toggle">
          <span>events.jsonl</span>
          <span>{eventCount} lines</span>
        </label>
        <div className="jsonl-viewer" role="log" aria-label="events.jsonl preview">
          {eventLines.length > 0 ? (
            eventLines.map((line, index) => (
              <div className="jsonl-line" key={`${index}:${line.slice(0, 48)}`}>
                <span className="jsonl-line-number" aria-hidden="true">{index + 1}</span>
                <code>{line}</code>
              </div>
            ))
          ) : (
            <div className="jsonl-empty">empty event log</div>
          )}
        </div>
      </div>

      <div className="tool-panel-section">
        <div className="section-head">
          <h2>Tool Schema</h2>
        </div>
        <div className="schema-tool-list">
          {toolSchemaItems.map((item) => (
            <ToolSchemaItem
              key={item.id}
              item={item}
              value={schemaTestInputs[item.id] || item.testInput}
              error={schemaTestErrors[item.id] || ''}
              onChange={(value) => onSchemaTestInputChange(item.id, value)}
              onRun={() => onRunSchemaTest(item.id)}
            />
          ))}
        </div>
      </div>

      <div className="tool-panel-section selected-node-panel">
        <div className="section-head">
          <h2>Selected Node</h2>
          {selectedNode ? <code>{selectedNode.versionId}</code> : null}
        </div>
        {selectedNode ? (
          <>
            <div className="selected-title">{selectedNode.title}</div>
            <div className="selected-meta">{selectedNode.updatedBy} · {displayDate(selectedNode.updatedAt)}</div>
            <div className="version-list">
              {selectedNode.versions.slice().reverse().map((version) => (
                <div key={`${selectedNode.id}:${version.versionId}:${version.updatedAt}`} className="version-item">
                  <div>
                    <strong>{version.title}</strong>
                    <span>{version.updatedBy} · {displayDate(version.updatedAt)}</span>
                  </div>
                  <code>{version.versionId}</code>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="empty-selected">No node selected</div>
        )}
      </div>
    </aside>
  );
}

function EventlineCanvas() {
  const initialEvents = useMemo(() => {
    try {
      return readStoredEvents();
    } catch {
      return [];
    }
  }, []);
  const initialReplay = useMemo(() => replayJsonlEvents(initialEvents), [initialEvents]);
  const initialLayout = useMemo(() => {
    try {
      return readStoredLayout();
    } catch {
      return {};
    }
  }, []);
  const [eventLog, setEventLog] = useState<EventlineJsonlEvent[]>(initialEvents);
  const [eventJsonl, setEventJsonl] = useState(() => eventsToJsonl(initialEvents));
  const [layoutOverrides, setLayoutOverrides] = useState<Record<string, { x: number; y: number }>>(initialLayout);
  const [graph, setGraph] = useState<EventlineGraph>(() => applyStoredLayout(initialReplay.graph, initialLayout));
  const [script, setScript] = useState<EventlineReplayCall[]>(() => initialEvents.map(jsonlEventToToolCall));
  const [toolSchemaItems, setToolSchemaItems] = useState<ToolSchemaItemDefinition[]>(TOOL_SCHEMA_ITEMS);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [pinnedNodeIds, setPinnedNodeIds] = useState<Set<string>>(new Set());
  const [changedNodeIds, setChangedNodeIds] = useState<Set<string>>(new Set());
  const [schemaTestInputs, setSchemaTestInputs] = useState<Record<string, string>>(() => Object.fromEntries(
    TOOL_SCHEMA_ITEMS.map((item) => [item.id, item.testInput]),
  ));
  const [schemaTestErrors, setSchemaTestErrors] = useState<Record<string, string>>({});
  const [accessOutput, setAccessOutput] = useState(() => accessEventline(initialReplay.graph, { mode: 'full' }));
  const [isAccessResultOpen, setIsAccessResultOpen] = useState(false);
  const [parseError, setParseError] = useState(initialReplay.notices.join('\n'));
  const [isPlaying, setIsPlaying] = useState(false);
  const [playIndex, setPlayIndex] = useState(-1);
  const [theme, setTheme] = useState<EventlineTheme>('DARK');
  const [visibleTreeIds, setVisibleTreeIds] = useState<Set<string>>(() => new Set(initialReplay.graph.treeOrder));
  const [highlightedTreeIds, setHighlightedTreeIds] = useState<Set<string>>(new Set());
  const playbackRunRef = useRef(0);
  const knownTreeIdsRef = useRef<Set<string>>(new Set(initialReplay.graph.treeOrder));
  const treeVisibilityTouchedRef = useRef(false);
  const { fitView, zoomIn, setViewport } = useReactFlow();
  const themeRendering = THEME_RENDERING[theme];
  const graphTreeIds = useMemo(() => graph.treeOrder.filter((treeId) => Boolean(graph.trees[treeId])), [graph.treeOrder, graph.trees]);

  useEffect(() => {
    let cancelled = false;
    void readToolSchemaItems()
      .then((items) => {
        if (cancelled || items.length === 0) {
          return;
        }
        setToolSchemaItems(items);
        setSchemaTestInputs((prev) => {
          const next: Record<string, string> = {};
          for (const item of items) {
            next[item.id] = prev[item.id] || item.testInput;
          }
          return next;
        });
      })
      .catch((error) => {
        console.warn(error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setVisibleTreeIds((prev) => {
      const knownTreeIds = knownTreeIdsRef.current;
      if (!treeVisibilityTouchedRef.current) {
        return new Set(graphTreeIds);
      }
      return new Set(graphTreeIds.filter((treeId) => prev.has(treeId) || !knownTreeIds.has(treeId)));
    });
    knownTreeIdsRef.current = new Set(graphTreeIds);
    setHighlightedTreeIds((prev) => {
      return new Set(Array.from(prev).filter((treeId) => graphTreeIds.includes(treeId)));
    });
  }, [graphTreeIds]);

  const applyEventFileEvents = useCallback((events: EventlineJsonlEvent[]) => {
    const replayed = replayJsonlEvents(events);
    setEventLog(events);
    setEventJsonl(eventsToJsonl(events));
    setScript(events.map(jsonlEventToToolCall));
    setGraph(applyStoredLayout(replayed.graph, layoutOverrides));
    setParseError(replayed.notices.join('\n'));
  }, [layoutOverrides]);

  const markChanged = useCallback((ids: string[]) => {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    if (uniqueIds.length === 0) {
      return;
    }
    setChangedNodeIds((prev) => {
      const next = new Set(prev);
      uniqueIds.forEach((id) => next.add(id));
      return next;
    });
    window.setTimeout(() => {
      setChangedNodeIds((prev) => {
        const next = new Set(prev);
        uniqueIds.forEach((id) => next.delete(id));
        return next;
      });
    }, 1400);
  }, []);

  useLayoutEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const events = await readEventFile();
        if (!cancelled && eventsToJsonl(events) !== eventsToJsonl(eventLog)) {
          applyEventFileEvents(events);
        }
      } catch {
        // The standalone demo can still run without the dev file endpoint.
      }
    };
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [applyEventFileEvents, eventLog]);

  const replaceEventLog = useCallback((events: EventlineJsonlEvent[], changedIds: string[] = []) => {
    const replayed = replayJsonlEvents(events);
    const jsonl = writeStoredEvents(events);
    setEventLog(events);
    setEventJsonl(jsonl);
    setScript(events.map(jsonlEventToToolCall));
    setGraph(applyStoredLayout(replayed.graph, layoutOverrides));
    setParseError(replayed.notices.join('\n'));
    markChanged(changedIds);
  }, [layoutOverrides, markChanged]);

  const appendCallsToLog = useCallback((calls: EventlineToolCall[]) => {
    let nextGraph = graph;
    const changed: string[] = [];
    const notices: string[] = [];
    let seq = eventLog.reduce((max, event) => Math.max(max, event.seq), 0);
    const nextEvents = [...eventLog];
    for (const call of calls) {
      const event = toolCallToJsonlEvent(call, seq + 1);
      seq = event.seq;
      const result = applyToolCallToGraph(nextGraph, jsonlEventToToolCall(event));
      nextGraph = result.graph;
      nextEvents.push(event);
      changed.push(...result.changedNodeIds);
      if (result.notice) {
        notices.push(`seq ${event.seq}: ${result.notice}`);
      }
    }
    const jsonl = writeStoredEvents(nextEvents);
    setEventLog(nextEvents);
    setEventJsonl(jsonl);
    setGraph(applyStoredLayout(nextGraph, layoutOverrides));
    markChanged(changed);
    setScript(nextEvents.map(jsonlEventToToolCall));
    setParseError(notices.join('\n'));
  }, [eventLog, graph, layoutOverrides, markChanged]);

  const handleSchemaTestInputChange = useCallback((toolId: string, value: string) => {
    setSchemaTestInputs((prev) => ({
      ...prev,
      [toolId]: value,
    }));
    setSchemaTestErrors((prev) => ({
      ...prev,
      [toolId]: '',
    }));
  }, []);

  const handleRunSchemaTest = useCallback((toolId: string) => {
    const item = toolSchemaItems.find((candidate) => candidate.id === toolId);
    if (!item) {
      return;
    }
    const raw = schemaTestInputs[toolId] || item.testInput;
    try {
      if (item.kind === 'read') {
        const args = parseAccessToolCall(raw);
        setAccessOutput(accessEventline(graph, args));
        setIsAccessResultOpen(true);
        setSchemaTestErrors((prev) => ({
          ...prev,
          [toolId]: '',
        }));
        setParseError('');
        return;
      }
      const calls = parseToolCalls(raw);
      appendCallsToLog(calls);
      setSchemaTestErrors((prev) => ({
        ...prev,
        [toolId]: '',
      }));
      setParseError('');
    } catch (error) {
      setSchemaTestErrors((prev) => ({
        ...prev,
        [toolId]: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [appendCallsToLog, graph, schemaTestInputs, toolSchemaItems]);

  const runPlayback = useCallback(async (calls: EventlineReplayCall[]) => {
    const runId = playbackRunRef.current + 1;
    playbackRunRef.current = runId;
    setIsPlaying(true);
    setPlayIndex(-1);
    setActiveNodeId(null);
    setPinnedNodeIds(new Set());
    setGraph(EMPTY_GRAPH);
    await new Promise((resolve) => window.setTimeout(resolve, 360));

    let nextGraph = EMPTY_GRAPH;
    for (let index = 0; index < calls.length; index += 1) {
      if (playbackRunRef.current !== runId) {
        break;
      }
      const result = applyToolCallToGraph(nextGraph, calls[index]);
      nextGraph = result.graph;
      setGraph(nextGraph);
      setPlayIndex(index);
      markChanged(result.changedNodeIds);
      await new Promise((resolve) => window.setTimeout(resolve, 820));
    }

    if (playbackRunRef.current === runId) {
      setIsPlaying(false);
      setPlayIndex(-1);
      window.setTimeout(() => fitView({ padding: 0.18, duration: 500 }), 80);
    }
  }, [fitView, markChanged]);

  const handleReplaySample = useCallback(() => {
    const events = sampleScript.map((call, index) => toolCallToJsonlEvent(call, index + 1));
    replaceEventLog(events);
    void runPlayback(sampleScript);
  }, [replaceEventLog, runPlayback]);

  const handleReplayCurrent = useCallback(() => {
    void runPlayback(script);
  }, [runPlayback, script]);

  const handleStopPlayback = useCallback(() => {
    playbackRunRef.current += 1;
    setIsPlaying(false);
    setPlayIndex(-1);
  }, []);

  const handleResetLayout = useCallback(() => {
    clearStoredLayout();
    setLayoutOverrides({});
    setGraph(replayJsonlEvents(eventLog).graph);
  }, [eventLog]);

  const handleToggleTheme = useCallback(() => {
    setTheme((prev) => {
      const index = THEME_ORDER.indexOf(prev);
      return THEME_ORDER[(index + 1) % THEME_ORDER.length];
    });
  }, []);

  const handleToggleTreeVisible = useCallback((treeId: string) => {
    treeVisibilityTouchedRef.current = true;
    setVisibleTreeIds((prev) => {
      const next = new Set(prev);
      if (next.has(treeId)) {
        next.delete(treeId);
      } else {
        next.add(treeId);
      }
      return next;
    });
  }, []);

  const handleToggleAllTreeVisible = useCallback(() => {
    treeVisibilityTouchedRef.current = true;
    setVisibleTreeIds((prev) => {
      const allVisible = graphTreeIds.length > 0 && graphTreeIds.every((treeId) => prev.has(treeId));
      return allVisible ? new Set() : new Set(graphTreeIds);
    });
  }, [graphTreeIds]);

  const handleToggleHighlightTree = useCallback((treeId: string) => {
    setHighlightedTreeIds((prev) => {
      const next = new Set(prev);
      if (next.has(treeId)) {
        next.delete(treeId);
      } else {
        next.add(treeId);
      }
      return next;
    });
  }, []);

  const handleNodesChange = useCallback((changes: NodeChange<EventFlowNode>[]) => {
    const positionChanges = changes.filter(isPositionNodeChange);
    if (positionChanges.length === 0) {
      return;
    }
    setGraph((prev) => {
      let changed = false;
      const nextNodes = { ...prev.nodes };
      for (const change of positionChanges) {
        const node = nextNodes[change.id];
        if (!node || !change.position) {
          continue;
        }
        changed = true;
        nextNodes[change.id] = {
          ...node,
          position: { ...change.position },
        };
      }
      return changed ? { ...prev, nodes: nextNodes } : prev;
    });
  }, []);

  const handleNodeDragStop = useCallback((_event: unknown, node: EventFlowNode) => {
    const position = {
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
    };
    setLayoutOverrides((prev) => {
      const next = {
        ...prev,
        [node.id]: position,
      };
      writeStoredLayout(next);
      return next;
    });
  }, []);

  const handleNodeClick = useCallback((nodeId: string) => {
    setActiveNodeId(nodeId);
    setPinnedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const flowNodes = useMemo(
    () => buildFlowNodes(graph, changedNodeIds, pinnedNodeIds, visibleTreeIds, highlightedTreeIds, handleNodeClick),
    [changedNodeIds, graph, handleNodeClick, highlightedTreeIds, pinnedNodeIds, visibleTreeIds],
  );
  const flowEdges = useMemo(() => buildFlowEdges(graph, visibleTreeIds), [graph, visibleTreeIds]);
  const selectedNode = activeNodeId ? graph.nodes[activeNodeId] || null : null;

  return (
    <div className={`eventline-shell theme-${theme.toLowerCase()}`}>
      <main className="flow-shell">
        <div className="flow-toolbar">
          <div className="flow-toolbar-title">
            <Workflow size={16} />
            <span>Project Eventline</span>
          </div>
          <div className="flow-toolbar-actions">
            <TreeFilterMenu
              graph={graph}
              visibleTreeIds={visibleTreeIds}
              highlightedTreeIds={highlightedTreeIds}
              onToggleVisible={handleToggleTreeVisible}
              onToggleAllVisible={handleToggleAllTreeVisible}
              onToggleHighlight={handleToggleHighlightTree}
            />
            <button type="button" onClick={handleToggleTheme}>
              <Palette size={14} />
              {theme}
            </button>
            <button type="button" onClick={() => zoomIn({ duration: 240 })}>
              <ZoomIn size={14} />
              Zoom
            </button>
            <button type="button" onClick={() => fitView({ padding: 0.2, duration: 420 })}>
              Fit
            </button>
            <button type="button" onClick={() => setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 420 })}>
              Reset
            </button>
          </div>
        </div>
        {flowNodes.length === 0 ? (
          <div className="empty-canvas">
            <Sparkles size={18} />
            <span>empty eventline</span>
          </div>
        ) : null}
        {isAccessResultOpen ? (
          <AccessResultPanel markdown={accessOutput} onClose={() => setIsAccessResultOpen(false)} />
        ) : null}
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={handleNodesChange}
          onNodeDragStop={handleNodeDragStop}
          nodesDraggable
          nodesConnectable={false}
          edgesFocusable={false}
          deleteKeyCode={null}
          fitView
          minZoom={0.22}
          maxZoom={3}
          defaultViewport={{ x: 60, y: 60, zoom: 0.9 }}
        >
          <Background color={themeRendering.backgroundColor} gap={28} size={1} />
          <Controls showInteractive={false} className="eventline-controls" />
          <MiniMap
            pannable
            zoomable
            className="eventline-minimap"
            nodeColor={(node) => {
              const data = node.data as EventNodeData;
              if (data.icon === 'bug' || data.icon === 'alert') return themeRendering.minimapAlert;
              if (data.icon === 'verified' || data.icon === 'check') return themeRendering.minimapVerified;
              return themeRendering.minimapDefault;
            }}
          />
          <svg className="eventline-defs">
            <defs>
              <linearGradient id="event-edge-gradient" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={themeRendering.edgeStops[0]} />
                <stop offset="52%" stopColor={themeRendering.edgeStops[1]} />
                <stop offset="100%" stopColor={themeRendering.edgeStops[2]} />
              </linearGradient>
              <marker
                id="eventline-arrow"
                viewBox="0 0 12 12"
                refX="10"
                refY="6"
                markerWidth="3"
                markerHeight="3"
                orient="auto-start-reverse"
              >
                <path d="M2 2 L10 6 L2 10 Z" fill={themeRendering.arrow} fillOpacity="0.94" />
              </marker>
            </defs>
          </svg>
        </ReactFlow>
      </main>
      <ToolPanel
        graph={graph}
        script={script}
        eventJsonl={eventJsonl}
        selectedNode={selectedNode}
        toolSchemaItems={toolSchemaItems}
        schemaTestInputs={schemaTestInputs}
        schemaTestErrors={schemaTestErrors}
        isPlaying={isPlaying}
        playIndex={playIndex}
        onSchemaTestInputChange={handleSchemaTestInputChange}
        onRunSchemaTest={handleRunSchemaTest}
        onReplaySample={handleReplaySample}
        onReplayCurrent={handleReplayCurrent}
        onStopPlayback={handleStopPlayback}
        onResetLayout={handleResetLayout}
      />
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <EventlineCanvas />
    </ReactFlowProvider>
  );
}
