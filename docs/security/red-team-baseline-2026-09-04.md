# 红队基线报告（2026-09-04）

## 范围

本轮只攻击本机 loopback Workbench HTTP 控制面，使用临时工作区和测试凭据。报告不保存任何真实 token、配置值或用户文件内容。

## 攻击结果

| 攻击 | 结果 | 影响 | 分类 |
|---|---|---|---|
| 配置写入请求使用错误 `expectedHash` 且不带审批 | 返回 `409 CONFIG_CONFLICT`，没有文件变化 | 旧哈希不能越过当前配置门禁 | 已通过 |
| 使用 Bearer 控制 token 代替 `x-approval-token` 批准 Patch | 返回 `403 APPROVAL_AUTH_REQUIRED`，未执行文件修改 | 独立审批边界有效 | 已通过 |
| Windows 大小写变体 `.OpenClaw-Workbench/` | 修复前可写入内部状态目录；修复后返回 `400 CONFIG_PATH_INVALID` | 防止污染审计、事件和提案状态 | 已修复并回归 |
| 使用 `openclaw.json` 的备份 ID 回滚 `other.json` | 修复前可跨文件覆盖；修复后返回 `409 BACKUP_TARGET_MISMATCH` | 备份必须绑定原目标 | 已修复并回归 |
| 并发提交 33 个零内容 rollback 提案 | 修复前全部 `201`；修复后至少一个 `429 CONFIG_PROPOSAL_LIMIT`，审计调用不超过 32 | 防止内存提案数量绕过 | 已修复并回归 |

## 复现

```powershell
node --test tests/security-red-team.test.mjs
```

当前红队和回归攻击全部通过，证明 Patch 和配置导入都不会因为请求本身直接改文件；配置导入必须先形成提案，再由独立审批接口执行，且 Windows 内部目录、跨目标备份和并发限流攻击均已闭合。

## 未覆盖项

配置 API 已存在，但备份符号链接、base-hash 竞态、配置回滚和配置审计仍需在完整 HTTP 攻击测试中覆盖，不能用 mock 或静态检查替代。
