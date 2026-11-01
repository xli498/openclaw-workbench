# Gateway / channel 生命周期调研纪要（第三轮，WB3）

> 状态：未闭合。以下内容均不含任何凭据与外部链接；凡未实测的均明确标注为未验证，不得据此写协议代码。

## 基线

- 仓库基线：main ecdbf1c（克隆自工作目录外，全部工作仅在 /tmp/wb3-gw 内）。
- 已读：runtime/gateway-lifecycle.mjs（探针 + 无适配器拒绝）、runtime/gateway-adapter.mjs（仅回环 WebSocket 传输边界，禁公网）、docs/01-integration-boundary.md（Gateway WebSocket、设备配对、scope 升级列为未验证项）。

## 安装尝试（失败，原因已定位）

- 来源：npm 官方包 openclaw（公开渠道二选一中选 npm，未走安装脚本、不跑 onboarding、不装 daemon、不登录、不配对、不绑真实网关）。
- 钉住版本：2026.10.9（npm latest 当时值）。
- 安装目标：/tmp 下隔离前缀（不改全局配置）。
- 结果：两次均失败，错误均为磁盘写满（ENOSPC，errno -28）。
  - 第 1 次：默认参数安装。
  - 第 2 次：精简参数（忽略安装脚本、不写审计、不写资金信息）仍失败，排除安装脚本体积因素。
- 根因证据：本 VM 的 /tmp 为 tmpfs，总量 512M，安装时可用约 390M；而 openclaw 包本身解包后约 250MB，另有上百个依赖，合计必然超过 /tmp 可用空间。失败是环境容量问题，不是包不存在或网络问题（npm 元数据查询正常，版本号可读）。
- 清理：失败的隔离安装目录已删除，/tmp 未遗留安装残留；未动用户个人电脑，未改任何系统配置。

## 实测到的命令清单（真实 CLI 实测：无）

- 由于 CLI 未能装上，本轮没有任何真实的 `--version`、`--help` 或子命令 `--help` 实测结果。
- 因此不存在“实测到稳定公开集成接口”的前提；按任务第 3 条，生命周期接入代码停在“探针 + 实测报告”，未编写任何 Gateway/channel 协议代码，未猜测任何私有协议。
- 第三方指南中出现的候选命令名（仅作下一轮 `--help` 待验清单，未验证、版本来源不一、相互有出入，不得直接采用）：
  - gateway 组候选：gateway、gateway run、gateway start、gateway stop、gateway restart、gateway status、gateway install、gateway health、gateway probe、gateway logs
  - channels 组候选：channels list、channels status、channels logs、channels add、channels remove、channels login、channels capabilities、channels resolve
  - 其他候选：status、status --deep、health、logs、doctor、config get、onboard
- 每个候选在下一轮都必须以“只读 --help、不启动、不连接、不配对、不写配置”的方式逐个实测存在性与登录/配置要求，并以实测时的 CLI 版本号为准；第三方指南的说法不能代替实测。

## 本轮代码改动（仅测试，不动 runtime）

- tests/gateway-lifecycle.test.mjs（追加 6 项，原有 4 项未动）：
  - 真实 spawn 路径 + mock CLI 脚本：首行版本、脱敏、shell:false 可执行脚本探针。
  - 真实 spawn 路径：非零退出报探针失败。
  - 真实 spawn 路径：挂起脚本触发超时，不 hang 住。
  - 真实 spawn 路径：超大输出触发上限，不无界缓冲。
  - 非法 CLI 命令 / 非法适配器校验、无适配器时 start 仍拒绝且 stop 报 stopped。
  - 注入适配器的 start/stop 参数透传。
- runtime/gateway-lifecycle.mjs：未改动。runtime/gateway-adapter.mjs：未改动。docs/01：未改动（未验证项仍为未验证）。

## 测试结果

- 网关三组命令：node --test tests/gateway-lifecycle.test.mjs tests/gateway-adapter.test.mjs tests/gateway-session.test.mjs
- 结果：17 项全过，0 失败（含新增 6 项、原有生命周期 4 项）。
- 全量测试套件结果见回传报告。

## 未闭合原因与下一步

1. 未闭合：官方 CLI 未能在本 VM 的 /tmp 内装上（tmpfs 512M 上限 vs 包体 + 依赖超限），故无真实 --version/--help 证据；Gateway WebSocket、设备配对、scope 升级仍全部未验证；channelAdapter 仍只能由调用方显式注入，start() 无适配器时仍拒绝。
2. 下一步（需父级决策，不在本轮擅自扩大范围）：在容量更大的隔离工作区重跑安装（本轮任务限定 /tmp，故未改用家目录安装），装上后按“只读 --help”逐个实测上列候选命令的存在性与登录/配置要求；只有实测到稳定、公开、无需登录即可读帮助的接口时，才设计生命周期接入；凡需登录、配对或写配置的接口，仍需用户明确授权后另行受控验证。
3. 不做：不硬编协议、不把第三方指南的命令表当成已验证接口、不把本轮的 mock CLI 测试说成真实 Gateway 验证。

## 过程注记

- 本目录曾在任务执行中途因 /tmp 清理丢失，后按相同内容重建并重新跑通网关三组测试；/tmp 内容易失，父级如需保留请及时转存到持久位置（转存决定由父级做，本轮未擅自写其他目录）。
