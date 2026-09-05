# OpenClaw 集成边界基线

> 基线日期：2026-08-29。本文只记录本机已安装 OpenClaw 2026.6.6 的可见文档与运行包信息；未验证的内容不得作为稳定接口。

## 已验证事实

MCP `enabled` 状态通过独立审批切换；启用/停用提案绑定当前配置哈希，不能用控制 token 或旧 hash 绕过。

MCP runtime 控制面通过 `GET /v1/mcp/runtimes` 提供只读实例状态；`POST /v1/mcp/servers/<serverId>/start|stop|call` 只创建审批提案，审批执行时再次绑定当前 `configHash`。工具调用输入不会出现在公开提案或审计事件中，Server 未启用或工具不在 allowlist 时不会触达 transport。

| 能力 | 当前证据 | 产品处理方式 |
|---|---|---|
| Agent 单轮调用 | `openclaw agent` 文档，支持 Gateway 或 `--local`、会话、模型、思考级别、超时、JSON | 通过 Adapter 调用，禁止桌面端直接依赖 CLI 文本格式 |
| Gateway 控制 | Control UI 文档，浏览器通过 WebSocket 与 Gateway 通信，支持 token/password、设备配对和 scope 升级审批 | 优先复用正式 Gateway 协议；协议版本必须锁定并做兼容测试 |
| Chat | Control UI 已支持 `chat.history`、`chat.send`、`chat.abort`、`chat.inject` 与工具事件 | 产品 Runtime 封装为会话事件流；所有事件做 schema 校验 |
| Exec 审批 | Control UI 文档列出 `exec.approvals.*`，存在审批策略与 allowlist | 产品默认不放宽现有策略；高风险动作保留二次审批 |
| MCP | `openclaw mcp` 支持 server/client registry、status/doctor/probe、Control UI `/mcp`；`serve` 为 stdio MCP server | 已有审批门禁注册骨架、`enabled` 配置门禁、显式 `shell:false` stdio JSON-RPC transport、受限的一次性 HTTP POST JSON/SSE 响应 transport，以及内部 runtime 的 start/stop/allowlist call 边界；command/args 和 endpoint 拒绝注入与凭据材料，header 拒绝控制字符注入且允许调用方显式传入认证 header；不读取 SecretRef、不自动重连；标准 SSE 双通道、完整 streamable HTTP 会话语义、HTTP 工具执行路由与 OpenClaw 私有协议仍未接入 |
| 插件/Skill | 文档提供插件、Skill 管理和权限请求能力 | 不自动安装；安装、启用、升级均需审计和审批 |
| 配置写入 | Control UI 文档描述 config get/set/apply/patch、base-hash guard、SecretRef 预检和校验 | 产品配置层必须保留 hash guard、备份、迁移和回滚 |
| 诊断 | Control UI 支持 status、health、models、logs.tail 等诊断入口 | 统一收集脱敏诊断，不采集密钥和完整敏感内容 |
| 运行环境 | 本机 OpenClaw package version `2026.6.6`，license `MIT`，Node `>=22.19.0` | 产品锁定兼容矩阵；不能据此推断第三方插件许可证 |

## 不可直接假设的能力

- OpenClaw 内部 TypeScript 模块是否为稳定公开 SDK。
- 任意版本的 WebSocket RPC 是否保持兼容。
- 任意 MCP Server 的安全性、许可证和数据边界。
- 现有 OpenClaw 配置是否能直接导入产品配置。
- 外部 Bridge、隧道或公网反向代理的安全性。
- 所有模型都支持同等的工具调用、流式、视觉和推理能力。

## Adapter 原则

1. 只通过明确版本化的 Adapter 接触 OpenClaw。
2. Adapter 输入输出使用产品自有 schema，不把 CLI 原始 stdout 当 API。
3. 每次调用记录 OpenClaw 版本、传输方式、会话 ID、耗时、结果状态和错误分类。
4. Gateway 不可用时是否允许 `--local` fallback，必须由策略决定并在 UI 明示。
5. 升级 OpenClaw 前先跑兼容性测试；失败时阻断升级，不自动修配置。

## 第一阶段验证任务

- [ ] 用隔离测试工作区验证 `openclaw agent --local --json` 的最小请求、工具事件和取消行为。
- [ ] 验证 Gateway WebSocket 连接、设备配对、scope 升级和撤销。
- [ ] 验证 `mcp status/doctor/probe` 的成功、超时、异常 Server 和子进程清理。
- [ ] 验证配置 base-hash 冲突、SecretRef 未解析和备份恢复。
- [ ] 验证 OpenClaw 升级后 Adapter 的兼容性。

## 当前结论

OpenClaw 已具备足够多的底层能力，可以作为产品基础；但 Workbench 必须增加产品 Runtime、权限策略、schema、诊断和恢复层。当前不能把 OpenClaw CLI、Control UI 或 MCP registry 直接拼成产品。
