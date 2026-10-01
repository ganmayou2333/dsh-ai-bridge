# dsh-mcp-connector

把外部 AI 客户端（Claude Code / Cursor / VS Code / Codex / Kimi Code / CodeBuddy / Qoder / TRAE / ZCode / Step Code / MiniMax Code）接到**本机 DeepSeek Harness（DSH）**的 MCP 服务器 demo。

- **零依赖**：MCP 的 stdio 传输就是「一行一个 JSON-RPC 2.0 消息」，协议半区直接手写，不需要装任何 SDK。
- **不改 DSH**：走随 CLI 发货的 `dsh --profile headless` 一次性 profile。
- **不动正在运行的服务**：不会碰你现在跑着的 `dsh web`（43120）。
- **已固化为 skill**：见本仓库 [`skills/dsh-mcp-connector/`](../skills/dsh-mcp-connector/)（含各客户端配置速查与「未证实项」清单）。任何会话让 agent「把外部 AI 接到 DSH」时会自动命中它，不必重新调研。

> **阅读提示**：下文出现的「本机」均指验证环境（Windows / Node v24 / PowerShell 7），命令与路径请按你自己的环境替换；文中 `C:\tools\dsh-mcp-connector` 是示例安装路径。

---

## 1. 本机实测结果（2026-10-01）

| 验证项 | 结果 |
|---|---|
| 密封 `DSH_HOME` 下 `dsh --profile headless --help` | exit 0，profile 首次自动初始化成功 |
| MCP stdio `initialize` / `tools/list` / `tools/call` 往返 | 全部通过 |
| Streamable HTTP 传输（401 / 403 / 404 / 405 / 202 / initialize / tools/list） | 8 项断言全部通过 |
| 真实模型调用（`dsh_ask`） | **3.7 秒**返回「连接器已就绪」 |
| 返回的会话 id | `session-3075a35c-76c4-444e-b4e2-678c083273f9` |
| **续同一个会话**（带 `sessionId` 再发一条） | 同一 sessionId 返回「第二条也到」，exit 0 |
| 自测总计 | 16 项断言，`ALL CHECKS PASSED`，退出码 0 |

复现命令：

```powershell
cd C:\tools\dsh-mcp-connector
node selftest.mjs                                   # 密封验证，不产生模型费用
$env:DSH_MCP_CONNECTOR_LIVE="1"; node selftest.mjs  # 追加一次真实模型调用
```

---

## 2. 它是怎么工作的

```
Claude Code / Cursor / VS Code / Codex
        │  MCP (stdio, 一行一个 JSON-RPC)
        ▼
   server.mjs  ──spawn──▶  dsh --profile headless --json <task via stdin>
        │                              │
        │◀──── NDJSON 事件流 ───────────┘
        ▼
  {type:'session'} → sessionId
  {type:'text'/'thinking'/'tool_call'/'tool_result'} → 过程
  {type:'final', text} → 最终答案
```

两个刻意的设计：

1. **任务文本永远走 stdin**（传 `-` 参数），绝不进 argv。这样带空格、引号、换行的中文任务文本在 Windows 上不会被 shell 引号规则破坏。
2. **`sessionId` 是唯一的会话句柄**：省略它 = 新建会话；带上它 = 往那个会话继续投递消息。

---

## 3. 前置条件

| 条件 | 说明 |
|---|---|
| Node ≥ 20 | 本机 v24.18.0 |
| `dsh` 在 PATH | 本机解析为 npx 缓存里的 `…\node_modules\.bin\dsh.cmd` |
| 首次运行会自动建 profile | 在 `$DSH_HOME/profiles/headless` 写 4 个文件：`package.json`（bundles = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`）、`cordis.yml`、`cordis.patch.yml`、`pnpm-workspace.yaml`。**无网络、无 pnpm install**。本机已创建完毕。 |

建议显式固定 dsh 路径（npx 缓存路径会随版本变化）：

```powershell
$env:DSH_BIN = "%APPDATA%\npm\dsh.cmd"
```

---

## 4. MCP 配置方法

统一约定：`server.mjs` 的绝对路径为

```
C:\tools\dsh-mcp-connector\server.mjs
```

### 4.0 图形界面客户端：「新建自定义连接器」对话框怎么填

很多客户端（包括国产 AI 客户端）用的是同一个表单，字段一一对应如下：

| 表单字段 | 填什么 |
|---|---|
| 服务器名称 | `dsh` |
| 传输类型 | `STDIO`（保持默认） |
| 命令 | `node`（若客户端找不到 node，改填绝对路径 `node`） |
| 参数 | `C:\tools\dsh-mcp-connector\server.mjs` |
| 环境变量 1 | `DSH_BIN` = `%APPDATA%\npm\dsh.cmd` |
| 环境变量 2 | `DSH_WORKSPACE` = `C:\tools` |

说明：

- **参数只填脚本路径这一项**，不要加 `--http` 之类；「命令 + 参数」等价于命令行的 `node <参数1> <参数2> …`。
- 表单提示「自定义连接器仅支持在本地电脑中使用」——这与我们默认的 stdio 传输完全一致。
- **`DSH_WORKSPACE` 建议填**：不填时 DSH 会话的工作目录会跟随客户端的启动目录，可能是任意位置。
- 路径里有中文（`插件`）。绝大多数情况没问题；万一客户端 spawn 失败，把整个目录复制到纯英文路径（如 `%USERPROFILE%\dsh-mcp-connector\`）再把参数改过去即可。

### 4.1 Claude Code（本机已安装，`claude` 在 PATH）

用户级（所有项目可用，推荐）：

```powershell
claude mcp add dsh -s user -- node "C:\tools\dsh-mcp-connector\server.mjs"
```

项目级（只在该项目可用，写入 `.mcp.json`）：

```powershell
claude mcp add dsh -s project -- node "C:\tools\dsh-mcp-connector\server.mjs"
```

需要传环境变量时：

```powershell
claude mcp add dsh -s user -e DSH_BIN="C:\...\dsh.cmd" -- node "C:\tools\...\server.mjs"
```

验证 / 移除：

```powershell
claude mcp list
claude mcp remove dsh -s user
```

等价的 `.mcp.json`（放项目根，与原生命令二选一）：

```json
{
  "mcpServers": {
    "dsh": {
      "command": "node",
      "args": ["C:\\tools\\dsh-mcp-connector\\server.mjs"]
    }
  }
}
```

### 4.2 Claude Desktop（本机未安装）

配置文件：`%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "dsh": {
      "command": "node",
      "args": ["C:\\tools\\dsh-mcp-connector\\server.mjs"]
    }
  }
}
```

改完需要完全退出并重启 Claude Desktop。

### 4.3 Cursor（本机已安装，尚无 `mcp.json`）

全局：`%USERPROFILE%\.cursor\mcp.json`；项目级：`<项目>\.cursor\mcp.json`

```json
{
  "mcpServers": {
    "dsh": {
      "command": "node",
      "args": ["C:\\tools\\dsh-mcp-connector\\server.mjs"]
    }
  }
}
```

### 4.4 VS Code / Copilot Chat

项目级 `.vscode/mcp.json`（VS Code 原生格式，顶层是 `servers`）：

```json
{
  "servers": {
    "dsh": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\tools\\dsh-mcp-connector\\server.mjs"]
    }
  }
}
```

可移植格式（多个 Copilot 工具共用，顶层是 `mcpServers`）：`%COPILOT_HOME%\mcp-config.json`，未设时用 `%USERPROFILE%\.copilot\mcp-config.json`。

### 4.5 Codex CLI（本机已安装）

追加到 `%USERPROFILE%\.codex\config.toml`（该文件的 `[mcp_servers.*]` 结构已在本机确认）：

```toml
[mcp_servers.dsh]
command = 'node'
args = ['C:\tools\dsh-mcp-connector\server.mjs']
enabled = true
```

### 4.6 远程 / 云端官方 agent：Streamable HTTP 模式

**云端托管的 agent 无法启动你本机的进程**（网页端产品都属于这一类），本地 stdio 对它们无效，必须给一个 HTTP 端点：

```powershell
node server.mjs --http --host 127.0.0.1 --port 8790 --token <你的token>

# 不传 --token 时自动生成一枚并打印到 stderr（先这样跑一次，记下 token 再固定）
node server.mjs --http --port 8790
```

| 项 | 值 |
|---|---|
| 端点 | `POST http://127.0.0.1:8790/mcp`（路径可用 `--path` 改） |
| 鉴权 | `Authorization: Bearer <token>`；缺失或错误返回 **401** |
| Origin | 未列入白名单的 `Origin` 头返回 **403**；`--allow-origin https://你的域名` 放行 |
| 其他方法 | `GET`/`DELETE` 返回 **405**；路径不符返回 **404** |
| 通知 | 只含通知的 POST 返回 **202**，无 body |
| 传输语义 | Streamable HTTP（MCP 2025-11-25 规范），无状态，不下发 `Mcp-Session-Id` |

以上每一条都有自测断言覆盖（`selftest.mjs` 第 4 步，8 项）。

要暴露到公网必须再套一层 **HTTPS 反向代理或隧道**（你已装好的 cloudflared 即可），并且：

1. token 用强随机值，别用示例值；
2. 若云端平台只支持 OAuth 接入，还需按 MCP 授权规范补 OAuth —— 本 demo 只实现了 Bearer；
3. 不要 `--host 0.0.0.0` 裸奔到公网。

### 4.7 Claude.ai 自定义连接器

Claude 的自定义连接器要求填 **HTTPS** 地址，官方文档没有 localhost 选项；私有网络要企业版 MCP tunnels。所以：

- **本机开发**：用 4.0–4.5 这些**允许 localhost 的 stdio 客户端**。
- **要接云端 Claude**：用 4.6 的 HTTP 模式 + 隧道，并把地址填成 `https://<隧道域名>/mcp`；token 走 `Authorization: Bearer`。

### 4.8 国产大模型官方客户端

**结论：已核对的国产官方客户端全部支持本地 stdio，所以「命令 `node` + 参数 `server.mjs`」这一套原样可用**，区别只在配置文件写在哪、顶层键叫什么（均为厂商自家文档站，2026-10-01 核验）。

| 客户端（厂商） | 配置文件 | 顶层键 | 格式 |
|---|---|---|---|
| **Kimi Code CLI**（月之暗面） | `%USERPROFILE%\.kimi-code\mcp.json`；项目级 `<项目>\.kimi-code\mcp.json` | `mcpServers` | JSON |
| **Kimi CLI**（旧版 Python，官方已声明将停维护） | `%USERPROFILE%\.kimi\mcp.json` | `mcpServers` | JSON |
| **ZCode**（智谱 / Z.ai） | `%USERPROFILE%\.zcode\cli\config.json`；项目级 `<项目>\.zcode\config.json` | **`mcp.servers`** | JSON |
| ZCode 的 `.agents` 兼容层 | `%USERPROFILE%\.agents\mcp.json`；项目级 `<项目>\.agents\mcp.json` | `mcpServers` | JSON |
| **Step Code**（阶跃星辰，`step`） | `%USERPROFILE%\.stepcode\config.toml`；项目级 `<项目>\.stepcode\config.toml` | **`[mcp_servers.<名称>]`** | **TOML** |
| **MiniMax Code**（桌面 / CLI） | `%USERPROFILE%\.minimax\mcp.json`（`MINIMAX_DATA_DIR` 可改根目录） | `mcpServers` | JSON |
| **Qwen Code**（阿里，Gemini CLI fork） | `%USERPROFILE%\.qwen\settings.json`；项目级 `<项目>\.qwen\settings.json` | `mcpServers` | JSON |
| **Qoder CLI**（阿里通义灵码，已改名 Qoder CN） | 用户级 `%USERPROFILE%\.qoder\settings.json`；local `<项目>\.qoder\settings.local.json`；项目级 `<项目>\.mcp.json` | `mcpServers` | JSON |
| **CodeBuddy CLI**（腾讯） | 用户级 `%USERPROFILE%\.codebuddy.json`；项目级 `<项目>\.mcp.json`；local `~/.codebuddy.json#/projects/<工作区路径>` | `mcpServers` | JSON |
| **TRAE**（字节） | 官方走设置面板（头像 > 设置 > MCP），磁盘路径未文档化 | `mcpServers` | JSON |
| **Comate 文心快码**（百度） | 官方手册确认支持 stdio，**路径未证实** | 未证实 | — |

**仅支持远程、本地 stdio 直接排除的两家**：

| 客户端 | 情况 |
|---|---|
| **扣子 Coze**（字节） | 官方**明确「暂不支持 STDIO 协议」**，只支持 Streamable HTTP / SSE，且只能在网页/桌面端创建自定义 MCP → 用 4.6 的 `--http` 模式 + 隧道 |
| **讯飞星辰 Agent 平台** | 只能用 **Server URL** 远程接入，无 stdio |

要点：

- **MiniMax Code 的 stdio 条目必须显式写 `"type": "stdio"`**，缺了它可能按远程处理。
- **ZCode 原生键是 `mcp.servers` 而不是 `mcpServers`**——最容易抄错的一处。另外：同一作用域内只要 `.zcode` 里配了任意 MCP 服务，同作用域的 `.agents/mcp.json` 会被**整体跳过、不合并**。
- **Step Code 是 TOML**，且明确**不支持旧式 SSE**（只有 stdio 与 Streamable HTTP）。
- **Qwen Code 虽然是 Gemini CLI 的 fork，但配置目录是 `~/.qwen`，不复用 `~/.gemini/settings.json`**；它的远程写法是 `httpUrl` + `headers`（不是 `url`）。
- **CodeBuddy CLI 与 Qoder CLI 属「Claude Code 兼容」类**：项目级都用 `.mcp.json`、同一份文件格式、同样的 `mcp__server__tool` 权限语法。但用户级是各自的 `~/.codebuddy.json` / `~/.qoder/settings.json`，**不直接复用 `~/.claude.json`**。
  - 实际好处：**同一个项目里的 `.mcp.json` 可以同时服务 Claude Code、CodeBuddy CLI、Qoder CLI**。
  - 坑（**未获第二个来源确认**）：有文档镜像称 **CodeBuddy 的项目级 `.mcp.json` 默认不生效**，需要放行——`"enableAllProjectMcpServers": true`，或用白名单 `"enabledMcpjsonServers": ["dsh"]`。独立复核时未能在另一份文档中找到该说法，官方只写「项目作用域首次连接需用户审批」。**走 user 作用域可以完全绕开这个不确定性。**
- **TRAE 的路径可用变量、超时也可控**：`args` 支持 `${workspaceFolder}`；`env` 里可设 `START_MCP_TIMEOUT_MS` / `RUN_MCP_TIMEOUT_MS`（stdio 启动慢时有用）。
- **Qoder CLI 是唯一列出 `ws` 传输的**（`-t stdio|sse|http|ws`），其余各家基本只有 stdio / SSE / Streamable HTTP。
- **没有任何一家官方文档声称会读 `~/.claude.json` 或 `~/.gemini/settings.json`**：真正可跨客户端复用的只有**项目级 `.mcp.json`**。
- Kimi 有两套并存文档（旧 Python 版 `~/.kimi`、新 Node 版 `~/.kimi-code`），别抄混。**通义灵码已更名为 Qoder CN**（文档域名仍是 `/help/zh/lingma/`），按新旧名字搜索都能找到。
- 扣子/豆包侧：**豆包客户端是否支持 MCP 未找到官方文档**，只有第三方 bridge。

照抄片段（Kimi Code CLI / MiniMax Code 通用，JSON 顶层 `mcpServers`）：

> **关于 `type` 字段**：MiniMax 与 CodeBuddy 的 stdio 条目需要显式写 `"type": "stdio"`；但 **Kimi 的官方 schema 并未收录 `type`**（有 `command` 即视为 stdio），另一份文档示例却写了它。两处均未实测，稳妥做法是**按各客户端官方文档写**，Kimi 先省略 `type`。下面片段保留 `type` 是为了覆盖 MiniMax/CodeBuddy 这类客户端。

```json
{
  "mcpServers": {
    "dsh": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\tools\\dsh-mcp-connector\\server.mjs"],
      "env": {
        "DSH_BIN": "%APPDATA%\\npm\\dsh.cmd",
        "DSH_WORKSPACE": "C:\\tools"
      }
    }
  }
}
```

ZCode 原生写法（注意是 `mcp.servers`）：

```json
{
  "mcp": {
    "servers": {
      "dsh": {
        "command": "node",
        "args": ["C:\\tools\\dsh-mcp-connector\\server.mjs"],
        "env": {
          "DSH_BIN": "%APPDATA%\\npm\\dsh.cmd",
          "DSH_WORKSPACE": "C:\\tools"
        }
      }
    }
  }
}
```

Step Code 写法（TOML）：

```toml
[mcp_servers.dsh]
command = "node"
args = ["C:\\tools\\dsh-mcp-connector\\server.mjs"]

[mcp_servers.dsh.env]
DSH_BIN = "%APPDATA%\\npm\\dsh.cmd"
DSH_WORKSPACE = "C:\\tools"
```

**智谱 Managed Agents（托管 Agent API 平台）只支持远程 MCP**——它的 `mcp_servers` 里 `type` 只能填 `"url"`（Streamable HTTP，必须公网 HTTPS），没有任何 stdio 字段。这类云端 agent 用 4.6 的 HTTP 模式 + 隧道。

### 4.9 别搞混：「厂商自己的 agent」vs「拿第三方客户端接国产模型」

| 厂商 | 官方文档让用哪个第三方客户端 | 关键端点 |
|---|---|---|
| 月之暗面 | Claude Code、OpenCode、Codex、Hermes Agent | `ANTHROPIC_BASE_URL=https://api.kimi.com/coding/` |
| 智谱 / Z.ai | Claude Code、Codex、Cursor、Cline、Roo、TRAE、CodeBuddy、Lingma、Qoder、Zed 等 | `https://open.bigmodel.cn/api/anthropic` |
| MiniMax | Claude Code、Codex、Cursor、TRAE、OpenClaw 等 | `https://api.minimax.cn/anthropic` |
| 阶跃星辰 | Claude Code、Codex CLI、OpenCode、Cursor、Zed、Cherry Studio 等 | Step Plan 端点 |
| DeepSeek | Claude Code、Codex、OpenCode、Qoder 等 | `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` |

走这一类时，**MCP server 仍然配在 Claude Code 自己的配置里**（见 4.1），跟厂商文件无关。厂商文档里给的 `claude mcp add ...` 命令，接入的是**厂商发布的远程 MCP server**（如智谱 `web-search-prime`、阶跃 StepSearch），客户端还是 Claude Code —— 那不是「厂商 agent 支持了 MCP」。

两个实操提醒：

1. **智谱的 Gemini CLI 路径依赖第三方 fork**（官方明说 Gemini CLI 官方仓库只支持 Google 模型），不算原生兼容；其余国产厂商官方文档里没有 Gemini CLI 接入页。
2. **GLM Coding Plan 有风控**：官方限定套餐只能用于「官方支持的指定工具与环境」，非受支持工具调用可能被限流，多次违规可能封号。换客户端前先看官方支持列表。

### 4.10 本节未证实的内容（别当事实用）

- **智谱清言（chatglm.cn）、AutoClaw、跃问（阶跃 App）是否支持接入自定义 MCP**：未找到官方文档。
- **AutoGLM 方向相反**：智谱发布的是 `autoglm-mcp-server`（把 AutoGLM-Phone 暴露为 MCP **server**），不是客户端；来源为 npm / GitHub，非文档站收录，只算半官方。
- **商汤日日新 / 零一万物 / 昆仑万维天工 / 面壁智能**：未找到厂商官方 MCP 客户端文档。网上搜到的 `deepseek-mcp-server`、`glm-mcp`、`kimi-api-mcp` 等一律是第三方社区项目，**不能当厂商官方支持**。
- **DeepSeek 官方 App / 开放平台 API 明确不支持 MCP**：Anthropic 兼容端点的 `mcp_servers` 字段被忽略，`mcp_tool_use` / `mcp_tool_result` 内容块也不支持。
- **文档不一致处**：ZCode 的配置目录在自家文档里同时出现 `~/.zcode/cli/config.json` 与 `~/.zcode/v2/config.json`；Step Code 项目级 MCP 的两种说法冲突；Kimi 新旧两套文档并存（旧版官方已声明将停维护）。用之前以客户端实际读取结果为准。

**已核对完毕**（2026-10-01）。补充两条未证实项：

- **百度 Comate 文心快码**：官方手册 PDF 确认支持 STDIO / SSE / Streamable HTTP，但**配置文件路径与顶层键名未证实**（文档正文依赖 JS，抓取失败）。
- **讯飞 iFlyCode**：IDE 插件是否为 MCP 客户端**未证实**；已证实的只有「讯飞星辰 Agent 开发平台」支持接入 MCP Server，且**只填 Server URL（远程），不支持本地 stdio**。

多数国产 CLI 都提供 `mcp add` 子命令（`kimi mcp add`、`qwen mcp add`、`qoder mcp add`、`codebuddy mcp add`、`step mcp add`）。参数顺序各家不同，用 `<cli> mcp add --help` 确认后再抄——**改配置文件往往比记命令更省事**。

---

## 5. 工具说明

| 工具 | 参数 | 作用 |
|---|---|---|
| `dsh_ask` | `task`（必填）、`sessionId?`、`cwd?`、`timeoutMs?`（默认 900000）、`includeEvents?` | 把一条消息投给 DSH 并返回最终答案 |
| `dsh_cli_info` | 无 | 自检：报告解析到的 dsh 可执行文件与 `dsh --version` 退出码 |

`dsh_ask` 的返回末尾固定带一行 `sessionId: …`，把它记下来即可续会话。

在客户端里可以这样用（自然语言）：

> 用 dsh_ask 让本机 DSH 回答「仓库里有哪些包」，然后用返回的 sessionId 追加一句「只看前三个」。

---

## 6. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_BIN` | `dsh` | dsh 可执行文件路径；建议显式设置（npx 缓存路径会随版本变化） |
| `DSH_WORKSPACE` | 客户端启动目录 | DSH 会话的默认工作目录；建议显式设置 |
| `DSH_ASK_TIMEOUT_MS` | `900000` | 单次 `dsh_ask` 的默认超时 |
| `DSH_MCP_TOKEN` | 无 | `--http` 模式的 bearer token，等价于 `--token` |
| `DSH_MCP_HTTP_PORT` | `8790` | `--http` 模式的端口，等价于 `--port` |

---

## 7. 安全与限制（务必读）

1. **外部消息在 DSH 里看起来就是「用户本人发的」**。`session.prompt` 路径的 source 恒为 `{kind:'user'}`，DSH 的 `MessageSourceMap` 没有通用 plugin 来源。所以请在 `task` 文本里显式写明来源，例如 `[来自 Cursor 的外部请求] …`，否则会话历史里无法区分人与外部 AI。
2. **权限由 DSH profile 预设决定**。headless 会话默认继承 deployment 预设（本机是 `workspace-write`）。要让外部触发只读，需要在 profile 里配一个 `read-only` 预设，而不是靠这个 connector 控制。
3. **一次调用一个 DSH 进程**：没有会话池，长任务要用 `timeoutMs`；并发调用会各自新建会话。
4. **会话续接有前置条件**：`--session-id` 要求会话已持久化、cwd 与来源一致，否则 DSH 会报错。
5. **Windows 通过 cmd 启动** dsh（因为它是 `.cmd` shim）。任务文本不进 argv，所以不受引号规则影响。
6. **stdio 模式不鉴权，HTTP 模式强制 Bearer**：stdio 由客户端进程本身充当信任边界；`--http` 模式默认生成随机 token，且默认只绑 `127.0.0.1`，未列入白名单的 `Origin` 一律 403。要上公网请再套 TLS 反代/隧道，并换掉示例 token。

---

## 8. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `spawn EPERM` | 你在受限沙箱里运行。自测需要管道捕获子进程输出，请在普通终端里跑 |
| `cannot run the dsh CLI (dsh)` | `dsh` 不在 PATH：设置 `DSH_BIN` |
| `unknown session id` | 会话 id 拼错、或不在同一个 `DSH_HOME`、或 cwd 不一致 |
| 超时被 kill | 调大 `timeoutMs`（长任务默认 15 分钟） |
| 返回空答案 | 结果里会附 stderr；多是模型/凭据未配置（headless 用的是你 DSH 账户的凭据） |
| 客户端列表里看不到 `dsh` 工具 | 先单独跑 `node server.mjs`，它应只在 stderr 打印一行 ready；若无输出，是命令/参数填错 |
| `--http` 起不来 | 端口被占：换 `--port`，或 `DSH_MCP_HTTP_PORT` |

---

## 9. 文件清单

| 文件 | 作用 |
|---|---|
| `server.mjs` | MCP 服务器（stdio + Streamable HTTP 双传输）+ headless 驱动，零依赖 |
| `selftest.mjs` | 自测：密封 profile 启动 + stdio 往返 + HTTP 传输断言 + 可选真实调用 |
| `package.json` | `npm start` / `npm run selftest` |

已知边界：本 demo 驱动的是 `dsh --profile headless` 这条**一次性**通道，不具备「往 GUI 正在进行的那个会话实时投递」的能力。要做到后者需要 DSH 侧的常驻桥（`/ext/bridge`）或自写 host 插件，见同目录外的评估文档 [`dsh-external-ai-connector-assessment.md`](../dsh-external-ai-connector-assessment.md)。
