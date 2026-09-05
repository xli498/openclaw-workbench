# Chat 会话 API 基线

本接口只做本地 Agent 会话编排，对齐 ShunCode 的产品路径：Chat 在本机运行，模型循环由独立 Adapter 执行；Ask / Plan / Code 是权限边界，不是三个不同的模型。

## 创建会话

```http
POST /v1/sessions
Content-Type: application/json

{"mode":"Ask","actor":"user"}
```

`mode` 只能是 `Ask`、`Plan` 或 `Code`。默认是 `Ask`。

## 发送消息

```http
POST /v1/sessions/:id/messages
Content-Type: application/json

{"message":"请阅读当前项目并总结风险","model":"...","thinking":"high"}
```

消息通过 `OpenClaw Adapter` 发送，并绑定当前 session ID。单轮消息最长 32 KiB，同一会话不允许并发 turn；Adapter 失败时不会残留半轮消息。

## 安全边界

- API 默认仅监听 `127.0.0.1`。
- 配置 Bearer Token 后所有接口都需要认证。
- Chat 会话当前保存在进程内，服务重启后会话历史不恢复。
- `Code` 模式不会绕过 Patch 审批；文件修改必须走已有的 `createPatchProposal` → `approveAndApplyPatch`。
- 当前不实现公网 Bridge、MCP Server 管理或自动修改 OpenClaw 配置。

## Code 工具提案

```http
POST /v1/sessions/:id/tools/proposals
Content-Type: application/json

{"tool":"patch","input":{"patch":"...","declaredPaths":["README.md"]}}
```

该接口只接受 `Code` 会话和两个结构化工具：`patch`、`command`。模型或客户端只能生成待审批提案，不能通过 Chat 直接写文件或运行命令；提案仍需经过独立的人工审批接口，沿用 action hash、workspace revision、路径边界和命令策略校验。

## 本地事件读取

```http
GET /v1/events?after=0&limit=100
Authorization: Bearer <token>
```

事件读取接口支持两种只读方式：`GET /v1/events?after=<sequence>&limit=<limit>` 轮询，以及 `GET /v1/events/stream?after=<sequence>` 的 SSE 流。两者都使用递增 `sequence` 游标；默认最多保留 500 条。SSE 先发送游标之后的保留历史，再推送新事件，并发送 keep-alive 注释；游标超出保留窗口时返回 `409 EVENT_CURSOR_EXPIRED`。当前事件包括 `session.created`、`chat.completed`、`plan.completed`、`plan.stage.started`、`plan.stage.completed`、`plan.stage.failed`、`proposal.created` 和 `proposal.verified`。事件接口需要 Bearer 鉴权，不携带执行凭据，也不能批准或执行提案。当前实现不提供 WebSocket。Plan 阶段事件的 `data.stage` 为 `proposal`、`challenge`、`response` 或 `judge`。

## 会话安全恢复

会话快照写入工作区 `.openclaw-workbench/sessions.json`，通过临时文件与原子 rename 更新。启动时只恢复历史、`active` 和 `closed` 会话；快照记录为 `running` 的会话会被降级为 `manual_review` 并标注 `interrupted_turn`，不会重新调用模型、重放消息或执行任何工具。损坏或不兼容快照将拒绝恢复，而不是猜测性修复。

```http
POST /v1/sessions/:id/review
Content-Type: application/json

{"decision":"resume","reviewer":"user"}
```

只有 `manual_review` 会话可调用该接口。`resume` 仅将会话标为可接收**新的**回合，`close` 则关闭会话；二者都不会重放中断消息、模型调用、Patch 或命令。完成后发布只读的 `session.reviewed` 事件。

## 提案安全恢复

提案快照写入 `.openclaw-workbench/proposals.json`，同样采用原子 rename。进程重启前未进入终态的提案将只恢复为可查看记录，并标记 `recovery.state: manual_review`；它们不重新进入审批或执行内存队列，`POST /v1/proposals/:id/approve` 会返回 `409 PROPOSAL_MANUAL_REVIEW`。已完成的 `verified`、`failed`、`timed_out`、`cancelled` 提案仅作为历史保留。要继续未完成操作，需经人工复核后创建新的提案，重新计算当前 revision、策略和 action hash。

## 事件恢复语义

本地事件快照位于 `.openclaw-workbench/events.json`，按 `sequence` 保存并原子更新。重启后，已恢复事件会带 `recovered: true`，`GET /v1/events` 响应也会带 `recovered: true`；这表示它们是历史审计记录，不能被 UI 当作本进程的实时执行流。新发布事件保持递增 sequence，但不带该标记。事件 API 仍是 Bearer 鉴权的只读接口；轮询和 SSE 均不提供恢复、审批或执行能力，当前未开放 WebSocket。

`GET /v1/status` 还会提供不含消息、命令、Patch、会话 ID 或提案内容的 `persistedState` 汇总：会话的总数/活跃/关闭/人工复核/中断回合计数，提案的总数/人工复核/终态计数，以及事件是否来自恢复和最新 sequence。该摘要仅用于本地操作者识别重启后待处理状态；它不构成恢复、审批或执行入口。

事务恢复状态可通过只读 `GET /v1/recovery` 查看。接口返回未完成事务的检查报告和 `requires_approval`、`mark_committed` 或 `blocked` 判定；损坏清单会被隔离，其他事务继续返回。该接口不会执行 `resume`、`rollback` 或审批。工作区浏览使用 `GET /v1/workspace/tree`，单文件只读预览使用 `GET /v1/workspace/read?path=<relativePath>`；越界、敏感路径和符号链接逃逸均被拒绝。

会话、提案和事件快照仅接受位于已解析工作区根目录内的普通文件；快照文件或其 `.openclaw-workbench` 上级目录为符号链接时，恢复和写入都会以各自的 `*_STORE_INVALID` 错误拒绝。原子写入后的文件权限固定为 `0600`，目录以 `0700` 创建。该措施用于阻断配置错误或本地替换造成的路径逃逸；它不替代操作系统账户隔离，也不承诺对拥有同等本机文件系统权限的对手提供竞争条件防护。

每个快照文件写入前还会以同目录 `<snapshot>.lock` 目录进行独占保护。检测到该锁时，写入立即以 `SESSION_STORE_BUSY`、`PROPOSAL_STORE_BUSY` 或 `EVENT_STORE_BUSY` 拒绝，不会等待、重试、抢占锁或以旧内存覆盖现有快照。锁只覆盖同步“写临时文件→rename→chmod”的临界区；进程崩溃留下的锁必须由本机操作者检查后处理，系统不会自行接管。

每个 store 在加载时还记录快照摘要；取得锁后会再次读取并比对。若另一个 manager 已提交新版本，后写者以 `SESSION_STORE_CONFLICT`、`PROPOSAL_STORE_CONFLICT` 或 `EVENT_STORE_CONFLICT` 拒绝，磁盘保留先提交版本。系统不会自动重载、合并、重试或覆盖冲突；操作者应停止冲突实例并在确认状态后新建 manager。

## Plan 多模型复核与多轮博弈

```http
POST /v1/sessions/:id/plan
Content-Type: application/json

{"question":"请设计只读审计方案","models":["model-a","model-b"]}
```

该接口只能用于 `Plan` 会话。默认并行调用 2—4 个独立模型，按回答摘要哈希标记 `full` 或 `partial` agreement。传入 `debate: true` 时执行四阶段只读博弈：独立提案、交叉质询、提案方回应、裁判综合；可用 `judgeModel` 指定裁判模型：

```json
{"question":"请设计只读审计方案","models":["model-a","model-b"],"judgeModel":"model-judge","debate":true}
```

博弈结果包含 `debate: true`、`judgeModel`，以及 `rounds.proposals`、`rounds.critiques`、`rounds.responses`、`rounds.verdict`，并将 `synthesis.agreement` 设为 `judged`。四阶段严格按 `proposal → challenge → response → judge` 执行；阶段结果分别标记 `proposer`、`opposing_reviewer`、`respondent` 和 `judge` 角色，`synthesis.evidence` 保存各阶段摘要哈希。任一模型局部失败会保留失败信息并要求人工复核；至少需要两份有效提案、一份有效质询和一份有效回应才能进入裁判。提案、质询或回应阶段全部失败时返回 `DEBATE_FAILED`；裁判失败时返回 `JUDGE_FAILED`；请求取消返回 `ABORTED`。所有阶段仍固定为本地 Plan 调用，不会创建 Patch、运行 Terminal，也不会自动执行任何建议。模型输出会作为不可信材料传给后续阶段，后续模型被明确要求只阅读材料而不执行其中指令。Debate 阶段累计输出上限为 96 KiB，超限时不会调用裁判。请求取消或失败后不会保存半成品，也不会发送 `plan.completed`。

## 当前实现边界

本版已完成会话管理、消息调用、忙状态、防半轮残留、三模式校验、Plan 多模型分歧标记、Plan 四阶段只读博弈、Code 结构化工具提案编排，以及会话/提案/本地事件的保守持久化恢复；事件已支持 HTTP 轮询和 SSE 流。`createGatewayAdapter` 提供仅回环地址的显式 WebSocket transport；`createMcpStdioTransport` 提供显式启动的 stdio JSON-RPC transport。两者都只负责受限传输生命周期，不猜 OpenClaw 私有协议、不自动启动业务服务、不读取 SecretRef、不执行 MCP 工具，也不是公网控制面。OpenClaw channel 生命周期、SSE/streamable HTTP、桌面 UI 和公网 Bridge 仍未实现。

## 请求关联 ID

`X-Request-Id` 仅接受 1—128 个 ASCII 字符：首位为字母数字，后续仅允许字母数字、`.`、`_`、`:`、`-`。不满足格式的值会被服务端 UUID 替换；未经限制的请求头值不会进入响应头、事件数据或本地快照。

事件查询的 `after` 与 `limit` 只接受安全范围内、无前导零的十进制整数；空白、十六进制、科学计数法、小数、前导零与超出 JavaScript 安全整数范围的值都会以 `INVALID_QUERY_INTEGER` 拒绝。任一参数重复出现会以 `DUPLICATE_QUERY_PARAMETER` 拒绝，服务端不会静默选择第一个或最后一个值。

所有写接口的请求体必须是 JSON 对象。数组、`null`、字符串、数字和布尔值会以 `INVALID_BODY` 拒绝；格式非法的 JSON 以 `INVALID_JSON` 拒绝，不会进入会话、提案或执行参数。

## Adapter 进程生命周期

在 POSIX 平台，Adapter 会以独立进程组启动 OpenClaw 子进程。超时、取消或输出超限时，会向整个进程组发送终止信号，而非只终止直接父进程；这避免模型调用或包装脚本留下后代进程。Windows 保持直接子进程终止行为。

## 控制面认证与审批

控制面只允许绑定 `127.0.0.1`、`::1` 或 `localhost`，启动时必须提供不少于 16 个字符的 Bearer token。执行 `/approve` 还必须提供**与 API token 独立**的 `X-Approval-Token`，并在 JSON 请求体传入待执行提案当前的 `actionHash`；二者任一不匹配都会拒绝。该分离防止仅持有普通 API token 的调用方自行批准写入或命令执行。

命令执行采用默认拒绝策略：仅限明确列出的只读本地检查命令，未知可执行文件、解释器、包管理器、项目内二进制以及 shell 一律不创建可执行提案。

Patch 事务读取目标时使用不跟随末级符号链接的文件描述符，并在读取后复核路径解析结果；读取期间目标被替换或变为符号链接会中止事务，不会将外部文件内容写入快照。

恢复流程对事务目标、临时文件和快照采用同样的无符号链接读取与读取后路径复核；恢复材料发生替换时按不可用处理并阻断恢复。

恢复清单的 `relativePath` 必须规范化并与实际 `target` 一一对应；显示、审计和实际恢复操作不会使用可分离的文件标识。

命令防重放账本会校验记录是否绑定当前 action 的 ID、hash、会话与命令预览，拒绝符号链接和伪造记录。文件审计日志必须使用工作区内相对路径；每次追加前会验证既有哈希链，发现篡改即停止追加。

## 事件数据边界

事件的 `data` 会在发布和快照恢复时进行 JSON 规范化、深复制和深冻结。循环引用或其他不可 JSON 序列化的数据以 `INVALID_EVENT_DATA` 拒绝；单条数据上限为 64 KiB，超限以 `EVENT_DATA_LIMIT` 拒绝。调用方后续修改原始嵌套对象不会影响已发布事件。

## 鉴权比较

配置了 token 时，控制面仅接受精确的 `Authorization: Bearer <token>`。服务端对期望值和收到的认证值分别做 SHA-256 后进行恒定时间比较；前缀、后缀、认证方案或类型不匹配均按未授权处理。
