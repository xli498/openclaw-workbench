# OpenClaw Workbench

面向 OpenClaw 的可审计本地 Agent Runtime 基础设施，提供审批绑定的 Patch 和 Terminal 执行闭环。

> 这是独立的、非官方 OpenClaw 项目，不会自动修改 OpenClaw 配置。当前版本是可测试的 Runtime 产品基线，不是已经接管生产环境的完整控制面。

## 当前可运行入口

包入口：`import { startWorkbench, createPatchProposal, approveAndApplyPatch, readConfig, importConfig, rollbackConfig } from 'openclaw-workbench'`。运行时提供本地工作区启动扫描、恢复编排、Patch 审批应用闭环、配置备份/回滚和独立的受控命令执行器；不会自动接管 OpenClaw Gateway。

```bash
npm test
node bin/workbench.mjs --help
node bin/workbench.mjs --root /path/to/workspace --json
```

## Quickstart（当前实现）

要求 **Node.js >= 22.19.0**（见 `package.json` 的 `engines`）。`root` 是要扫描和约束读写的工作区绝对路径；快照、提案和审计材料必须留在该目录内。

```bash
cd openclaw-workbench
npm install
npm test

# 无 token：只执行启动恢复扫描后退出
node bin/workbench.mjs --root "$PWD" --json

# 有 token：启动长期、本地回环 HTTP 控制面
node bin/workbench.mjs \
  --root "$PWD" \
  --host 127.0.0.1 \
  --port 4312 \
  --token-env OPENCLAW_WORKBENCH_TOKEN \
  --approval-token-env OPENCLAW_WORKBENCH_APPROVAL_TOKEN \
  --openclaw-command-env OPENCLAW_WORKBENCH_COMMAND
```

`OPENCLAW_WORKBENCH_COMMAND` 可选，默认值为 `openclaw`。Windows 可将它设为 `openclaw.cmd` 或 OpenClaw 可执行文件的完整路径；Workbench 会把同一个命令用于只读诊断和本地 Agent 调用。命令通过环境变量读取，不会出现在令牌参数中，也不会修改 OpenClaw 配置。

服务从环境变量读取至少 16 个字符的 `OPENCLAW_WORKBENCH_TOKEN` 与 `OPENCLAW_WORKBENCH_APPROVAL_TOKEN`，禁止把令牌放进命令行参数或提交到仓库。服务默认监听 `127.0.0.1`；`--host` 仅允许 `127.0.0.1`、`::1` 或 `localhost`，`--port` 默认为 `0`（由操作系统分配空闲端口）。服务在启动恢复扫描完成后才开始监听；收到 `SIGINT`/`SIGTERM` 时会关闭 HTTP 服务、结束 SSE 连接，并取消进行中的 Agent 回合。

也可从 Node API 启动：

```js
import { createWorkbenchServer } from 'openclaw-workbench';

const app = createWorkbenchServer({
  root: '/absolute/path/to/workspace',
  host: '127.0.0.1',
  port: 4312,
  token: process.env.WORKBENCH_TOKEN,
  approvalToken: process.env.WORKBENCH_APPROVAL_TOKEN,
});
console.log(await app.listen());
// 进程退出时调用 await app.close()
```

每个请求都要带 `Authorization: Bearer <token>`；`/approve` 另外必须带独立的 `X-Approval-Token: <审批 token>`，并在 JSON body 中提交提案当前的 `actionHash`。这两个 token 不会由 Workbench 生成或回显，也不要提交到仓库。控制面是 **loopback-only**：它不提供公网监听、Gateway 接管、WebSocket Bridge 或生产部署能力；`/v1/events` 和 SSE 只是只读事件读取，不是执行入口。

主路径按 Ask → Plan → Code 理解：

1. **Ask**：`POST /v1/sessions`（`{"mode":"Ask"}`）后调用 `/messages`；用于只读问答，不能创建修改提案。
2. **Plan**：创建 `{"mode":"Plan"}` 会话后调用 `/plan`，传入 `question` 和 2—4 个 `models`；只读复核/博弈，不创建 Patch、不运行 Terminal。
3. **Code**：创建 `{"mode":"Code"}` 会话后调用 `/tools/proposals`，`tool` 只能是 `patch` 或 `command`；这里只生成 `awaiting_approval` 提案。用户人工核对预览、路径、策略和 `actionHash` 后，才可用独立审批 token 调 `/v1/proposals/:id/approve`。Code Chat 不会直接写文件。

无真实模型、无外部网络的 fresh-workspace smoke 覆盖位于 `tests/fresh-workspace-smoke.test.mjs`，通过注入 `runAgentFn` 验证上述主路径；它不会启动 `openclaw` 子进程，也不会批准或执行 Patch。若需要真实 OpenClaw Adapter，必须由调用方显式配置并承担其本地 CLI/登录态依赖。

## 本地控制面 API

`createWorkbenchServer` 提供默认仅监听 `127.0.0.1` 的本地 HTTP 控制面：`GET /health`、`GET /v1/status`、创建 Patch/Command 提案以及明确批准执行提案。请求体限制为 256 KiB；配置 `token` 后所有请求必须携带 `Authorization: Bearer <token>`。该 API 不绑定公网地址、不接管 Gateway，也不把状态持久化到网络数据库；会话、提案和本地事件分别写入工作区的原子 JSON 快照。服务重启后未完成会话/提案只进入 `manual_review`，不会自动调用模型或执行命令。

启动入口只扫描并报告未完成事务；仅对文件已全部达到 `afterHash` 的事务自动标记为 `committed`，不会自动执行 `resume` 或 `rollback`。非法清单会被隔离为结构化错误，其他事务继续扫描。控制面还提供只读 `GET /v1/recovery`，返回每个未完成事务的检查报告与 `requires_approval`、`mark_committed` 或 `blocked` 判定；该接口不会执行恢复或审批。工作区可通过只读 `GET /v1/workspace/tree` 浏览、`GET /v1/workspace/read?path=<relativePath>` 读取单个文件，越界、敏感路径和符号链接逃逸都会被拒绝。

Chat 会话接口遵循 ShunCode 的 Ask / Plan / Code 三模式：`POST /v1/sessions` 创建会话，`POST /v1/sessions/:id/messages` 调用独立的 OpenClaw Adapter，`GET /v1/sessions/:id/messages` 读取消息，`POST /v1/sessions/:id/close` 关闭会话。当前三种模式已完成会话级边界；真正的 Code 文件修改仍必须通过 Patch 提案和明确审批，不允许 Chat 直接写文件。

Plan 会话支持 `POST /v1/sessions/:id/plan` 的多模型只读复核；传入 `debate: true` 时执行四阶段 `proposal → challenge → response → judge`，可用 `judgeModel` 指定裁判模型。结果通过 `rounds.proposals`、`rounds.critiques`、`rounds.responses`、`rounds.verdict` 返回，并保留失败信息和人工复核语义；Plan 不会创建 Patch、运行 Terminal 或自动执行建议。

事件可通过只读 `GET /v1/events` 轮询，或通过 Bearer 鉴权的 `GET /v1/events/stream?after=<sequence>` 使用 SSE 接收历史事件和后续事件（含 keep-alive）；事件流不是审批或执行入口。`createGatewayAdapter` 只提供显式调用的回环 WebSocket 传输边界，固定禁止公网地址，不自动连接、启动 Gateway、读取密钥或执行 MCP 工具；OpenClaw 私有协议、channel 生命周期、WebSocket 控制面和公网 Bridge 仍未实现。

Patch 垂直切片的调用顺序为：`createPatchProposal` 生成绑定工作区 revision 和 `actionHash` 的提案，用户明确批准后调用 `approveAndApplyPatch`，由事务引擎原子应用并返回 `verified` action。`Ask` 模式不能创建修改提案，审批后工作区 revision 变化会阻断应用。当前已有本地 Web 控制台，但仍不包含桌面壳、MCP 管理、OpenClaw channel/Gateway 生命周期接入和公网 Bridge。

配置管理垂直切片提供 `GET /v1/config`、`POST /v1/config/import`、`POST /v1/config/rollback` 和 `POST /v1/config/:actionId/approve`。配置文件必须是工作区内的相对 `.json` 文件（默认 `openclaw.json`）；导入会先创建 `.openclaw-workbench/config-backups/` 下的备份，写入前和写入时都校验 `expectedHash`，冲突返回 `409 CONFIG_CONFLICT`。创建提案只返回相对路径、大小和哈希，原始配置内容不写入 proposals 快照、不返回 UI，也不进入审计；待审批提案只保存在当前进程，重启后必须重新创建。

## 能力状态

| 能力 | 状态 |
| --- | --- |
| Patch 解析、审批、原子事务和回滚 | 基线完成 |
| argv-only Terminal、`shell: false`、资源限制 | 基线完成 |
| 命令 action 跨进程原子 claim 防重放 | 已实现 |
| 命令终态持久化与启动扫描 | 已实现；未完成动作只进入人工复核 |
| 审计哈希链与并发追加锁 | 已实现 |
| 配置导入、备份、哈希冲突和回滚 | 已实现；仅限工作区 JSON，需独立审批 |
| 模型档案、SecretRef 引用和连接测试 | 已实现受控元数据骨架；默认禁用，不解析密钥或联网 |
| Gateway WebSocket 传输边界 | 已实现回环连接/请求关联/超时取消；未实现 OpenClaw 协议和生命周期 |
| 本地控制台 UI、OpenClaw CLI 诊断 | 已实现；首次连接会显示 CLI 状态 |
| MCP 注册、工具 allowlist、健康状态 | 已实现受控注册骨架；默认禁用，不启动 Server/调用工具 |
| 公网 Bridge | 未实现 |
| 生产部署承诺 | 不承诺 |

## 安全边界

- 所有修改和命令执行都必须经过明确审批；审批不能绕过 `blocked` 策略。
- action hash 绑定 session、workspace revision、目标和不可变预览；执行前重新校验。
- 命令首次执行前写入持久化 ledger，重复 action hash 永久阻断，除非由明确的人工恢复流程处理。
- 启动扫描不会自动重跑命令；`claimed`/`executing` 等未完成状态只进入 `manual_review`。
- ledger 和审计日志不保存 API Key、环境变量密钥或用户凭据；命令预览只包含 argv、cwd 和资源参数。
- 这套库不能替代宿主机权限隔离、容器隔离、密钥管理或 OpenClaw 正式审批系统。

`GET /v1/status` 提供不含会话内容、提案内容或 ID 的 `persistedState` 汇总，用于识别重启后的人工复核数量和恢复事件；该接口只读，不会恢复或执行任何中断操作。

`GET /v1/audit?limit=<n>` 只读返回最近的脱敏审计事件，最多 500 条；控制台可查看并导出这份脱敏 JSON。未显式注入 audit 时，服务会惰性写入工作区 `.openclaw-workbench/audit.jsonl`；命令预览、完整错误文本、环境变量、凭据和绝对路径不会通过该接口返回。

## OpenClaw 兼容性诊断

`GET /v1/openclaw/diagnostics` 是已鉴权的只读探针。它只以 `shell: false` 运行配置的 OpenClaw CLI 的固定 `--version` 参数，并使用 5 秒和 16 KiB 输出上限。

- `ready`：CLI 返回了可解析的版本号。
- `unavailable` / `CLI_NOT_FOUND`：Workbench 无法运行配置的 CLI 命令。
- `unavailable` / `CLI_UNAVAILABLE`：CLI 未能完成受限的只读探针。

该探针不认证到 OpenClaw、不读取或修改 OpenClaw 配置、不启动 Gateway、不调用模型、不修改工作区，也不返回 stderr、环境变量或凭据。

`GET /v1/openclaw/mcp` 是同样已鉴权的只读 MCP 探针。它固定运行 `openclaw mcp status --json`，只返回 Server 数量、脱敏后的名称和状态，不返回原始配置、命令参数、环境变量或错误文本。`ready` 表示 CLI 成功返回可解析的 Server 状态；CLI 不存在、超时或返回非 JSON 时分别映射为 `CLI_NOT_FOUND`、`CLI_UNAVAILABLE` 或 `INVALID_RESPONSE`。该接口不会启动 MCP Server、调用工具或修改 MCP 注册表。

## MCP 注册与授权

启用状态也必须单独审批：`POST /v1/mcp/servers/<serverId>/enable` 与 `/disable` 会绑定当前 `configHash`，旧 hash、重复提案或错误审批凭据不能改变状态。

`GET /v1/mcp/servers` 查看 Workbench 自己的本地注册表；`POST /v1/mcp/servers` 创建注册提案，必须使用独立 `x-approval-token` 调用 `/v1/mcp/servers/<actionId>/approve` 才会写入。注册记录只保存 Server 名称、transport、命令/端点、环境变量名称、工具 allowlist 和布尔权限；不会保存环境变量值、token 或 URL 用户密码。所有新 Server 默认 `enabled:false`。

`POST /v1/mcp/servers/<serverId>/authorize` 以当前 `configHash` 创建工具授权提案，审批时再次校验哈希，防止并发修改覆盖授权。`GET /v1/mcp/servers/<serverId>/health` 只调用调用方显式注入的只读探针；默认返回 `NOT_CONFIGURED`。所有新 Server 默认 `enabled:false`，必须由后续显式启用流程打开；`createMcpServerRuntime` 还会在每次 start/call 校验 `enabled:true`、当前 `configHash` 和独立审批标记，配置漂移会使旧实例失效。`createMcpStdioTransport` 提供显式启动的 `shell:false` stdio JSON-RPC 传输边界，command/args 同样拒绝 shell 元字符、凭据标签和 URL userinfo，支持请求关联、超时、取消、关闭清理和帧大小门禁。`createMcpHttpTransport` 目前只提供受限的一次性 POST JSON-RPC 响应边界，可解析单个 JSON 或有限 SSE 响应，并具备 endpoint 校验、header 控制字符注入防护、超时、取消和流式帧大小门禁；调用方传入的认证 header 不会被 Workbench 持久化或记录。它们不读取 SecretRef、不自动重连、不替代审批、allowlist 或工具编排。标准 SSE 双通道、完整 streamable HTTP 会话语义、OpenClaw 私有协议和 HTTP 工具执行路由仍未开放。

## 模型档案与连接测试

`GET /v1/models` 查看 Workbench 的本地模型档案；`POST /v1/models` 创建档案提案，使用独立 `x-approval-token` 调用 `/v1/models/<actionId>/approve` 才会登记。档案只保存 provider、protocol、model、能力列表、无密钥的 `env:`/`keychain:` SecretRef 引用和健康摘要；新档案默认 `enabled:false`，不会保存 API key 或 SecretRef 解析值。

`GET /v1/models/<profileId>/health` 只调用显式注入的连接探针；默认返回 `NOT_CONFIGURED`，不联网、不读取 SecretRef、不调用真实模型。真实供应商 SDK、密钥环解析、模型调用和 Gateway 生命周期仍未开放。

本地快照仅允许工作区内的普通文件，发现快照或快照目录为符号链接即拒绝恢复/写入；快照写入后固定为 `0600`，创建目录为 `0700`。这不是宿主机隔离的替代品。

受控命令执行器位于 `runtime/terminal.mjs`，入口为 `runControlledCommand`。调用必须传入 argv 数组和 `approved: true`；它固定 `shell: false`，限制 cwd 在工作区内，限制 argv 数量/大小和最长执行时间，过滤环境变量（不允许 `NODE_OPTIONS` 等代码注入变量，且不接受调用方覆盖 `PATH`、`HOME`、`TMPDIR`），并提供超时、取消和输出上限。命令工作流入口为 `createCommandProposal` → `approveAndRunCommand`，执行成功返回 `verified` action，失败分别进入 `failed`、`timed_out` 或 `cancelled`；不会由 Patch 工作流隐式触发。
命令工作流还会通过 `classifyCommand` 做基础策略分类：明确禁止命令直接阻断，未知命令不会自动放行，并在执行前再次复核 argv。
策略同时检查参数级风险，默认阻断 `git push`、`git reset --hard`、`git clean`、`npm publish` 及常见 shell 语法字符。
