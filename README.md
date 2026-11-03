# OpenClaw Workbench

面向 OpenClaw 的可审计本地 Agent Runtime 基础设施，提供审批绑定的 Patch 和 Terminal 执行闭环。

> 这是独立的、非官方 OpenClaw 项目，不会自动修改 OpenClaw 配置。当前版本是可测试的 Runtime 产品基线，不是已经接管生产环境的完整控制面。

产品核心的可验收闭环是：模型注册 → 真实模型请求 → 规范化 Chat 回合 → 只读工具 → 审批提案 → 验证与脱敏审计。`Streamable HTTP MCP Bridge` 已作为独立的本机回环服务实现；公网隧道仅有受控 CLI 适配器、真实公网部署未验证，LSP 已实现文档同步、诊断、经审批编辑提案与 documentChanges 提案化（真实语言服务器接入仍未核），持久 PTY 已实现 POSIX 显式注入 provider 的 resize 通道（默认仍 pty:false）与 Windows ConPTY 已由 Windows job 中被选中执行的测试验证（PR #45，测试 229–236）（Windows resize 仍未接线），不能用诊断或一次性命令执行冒充这些能力。

## 当前可运行入口

包入口：`import { startWorkbench, createPatchProposal, approveAndApplyPatch, readConfig, importConfig, rollbackConfig } from 'openclaw-workbench'`。运行时提供本地工作区启动扫描、恢复编排、Patch 审批应用闭环、配置备份/回滚和独立的受控命令执行器；不会自动接管 OpenClaw Gateway。

```bash
npm test
npm run smoke:mcp-bridge
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

## 本机 Streamable HTTP MCP Bridge

Bridge 是独立于控制面的本地 `node:http` 服务。它使用 MCP `2025-06-18` 的 Streamable HTTP 会话语义：`initialize` 协商会话，`tools/list` 和 `tools/call` 使用 `Mcp-Session-Id` 与 `MCP-Protocol-Version`，支持有限 JSON/SSE 响应、`GET` SSE 订阅与 `DELETE` 关闭。空闲会话会过期，`stop()` 会关闭所有 SSE 流。

```js
const bridge = app.createMcpBridge({
  token: process.env.OPENCLAW_WORKBENCH_MCP_TOKEN,
  // 可选：只作短时路由定位，不是认证凭据；不要输出或记录它。
  pathToken: process.env.OPENCLAW_WORKBENCH_MCP_PATH_TOKEN,
});
const address = await bridge.start();
console.log({ host: address.address, port: address.port });
// 进程退出时调用 await bridge.stop()；app.close() 也会停止子 Bridge。
```

Bridge 只允许 `127.0.0.1`、`::1` 或 `localhost` 绑定。每个请求仍必须携带独立的 `Authorization: Bearer <MCP token>`；可选 path token 位于路径中，只作路由定位，不能替代 Bearer。调用方不得把 path token 或 Bearer 放入查询参数、日志、终端历史或仓库（服务端按路径名路由、不把查询参数当作认证来源，但目前不主动拒绝带查询串的请求）。path token 默认自 Bridge 构造起 5 分钟内有效，过期后新请求返回不回显 token 的 404，已建立的 SSE 不随过期立即关闭。启用它时不要输出或传播完整 endpoint。默认拒绝所有携带 `Origin` 的请求（无 Origin 的请求放行，没有同源特例）。只读工作区工具立即执行，`workspace.patch` 与 `workspace.command` 只返回审批提案、不应用业务 patch、不执行提议命令，必须回到控制面使用独立审批 token 才能生效；该保证适用于默认／控制面注册表，宿主直接注入自定义 registry 属于可信扩展，其内部副作用不在本保证内（提案本身的持久化／审计元数据写入不属于业务 patch 应用）。

运行 `npm run smoke:mcp-bridge` 可在临时本地工作区验证初始化、工具调用、审批边界、SSE、回放与攻击拦截，不需要真实模型、OpenClaw 登录态或 token。公网 Tunnel 适配器只提供显式启动的受控 CLI 生命周期，不能替代本机 Bridge 的 loopback 绑定、Bearer 认证或审批；未完成实际公网部署验证前，不要把 endpoint 当作生产地址。

### 公网 Tunnel 适配器（实验性、显式启动）

`createBridgeTunnelAdapter` 只提供受控外部 CLI 的生命周期边界，不会自动启动公网隧道，也不会替代本机 Bridge 的 loopback 绑定或审批。当前允许的 provider 标识为 `cloudflare-quick`、`cloudflare-named`、`ngrok` 和 `ngrok-fixed`；Named 模式要求安全的 `tunnelName`，固定域名模式要求不带协议或路径的 `hostname`。调用方必须显式注入 CLI、端口、Bearer token 以及不可信 stdout 的 `parsePublicUrl`。适配器使用 `shell:false`，Bearer 只放在子进程环境变量：适配器主动构造的参数不含 token，构造时拒绝含 token 的附加参数，解析出的公网 URL 若含 token 会被丢弃；`authHeaders()` 与 `endpoint()` 是调用方显式取用完整敏感值的接口，调用方不得记录或持久化它们。每次 `start()` / `reset()` 生成新的随机路由路径；`reset()` 先请求停止旧进程并轮换进程内 endpoint，旧地址在网络侧是否失效取决于外部 CLI／隧道服务，本适配器不保证撤销。`status()` 与状态回调不含公网 URL 或 token（`start()` 返回值与进程内 `endpoint()` 除外）。真实 Cloudflare/ngrok 启动、域名绑定、TLS、设备配对和公网部署仍需单独验证。

```js
import { createBridgeTunnelAdapter } from 'openclaw-workbench';
const tunnel = createBridgeTunnelAdapter({
  provider: 'cloudflare-quick', command: 'cloudflared',
  args: ['tunnel'], localPort: address.port,
  token: process.env.OPENCLAW_WORKBENCH_MCP_TOKEN,
  parsePublicUrl: (line) => line.match(/https:\/\/[^\\s]+/)?.[0],
});
const { endpoint } = await tunnel.start(); // 不要记录或持久化 endpoint
// await tunnel.reset(); // 进程内路由已轮换，网络侧旧地址失效未经验证
```

主路径按 Ask → Plan → Code 理解：

1. **Ask**：`POST /v1/sessions`（`{"mode":"Ask"}`）后调用 `/messages`；用于只读问答，不能创建修改提案。
2. **Plan**：创建 `{"mode":"Plan"}` 会话后调用 `/plan`，传入 `question` 和 2—4 个 `models`；只读复核/博弈，不创建 Patch、不运行 Terminal。
3. **Code**：创建 `{"mode":"Code"}` 会话后调用 `/tools/proposals`，`tool` 只能是 `patch` 或 `command`；这里只生成 `awaiting_approval` 提案。用户人工核对预览、路径、策略和 `actionHash` 后，才可用独立审批 token 调 `/v1/proposals/:id/approve`。Code Chat 不会直接写文件。

无真实模型、无外部网络的 fresh-workspace smoke 覆盖位于 `tests/fresh-workspace-smoke.test.mjs`，通过注入 `runAgentFn` 验证上述主路径；它不会启动 `openclaw` 子进程，也不会批准或执行 Patch。若需要真实 OpenClaw Adapter，必须由调用方显式配置并承担其本地 CLI/登录态依赖。

## 本地控制面 API

`createWorkbenchServer` 提供默认仅监听 `127.0.0.1` 的本地 HTTP 控制面：`GET /health`、`GET /v1/status`、创建 Patch/Command 提案以及明确批准执行提案。请求体限制为 256 KiB；配置 `token` 后所有请求必须携带 `Authorization: Bearer <token>`。该 API 不绑定公网地址、不接管 Gateway，也不把状态持久化到网络数据库；会话、提案和本地事件分别写入工作区的原子 JSON 快照。服务重启后按对象分别处理，不笼统降级：持久化普通提案非终态只进入 `manual_review`；恢复审批提案只存内存、重启后消失；事务清单已完成状态可自动收敛为 `committed`（仅清单状态收敛，不重新执行 `resume`/`rollback`）；不会自动调用模型或执行命令。

启动入口只扫描并报告未完成事务；仅对文件已全部达到 `afterHash` 的事务自动标记为 `committed`，不会自动执行 `resume` 或 `rollback`。非法清单会被隔离为结构化错误，其他事务继续扫描。控制面还提供只读 `GET /v1/recovery`，返回每个未完成事务的检查报告与 `requires_approval`、`mark_committed` 或 `blocked` 判定；该接口不会执行恢复或审批。审批时冲突返回 `409`，缺少独立凭据/事务或提案不存在/提案超限分别返回 `403`、`404`、`429`；服务端应用、部分补偿、最终状态落盘或扫描失败返回 `500`。恢复失败审计和清单只含安全错误码、受控通用说明与相对文件路径，不包含绝对路径、审批凭据或原始 provider/OS 错误。工作区可通过只读 `GET /v1/workspace/tree` 浏览、`GET /v1/workspace/read?path=<relativePath>` 读取单个文件，越界、敏感路径和符号链接逃逸都会被拒绝。

Chat 会话接口遵循 ShunCode 的 Ask / Plan / Code 三模式：`POST /v1/sessions` 创建会话，`POST /v1/sessions/:id/messages` 调用独立的 OpenClaw Adapter，`GET /v1/sessions/:id/messages` 读取消息，`POST /v1/sessions/:id/close` 关闭会话。当前三种模式已完成会话级边界；真正的 Code 文件修改仍必须通过 Patch 提案和明确审批，不允许 Chat 直接写文件。

Plan 会话支持 `POST /v1/sessions/:id/plan` 的多模型只读复核；传入 `debate: true` 时执行四阶段 `proposal → challenge → response → judge`，可用 `judgeModel` 指定裁判模型。结果通过 `rounds.proposals`、`rounds.critiques`、`rounds.responses`、`rounds.verdict` 返回，并保留失败信息和人工复核语义；Plan 不会创建 Patch、运行 Terminal 或自动执行建议。

事件可通过只读 `GET /v1/events` 轮询，或通过 Bearer 鉴权的 `GET /v1/events/stream?after=<sequence>` 使用 SSE 接收历史事件和后续事件（含 keep-alive）；事件流不是审批或执行入口。`createGatewayAdapter` 只提供显式调用的回环 WebSocket 传输边界，固定禁止公网地址，不自动连接、启动 Gateway、读取密钥或执行 MCP 工具；OpenClaw 私有协议、channel 生命周期、WebSocket 控制面和公网 Bridge 仍未实现。

Patch 垂直切片的调用顺序为：`createPatchProposal` 生成绑定工作区 revision 和 `actionHash` 的提案，用户明确批准后调用 `approveAndApplyPatch`，由事务引擎原子应用并返回 `verified` action。`Ask` 模式不能创建修改提案，审批后工作区 revision 变化会阻断应用。当前已有本地 Web 控制台与 Tauri 桌面壳；MCP 管理面 API（update/remove 提案、deny/cancel 路由、GET tools）与桌面控制台 MCP 面板已实现（面板含全量配置编辑器、拒绝/撤销入口与更新后重新启用入口，批准后需重新启用），OpenClaw channel/Gateway 生命周期接入和作为产品能力的公网 Bridge 仍未实现。

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
| 模型档案、SecretRef 引用和连接测试 | 已实现受控元数据、`env:`/抽象 `keychain:` 解析和审批触发的 OpenAI-compatible 健康探针；不持久化密钥 |
| Gateway WebSocket 传输边界 | 已实现回环连接/请求关联/超时取消；未实现 OpenClaw 协议和生命周期 |
| 本地控制台 UI、OpenClaw CLI 诊断 | 已实现；首次连接会显示 CLI 状态 |
| 聚合诊断 API | 已实现；只返回状态、哈希、计数和脱敏审计 |
| Durable terminal session 合同 | 已实现；审批、游标、输出上限、取消/超时和 manual review；默认 `pty:false` |
| MCP 注册、工具 allowlist、健康状态 | 默认禁用，已有受审批约束的注册、启停与工具调用（注册／启用／授权／启停／工具调用均须独立审批并绑定当前 configHash，工具调用须命中 allowlist；管理面 API 与桌面面板已实现，见 MCP 章节）；完整管理能力仍有未闭合项：OpenClaw 私有协议与 Gateway 生命周期未接入、公网 Bridge 未验证、桥接服务端 workspace.patch／workspace.command 仍只返回审批提案而不直接执行、服务端状态快照端点仍在按 MCP 2025-06-18 核对 |
| 本机 Streamable HTTP MCP Bridge | 已实现；回环绑定、Bearer、会话、SSE、回放保护和审批提案边界；服务端 Last-Event-ID 断线回放已实现（默认进程内缓冲，重启后丢失；传 `replayStorePath` 后缓冲与游标持久化，快照只含事件内容与游标、不含 Bearer 与原始会话 id，重启后旧会话 id 仍按过期处理、已关闭会话不复活，续接须由调用方显式 `resumeSession` 接入新会话） |
| 公网 Bridge / 隧道 | 受控 CLI 适配器已实现；真实公网启动、部署与第三方 CLI 仍未验证 |
| 生产部署承诺 | 不承诺 |

## 安全边界

- 所有修改和命令执行都必须经过明确审批；审批不能绕过 `blocked` 策略。
- action hash 绑定 session、workspace revision、目标和不可变预览；执行前重新校验。
- 命令首次执行前写入持久化 ledger，重复 action hash 永久阻断，除非由明确的人工恢复流程处理。
- 启动扫描不会自动重跑命令；`claimed`/`executing` 等未完成状态只进入 `manual_review`。
- 本机 MCP Bridge 的路径令牌只是短时路由定位，Bearer 才是认证；Bridge 不监听公网，不接受把 Bearer 或其他认证凭据放入 URL。
- ledger 和审计日志不保存 API Key、环境变量密钥或用户凭据；命令预览只包含 argv、cwd 和资源参数。
- 这套库不能替代宿主机权限隔离、容器隔离、密钥管理或 OpenClaw 正式审批系统。

`GET /v1/status` 提供不含会话内容、提案内容或 ID 的 `persistedState` 汇总，用于识别重启后的人工复核数量和恢复事件；该接口只读，不会恢复或执行任何中断操作。

`GET /v1/diagnostics` 返回一次性、脱敏的产品诊断摘要：OpenClaw CLI 状态、MCP 状态、模型档案启用状态、工作区 revision 和最近审计摘要。每个组件都有 `ready`、`unavailable` 或 `degraded` 语义；诊断不会读取 SecretRef 解析值、返回命令/endpoint、启动 Gateway、调用模型或修改工作区。

## 持久终端会话

控制面提供 `GET /v1/terminal/sessions`、`POST /v1/terminal/sessions`、`GET /v1/terminal/sessions/:id/output`、`POST /v1/terminal/sessions/:id/input` 和 `POST /v1/terminal/sessions/:id/cancel`。创建、输入和取消都需要独立 `X-Approval-Token`；命令仍经过 argv、cwd 和只读策略门禁。输出按游标增量读取；管理器构造参数 `maxOutputBytes` 上限为 4 MiB，但单次 `create` 可另传 `maxOutputBytes`（底层校验上限为 16 MiB），因此 4 MiB 不是单次会话输出的硬上限。输入原文不写入快照。

当前默认实现使用受控命令 runner 作为非 PTY fallback，返回 `capabilities: { pty: false, input: false, incrementalOutput: false }`，因此不会把一次性命令冒充交互终端。POSIX PTY provider 需要宿主显式注入并单独完成进程树、权限和秘密环境复审；Windows ConPTY provider 已由 Windows job 中被选中执行的测试验证（PR #45）spawn/输出/输入/取消/退出码（Windows resize 仍未接线）。服务重启后未完成会话只进入 `manual_review`，不会自动重放。

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

`POST /v1/mcp/servers/<serverId>/authorize` 以当前 `configHash` 创建工具授权提案，审批时再次校验哈希，防止并发修改覆盖授权。`GET /v1/mcp/servers/<serverId>/health` 只调用调用方显式注入的只读探针；默认返回 `NOT_CONFIGURED`。所有新 Server 默认 `enabled:false`，必须由后续显式启用流程打开；`createMcpServerRuntime` 还会在每次 start/call 校验 `enabled:true`、当前 `configHash` 和独立审批标记，配置漂移会使旧实例失效。`createMcpStdioTransport` 提供显式启动的 `shell:false` stdio JSON-RPC 传输边界，command/args 同样拒绝 shell 元字符、凭据标签和 URL userinfo，支持请求关联、超时、取消、关闭清理和帧大小门禁。`createMcpHttpTransport` 提供 MCP 2025-06-18 双通道客户端：initialize 协商（仅接受 2025-06-18）、notify、GET SSE 订阅（含 Last-Event-ID 续接）与 DELETE 会话终止，并具备 endpoint 校验、header 控制字符注入防护、超时、取消和流式帧大小门禁；调用方传入的认证 header 不会被 Workbench 持久化或记录。它们不读取 SecretRef、不自动重连、不替代审批、allowlist 或工具编排。OpenClaw 私有协议仍未实现；桥接服务端的 Last-Event-ID 回放默认仅限进程内缓冲，`replayStorePath` 启用后才持久化（见上表）。

控制面现在提供 `GET /v1/mcp/runtimes` 查看已启动实例，以及 `POST /v1/mcp/servers/<serverId>/start|stop|call` 创建 runtime 操作提案。每个操作都必须使用独立 approval token 审批，并在执行时重新校验当前 `configHash`；Server 必须先启用，工具调用必须命中 allowlist。call 提案只返回工具名、输入字节数和输入哈希，不返回输入内容；runtime 关闭时会清理所有活动传输。

## 模型档案与连接测试

`GET /v1/models` 查看 Workbench 的本地模型档案；`POST /v1/models` 创建档案提案，使用独立 `x-approval-token` 调用 `/v1/models/<actionId>/approve` 才会登记。档案只保存 provider、protocol、model、能力列表、无密钥的 `env:`/`keychain:` SecretRef 引用和健康摘要；新档案默认 `enabled:false`，不会保存 API key 或 SecretRef 解析值。

`GET /v1/models/<profileId>/health` 是只读、非联网健康摘要，默认返回 `NOT_CONFIGURED`。需要真实连接测试时，调用 `POST /v1/models/<profileId>/health`，请求必须带独立 `x-approval-token`，并在 JSON body 中提交当前 `configHash`；服务只执行一次有超时、取消和响应大小上限的 OpenAI-compatible `GET <endpoint>/models`，在探针执行层固定拒绝 HTTP、回环/私网/metadata endpoint 且不跟随重定向。分层口径：配置保存层只要求 endpoint 为 `http(s)` 且不含凭据或敏感查询，允许保存 HTTP 与私网地址；上述 HTTPS 与主机/DNS 检查只在探针／runner 实际发起请求时才生效，不是配置保存层的阻断条件。SecretRef 仅在内存中解析为请求头，解析值不会进入模型档案、审计、响应或快照。Windows 默认使用 Windows Credential Manager 保存 `keychain:` 密钥，非 Windows 开发环境使用进程内存储且不会持久化；Credential Manager 的单条凭据内容限制为 2560 字节。当前不执行聊天补全，也不支持真实 Anthropic/Responses 调用。

`POST /v1/secrets` 只返回凭据名称和配置状态，不返回密钥值；同名写入默认拒绝覆盖。只有显式 `overwrite:true` 的轮换和 `DELETE /v1/secrets/<name>` 才能使用独立 `x-approval-token`，并写入不含密钥值的 `secret.configured`/`secret.deleted` 审计事件。

本地快照仅允许工作区内的普通文件，发现快照或快照目录为符号链接即拒绝恢复/写入；快照写入后固定为 `0600`，创建目录为 `0700`。这不是宿主机隔离的替代品。

受控命令执行器位于 `runtime/terminal.mjs`，入口为 `runControlledCommand`。调用必须传入 argv 数组和 `approved: true`；它固定 `shell: false`，限制 cwd 在工作区内，限制 argv 数量/大小和最长执行时间，过滤环境变量（不允许 `NODE_OPTIONS` 等代码注入变量，且不接受调用方覆盖 `PATH`、`HOME`、`TMPDIR`），并提供超时、取消和输出上限。命令工作流入口为 `createCommandProposal` → `approveAndRunCommand`，执行成功返回 `verified` action，失败分别进入 `failed`、`timed_out` 或 `cancelled`；不会由 Patch 工作流隐式触发。
命令工作流还会通过 `classifyCommand` 做基础策略分类：明确禁止命令直接阻断，未知命令不会自动放行，并在执行前再次复核 argv。
策略同时检查参数级风险，默认阻断 `git push`、`git reset --hard`、`git clean`、`npm publish` 及常见 shell 语法字符。
