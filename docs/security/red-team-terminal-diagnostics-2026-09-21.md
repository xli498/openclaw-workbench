# Durable Terminal 与 Diagnostics 红队复审（2026-09-21）

## 范围

本批次覆盖持久终端会话状态、增量输出、输入/取消边界、重启恢复和只读诊断聚合。所有测试在临时工作区执行，未使用真实 API key、Cookie 或 OpenClaw 登录态。

## 攻击与结果

| 攻击 | 修复后结果 | 证据 |
|---|---|---|
| 未带独立审批令牌创建会话 | `403 APPROVAL_AUTH_REQUIRED`，不启动命令 | `tests/http-server.test.mjs` |
| 未审批直接使用底层会话 API | `APPROVAL_REQUIRED` | `tests/terminal-session.test.mjs` |
| shell、绝对可执行路径和危险参数 | `COMMAND_POLICY_DENIED`，不创建子进程 | `tests/terminal-session.test.mjs` |
| `../` 越界 cwd | `PATH_ESCAPE` | 同上 |
| 输出洪泛 | 到达上限后终止并进入 `failed/OUTPUT_LIMIT`，不保留无限输出 | 同上 |
| PTY provider 输出超限后继续运行 | 进入 `failed/OUTPUT_LIMIT` 后调用 provider `cancel()`，忽略后续输出 | 同上 |
| 超时 | 进入 `timed_out`，不残留 `running` | 同上 |
| 输入注入/非 PTY 伪造 | fallback 明确返回 `409 PTY_UNAVAILABLE` | `tests/http-server.test.mjs` |
| 重启后重放 running 会话 | 自动降级 `manual_review`，不重新启动 provider | `tests/terminal-session.test.mjs` |
| 重复 session ID | `SESSION_EXISTS`，不创建第二个进程 | 同上 |
| 并发容量/重复 ID 竞态 | 创建前 reservation 绑定容量和 ID；并发请求一成功一 `SESSION_LIMIT`/`SESSION_EXISTS` | 同上 |
| 调用方环境变量注入 | 会话 API 不接受 `env`，受控 runner 只收到审批后的 argv/cwd | 同上 |
| 诊断回显 token、SecretRef、路径、MCP command | 只输出状态、版本、哈希、计数和脱敏事件 | `tests/diagnostics.test.mjs` |
| 单个诊断组件异常 | 映射为 `unavailable/DIAGNOSTIC_UNAVAILABLE`，不回显异常原文 | 同上 |

## 蓝队控制

- 持久记录只保存安全 argv、相对 cwd、状态、游标和脱敏输出；不保存输入原文、环境变量或工作区绝对路径。
- session store 使用工作区内原子快照和哈希门禁；损坏/越界清单不会触发执行。
- 没有 PTY provider 时明确返回 `pty:false`、`input:false`、`incrementalOutput:false`，不把一次性命令冒充交互终端。
- 诊断聚合只读取 CLI/MCP/model/workspace/audit 的安全摘要，不执行模型请求，不读取 SecretRef 解析值。

## 验收命令

```text
node --test tests/terminal-session.test.mjs tests/diagnostics.test.mjs
npm test
git diff --check
npm pack --dry-run
```

同一组红队输入修复后重放：终端/诊断定向测试 17/17 通过；控制面定向测试 64 pass、0 fail、1 个既有 Windows symlink 权限 skip。全仓回归需以提交前最后一次新鲜执行结果为准。

## 剩余边界

当前 fallback 不提供 PTY、真正交互 shell 或跨重启进程接管；仅报告 `pty:false` 并进入人工复核。若未来接入 PTY provider，必须另做进程树、设备权限和秘密环境的独立复审。
