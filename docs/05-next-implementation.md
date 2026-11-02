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

## 仍未闭合项（截至第二轮闭环，2026-11-01，历史快照；以文末第三轮清单为准）

- **LSP 全量**：未实现。下一步：在只读切片上补文档同步（didOpen/didChange/didClose）、诊断接入与经审批的编辑路径（applyEdit 仍须走 Patch 审批），并支持多语言服务器配置。
- **PTY 窗口尺寸与 Windows PTY**：未实现。下一步：仅在明确需要时做 resize 协议（宿主注入的尺寸通道）与 Windows ConPTY 方案，默认仍保持 pty:false。
- **OpenClaw channel / Gateway 生命周期**：未实现（仅探针已完成）。`createGatewayLifecycle` 的 probe() 在本机与 CI 环境实测为 CLI_NOT_FOUND（openclaw 未安装），start() 无显式注入适配器时明确拒绝，绝不猜测或硬编码 OpenClaw 私有协议；`createGatewayAdapter` 仍只有回环 WebSocket 传输边界且禁公网。下一步：先在已安装 OpenClaw 的受控环境实测稳定集成接口与 docs/01 的 Gateway WebSocket、设备配对、scope 升级清单，再设计生命周期接入。
- **完整 streamable HTTP 会话语义的剩余项**：未全部开放。下一步：按 MCP `2025-06-18` 补服务端对客户端请求的断线续接（Last-Event-ID 回放）与 HTTP 工具执行路由的完整语义，仍须守住审批与 allowlist。
- **MCP 管理桌面面板**：未实现。下一步：在已完成的管理面 API 上补桌面控制台面板，仍须守住审批与配置漂移失效。
- **公网隧道真实部署验证**：未验证，已按受控规则停下（不是漏做）。核查：本机与 CI 均无 cloudflared/ngrok CLI；真实验证需要下载第三方隧道二进制，且 named/fixed 模式需要账号凭证与域名绑定，超出受控范围；适配器本身已用 mock CLI 验过（shell:false、Bearer 仅放环境变量、随机路由、reset 失效旧路由、状态/审计不含 URL 与 token）。下一步：仅在已安装 cloudflared 且操作者明确批准的前提下，对哑元回环服务做一次短时 quick-tunnel 试验、立即关闭、只记录通过/失败（不记录 URL），验证前不称生产可用。

## 第三轮闭环已完成（2026-11-01，PR #35–#40）

- **streamable HTTP 剩余语义（已完成，进程内回放）**：桥接服务端新增每会话有界回放缓冲（默认 100 条，`evt-N` 递增 id），GET SSE 订阅带 Last-Event-ID 时只重放缓冲内该 id 之后的事件；过期/截断/超前/非法 id 返回 410 `MCP_EVENT_EXPIRED` 或 400 `MCP_EVENT_ID_INVALID` 且不含事件内容；跨会话回放隔离、Bearer/会话检查优先于回放；broadcast 仍只来自显式调用，工具执行不自动产生广播；patch/command 仍只返回待审批提案。限制：缓冲仅进程内内存，桥接重启、会话过期或 DELETE 关闭后无法续接；POST SSE 单帧响应不可续接；410 后客户端须自行用 tools/list/call 重查状态。
- **LSP 全量切片（文档同步、诊断、经审批编辑、多语言配置已完成）**：didOpen/didChange/didClose（含版本追踪、UTF-16 增量变更、workspace-root URI  enforcement、内容上限）、publishDiagnostics 收集（白名单字段、脱敏、每 URI 封顶）、`collectWorkspaceEditProposal`（只产冻结提案数据，create/rename/delete 拒绝，落盘仍走 Patch 提案＋独立审批）、多语言服务器注册表（配置-only，复用命令/参数/环境校验）。未验证：真实语言服务器与 Windows。
- **PTY（POSIX resize 已完成；Windows ConPTY 代码已合但未验证）**：POSIX helper 经 fd3 控制通道接受 `cols rows` 行并用 TIOCSWINSZ + SIGWINCH 生效，provider 句柄与 terminal-session 均透传 resize（cols 1–500、rows 1–200）；Windows ConPTY provider 与 PowerShell P/Invoke helper 已合入，文件头标 WINDOWS_PTY_STATUS: UNVERIFIED，Windows 测试在 Windows CI 上按设计跳过，故 ConPTY 生成、输入/输出 pump、cancel、退出码均未验证；Windows resize 明确为 PTY_RESIZE_UNSUPPORTED，留待后续切片（需持久控制通道）。
- **MCP 管理桌面面板（已完成，后端 0 改动）**：桌面控制台新增 MCP 面板，复用已合管理面 API：只显示名称/启用状态/工具名与 authorized 标记，不显示配置原文、命令参数与密钥引用；update/remove 只生成提案，批准后需重新启用。收窄口径：面板更新目前只改显示名称；后端无拒绝入口，面板只提供批准；漂移失效依赖面板见过的旧 configHash 或提案返回 MCP_CONFLICT。
- **Gateway（探针测试加强与帮助面实测已完成；生命周期仍未闭合）**：官方 openclaw CLI 2026.10.9 已在受控 VM 家目录装上（605M，含 344 个包），只读 --help 实测确认 gateway/channels/顶层命令名存在；但未实测到稳定、公开的集成接口输出（无运行网关时无法观测 --json 形态与 RPC 协议），故未编写任何生命周期接入代码，start() 无显式注入适配器时仍拒绝。新增探针测试 6 项与调研纪要 docs/gateway-lifecycle-wb3-research.md。
- **公网隧道真实部署验证（未闭合，已按受控规则停下）**：cloudflared 已从官方渠道下载到 /tmp（约 40.3MB），哑元回环服务本身可达；但 quick-tunnel 两次建链均失败（TLS 握手异常类别，带代理与直连均同），未建立可用隧道，试验后进程均已确认退出、无长期 endpoint 残留。下一步：仅在隧道建链端点 TLS 握手能正常通过的环境中重跑哑元 quick 试验，或由操作者明确批准其他受控路径；不改 named/fixed、不接真实工作区。
- **并行时序 flaky（已确定性修复，非阈值蒙混）**：MCP HTTP 超时测试的 slow 服务改为永不响应（超时必赢）、非超时断言改用 generous-timeout 传输、洪泛测试改为轮询等服务端观测到关闭；运行时修了显式调用方 abort 优先于超时计时器的错误映射（abortedByCaller 标志）。全量本地（代理变量清空）：542 项、527 通过、0 失败、15 跳过（Windows-only）。

## 仍未闭合项（截至第三轮闭环，2026-11-01，写明原因与下一步，不冒充完成）

- **LSP 全量剩余**：真实语言服务器接入未验证；`documentChanges` 的 create/rename/delete 类编辑仍被拒绝而非提案化；didChange 编码对齐（UTF-8/UTF-32 服务器）未验证。下一步：接真实语言服务器实测后再切片。
- **PTY 剩余**：Windows ConPTY 生成、输入/输出 pump、cancel、退出码未验证（Windows 测试按设计跳过）；Windows resize 未接线（PTY_RESIZE_UNSUPPORTED）。下一步：在 Windows CI/受控 Windows 环境实测 ConPTY 路径后，再补命名管道控制通道做 Windows resize。
- **OpenClaw channel / Gateway 生命周期**：未实现（仅探针与帮助面实测）。下一步：在受控隔离环境以隔离 profile 起本地回环网关，实测 gateway status/probe/health 的裸跑输出（尤其 --json 形态）与 channels list/status 的空配置行为，拿到真实输出样本后才设计生命周期接入；凡涉及登录、配对、token、写真实配置的验证，须用户明确授权后另行受控验证。
- **streamable HTTP 剩余**：进程内回放缓冲重启即失；无服务端状态快照端点。下一步：如需跨重启续接，设计持久化回放缓冲与快照语义（仍守审批与 allowlist）。
- **MCP 管理剩余**：面板全量配置编辑器未实现；提案拒绝/撤销入口缺失（后端无 deny/cancel 路由）；更新后重新启用无面板入口。下一步：在管理面 API 上补上述入口。
- **公网隧道真实部署验证**：未验证（见上）。下一步：仅在 TLS 建链可通的环境重跑哑元 quick 试验，验证前不称生产可用。

## 第四轮闭环已完成（2026-11-01，PR #42–#44）

- **LSP documentChanges 提案化（已完成）**：create/rename/delete 类编辑从拒绝改为只产冻结提案数据，落盘仍走 Patch 提案＋独立审批；positionEncodings 协商与 UTF-16 转换已合；pyright 实测 hover/definition 通过（UTF-8/32 对齐由 mock 与纯转换器验证，非 pyright）。
- **MCP 管理完整化（已完成）**：后端 deny/cancel 路由（审批 token＋actionHash 绑定，拒绝后不得再批准）；桌面面板补全量配置编辑器（仅 env 键名，不含密钥值）、拒绝/撤销按钮与更新后重新启用入口。
- **Streamable 持久回放（已完成）**：快照只含事件内容与游标（会话 id 仅 SHA-256 哈希，不含 token）；重启后旧会话按过期处理、不静默复活；跨重启续接须显式 resumeSession（新会话 id、一次性）。

## 第五轮闭环已完成（2026-11-02，GPT Work 审查交叉核对，PR #45）

- **审查来源与核对方式**：主窗口谷歌浏览器 GPT Work 模式（GPT-6.1 Sol，Extra High）静态审查结论，审查包在 ~/workspace/wb4-work/gpt-review-packet/（不进仓库）；结论采纳前逐项在 wb4-pty 现行 head 源码里验真，行号以现行 head 为准。未用 Codex（该授权已作废）。
- **Q2 指针修复（已验证）**：ps1 直接传 $hPC，删 $pcPtr 分配/写入/释放，保留外层属性列表清理；管道改为非继承、CreateProcess 的 bInheritHandles 改为 $false（旧注释称必须为 TRUE 已纠正，伪控制台属性与普通句柄继承不得混为一谈）；CreateProcess 成功后立即关闭并置零 helper 持有的 $inputPipe.Read/$outputPipe.Write，主机端 FileStream 改为单一所有者；[uint32] 读码、进入 finally 前输出 PTY_CHILD_EXIT decimal/hex，provider 仅在确实收到时附加 error.childExitCode，顶层 result.code 契约与 0/1 归一化不变。错误码纠错已验算：3221225794 = 0xC0000142、3221225474 = 0xC0000002、3221226021 = 0xC0000225；“CRLF 导致初始化失败”无证据，未采纳为根因。
- **Q1 清理顺序与日志（已验证）**：PTY_STAGE/PTY_WAIT 日志（Wait 返回值不再 [void] 丢弃）；provider 增加 handle.diagnostics()，测试超时 abort 前先打印诊断；清理改为“解除实际 I/O → 有界等待 → Dispose”，输入 pump 加共享停止标志＋尽力而为的 CancelIoEx（只取消调用线程的 I/O，FALSE 只作信息）、输出 pump 保持运行、先 ClosePseudoConsole 再等 EOF；仍阻塞的 pump 不同步 Stop，跳过 Dispose 并记日志，靠进程退出终止；结算后移除 abort listener。分步证据：Q2 单独落地时 230/232 原样超时，Q1 落地后才变绿，故 Q1/Q2 未合并认定。
- **Q3 高项（已验证）**：provider 改为 exit 只记状态、close 收齐 stdio 后刷新两个 decoder 再结算；231 断言 error.childExitCode === 42（启动失败再也不能冒充真 42）；233 先等就绪标记、断言取消前未退出、再取消；新增大输出（100 行＋唯一尾标记）测试，尾标记须在 onExit 解析时已在输出中。
- **Q3 中、低项（已验证）**：provider 注册 stdin error 监听；taskkill 加 5 秒有限 timeout 并保存结果；环境合并按 Windows 不区分大小写规范化键，helper 按 OrdinalIgnoreCase 排序环境块；全部 cmd 测试 argv 加 /d（AutoRun 未断言为原因，仅作加固）。
- **Windows CI 验证结果（PR #45 最终 head cbaea26，run 41391398892，job 125103384548）**：test (22.19.0) success、test (24.x) success、windows-compatibility success；Windows PTY 测试 229–236 全部通过（229 PS 可用、230 echo、231 exit 42、232 input、233 cancel、234 尾标记、235 提前结束写、236 环境规范化）。PR #45 以合并 commit d810db0 合入 main，wb4-pty 分支已删。
- **本地测试说明**：最终全量本地为 557 项中 532 通过、2 失败、23 跳过；2 项失败均为 DNS 地址固定并保留 TLS 验证的 HTTPS 传输测试的 ERR_PROXY_TUNNEL 代理隧道超时，已在基线 1f440e7 的 worktree 上复现同一失败，与本次改动文件无关；Windows-only 测试在 Linux 上按设计跳过，从未声称本地跑过。

## 仍未闭合项（截至第五轮闭环，2026-11-02，写明原因与下一步，不冒充完成）

- **Windows ConPTY resize**：仅有命名管道控制通道的设计文档（~/workspace/wb4-work/windows-pty-resize-design.md，不进仓库），PTY_RESIZE_UNSUPPORTED 仍在。下一步：在已验证的 ConPTY 执行路径上补实现 PR＋绿色 Windows 执行测试（含 $Host.UI.RawUI.WindowSize 观测验证）。
- **LSP 全量剩余**：真实语言服务器接入未验证；UTF-8/UTF-32 编码对齐仅由 mock 与纯转换器验证。下一步：接真实语言服务器实测后再切片。
- **OpenClaw channel / Gateway 生命周期**：未实现（仅探针与帮助面实测）。channel add/login/logout、scope 升级、设备配对、持久化运行时 token、gateway install/start 均未做（授权边界止步）。下一步：凭用户授权的非密钥登录/配对路径，或可注入的已验证 channel 适配器，再推进。
- **公网隧道真实部署验证**：未验证。quick-tunnel 两次建链均失败（TLS 握手异常类别，带代理与直连均同；已排查时钟偏差约 3 秒、DNS CGNAT sinkhole 答案、公共解析器 UDP 53 被拦）。下一步：仅在能到达真实 Cloudflare 边缘的可 clean egress 主机上重跑哑元 quick 试验，验证前不称生产可用。
- **Streamable 剩余**：回放缓冲持久化已实现（replayStorePath），但服务端状态快照端点等完整语义仍按 MCP 2025-06-18 逐项核对中。下一步：按协议逐项补齐并加红队测试，仍守审批与 allowlist。
