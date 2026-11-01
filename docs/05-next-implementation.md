# 下一阶段实施顺序

1. 将 `parseUnifiedPatch` 接入工作区安全解析，逐文件读取并校验 old content。
2. 在所有文件预检通过后才创建快照，避免多文件半执行。
3. 使用临时目录生成完整新树，校验每个 after hash 后再提交替换。
4. 提交阶段增加进程内互斥锁和 workspace revision 二次校验。
5. 失败时按快照清单恢复；恢复失败必须保留现场并返回 `ROLLBACK_PARTIAL`。
6. 用故障注入覆盖：第二个文件 hash 冲突、写入失败、进程中断、符号链接替换和并发变更。

在上述门禁通过前，不接入 Agent 自动 Code 模式。当前实现仍坚持这一边界：Code 只能生成待审批提案，文件修改和命令执行都需要独立人工批准。

## 当前已实现的 Chat/Plan 边界

- Chat 会话支持 Ask / Plan / Code 三模式；消息调用由独立 Adapter 执行，服务重启或请求取消不会重放中断回合。
- Plan 支持多模型只读复核；`debate: true` 时按 `proposal → challenge → response → judge` 四阶段执行，结果字段为 `debate`、`judgeModel` 和 `rounds.proposals` / `rounds.critiques` / `rounds.responses` / `rounds.verdict`。
- Plan 各阶段只处理不可信模型材料，不创建 Patch、不运行 Terminal、不自动执行建议。局部失败保留失败信息并要求人工复核；阶段前置条件不满足返回 `DEBATE_FAILED`，裁判失败返回 `JUDGE_FAILED`，取消返回 `ABORTED`；失败或取消不保存半成品。
- 本地事件支持 Bearer 鉴权的轮询 `GET /v1/events` 和 SSE `GET /v1/events/stream`，SSE 支持历史回放、递增游标和 keep-alive；当前不支持 WebSocket。

## 启动扫描阶段（已完成）

- `scanPendingTransactions`：严格模式拒绝非法清单，启动编排使用容错模式隔离单项错误。
- `scanStartupRecovery`：区分单项错误与整轮 `SCAN_FAILED`，支持告警回调失败隔离。
- `startWorkbench`：返回结构化恢复结果、摘要和 `fatalError`，可被 CLI 或上层生命周期接入。
- CLI 已提供 `--root`、`--json`、`--help`，但尚未绑定 OpenClaw channel 生命周期。

## 下一实现单元

1. 为 `FINALIZE_FAILED` 增加持久化状态标记，使下一次启动能识别“文件已完成、清单未完成”的可收敛状态。（已完成：`finalize_failed` 状态与失败元数据落盘；启动时仅在全部文件达到 `afterHash` 时自动标记 `committed`，否则保留 `blocked`/人工决策结果，不跳过恢复判定。）
2. 复审 stale lock 的 PID 重用防护与隔离文件清理失败告警。（已完成 stale lock 原子接管、令牌校验和活动/损坏锁阻断复审。）
3. 补齐多文件混合状态、缺少快照、非法报告、提交失败和回滚失败故障注入。（已完成混合状态、缺少快照、提交中途失败、提交后校验失败和回滚再次失败测试；非法报告与符号链接逃逸已覆盖。）
4. 完成首个 CLI/测试 harness 垂直切片：`createPatchProposal` → 明确审批 → `approveAndApplyPatch` → 原子事务提交 → `verified` action；已覆盖 Ask 拒绝、未审批拒绝和审批后 revision 冲突。
5. 完成受控 Terminal Executor 基线：argv-only、`shell: false`、工作区 cwd 边界、环境变量白名单、超时、取消和输出上限；命令执行仍需上层显式传入审批，不由 Patch 应用隐式触发。
6. 完成命令 action 编排：`createCommandProposal` → 明确审批 → `approveAndRunCommand`，成功进入 `verified`，失败按 `failed`/`timed_out`/`cancelled` 保留终态和审计事件。
4. 完成 `verifyAuditChain(records)` 的篡改、断链和空链测试。（已完成。）
5. 通过上述测试后，再设计受控的启动恢复调度，不自动越过审批。

## 命令持久化与启动门禁（已完成基线）

- 命令 action 首次执行前写入 `.openclaw-workbench/commands/<actionHash>.json`，使用独占创建实现跨进程原子 claim。
- 相同 action hash 再次执行返回 `COMMAND_REPLAYED`；claim 失败不会创建第二个子进程。
- 启动扫描会发现命令 ledger，但只标记 `manual_review`，不会自动执行或替代审批。
- 当前限制：ledger 记录已持久化，后续如需完整业务态恢复，应增加受控的人工确认接口和过期/清理策略；不得把启动扫描改为自动执行。

## Terminal 策略阶段（已完成）

- 已完成命令名和参数级策略分类。
- 已完成提案/审批审计记录策略结果。
- 已完成策略结果写入 action 不可变 preview，并在执行前复核。

## Durable Terminal 与 Diagnostics 阶段（已完成基线）

- `runtime/terminal-session.mjs` 提供工作区内原子会话清单、增量输出、输入/取消、超时、输出预算和重启 `manual_review` 门禁。
- 默认使用 `runControlledCommand` 的非 PTY fallback，并显式暴露 `pty:false`；不伪造交互 shell，不自动接管中断进程。
- 创建前使用进程内 reservation 绑定 session ID 和容量；输出超限会取消 provider，避免进程继续运行。
- `runtime/diagnostics.mjs` 聚合 OpenClaw CLI、MCP、模型、工作区 revision 和脱敏审计摘要；`GET /v1/diagnostics` 已接入鉴权控制面。
- 红队覆盖审批绕过、shell/路径逃逸、输出洪泛、超时、重放、环境变量注入、PTY 伪造和诊断泄露；定向测试与控制面回归已通过。

## 下一实现单元

1. 本地 release gates 已完成：全量测试、MCP smoke、语法检查和包内容审查；仍需在 GitHub 上完成 Node 22、Node 24、Windows CI 的远端检查。
2. 完成独立最终代码审核，修复 Critical/Important 问题后再创建/合并 PR；当前本地 commit 为 `59fe813`，远端推送等待授权和网络恢复。
3. 仅在用户明确需要时设计真正 PTY provider；在此之前保持 `pty:false` 产品边界。

## 第二轮闭环已完成（2026-11-01，PR #28–#32）

- **标准 SSE 双通道与 streamable HTTP 会话语义（已完成客户端与桥接广播）**：`createMcpHttpTransport` 新增 `initialize` 协商（仅接受 `2025-06-18`）、`notify`（202/204）、GET SSE `subscribe`（Last-Event-ID 续接、按事件分帧限额、畸形事件忽略、超限报错）与 DELETE `terminateSession`；桥接服务端新增受控 `broadcast(sessionId, notification)` 与 `streamCount`。工具执行仍走审批与 allowlist；服务端自动推送仅来自显式 `broadcast` 调用，不由工具执行自动产生。
- **完整 MCP 管理面 API（已完成）**：注册表新增 `update`（配置变更后强制重新启用，旧实例因 configHash 失效）与 `remove`（hash 校验，运行中拒绝）；运行时新增 `listTools`（返回工具名与 authorized 标记，列出绝不等于授权）；控制面新增 update/remove 提案与 GET tools。桌面端 MCP 管理面板仍未实现。
- **LSP（只读客户端切片已完成，全量 LSP 未闭合）**：`createLspClient` 为工作区内 stdio 客户端，仅允许只读方法（initialize、hover、definition、references、documentSymbol、completion、workspace/symbol、shutdown）；服务端请求绝不自动执行（默认回 -32601），命令/参数拒绝 shell 与凭据材料，环境值绝不进错误与日志，applyEdit/executeCommand 在送达前即被拒绝。
- **真正 PTY provider（POSIX 显式注入切片已完成，默认仍 pty:false）**：`createPosixPtyProvider` 经 Python pty 桥接 helper 实现交互输入、增量输出与进程组取消（cancel 杀整个进程组），环境最小化且绝不进记录；Windows 与无 python3 时明确报 PTY_UNAVAILABLE，绝不伪造 PTY。未实现：窗口尺寸调整（resize）、Windows PTY。

## 仍未闭合项（截至第二轮闭环，2026-11-01，写明原因与下一步，不冒充完成）

- **LSP 全量**：未实现。下一步：在只读切片上补文档同步（didOpen/didChange/didClose）、诊断接入与经审批的编辑路径（applyEdit 仍须走 Patch 审批），并支持多语言服务器配置。
- **PTY 窗口尺寸与 Windows PTY**：未实现。下一步：仅在明确需要时做 resize 协议（宿主注入的尺寸通道）与 Windows ConPTY 方案，默认仍保持 pty:false。
- **OpenClaw channel / Gateway 生命周期**：未实现（仅探针已完成）。`createGatewayLifecycle` 的 probe() 在本机与 CI 环境实测为 CLI_NOT_FOUND（openclaw 未安装），start() 无显式注入适配器时明确拒绝，绝不猜测或硬编码 OpenClaw 私有协议；`createGatewayAdapter` 仍只有回环 WebSocket 传输边界且禁公网。下一步：先在已安装 OpenClaw 的受控环境实测稳定集成接口与 docs/01 的 Gateway WebSocket、设备配对、scope 升级清单，再设计生命周期接入。
- **完整 streamable HTTP 会话语义的剩余项**：未全部开放。下一步：按 MCP `2025-06-18` 补服务端对客户端请求的断线续接（Last-Event-ID 回放）与 HTTP 工具执行路由的完整语义，仍须守住审批与 allowlist。
- **MCP 管理桌面面板**：未实现。下一步：在已完成的管理面 API 上补桌面控制台面板，仍须守住审批与配置漂移失效。
- **公网隧道真实部署验证**：未验证，已按受控规则停下（不是漏做）。核查：本机与 CI 均无 cloudflared/ngrok CLI；真实验证需要下载第三方隧道二进制，且 named/fixed 模式需要账号凭证与域名绑定，超出受控范围；适配器本身已用 mock CLI 验过（shell:false、Bearer 仅放环境变量、随机路由、reset 失效旧路由、状态/审计不含 URL 与 token）。下一步：仅在已安装 cloudflared 且操作者明确批准的前提下，对哑元回环服务做一次短时 quick-tunnel 试验、立即关闭、只记录通过/失败（不记录 URL），验证前不称生产可用。
