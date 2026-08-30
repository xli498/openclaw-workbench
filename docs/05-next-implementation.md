# 下一阶段实施顺序

1. 将 `parseUnifiedPatch` 接入工作区安全解析，逐文件读取并校验 old content。
2. 在所有文件预检通过后才创建快照，避免多文件半执行。
3. 使用临时目录生成完整新树，校验每个 after hash 后再提交替换。
4. 提交阶段增加进程内互斥锁和 workspace revision 二次校验。
5. 失败时按快照清单恢复；恢复失败必须保留现场并返回 `ROLLBACK_PARTIAL`。
6. 用故障注入覆盖：第二个文件 hash 冲突、写入失败、进程中断、符号链接替换和并发变更。

在上述门禁通过前，不接入 Agent 自动 Code 模式。

## 启动扫描阶段（已完成）

- `scanPendingTransactions`：严格模式拒绝非法清单，启动编排使用容错模式隔离单项错误。
- `scanStartupRecovery`：区分单项错误与整轮 `SCAN_FAILED`，支持告警回调失败隔离。
- `startWorkbench`：返回结构化恢复结果、摘要和 `fatalError`，可被 CLI 或上层生命周期接入。
- CLI 已提供 `--root`、`--json`、`--help`，但尚未绑定 OpenClaw channel 生命周期。

## 下一实现单元

1. 为 `FINALIZE_FAILED` 增加持久化状态标记，使下一次启动能识别“文件已完成、清单未完成”的可收敛状态。（已增加 `finalize_failed` 状态与失败元数据落盘；下一步需接入启动时的重试/人工决策展示。）
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
