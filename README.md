# dsh-ai-bridge

把**外部 AI 客户端**和**本机 DeepSeek Harness（DSH）**接起来的两件小工具，零依赖，不动 DSH 本体。

[English](README.en.md)

> Two zero-dependency tools that bridge external AI clients and a local DeepSeek Harness (DSH): an MCP server that lets any MCP-capable client send messages into DSH, and a CDP driver that dispatches tasks into the Doubao desktop app.

```
外部 AI 客户端 ──MCP──▶ dsh-mcp-connector ──▶ dsh --profile headless ──▶ DSH
   (Claude Code / Cursor / VS Code / Codex / Kimi Code / CodeBuddy / Qoder / TRAE /
    ZCode / Step Code / MiniMax Code / Coze …)

DSH / 脚本 / HTTP ──入队──▶ tasks.jsonl ──task_claim──▶ 任意 MCP 客户端（拉取式任务队列）

脚本 / DSH ──CDP──▶ doubao-cdp ──▶ 豆包桌面版（把任务下发进它的聊天框）
```

## 为什么需要它

DSH 随发行体只带了 **MCP 客户端**（`dsh-mcp-client`），**没有 MCP server 半区**；它的 Web API 又需要浏览器 cookie 与 Host/Origin 围栏，第三方程序难以直接持有。所以「让别的 AI 给 DSH 发消息」必须有一个独立桥——这就是本仓库的第一个工具。

反方向（把任务下发给别家 AI）**没有任何官方入站 API**，只能走 GUI 自动化——这是第二个工具。

而 MCP 工具只在客户端自己的回合里执行，**推送不进去**；所以真正能自动化的派活方式是**拉取**：生产者入队，客户端领取。这部分已经做进第一个工具（`task_claim` / `task_complete` / `task_publish` / `task_list` + `POST /tasks`）。

## 目录

| 路径 | 作用 |
|---|---|
| [`dsh-mcp-connector/`](dsh-mcp-connector/) | MCP server（stdio + Streamable HTTP 双传输），暴露 `dsh_ask` / `dsh_cli_info` / `connector_status` 与四个任务队列工具，驱动 `dsh --profile headless` |
| [`doubao-cdp/`](doubao-cdp/) | 用 Chrome DevTools Protocol 驱动豆包桌面版（Electron）：`cdp.mjs` 下发并读回，`dispatch.mjs` 带**副作用校验**的派发（拒绝相信客户端的自述） |
| [`doubao-status-panel/`](doubao-status-panel/) | DSH Web 侧栏徽章：把 `status.jsonl` 的活跃任务实时显示在界面里（`已接收 → 工作开始 → 进行中 → 已完成`），并常驻显示豆包**当前模式与模型**（工作/对话、模型名与档位）。宿主半是**只读** `GET /doubao-status/api`，复用 DSH 自己的 web 端口，不新开监听 |
| [`skills/dsh-mcp-connector/`](skills/dsh-mcp-connector/) | 给 AI agent 用的技能包：17 个 MCP 客户端的配置矩阵、陷阱表、以及「未证实项」清单 |
| [`docs/design-notes.md`](docs/design-notes.md) | 设计说明：为什么必须有独立的桥、DSH 的五个机器入口面、队列为何是拉取式、两个方向的合规结论、已知失败模式 |
| [`scripts/register.mjs`](scripts/register.mjs) | 注册助手：把连接器写进各 MCP 客户端的配置文件，不用手抄 JSON/TOML |

各自的使用方法见对应 README。

## 快速开始

```bash
git clone https://github.com/ganmayou2333/dsh-ai-bridge
cd dsh-ai-bridge

npm test                       # 两套密封测试：不需要 DSH，也不需要豆包

cd dsh-mcp-connector
node selftest.mjs              # 完整自测（多跑两项需要本机 DSH 的检查）

# 然后在你的 MCP 客户端里加一条 stdio server：
#   命令: node
#   参数: <你的路径>/dsh-ai-bridge/dsh-mcp-connector/server.mjs
#   环境: DSH_BIN=<dsh 可执行文件>   DSH_WORKSPACE=<DSH 会话工作目录>
# 逐客户端配置见 dsh-mcp-connector/README.md
```

### 用注册助手代替手抄配置

```bash
node scripts/register.mjs --list                       # 看每个客户端的配置文件位置与注册状态
node scripts/register.mjs --client cursor --dry-run    # 只打印将要写入的内容，不落盘
node scripts/register.mjs --client vscode              # 写入（已存在的文件会先备份成 .bak）
node scripts/register.mjs --client all --dry-run       # 一次看全部
```

支持的客户端与各自的坑都编码在里面（ZCode 的 `mcp.servers`、Step Code 的 TOML、CodeBuddy/MiniMax 必须显式 `type: stdio`、VS Code 的 `servers`）。`claude-code` 是 CLI 管理的，脚本**不写文件**，只打印该运行的 `claude mcp add` 命令。

写入前建议先 `--dry-run` 看一眼；测试用 `--root`/`--project` 重定向到临时目录，不会碰你的真实配置。

要求：Node ≥ 20（本机用 v24 验证）、一个可用的 DSH 安装（`dsh` 命令）。

## 验证状态

| 项 | 证据 |
|---|---|
| `dsh-mcp-connector` 自测 | **61 项断言全过，退出码 0**（密封 `DSH_HOME` 下 headless profile 首次初始化、stdio 往返、HTTP 鉴权 401/403/404/405/202、生产者路由 201、队列语义与 6 路并发领取无碰撞、自观测与流水线握手闸门） |
| 离线自测（CI 用） | **58 项通过 / 2 项跳过，退出码 0**；跳过的两项需要本机装好 DSH。工作流见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)，矩阵为 Ubuntu/Windows × Node 20/24 |
| 真实模型调用 | 一条消息 3.7 秒返回，拿到 `sessionId`；带该 id 再发一条成功续接同一会话 |
| 真实 MCP 客户端握手 | Claude Code 2.1.226 完成握手并协商到协议 `2025-11-25`，证据是连接器自己记录的 `clients.json`（该客户端当时未登录，故工具调用未执行） |
| `doubao-cdp` 真实往返 | 连续 3 次下发-回传成功，最后一次为 `send` + `wait` 单次调用完成 |
| `dispatch.mjs` 校验逻辑 | 成功路径（队列完成 → 退出 0 `VERIFIED`）与失败路径（客户端嘴上说做了、队列仍 `pending` → 退出 2 `UNVERIFIED`）**双向实测**；密封测试 **35 项断言全过**（含指令内容、状态契约、实时状态、无 started 的完成、发送前预检、`--no-send` 不写 `received`、发送后 `wait`/`read` 带 `--no-preflight`），不需要豆包与 CDP |
| 豆包启动确认 | **34 项断言全过**：端口关闭 / 端口通但无匹配页面 / 就绪 / `--no-preflight` 逃生门 四种状态，外加「确认失败不得留下孤儿任务」、模型控件文字的拆分（`豆包 2.1 Lite低` 里的档位不是模型名）、以及 `state` 是读数不是闸门（豆包没开也退 0 并报 `connected:false`）。用假 CDP 端点密封测，不需要豆包 |
| 状态回报 | **34 项断言全过**：固定词表与别名、ini 开关、被关掉的状态静默 no-op、限流（关键状态永不丢）、截断、终态不可覆盖、崩溃半行、时间线排序、忙闲与疑似卡死；`received`（派发器写的发送侧事实）的写入 / 折叠 / 被 `started` 覆盖 / 未开工也算「忙」 |
| 调用前五维识别 | **23 项断言全过**：连通 / 模式 / 命令能力 / 忙闲 / 通道，三态区分（`0` 可发 / `3` 未就绪 / `8` 无法识别），模式不匹配与忙闲都拒绝，`--force` 放行并留 `override` 记录 |
| 状态推送（P2） | **16 项断言全过**：只推阶段转换（`progress` 不推）、游标幂等、新增事件会推、缺会话时明确报错、`--create-session` 只建一次会话 |
| 状态面板（DSH Web 侧栏徽章） | **54 项断言全过**：`received` 折叠与「未开工也算忙」、接口只读（POST/PUT/DELETE/PATCH → 405 且**不触发读取**，无副作用）、来源围栏（非本机来源 → 403 且不读数据，因为 web 服务监听 `0.0.0.0` 而 GUI 页面本身要鉴权）、只注册一条相对路径、源码不起监听、清单与模块装载器形态、宿主进程缺 `DSH_HOME` 时的回退、运行时快照的解析与 15 秒缓存（TTL 内不重读、过期先给旧值再后台刷新、失败降级为 `connected:false` 而不连累任务列表）。真机（2026-10-10 本机）：`GET /doubao-status/api` 返 200 JSON 且路径正确、`POST` 返 405、非回环 `Host` 返 403；侧栏槽占用者已注册；**界面渲染已确认**——侧栏底部出现徽章并显示「已接收」（截图佐证）；一条真任务（chat 模式）真回复并在 7 秒内写下 `received → done`；`cdp.mjs state --json` 对真豆包返回 `work / 本地电脑 / 豆包 2.1 Lite`，宿主半走真链路拿到同一份快照 |
| 统一入口 | 仓库根 `npm test` = 连接器离线自测 + 派发器 + 豆包确认 + 状态 + 状态推送 + 状态面板 + 注册助手，共七套，退出码 0 |

自测默认不产生模型费用；`DSH_MCP_CONNECTOR_LIVE=1 node selftest.mjs` 会追加一次真实调用。

## 安全须知

- `dsh-mcp-connector` 的 **stdio 模式**由客户端进程本身充当信任边界；**HTTP 模式**强制 Bearer token，默认只绑 `127.0.0.1`，未列入白名单的 `Origin` 一律 403。要上公网请再套 TLS 反向代理并换掉示例 token。
- 外部投递的消息在 DSH 内以 `{kind:"user"}` 进入会话，**与真人输入不可区分**——请让下游在任务文本里自带来源标记。
- **不要相信任何 AI 客户端的"我已经调用了工具"**。实测：豆包在连接器未启用时会回复「已调用 task_claim，status 为 ok」，而队列里那条任务仍是 `pending`。核实副作用（队列事件、文件、日志）才是唯一证据——`doubao-cdp/dispatch.mjs` 就是按这个原则写的。
- `doubao-cdp` 需要给豆包加 `--remote-debugging-port`，这意味着**本机任何进程都能接管你的豆包**（读聊天、以你身份发消息）。不用时退出并正常启动。
- 两者都只做**消息投递**：不要把外部订阅凭证当作 DSH 的模型后端，那违反各家消费者条款。

## 许可

MIT，见 [LICENSE](LICENSE)。
