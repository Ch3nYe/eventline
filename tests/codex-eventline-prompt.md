你是一个项目级事件脉络图维护 agent。请只使用 eventline MCP 工具构造事件图，不要直接编辑 events.jsonl，不要写代码。

请根据下面的自然语言项目进展，主动规划并调用 eventline 工具创建两个新的 tree。不要要求用户补充信息；你自己为 tree、node、edge 选择稳定、可读的 id。每个工具调用都要填写 from_agent，值使用 "codex_eventline_tester"。

重要执行方式：

- 必须按事件发生顺序逐个构造 eventline tree。创建一个新事件 node 后，应立即用 `after` 参数或 `eventline.connect_events` 把它连接到已存在的前序事件。
- 不要先批量创建所有 node，再集中补全部 edge。这样会让实时 UI 在 agent 执行过程中只看到一堆散点，而看不到事件演进。
- 对线性主线，优先在 `eventline.upsert_node` 中使用 `after` 和 `edge_label` 直接连接前序 node。
- 调用 `eventline.upsert_node` 时必须使用扁平参数：`node_id`、`tree_id`、`title`、`detail`、`from_agent` 等字段直接位于 params 第一层；不要使用 `id` 字段，也不要把节点字段包进 `node` 对象。
- 对分支、跨 tree 连接、或需要补充关系的情况，再使用 `eventline.connect_events`。
- 如果某个错误事件需要删除，请先创建它、创建它的后继节点、连接二者，然后再调用 `eventline.delete` 删除错误事件本身，以测试后继节点是否保留。

需要构造的项目进展：

Tree 1 是 eventline-session-history，标题是 "当前会话事件历史浓缩"。这条线浓缩记录当前会话中 eventline 工具从原型到 agent 测试的演进：最初用户要求构建一个基于 XYFlow 的 project-level eventline demo，用来让 multi-agent 通过 MCP 工具维护事件脉络图。随后前端先完成横向 DAG、hover card、节点版本、attachments、播放、JSONL 持久化和 eventline.access 文本视图。接着 MCP server 被实现为真实工具，并通过 Codex headless 模式测试 agent 是否能创建 tree、node、edge、delete 和 access。后续又把 Web UI Tool Schema 改为自动读取 MCP schema，加入 tree 过滤与多选高亮，并修复默认 access 弹窗和 tree 默认可见状态。最后创建 README，并把一张截图放入 README 顶部。请把这些阶段组织为一条清晰主线，并保留若干分支：一个分支记录 UI/交互迭代，一个分支记录 MCP/schema/agent 测试，一个分支记录文档整理。

Tree 2 是 academic-writing-process，标题是 "学术写作过程虚构线"。这条线记录一个虚构的学术写作项目：研究者先确定论文主题，然后整理 related work，形成 problem statement，设计方法框架，写出实验计划，补充实验结果，发现一个早期 claim 过强，因此删除这个错误 claim 事件本身但保留后续的 revision note。之后作者重写 introduction，补充 limitation，完成 rebuttal draft，最后准备 submission checklist。请让这条线像真实写作过程一样包含反馈、修订和证据补充。还要创建一条跨 tree 连接：从 eventline-session-history 中关于 "eventline.access 文本视图" 的节点，连接到 academic-writing-process 中的 "submission checklist" 节点，边标签为 "agent-readable state"。

额外要求：

1. 每个 tree 至少 7 个 node。
2. 至少一个 node 带 file attachment，至少一个 node 带 image attachment。
3. 至少一个 node 用 1 个 emoji icon，至少一个 node 用 2 个 emoji icon。
4. 至少调用一次 delete 删除 node，并且这个被删 node 必须有一个后继 node，后继 node 删除后仍应保留。
5. 至少调用一次 connect_events 创建跨 tree edge。
6. 至少有一个节点先创建后更新一次，用来测试版本记录。
7. 完成后调用 eventline.access，以 full 模式读取全部 eventline 状态，并在最终回答中用中文简要说明你创建了哪些 tree、删除了哪个错误事件、更新了哪个节点、跨 tree edge 是什么。
