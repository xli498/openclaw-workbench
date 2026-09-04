
## 2026-08-29：Change Engine 初版

- 目标：实现文件变更的 hash 校验、快照、原子替换、回滚和路径边界。
- 初次实现：正常路径、hash 冲突、路径越界测试通过。
- 主动复审：补充符号链接逃逸防护后发现变量残留导致正常写入报 `target is not defined`；已修复。
- 补充攻击测试：写入逃逸符号链接被 `SYMLINK_ESCAPE` 拒绝。
- 当前结果：全量 `npm test` 17/17 通过，`git diff --check` 通过。
- 尚未宣称完成：目录级多文件 Patch、并发锁、快照清理策略和崩溃恢复扫描仍待实现。

## 2026-08-29：Unified Patch 解析器

- 目标：解析多文件 unified diff，校验路径、hunk 和声明目标，供后续变更计划使用。
- 主动复审 1：正常文件的 old/new 路径被误判为重复；改为按文件条目去重。
- 主动复审 2：Patch 末尾换行被误计为 hunk 行；改为忽略裸分隔空行，保留带前缀的真实空行。
- 当前结果：全量 `npm test` 20/20 通过，`git diff --check` 通过。
- 尚未宣称完成：当前只解析和校验 Patch，尚未真正应用多文件 Patch；尚未实现跨文件原子提交、并发锁和回滚事务。

## 2026-08-29：多文件 Change Transaction

- 目标：实现多文件 Patch 的全量预检、临时文件、快照、提交和失败恢复。
- 已实现：进程内互斥锁、目标路径/符号链接校验、hunk 上下文校验、全文件预检后再写入、workspace revision 门禁、每文件快照、临时文件原子 rename、提交失败恢复。
- 主动复审：revision 测试首次遗漏 `declaredPaths`，先触发目标声明错误；已补齐测试输入后重新验收。
- 当前结果：全量 `npm test` 25/25 通过，`git diff --check` 通过。
- 限制：当前只支持同路径原地更新，不支持新建/删除/重命名；进程内锁不覆盖多进程；提交中断恢复仍需单独的崩溃恢复扫描。

## 2026-08-29：事务复审增强

- 增加动态 `getCurrentRevision` 二次读取和提交后每文件 hash 验证。
- 失败恢复细分为 `COMMIT_FAILED` 与 `ROLLBACK_PARTIAL`，保留回滚失败明细。
- 复审确认：所有预检失败不会修改工作区；测试总数 25/25 通过。

## 2026-08-29：持久化审计与复审

- 新增 JSONL 持久化审计日志，记录 `previousHash` / `recordHash` 哈希链，可重载后继续追加。
- 复审发现测试中将换行分隔符写成字面量 `\\n`，导致两条日志被当成一行；已修正测试并重新运行。
- 当前结果：全量 `npm test` 26/26 通过，`git diff --check` 通过。
- LangGraph 参考意见的落点：可见状态、可调试执行图、明确节点边界对产品有帮助；但 Workbench 仍保持 Runtime Adapter 隔离，不把 LangGraph 或 OpenClaw 内部 API 直接写死为核心依赖。

## 2026-08-29：崩溃恢复扫描复审

- 新增 `runtime/recovery.mjs`：扫描事务清单、校验清单状态和工作区边界、检查目标/快照当前 hash。
- 当前恢复策略为“先识别、再人工/上层策略决定恢复”，没有未经确认自动覆盖文件，避免把并发修改误判成可回滚。
- 复审覆盖：已完成事务过滤、损坏清单、工作区外路径、目标缺失/快照缺失状态报告。
- 当前结果：全量 `npm test` 30/30 通过，`git diff --check` 通过。
- 下一阶段：实现基于 hash 三态判定的受控 `resume` / `rollback`，并为每种决策增加审批和审计事件。

## 2026-08-29：恢复决策安全门

- 新增 `decideRecovery`，按当前文件 hash 与 before/after hash 的关系分类：`already_committed`、`can_resume_or_discard`、`conflict`、`blocked`。
- 并发修改直接 `blocked`；快照缺失直接 `blocked`；只有完全一致的已提交状态才允许上层标记完成。
- 可继续或回滚的状态只返回 `requires_approval`，不自动覆盖工作区。
- 当前结果：全量 `npm test` 33/33 通过，`git diff --check` 通过。

## 2026-08-29：受控恢复执行

- 新增 `executeRecovery`，支持经明确审批后的 `rollback` / `resume` 入口。
- 默认拒绝无审批恢复；并发修改、未知 hash 状态、缺失快照均阻断。
- `rollback` 通过临时文件写入后原子替换，并写入审计事件。
- 复审发现 rollback 测试初始使用占位 hash，正确触发并发修改阻断；已改用真实 before/after hash 后通过。
- 当前结果：全量 `npm test` 35/35 通过，`git diff --check` 通过。
- 尚未实现：启动时自动恢复调度。

## 2026-08-29：恢复执行第二轮复审

- `resume` 已补为受控原子执行：校验临时文件 hash 后再 rename；临时文件缺失或 hash 不符直接阻断。
- 增加基于文件系统的 recovery lock，覆盖跨进程并发恢复；锁目录不存在时自动创建。
- rollback/resume 均在执行前重新 inspect，避免依赖旧报告。
- 复审中发现并修复测试环境未创建锁目录的问题；另一次验证命令路径大小写误写，按原命令重跑后通过。
- 当前结果：全量 `npm test` 36/36 通过，`git diff --check` 通过。
- 剩余风险：启动时自动恢复仍只做扫描，不自动执行。

## 2026-08-29：多文件恢复事务复审

- `executeRecovery` 增加跨文件失败回滚：任一文件恢复失败，会按逆序恢复已经应用的文件。
- `resume` 对临时文件重新计算 `afterHash` 后才允许原子替换；已经处于 after 状态的文件跳过，支持进程中断后的幂等续作。
- 增加文件系统 recovery lock，避免多进程同时恢复同一工作区。
- 故障注入测试覆盖第二个文件失败，确认第一个文件会恢复到快照内容。
- 复审中发现并修复错误路径：`applied.reverse()` 会改变原数组，改为复制后逆序，保留准确错误详情。
- 当前结果：全量 `npm test` 37/37 通过，`git diff --check` 通过。
- 剩余风险：启动时自动恢复仍只做扫描，不自动执行；恢复清单状态更新和审计落盘还需进一步整合。

## 2026-08-29：事务最终状态与多文件回滚复审

- 主事务清单统一使用 `manifestFiles()` 生成，确保 `prepared` 阶段、`committing` 阶段和最终状态都包含完整目标、临时文件、快照及 hash 信息。
- 恢复成功后支持通过 `updateManifest` 原子更新为 `committed` 或 `rolled_back`，审计事件携带最终状态。
- 多文件恢复中途失败会逆序回滚已应用文件，并保留 `ROLLBACK_PARTIAL` 错误分支。
- 新增 resume 最终状态测试；首次测试使用了与实际文件不一致的占位 hash，正确触发并发修改保护，随后改为从 fixture 实际读取 hash 并通过。
- 当前结果：全量 `npm test` 39/39 通过，`git diff --check` 通过。

## 2026-08-29：事务审计与状态落盘复审

- 主事务流程新增可选 `audit` 注入，生命周期写入 `prepared`、`committing`、`committed` 事件。
- manifest 在写入 `prepared` 前即生成完整路径与 hash 字段，避免早期清单缺少恢复所需材料。
- 恢复流程支持成功后通过 `updateManifest` 原子更新最终状态，并在审计事件中绑定最终状态。
- 新增事务生命周期审计测试，确认事件顺序严格为 `prepared → committing → committed`。
- 清理未使用的 `open` 导入，并完成全量回归。
- 当前结果：全量 `npm test` 39/39 通过，`git diff --check` 通过。
- 仍需处理：审计写入失败时的事务语义、启动时恢复调度、统一主事务与恢复锁。

## 2026-08-29：跨进程事务锁与审计故障语义复审

- 主事务增加 `transaction.lock` 文件锁，补齐原先仅模块级 `active` 锁的跨进程缺口；已有锁时返回 `BUSY`。
- 恢复流程仍使用独立 `recovery.lock`，因此尚未声称两条路径完全互斥。
- 增加审计失败语义测试：若最终 `transaction.committed` 审计追加失败，已落盘的 `committed` manifest 与文件内容保持事实一致，错误不会被伪装成事务回滚。
- 当前策略：审计不可用是可观测性故障，而非篡改已完成写入的理由；调用方需把该失败作为告警并重试审计，不得误导为未提交。
- 当前结果：全量 `npm test` 41/41 通过，`git diff --check` 通过。

## 2026-08-29：统一工作区写锁复审

- 主事务与 Recovery 统一使用 `.openclaw-workbench/write.lock`，消除原先 `transaction.lock` / `recovery.lock` 两套锁并存造成的互斥盲区。
- Recovery 不再维护独立锁逻辑，直接复用 `acquireWorkspaceWriteLock`。
- 复审首次失败原因是测试仍创建旧锁文件名；已修正测试并重新执行。
- 第二次复审发现 Recovery 对 `BUSY` 的错误映射会被状态检查前的并发修改掩盖，确认测试 fixture 的文件状态后修正锁测试数据。
- 当前结果：全量 `npm test` 41/41 通过，`git diff --check` 通过。
- 注意：文件锁可防止并发进入，但不具备租约/过期回收；异常硬中断可能留下 stale lock，后续需设计带 PID、时间戳和安全接管规则。

## 2026-08-29：stale lock 安全接管复审

- `write.lock` 写入 `pid`、`createdAt` 和随机 `token` 元数据。
- 只有同时满足以下条件才允许接管：超过 `staleAfterMs`、PID 已不存在、锁内容可解析且字段合法。
- 活动进程锁、损坏锁和竞争接管失败均保持 `BUSY`，不会自动删除或覆盖。
- 释放操作具备幂等性，重复释放不会产生额外副作用。
- 新增 stale lock 接管及损坏 lock 拒绝测试。
- 当前结果：全量 `npm test` 43/43 通过，`git diff --check` 通过。
- 注意：PID 重用和时钟回拨仍需进一步处理；当前实现没有跨平台进程启动时间证明。

## 2026-08-29：stale lock 竞态与元数据复审

- stale lock 接管不再直接 `unlink` 旧锁，改为先 `rename` 到随机隔离路径，再删除隔离文件，避免读检查与删除之间误删竞争者新锁。
- stale 判定增加 `token` 合法性和 `now >= createdAt` 检查，时钟回拨时不接管。
- lock 元数据写入失败时立即关闭句柄并清理新建锁，避免留下半初始化锁。
- 新增测试确认接管后会生成新的 PID/token，并能正常释放。
- 当前结果：全量 `npm test` 44/44 通过，`git diff --check` 通过。
- 未宣称完全解决：PID 重用仍需进程启动时间或平台级句柄验证；隔离文件清理失败也需要后续可观测告警。

## 2026-08-29：恢复最终落盘失败语义复审

- 恢复动作完成后，`updateManifest` 失败不再被静默吞掉，统一转换为 `FINALIZE_FAILED`。
- 文件内容已经恢复但清单未能更新时，结果明确表示“恢复动作已执行、最终状态落盘失败”，避免误报为完全成功。
- 若可用，追加 `transaction.finalize_failed` 审计事件；审计本身失败不会覆盖原始 `FINALIZE_FAILED`。
- 新增最终清单更新失败测试，确认目标文件已恢复且错误分类准确。
- 当前结果：全量 `npm test` 46/46 通过，`git diff --check` 通过。

## 2026-08-29：启动后已提交事务收敛复审

- 新增 `finalizeAlreadyCommitted`，用于处理文件已经全部达到 `afterHash`、但 manifest 仍停留在 `committing` 的场景。
- 收敛前重新执行完整 `inspectPendingTransaction` 与 `decideRecovery`，只有决策为 `mark_committed` 才允许更新。
- manifest 使用临时文件 + 原子 `rename` 写回，路径仍受工作区边界校验。
- 使用统一 `write.lock`，与事务提交和普通 Recovery 互斥。
- 新增测试：已全部写入 afterHash 时原子标记 `committed`。
- 当前结果：全量 `npm test` 47/47 通过，`git diff --check` 通过。
- 未宣称完成：启动扫描器尚未自动调用该收敛函数，仍需由上层显式编排并携带审计与告警策略。

## 2026-08-29：启动恢复扫描编排复审

- 新增 `runtime/startup-recovery.mjs` 与 `scanStartupRecovery`。
- 启动扫描会重新检查每个未完成 manifest 的文件状态并生成恢复决策。
- 仅对全部文件已达到 `afterHash` 的 `mark_committed` 场景自动原子收敛。
- `resume`、`rollback`、冲突和材料缺失不会被启动扫描自动执行，仍需显式审批。
- 启动扫描使用统一 `write.lock`，并保留审计接口。
- 新增测试验证“自动收敛已完成事务、不自动恢复冲突事务”。
- 当前结果：全量 `npm test` 48/48 通过，`git diff --check` 通过。
- 当前仍需补充：单个 manifest 收敛失败时的继续扫描策略、启动告警结果模型，以及正式启动入口接入。

## 2026-08-29：启动扫描失败隔离复审

- `scanStartupRecovery` 改为容错扫描：单个 manifest 非法、检查失败或收敛失败时生成结构化 `error` 结果，并继续处理其余事务。
- 原始 `scanPendingTransactions` 默认仍保持严格模式，发现非法 manifest 直接失败；只有启动编排显式传入 `tolerateInvalid: true` 才隔离坏清单。
- 启动结果保留 `transactionId`、状态、决策、是否收敛和错误 `code/message`，支持上层告警。
- 新增测试验证有效事务继续收敛、非法事务单独报错、不阻断整轮扫描。
- 当前结果：全量 `npm test` 49/49 通过，`git diff --check` 通过。
- 发现并修复：首次测试暴露严格扫描会在单项非法 manifest 处提前终止；已将容错边界限定在启动编排层，未放宽底层默认校验。

## 2026-08-29：正式启动入口复审

- 新增 `runtime/index.mjs` 的 `startWorkbench` 作为正式启动编排入口。
- 启动入口执行恢复扫描，并返回结构化摘要：扫描数、自动收敛数、错误数、需审批数、阻断数。
- 启动入口只自动收敛已完成事务，不自动执行 `resume` 或 `rollback`。
- 启动错误通过 `onStartupRecoveryAlert` 向上层传递，不直接吞掉。
- 新增空工作区启动入口测试。
- 当前结果：全量 `npm test` 50/50 通过，`git diff --check` 通过。
- 当前正式入口仍是库函数，尚未绑定桌面 UI、CLI 或 OpenClaw channel 生命周期。

## 2026-08-29：CLI 启动入口复审

- 新增 `bin/workbench.mjs`，提供明确的 `--root`、`--json`、`--help` 参数。
- `package.json` 增加 `openclaw-workbench` bin 映射。
- CLI 复用 `startWorkbench`，不直接绕过恢复策略或写入逻辑。
- 默认文本输出只返回启动摘要；`--json` 返回结构化结果，便于上层集成。
- 错误事务返回非零退出码；帮助和无事务启动返回 0。
- 新增参数解析与 JSON 输出测试。
- 当前结果：全量 `npm test` 52/52 通过，`git diff --check` 通过；已用 CLI 实测 JSON 输出。
- 当前仍未接入 OpenClaw channel 或桌面 UI，且未执行 npm install / 发布动作。

## 2026-08-29：启动告警失败隔离复审

- 损坏 JSON manifest 在启动容错扫描中也会被隔离为 `MANIFEST_INVALID`，不会阻断其他事务。
- `onError` 告警回调失败时不再阻断扫描；结果追加 `STARTUP_ALERT_FAILED`，保留原始事务错误。
- 修复复审中发现的冻结对象写入错误：先构造完整结果，再统一 `Object.freeze`，避免 `Cannot add property ... object is not extensible`。
- 当前结果：全量 `npm test` 54/54 通过，`git diff --check` 通过。
- 这轮未发现需要暂停的不可跨越阻塞。

## 2026-08-29：CLI 可执行性复审

- `bin/workbench.mjs` 已设置可执行权限，并通过直接运行验证。
- 入口继续复用 `startWorkbench`，不引入第二套恢复逻辑。
- 全量测试与差异空白检查保持通过。
- 当前结果：`npm test` 54/54 通过，`git diff --check` 通过，CLI 文件权限为 `rwxr-xr-x`。
- 未执行安装、发布或生产配置修改。

## 2026-08-29：启动扫描总失败与回调边界复审

- 扫描事务目录本身不可读或类型错误时，通过独立 `onScanError` 上报结构化 `SCAN_FAILED`，随后抛出 `RecoveryError('SCAN_FAILED', ...)`，避免把“整轮扫描失败”误标成单项事务错误。
- 单项 `onError` 告警回调仍保持隔离，不会阻断扫描；回调失败记录 `STARTUP_ALERT_FAILED`。
- 新增整轮扫描失败测试。
- 复审中发现测试夹具最初没有真正把事务目录变成非法类型，已改为创建同名文件后重跑，避免假阳性。
- 当前结果：全量 `npm test` 55/55 通过，`git diff --check` 通过。
- 当前没有不可跨越阻塞。

## 2026-08-29：正式启动失败交付语义复审

- `startWorkbench` 现在接收 `onStartupScanError`，整轮扫描失败会先上报，再转换为结构化 `fatalError` 返回，不让库调用方只能依赖未分类异常。
- 启动摘要在整轮失败时固定返回 `errors: 1`，CLI 因此稳定返回非零退出码。
- 单项错误与整轮错误保持区分：前者继续扫描，后者停止本轮并显式交付失败状态。
- 新增启动入口整轮失败测试，并完成 CLI JSON smoke test。
- 当前结果：全量 `npm test` 56/56 通过，`git diff --check` 通过。
- 当前没有不可跨越阻塞。

## 2026-08-29：启动扫描告警失败语义复审

- 合并 `startup-recovery.mjs` 的重复 recovery 导入，避免入口维护歧义。
- 整轮扫描的 `onScanError` 回调失败时，保留主错误 `SCAN_FAILED`，并在 `fatalError.alertError` 暴露 `STARTUP_ALERT_FAILED`。
- `startWorkbench` 对整轮扫描失败返回可序列化、可交付的失败结果，不吞掉告警失败信息。
- 新增告警回调失败测试。
- 当前结果：全量 `npm test` 57/57 通过，`git diff --check` 通过。
- 当前没有不可跨越阻塞。

## 2026-08-29：包入口与发布边界复审

- `package.json` 增加 `main`、`exports` 和 `files`，明确库调用入口及发布文件边界。
- README 增加 `import { startWorkbench } from 'openclaw-workbench'` 使用说明。
- 通过 Node ESM smoke test 验证 `startWorkbench` 可从运行时入口导入。
- 保持 `private: true`，未执行安装、打包或发布，避免误触外部动作。
- 当前结果：全量 `npm test` 57/57 通过，`git diff --check` 通过。

## 2026-08-29：审计链验收与实施清单更新

- 补充 `verifyAuditChain` 对空链、断链、篡改记录和缺少 `recordHash` 的测试。
- 更新 `docs/05-next-implementation.md`，明确启动扫描阶段已完成及下一实现单元。
- 包元数据已明确公共入口和发布文件边界，但仍保持 `private: true`，未执行发布。
- 当前结果：全量 `npm test` 59/59 通过，`git diff --check` 通过。

## 2026-08-29：FINALIZE_FAILED 持久化状态复审

- 新增 `finalize_failed` 事务状态，启动扫描会继续识别该状态。
- `executeRecovery` 在文件已成功恢复但最终清单更新失败时，尝试原子写入 `finalize_failed` 及错误信息，保留下一次启动可识别的现场。
- `FINALIZE_FAILED` 原始错误仍向调用方抛出；状态标记写入失败不会覆盖主错误。
- 新增测试验证失败状态已落盘且目标文件保持已恢复内容。
- 当前结果：全量 `npm test` 59/59 通过，`git diff --check` 通过。

## 2026-08-29：FINALIZE_FAILED 启动再收敛复审

- 启动扫描将 `finalize_failed` 纳入“仅允许已全部达到 `afterHash` 时自动标记 committed”的路径。
- 若文件状态仍是冲突、缺少快照或未完成写入，仍保持错误/阻断，不自动 resume、rollback 或覆盖。
- 新增回归测试，验证下一次启动能够安全收敛 `finalize_failed` 事务。
- 当前结果：全量 `npm test` 60/60 通过，`git diff --check` 通过。

## 2026-08-29：恢复执行失败状态持久化复审

- 新增 `recovery_apply_failed` 状态，启动扫描会保留并识别恢复执行失败现场。
- `resume`/`rollback` 在应用阶段失败时，先尝试回滚已应用文件，再原子写入失败清单与 `recoveryError`；落盘失败不覆盖原始错误。
- 增加 `transaction.recovery_apply_failed` 审计事件，记录失败码、已应用文件、回滚错误和状态落盘结果。
- 新增故障注入测试，验证失败状态可被下一次启动发现，且不自动越过审批。
- 当前结果：全量 `npm test` 62/62 通过，`git diff --check` 通过。

## 2026-08-29：恢复材料符号链接边界复审

- `inspectPendingTransaction` 现在会对 target、snapshot、temp 做真实路径校验。
- 恢复材料通过符号链接指向工作区外时，直接返回 `RECOVERY_PATH_ESCAPE`，不读取、不写入、不执行恢复。
- 新增符号链接逃逸回归测试。
- 当前结果：全量 `npm test` 62/62 通过，`git diff --check` 通过。

## 2026-08-29：Unified Patch 边界兼容性复审

- 修复统一补丁解析器对空分隔行的处理，避免合法 patch 在末尾换行后被误报 `HUNK_LINE_INVALID`。
- 增加 CRLF、`/dev/null` 空文件新增和 `\\ No newline at end of file` 标记测试。
- `rollback_partial` 与 `recovery_apply_failed` 分别保留实际失败语义，未自动覆盖或跳过审批。
- 当前结果：全量 `npm test` 61/61 通过，`git diff --check` 通过。

## 2026-08-30：恢复故障注入复审

- 新增多文件混合状态测试：一项已达到 `afterHash`、另一项仍可 `resume` 时，只返回需审批，不自动执行恢复。
- 新增缺少快照测试：恢复材料不完整时返回 `RECOVERY_BLOCKED`，目标文件保持不变。
- 为提交阶段增加可注入的 `renameFile`，验证第二个文件提交失败后已提交文件被恢复，事务清单落为 `rolled_back`。
- 新增回滚再次失败测试：恢复应用失败且补偿回滚失败时落盘 `rollback_partial` 与 `ROLLBACK_PARTIAL`，保留已应用路径及错误现场。
- 当前结果：全量 `npm test` 66/66 通过，`git diff --check` 通过。

## 2026-08-30：提交后校验与恢复执行边界复审

- 修复提交后校验失败未进入统一补偿回滚的问题；现在会回滚已提交文件，并将事务清单写为 `rolled_back`、`rollback_partial` 或保留 `POST_VERIFY_FAILED` 现场。
- 提交失败补偿改为临时文件写入后原子替换，避免直接 `writeFile` 恢复时留下半写文件。
- 恢复执行前再次校验 `target`、`snapshot`、`temp` 的安全真实路径，防止检查与执行之间的路径边界失效。
- 新增提交后校验失败回归测试。
- 当前结果：全量 `npm test` 67/67 通过，`git diff --check` 通过。

## 2026-08-30：受控 Terminal 工作流复审

- 新增命令提案入口 `createCommandProposal`，命令参数固定为 argv 数组，并绑定 session、workspace revision 和 action hash。
- 新增 `approveAndRunCommand`，命令执行必须经过明确审批；执行成功进入 `verified`，失败、超时和取消分别保留 `failed`、`timed_out` 和 `cancelled` 终态。
- 命令执行继续保持独立 Runtime API，不由 Patch 应用流程隐式触发；保留 `shell: false`、cwd/符号链接边界、环境白名单、输出上限和进程组终止控制。
- 新增命令工作流测试，覆盖模式限制、未审批拒绝、成功审计、失败/超时/取消终态。
- 当前项目文件仍全部为未跟踪状态，未执行 `git add`、`commit` 或 `push`。
- 当前结果：全量 `npm test` 82/82 通过，`git diff --check` 通过。

## 2026-08-30：Terminal 命令策略复审

- 新增 `classifyCommand`：将命令分为已知只读、未知和明确禁止三类。
- `rm`、`sudo`、shell 解释器、网络下载/上传及破坏性系统命令在提案阶段直接阻断；未知命令不自动放行，仍需显式审批。
- 执行前再次按 argv 分类，防止审批后命令对象被替换绕过策略。
- 新增策略分类及提案篡改回归测试。
- 当前结果：全量 `npm test` 82/82 通过，`git diff --check` 通过。

## 2026-08-30：Terminal 参数级策略复审

- 策略从命令名检查扩展到 argv 参数检查。
- 明确阻断 `git push`、`git reset --hard`、`git clean` 和 `npm publish`。
- 阻断参数中的常见 shell 语法字符，避免通过 argv 传递拼接语义。
- 当前结果：全量 `npm test` 待本轮复跑确认，`git diff --check` 待本轮复跑确认。

## 2026-08-30：命令持久化 claim 与启动恢复门禁

- 命令 action 首次执行前通过独占文件创建持久化 claim，跨进程/重启阻断同 action hash 重放。
- 启动扫描只识别命令 ledger 并标记 `manual_review`，不自动执行命令、不替代明确审批。
- 当前结果：全量 `npm test` 待本轮复跑确认，`git diff --check` 待本轮复跑确认。

## 2026-08-30：Terminal 参数资源门禁复审

- 增加 argv 数量、总字节数、单参数字节数和最长执行时间上限。
- 超限在创建子进程前返回结构化错误，不进入系统调用。
- 新增超大 argv 与超长 timeout 回归测试。
- 当前结果：全量 `npm test` 待本轮复跑确认，`git diff --check` 待本轮复跑确认。

## 2026-08-30：Terminal PATH 劫持边界复审

- 环境白名单继续保留 `PATH`，但其值固定来自宿主运行环境，不接受调用方覆盖。
- 新增回归测试，确认 `/untrusted/bin` 等外部 PATH 不会影响受控命令解析。
- 当前结果：全量 `npm test` 待本轮复跑确认，`git diff --check` 待本轮复跑确认。

## 2026-08-30：Terminal 环境代码注入边界复审

- 从环境白名单移除 `NODE_OPTIONS`，防止通过 `--require` 等机制注入工作区外代码。
- 新增回归测试，确认敏感环境变量不会传入受控子进程。
- 当前结果：全量 `npm test` 待本轮复跑确认，`git diff --check` 待本轮复跑确认。

## 2026-08-30：Terminal action hash 完整绑定复审

- 执行前重新计算 action hash，覆盖命令 argv、cwd、超时、输出上限和策略结果。
- 审批后替换任一命令参数都会返回 `ACTION_HASH_MISMATCH`，不会执行被修改的命令。
- 当前结果：全量 `npm test` 待本轮复跑确认，`git diff --check` 待本轮复跑确认。

## 2026-08-30：Terminal 策略哈希绑定复审

- 将提案时的策略判定写入 action 的不可变 `preview`，使 `actionHash` 同时绑定命令和策略结果。
- 执行前同时校验提案策略与 action 策略绑定，任一不一致都拒绝执行。
- 当前结果：全量 `npm test` 待本轮复跑确认，`git diff --check` 待本轮复跑确认。

## 2026-08-30：Terminal 策略审计绑定复审

- 命令提案和审批审计现在记录完整策略判定及阻断原因。
- 执行前重新分类并与提案时策略结果比较；策略结果被替换或发生变化时拒绝执行。
- 当前结果：全量 `npm test` 待本轮复跑确认，`git diff --check` 待本轮复跑确认。

## 2026-08-30：Terminal 提案参数一致性复审

- 提案阶段复用 Terminal 资源限制校验，提前拒绝无效 timeout、输出上限和超大 argv。
- 执行阶段再次校验相同限制，避免审批后替换参数造成不一致。
- 当前结果：全量 `npm test` 待本轮复跑确认，`git diff --check` 待本轮复跑确认。

## 2026-08-30：命令 action 防重放复审

- 命令 action 在首次进入审批执行链后即消费其 action hash。
- 同一 action 或复制出的同 hash 提案再次执行时返回 `COMMAND_REPLAYED`，失败、超时和取消也不可自动重试。
- 通过内存消费集合阻断当前 Runtime 进程内的重复执行；跨进程持久化防重放仍依赖后续受控启动恢复/持久化提案存储设计。
- 当前结果：全量 `npm test` 待本轮复跑确认，`git diff --check` 待本轮复跑确认。

## 2026-08-30：Terminal 配置目录与临时目录边界复审

- `HOME` 与 `TMPDIR` 固定继承宿主运行环境，不接受调用方覆盖。
- 防止受控 `git`/`npm` 命令改用外部配置目录，或将临时文件写入调用方指定位置。
- 新增环境覆盖回归测试；当前结果：全量 `npm test` 待本轮复跑确认，`git diff --check` 待本轮复跑确认。

## 2026-09-04：配置导入红蓝复审

- 红队攻击：错误 base hash、控制 token 冒充 approval token、actionHash 篡改/重放、路径穿越、Windows 盘符路径、内部目录和伪造备份。
- 蓝队结果：配置写入采用两阶段审批、哈希门禁和已有 anchored snapshot 原子写入；备份只使用生成的随机 ID，原始配置内容不进入审计或提案快照。
- 回归结果：`tests/security-red-team.test.mjs` 5/5 通过；`tests/config-store.test.mjs` 5 通过、1 个 Windows 符号链接场景因 Developer Mode 未启用而跳过；HTTP 配置导入/冲突/回滚 2/2 通过；整仓 `260 tests / 241 pass / 0 fail / 19 skipped`。
- 产品边界：当前只管理工作区内 JSON 副本，不宣称已接管用户目录中的 OpenClaw 配置、Gateway 或 MCP 工具。
