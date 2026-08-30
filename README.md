# OpenClaw Workbench

面向 OpenClaw 的开箱即用本地 Agent 工作台。

> 当前处于基线审计阶段：暂不承诺生产可用，不直接修改现有 OpenClaw 配置。

## 当前可运行入口

包入口：`import { startWorkbench, createPatchProposal, approveAndApplyPatch } from 'openclaw-workbench'`。运行时提供本地工作区启动扫描、恢复编排、Patch 审批应用闭环和独立的受控命令执行器，不会接管 OpenClaw 配置。

```bash
npm test
node bin/workbench.mjs --help
node bin/workbench.mjs --root /path/to/workspace --json
```

启动入口只扫描并报告未完成事务；仅对文件已全部达到 `afterHash` 的事务自动标记为 `committed`，不会自动执行 `resume` 或 `rollback`。非法清单会被隔离为结构化错误，其他事务继续扫描。

Patch 垂直切片的调用顺序为：`createPatchProposal` 生成绑定工作区 revision 和 `actionHash` 的提案，用户明确批准后调用 `approveAndApplyPatch`，由事务引擎原子应用并返回 `verified` action。`Ask` 模式不能创建修改提案，审批后工作区 revision 变化会阻断应用。当前仍不包含 UI、完整 Chat/Plan 工作流、MCP 管理和公网 Bridge。

受控命令执行器位于 `runtime/terminal.mjs`，入口为 `runControlledCommand`。调用必须传入 argv 数组和 `approved: true`；它固定 `shell: false`，限制 cwd 在工作区内，限制 argv 数量/大小和最长执行时间，过滤环境变量（不允许 `NODE_OPTIONS` 等代码注入变量，且不接受调用方覆盖 `PATH`、`HOME`、`TMPDIR`），并提供超时、取消和输出上限。命令工作流入口为 `createCommandProposal` → `approveAndRunCommand`，执行成功返回 `verified` action，失败分别进入 `failed`、`timed_out` 或 `cancelled`；不会由 Patch 工作流隐式触发。
命令工作流还会通过 `classifyCommand` 做基础策略分类：明确禁止命令直接阻断，未知命令不会自动放行，并在执行前再次复核 argv。
策略同时检查参数级风险，默认阻断 `git push`、`git reset --hard`、`git clean`、`npm publish` 及常见 shell 语法字符。
