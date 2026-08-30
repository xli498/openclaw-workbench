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

事件读取接口仅轮询内存中的最近事件，支持递增 `sequence` 游标；默认最多保留 500 条。当前事件包括 `session.created`、`chat.completed`、`plan.completed`、`proposal.created` 和 `proposal.verified`。它是只读接口，不提供 SSE/WebSocket，不携带执行凭据，也不能批准或执行提案。

## Plan 多模型复核

```http
POST /v1/sessions/:id/plan
Content-Type: application/json

{"question":"请设计只读审计方案","models":["model-a","model-b"]}
```

该接口只能用于 `Plan` 会话。它并行调用 2—4 个独立模型，要求每路返回可用文本，并按回答摘要哈希标记 `full` 或 `partial` agreement。出现模型失败或回答分歧时，结果会设置 `requiresHumanReview: true`；它不会创建 Patch、运行 Terminal，也不会自动执行任何建议。

## 当前实现边界

本版已完成会话管理、消息调用、忙状态、防半轮残留、三模式校验和 Plan 多模型分歧标记；Code 的结构化工具编排、会话持久化和 Gateway WebSocket Adapter 属于后续垂直切片，不能从当前接口声明中推断已实现。
