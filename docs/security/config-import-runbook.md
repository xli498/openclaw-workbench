# 配置导入与回滚运行手册

## 安全前提

Workbench 只接受工作区内的相对 `.json` 文件，默认目标是 `openclaw.json`。它不会自动读取用户目录配置、启动 Gateway 或调用模型。所有请求需要控制 Bearer token；真正写入还需要独立 `X-Approval-Token` 和创建提案时返回的 `actionHash`。

## 导入流程

1. `GET /v1/config` 获取当前 `hash` 和 `relativePath`。
2. `POST /v1/config/import` 提交 `sessionId`、`expectedHash`、`content`，得到 `awaiting_approval` 提案。
3. 人工核对返回的路径、字节数、内容哈希和 action hash；不要把原始配置复制到日志或聊天记录。
4. `POST /v1/config/:actionId/approve`，带 `X-Approval-Token` 和 JSON `actionHash`。
5. 成功响应只包含 before/after hash 与 `backupId`。备份位于 `.openclaw-workbench/config-backups/`。

## 冲突与回滚

如果文件在提案后发生变化，审批返回 `409 CONFIG_CONFLICT`，不会覆盖当前文件。重新读取配置并创建新提案。回滚时提交 `backupId` 和当前 `expectedHash`，同样必须经过独立审批；未知、穿越或符号链接备份会被拒绝。

待审批配置提案只存在当前 Workbench 进程内，重启后不会恢复原始内容；这是避免凭据落盘的刻意设计。
