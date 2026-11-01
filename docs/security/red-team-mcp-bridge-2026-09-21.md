# Streamable HTTP MCP Bridge 红队复审（2026-09-21）

## 范围

本批次只覆盖本机 Streamable HTTP MCP Bridge。测试使用临时工作区和合成令牌，不读取或保存用户凭据；没有把 Bridge 暴露到公网，也没有使用真实 OpenClaw 登录态。

## 攻击与结果

| 攻击 | 修复后结果 | 证据 |
|---|---|---|
| 缺少或错误 Bearer | `401 MCP_UNAUTHORIZED`，不解析请求体 | `tests/mcp-bridge-red-team.test.mjs` |
| 初始化协议降级 | `400 MCP_PROTOCOL_INVALID` | 同上 |
| 客户端预设 session ID | `400 MCP_SESSION_FIXATION` | 同上 |
| 缺少协议版本、跨 session 请求 ID 重放 | `400/409`，请求不执行第二次 | 同上 |
| 超过 body 限制 | `413 MCP_BODY_LIMIT` | 同上 |
| 未允许 Origin | `403 MCP_ORIGIN_FORBIDDEN` | 同上 |
| 默认路径访问带 path token 的端点 | `404`，响应不回显 token | 同上 |
| path token 过期 | `404 MCP_ENDPOINT_NOT_FOUND`，不回显 token | 同上 |
| 工作区路径穿越 | 工具返回安全错误结果，工作区外文件不读取 | 同上 |
| shell 注入参数 | 工具返回安全错误结果，不创建子进程 | 同上 |
| 未经审批直接 Patch | 只返回 `awaiting_approval` 提案，文件不改变 | 同上 |
| claim 后执行失败卡在 executing | 转入 `manual_review`，保留恢复信息 | 同上 |
| SSE/GET 流关闭与空闲会话 | 流被关闭，会话不再可用 | `tests/mcp-bridge-server.test.mjs` |

## 蓝队控制

- 只允许 `127.0.0.1`、`::1` 或 `localhost` 监听；Bridge 不提供公网隧道。
- 每个请求仍需独立 Bearer；path token 只用于短时路由定位，不能替代认证。
- MCP session、协议版本和 JSON-RPC request ID 均绑定并校验；请求 ID 不能跨 session 重放。
- 请求体、响应、会话数量和会话空闲时间均有硬上限。
- 只读工具立即执行；Patch/Command 只生成控制面可审批提案，不在 Bridge 内直接写文件或运行命令。
- 错误响应不回显原始异常、token、路径或工具输入。

## 复放与验收命令

```text
npm run smoke:mcp-bridge
npm test
git diff --check
npm pack --dry-run
```

修复后同一组 HTTP 攻击脚本重新执行：桥接定向测试 8/8 通过；全仓测试 386 项中 366 项通过、0 项失败，20 项为 Windows 未启用符号链接权限时的既有跳过项。

## 剩余边界

Bridge 仍是本机回环能力，不包含设备配对、撤销、公网隧道、OpenClaw 私有协议或生产部署隔离。任何外部反向代理或 tunnel 都必须作为独立风险评审的后续适配器实现。
