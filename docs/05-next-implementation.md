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
- **本地测试说明**：最终全量本地为 557 项中 532 通过、2 失败、23 跳过；2 项失败均为 pinned HTTPS transport 测试的 ERR_PROXY_TUNNEL 代理隧道超时，已在基线 1f440e7 的 worktree 上复现同一失败，与本次改动文件无关；Windows-only 测试在 Linux 上按设计跳过，从未声称本地跑过。

## 仍未闭合项（截至第五轮闭环，2026-11-02，写明原因与下一步，不冒充完成）

- **Windows ConPTY resize**：仅有命名管道控制通道的设计文档（~/workspace/wb4-work/windows-pty-resize-design.md，不进仓库），PTY_RESIZE_UNSUPPORTED 仍在。下一步：在已验证的 ConPTY 执行路径上补实现 PR＋绿色 Windows 执行测试（含 $Host.UI.RawUI.WindowSize 观测验证）。
- **LSP 全量剩余**：真实语言服务器接入未验证；UTF-8/UTF-32 编码对齐仅由 mock 与纯转换器验证。下一步：接真实语言服务器实测后再切片。
- **OpenClaw channel / Gateway 生命周期**：未实现（仅探针与帮助面实测）。channel add/login/logout、scope 升级、设备配对、持久化运行时 token、gateway install/start 均未做（授权边界止步）。下一步：凭用户授权的非密钥登录/配对路径，或可注入的已验证 channel 适配器，再推进。
- **公网隧道真实部署验证**：未验证。quick-tunnel 两次建链均失败（TLS 握手异常类别，带代理与直连均同；已排查时钟偏差约 3 秒、DNS CGNAT sinkhole 答案、公共解析器 UDP 53 被拦）。下一步：仅在能到达真实 Cloudflare 边缘的可 clean egress 主机上重跑哑元 quick 试验，验证前不称生产可用。
- **Streamable 剩余**：回放缓冲持久化已实现（replayStorePath），但服务端状态快照端点等完整语义仍按 MCP 2025-06-18 逐项核对中。下一步：按协议逐项补齐并加红队测试，仍守审批与 allowlist。

## 第六轮收尾 docs 同步（2026-11-02，main efad9c8；PR #47–#51 全部 open、未合）

本节只同步已验证的状态：未合的 PR 一律写 open、未合，不得写成已合；数字只写 API／CI 实测的，不照搬他人汇总数。仓库内没有 `docs/05/` 目录，本文件即任务所指的 docs/05（`docs/05-next-implementation.md`）。

### 第六轮 open PR 状态表（以 GitHub API 实测为准）

| PR | 分支 / head | 改动范围（与 main 的 diff 实测） | CI（check-runs 实测，每项 3 个检查） | 合并门 |
| --- | --- | --- | --- | --- |
| #47 Windows ConPTY resize | `wb6-pty-resize` / `3623152` | `runtime/windows-pty-provider.mjs`、`runtime/windows-pty.ps1`、新增 `tests/windows-pty-resize.test.mjs`；命名管道控制通道（每会话 `ocw-pty-<uuid>`），无控制通道不静默退化为无 resize 会话 | test (22.19.0)、test (24.x)、windows-compatibility 全部 success | 协调员通报：主窗口第一批审查中；GitHub 上无 review 记录，审查在主窗口侧进行。结论与交叉核对未齐前不合 |
| #48 LSP 真实 pyright | `wb6-lsp-real` / `a920b07` | 仅新增 `tests/lsp-real-server.test.mjs`（3 项，真实 pyright-langserver over stdio，hover/definition、diagnostics、didOpen/didChange/didClose），无运行时改动 | test (22.19.0)、test (24.x)、windows-compatibility 全部 success，但该绿不等于 CI 上已验真实服务器（见下） | 两道门未齐：①协调员通报：审查包已按新规则转发 ChatGPT 网页版 Codex 窗口，复核结论交叉核对未完成；②CI pyright 安装步未齐：#48 diff 只改测试文件，`ci.yml` 未动，CI 上无 pyright 时测试按设计跳过（`SKIP_NO_SERVER`），故 CI 绿不能当作真实服务器已验的证据 |
| #49 快照校验加固 | `wb6-streamable-snapshot` / `64b72b0` | 仅 `runtime/mcp-bridge-server.mjs` 的快照校验／加载器＋新增 `tests/mcp-bridge-snapshot-red-team.test.mjs`（7 项） | test (22.19.0)、test (24.x)、windows-compatibility 全部 success | 待复核结论与交叉核对后才可合并 |
| #50 程序化路径过期 | `wb6-streamable-expiry` / `143d82a` | 仅 `runtime/mcp-bridge-server.mjs` 的 `broadcast` 与 `resumeSession` 两处调用点＋新增 `tests/mcp-bridge-expiry-red-team.test.mjs`（4 项） | test (22.19.0)、test (24.x)、windows-compatibility 全部 success | 待复核结论与交叉核对后才可合并 |
| #51 客户端 404 重初始化 | `wb6-streamable-session404` / `c3a130b` | 仅 `runtime/mcp-http-transport.mjs`（request、notify、subscribe 三路）＋新增 `tests/mcp-http-session-recovery.test.mjs`（4 项） | test (22.19.0)、test (24.x)、windows-compatibility 全部 success | 待复核结论与交叉核对后才可合并 |

建议合并顺序：#49 → #50 → #51，每合一个重看 CI（分支保护 strict，要求最新 main 下的 test (22.19.0) 与 test (24.x) 绿；#47、#48 各自的合并门与此三者无关，不捆绑）。

### 审查路线（最新规则，取代第五轮的 GPT Work 表述）

- 往后新复核一律走 ChatGPT 网页版 Codex 窗口（查看电脑配置任务线程，Full access＋GPT-6.1 Sol Extra High），结论须经本窗口交叉核对后才采纳。
- 第一批、第二批旧 GPT Work 包不动、不转 Codex；第三批及以后走 Codex。第五轮 PR #45 的 GPT Work 审查记录是历史事实，保留原样，不改写。
- 大段代码不得裸粘进 Codex 网页版输入框：成对美元符会被界面当数学公式渲染，PR #48 首轮即因此误报源码损坏。优先让 Codex 直接读 GitHub 原文；小片段用四重反引号围栏包裹，并在指令里写明围栏内美元符按原文读。
- 本 docs 同步 PR 本身如需复核，也按 Codex 窗口表述报给协调员转发主窗口，不另发 GPT Work 包。

### Streamable 协议逐项核对表（MCP 2025-06-18，主口径为已合入 main 的实现）

已合入 main（第五轮及以前，README 与本文件前文一致）：

- 单端点 Streamable HTTP 会话：`initialize` 协商、`tools/list`、`tools/call` 使用 `Mcp-Session-Id` 与 `MCP-Protocol-Version`；`notify`（202/204）、`DELETE` 关闭会话。
- GET SSE 订阅与 Last-Event-ID 续接：每会话有界回放缓冲（默认 100 条，`evt-N` 递增 id）；过期／截断／超前／非法 id 返回 410 `MCP_EVENT_EXPIRED` 或 400 `MCP_EVENT_ID_INVALID` 且不含事件内容；跨会话回放隔离；Bearer／会话检查优先于回放。
- 持久回放 `replayStorePath`：快照只含事件内容与游标，会话 id 仅 SHA-256 哈希，不含 token；重启后旧会话按过期处理、不静默复活；关闭会话留 tombstone、永不复活；跨重启续接须调用方显式 `resumeSession`（新会话 id、一次性）。
- 空闲会话过期（HTTP 路径）：`requireSession` 先执行过期判定；过期会话处处 404。
- 显式 `broadcast`：服务端自动推送只来自显式调用，工具执行不自动产生广播；`patch`／`command` 仍只返回待审批提案。
- 审批与 allowlist 全程未动：Bridge 不替代控制面审批，工具调用仍命中 allowlist。

本轮补齐三项（全部 open、未合，见上表；三者互不重叠，各自只改一处）：

- #49 快照校验加固：事件 id 须与 sequence 对应（`evt-N` ⇔ sequence N）、缓冲须连续无缺口、游标须跟随末事件（空缓冲的开放会话游标须为 1，关闭 tombstone 豁免该条但不豁免其他条）；编码帧须恰为 broadcast notification（jsonrpc 2.0、有 method、无 id／result／error 键，params 若有须为对象）；任一校验失败即整条目丢弃、同文件内有效条目不受影响；同键后来重复条目不得覆盖首个有效快照。红队 7 项覆盖：id／sequence 错位、缺口、重复、游标错位、响应／请求帧混入、合法截断缓冲与 tombstone、坏条目隔离与跨会话隔离、截断／空／错版文件 fail-closed、超大事件丢弃。
- #50 程序化路径过期：`broadcast` 与 `resumeSession` 入口先执行过期判定， idle-expired 的活会话广播失败且不被复活、resume 报 `MCP_SESSION_EXPIRED` 而非 `MCP_SESSION_ACTIVE`；活会话广播仍刷新 activity。红队 4 项覆盖：广播复活阻断、活会话刷新、resume 过期语义、HTTP／broadcast／resume 三路一致 404。
- #51 客户端 404 重初始化：request、notify、GET SSE 三路，携带会话 id 的请求收到 404 即清空旧会话 id 与已协商版本并报 `MCP_SESSION_NOT_FOUND`，随后 `initialize()` 可立即以裸 InitializeRequest 重开；无会话 id 的 404（如错 endpoint）仍为普通 HTTP 错误。红队 4 项覆盖：request、notify、GET 三路清会话与重初始化、无会话 id 的 404 不误清。

三 PR 均守住的点（diff 实测）：快照不含 token／密钥（#49 只加校验、不加字段）；管理面只产提案（#49–#51 均未碰管理面与审批代码）；审批与 allowlist 未动（#49 改校验／加载器、#50 改两处过期调用点、#51 改客户端 404 处理，无一触及审批或 allowlist）。

部分／未采纳／未闭合项（逐项裁决待定，不冒充完成）：

- POST SSE 续接：部分。POST 单帧响应不可续接；410 后客户端须自行用 tools/list/call 重查状态。
- Initialize 版本协商：未采纳。服务端与客户端均只认 `2025-06-18`，不符返回 400 `MCP_PROTOCOL_INVALID`；不做多版本协商。
- `notifications/cancelled`：未处理。除 `notifications/initialized` 外的 notification 在工具路由上返回 400；取消语义未实现。
- 服务端主动请求（server-to-client requests）：未实现。客户端侧对服务端请求的默认回 -32601 仍在；桥接服务端不发主动请求。
- 多 GET 流扇出：已知张力。`streamCount` 存在，但多流并发语义未逐项裁决。
- 服务端状态快照 HTTP 端点：未采纳。只有程序化 `resumeSession`，无 HTTP 快照端点。
- 快照留存无界：未闭合。单会话缓冲有 `maxReplayEvents` 上限，但快照文件条目总数无上限、无定期清理；过期快照只在被 resume 触及时删除。
- 外部截断致整文件丢失：已知限制。快照文件 JSON 解析失败即整文件丢弃、启动不受影响（#49 红队覆盖 fail-closed，但不恢复部分条目）。
- 快照文件权限：后续加固候选。回放快照写盘经 tmp＋rename，但无显式 0600，与工作区快照 0600／0700 的口径不统一。

### README 与章程口径核对（本次未改 README 与章程）

- README 能力表“本机 Streamable HTTP MCP Bridge”行与章程 §8 现行措辞，经核对仍与已合入 main 的状态一致：ConPTY 已验证状态沿用 #45／#46 的口径（Windows CI 执行测试验证，Windows resize 未接线，默认仍 pty:false）。
- 未把 #47 resize、#48 LSP 真实服务器、#49–#51 Streamable 三项写成已实现；它们合入后，须另起同步改动再改 README 与章程。

## 仍未闭合项（截至第六轮 docs 同步，2026-11-02，最新清单；此前各轮清单为历史快照）

- **Gateway 生命周期**：未实现（仅探针与帮助面实测）。下一步：凭用户授权的非密钥登录／配对路径，或可注入的已验证 channel 适配器，再推进；凡涉及登录、配对、token、写真实配置的验证，须用户明确授权后另行受控验证。
- **公网隧道真实部署验证**：未验证。quick-tunnel 两次建链均失败（TLS 握手异常类别，带代理与直连均同；已排查时钟偏差约 3 秒、DNS CGNAT sinkhole 答案、公共解析器 UDP 53 被拦）。下一步：仅在能到达真实 Cloudflare 边缘的可 clean egress 主机上重跑哑元 quick 试验，验证前不称生产可用。
- **Streamable 部分／未采纳／未闭合项的逐项裁决**：见上表（POST SSE 续接、多版本协商、`notifications/cancelled`、服务端主动请求、多 GET 流扇出、服务端状态快照 HTTP 端点、快照留存无界、外部截断整文件丢失、快照文件权限），每项须单独裁决采纳／不采纳／排期，不得打包默认通过。
- **#47／#48／#49／#50／#51 的合并门**：见上表。#47 等第一批审查结论与交叉核对；#48 等 Codex 窗口复核结论交叉核对＋CI pyright 安装步；#49–#51 等复核结论与交叉核对，建议顺序 #49 → #50 → #51，每合一个重看 CI。
- **承接项（不重列已闭合项）**：LSP 真实服务器接入在 #48 合入前仍算未验证（CI 安装步缺失时测试跳过）；Windows resize 在 #47 合入前仍为 `PTY_RESIZE_UNSUPPORTED`；MCP 管理面板全量编辑器与 deny/cancel 路由已在第四轮闭合，不再重列。
