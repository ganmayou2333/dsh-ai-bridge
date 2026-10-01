# dsh-ai-bridge

把**外部 AI 客户端**和**本机 DeepSeek Harness（DSH）**接起来的两件小工具，零依赖，不动 DSH 本体。

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
| [`dsh-mcp-connector/`](dsh-mcp-connector/) | MCP server（stdio + Streamable HTTP 双传输），暴露 `dsh_ask` / `dsh_cli_info` 与四个任务队列工具，驱动 `dsh --profile headless` |
| [`doubao-cdp/`](doubao-cdp/) | 用 Chrome DevTools Protocol 驱动豆包桌面版（Electron）：`cdp.mjs` 下发并读回，`dispatch.mjs` 带**副作用校验**的派发（拒绝相信客户端的自述） |
| [`skills/dsh-mcp-connector/`](skills/dsh-mcp-connector/) | 给 AI agent 用的技能包：17 个 MCP 客户端的配置矩阵、陷阱表、以及「未证实项」清单 |

各自的使用方法见对应 README。

## 快速开始

```bash
git clone <this repo>
cd dsh-ai-bridge/dsh-mcp-connector

# 1) 确认桥本身能跑（不花模型额度）
node selftest.mjs

# 2) 在你的 MCP 客户端里加一条 stdio server：
#      命令: node
#      参数: <你的路径>/dsh-ai-bridge/dsh-mcp-connector/server.mjs
#      环境: DSH_BIN=<dsh 可执行文件>   DSH_WORKSPACE=<DSH 会话工作目录>
#    详见 dsh-mcp-connector/README.md 的逐客户端配置
```

要求：Node ≥ 20（本机用 v24 验证）、一个可用的 DSH 安装（`dsh` 命令）。

## 验证状态

| 项 | 证据 |
|---|---|
| `dsh-mcp-connector` 自测 | **32 项断言全过，退出码 0**（密封 `DSH_HOME` 下 headless profile 首次初始化、stdio 往返、HTTP 鉴权 401/403/404/405/202、生产者路由 201、队列语义与 6 路并发领取无碰撞） |
| 真实模型调用 | 一条消息 3.7 秒返回，拿到 `sessionId`；带该 id 再发一条成功续接同一会话 |
| `doubao-cdp` 真实往返 | 连续 3 次下发-回传成功，最后一次为 `send` + `wait` 单次调用完成 |
| `dispatch.mjs` 校验逻辑 | 成功路径（队列完成 → 退出 0 `VERIFIED`）与失败路径（客户端嘴上说做了、队列仍 `pending` → 退出 2 `UNVERIFIED`）**双向实测** |

自测默认不产生模型费用；`DSH_MCP_CONNECTOR_LIVE=1 node selftest.mjs` 会追加一次真实调用。

## 安全须知

- `dsh-mcp-connector` 的 **stdio 模式**由客户端进程本身充当信任边界；**HTTP 模式**强制 Bearer token，默认只绑 `127.0.0.1`，未列入白名单的 `Origin` 一律 403。要上公网请再套 TLS 反向代理并换掉示例 token。
- 外部投递的消息在 DSH 内以 `{kind:"user"}` 进入会话，**与真人输入不可区分**——请让下游在任务文本里自带来源标记。
- **不要相信任何 AI 客户端的"我已经调用了工具"**。实测：豆包在连接器未启用时会回复「已调用 task_claim，status 为 ok」，而队列里那条任务仍是 `pending`。核实副作用（队列事件、文件、日志）才是唯一证据——`doubao-cdp/dispatch.mjs` 就是按这个原则写的。
- `doubao-cdp` 需要给豆包加 `--remote-debugging-port`，这意味着**本机任何进程都能接管你的豆包**（读聊天、以你身份发消息）。不用时退出并正常启动。
- 两者都只做**消息投递**：不要把外部订阅凭证当作 DSH 的模型后端，那违反各家消费者条款。

## 许可

MIT，见 [LICENSE](LICENSE)。
