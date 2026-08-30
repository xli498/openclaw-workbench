# OpenClaw Workbench

面向 OpenClaw 的可审计本地 Agent Runtime 基础设施，提供审批绑定的 Patch 和 Terminal 执行闭环。

> 这是独立的、非官方 OpenClaw 项目，不会自动修改 OpenClaw 配置。当前版本是可测试的 Runtime 产品基线，不是已经接管生产环境的完整控制面。

## 当前可运行入口

包入口：`import { startWorkbench, createPatchProposal, approveAndApplyPatch } from 'openclaw-workbench'`。运行时提供本地工作区启动扫描、恢复编排、Patch 审批应用闭环和独立的受控命令执行器，不会接管 OpenClaw 配置。

```bash
npm test
node bin/workbench.mjs --help
node bin/workbench.mjs --root /path/to/workspace --json
```

## 本地控制面 API

`createWorkbenchServer` 提供默认仅监听 `127.0.0.1` 的本地 HTTP 控制面：`GET /health`、`GET /v1/status`、创建 Patch/Command 提案以及明确批准执行提案。请求体限制为 256 KiB；配置 `token` 后所有请求必须携带 `Authorization: Bearer <token>`。该 API 不绑定公网地址、不接管 Gateway，也不把状态持久化到网络数据库；会话、提案和本地事件分别写入工作区的原子 JSON 快照。服务重启后未完成会话/提案只进入 `manual_review`，不会自动调用模型或执行命令。

启动入口只扫描并报告未完成事务；仅对文件已全部达到 `afterHash` 的事务自动标记为 `committed`，不会自动执行 `resume` 或 `rollback`。非法清单会被隔离为结构化错误，其他事务继续扫描。

Chat 会话接口遵循 ShunCode 的 Ask / Plan / Code 三模式：`POST /v1/sessions` 创建会话，`POST /v1/sessions/:id/messages` 调用独立的 OpenClaw Adapter，`GET /v1/sessions/:id/messages` 读取消息，`POST /v1/sessions/:id/close` 关闭会话。当前三种模式已完成会话级边界；真正的 Code 文件修改仍必须通过 Patch 提案和明确审批，不允许 Chat 直接写文件。

Patch 垂直切片的调用顺序为：`createPatchProposal` 生成绑定工作区 revision 和 `actionHash` 的提案，用户明确批准后调用 `approveAndApplyPatch`，由事务引擎原子应用并返回 `verified` action。`Ask` 模式不能创建修改提案，审批后工作区 revision 变化会阻断应用。当前仍不包含桌面 UI、MCP 管理、OpenClaw channel/Gateway 生命周期接入和公网 Bridge。

## 能力状态

| 能力 | 状态 |
| --- | --- |
| Patch 解析、审批、原子事务和回滚 | 基线完成 |
| argv-only Terminal、`shell: false`、资源限制 | 基线完成 |
| 命令 action 跨进程原子 claim 防重放 | 已实现 |
| 命令终态持久化与启动扫描 | 已实现；未完成动作只进入人工复核 |
| 审计哈希链与并发追加锁 | 已实现 |
| OpenClaw channel/Gateway 生命周期接入 | 未实现 |
| UI、MCP 管理、公网 Bridge | 未实现 |
| 生产部署承诺 | 不承诺 |

## 安全边界

- 所有修改和命令执行都必须经过明确审批；审批不能绕过 `blocked` 策略。
- action hash 绑定 session、workspace revision、目标和不可变预览；执行前重新校验。
- 命令首次执行前写入持久化 ledger，重复 action hash 永久阻断，除非由明确的人工恢复流程处理。
- 启动扫描不会自动重跑命令；`claimed`/`executing` 等未完成状态只进入 `manual_review`。
- ledger 和审计日志不保存 API Key、环境变量密钥或用户凭据；命令预览只包含 argv、cwd 和资源参数。
- 这套库不能替代宿主机权限隔离、容器隔离、密钥管理或 OpenClaw 正式审批系统。

`GET /v1/status` 提供不含会话内容、提案内容或 ID 的 `persistedState` 汇总，用于识别重启后的人工复核数量和恢复事件；该接口只读，不会恢复或执行任何中断操作。

受控命令执行器位于 `runtime/terminal.mjs`，入口为 `runControlledCommand`。调用必须传入 argv 数组和 `approved: true`；它固定 `shell: false`，限制 cwd 在工作区内，限制 argv 数量/大小和最长执行时间，过滤环境变量（不允许 `NODE_OPTIONS` 等代码注入变量，且不接受调用方覆盖 `PATH`、`HOME`、`TMPDIR`），并提供超时、取消和输出上限。命令工作流入口为 `createCommandProposal` → `approveAndRunCommand`，执行成功返回 `verified` action，失败分别进入 `failed`、`timed_out` 或 `cancelled`；不会由 Patch 工作流隐式触发。
命令工作流还会通过 `classifyCommand` 做基础策略分类：明确禁止命令直接阻断，未知命令不会自动放行，并在执行前再次复核 argv。
策略同时检查参数级风险，默认阻断 `git push`、`git reset --hard`、`git clean`、`npm publish` 及常见 shell 语法字符。
