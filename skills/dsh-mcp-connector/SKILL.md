---
name: dsh-mcp-connector
description: Use when an external AI client (Claude Code, Cursor, VS Code, Codex, Kimi Code, CodeBuddy, Qoder, TRAE, ZCode, Step Code, MiniMax Code, Coze) must send messages to a local DeepSeek Harness over MCP, when DSH tools are missing from such a client's tool list, or when asked to build a bridge/server so another agent can talk to DSH. 中文触发：把外部 AI 接到 DSH、给 DSH 发消息、DSH 的 MCP 连接器/桥、客户端工具列表里看不到 dsh 工具、配置 MCP server。
---

# DSH MCP Connector

## Overview

DSH ships **no MCP server half** — only an MCP client. Anything letting an external client *call* DSH must be a bridge, and that bridge already exists, is zero-dependency, and is verified end to end:

```
C:\tools\dsh-mcp-connector\server.mjs
```

It drives `dsh --profile headless --json` and exposes two tools: `dsh_ask` (deliver one message, return the final answer plus a `sessionId`; pass that id back to continue the same session) and `dsh_cli_info` (self-check).

**Check for an already-running bridge before starting another one.** A deployment may already have live instances — stdio, or HTTP on `127.0.0.1:8790`.

## Quick reference

| Need | Action |
|---|---|
| Local stdio client | `command: "node"`, `args: ["<abs server.mjs>"]`, env `DSH_BIN` + `DSH_WORKSPACE` |
| Cloud-only client (Coze, 讯飞星辰, Claude.ai) | `node server.mjs --http --port 8790 --token <t>` + HTTPS tunnel; `POST /mcp`, `Authorization: Bearer` |
| Prove the bridge | `initialize` → `tools/list` (stdio, or `POST /mcp` for HTTP); tokenless HTTP must answer 401 |
| Prove DSH | `node selftest.mjs` — 16 assertions, exit 0, no model cost |
| Prove the model | `DSH_MCP_CONNECTOR_LIVE=1 node selftest.mjs` — one billed call |
| Queue work for a client to pull | producer: `node queue.mjs add "…"` or `POST /tasks`; consumer: `task_claim` → work → `task_complete` |
| Per-client paths and snippets | `references/client-configs.md` |

## Hard facts (verified)

- First run creates `~/.dsh/profiles/headless` — 4 small files, no network, no pnpm install.
- Delivered messages arrive with source `{kind:"user"}`: **indistinguishable from the human's own input.** Put the origin in the task text.
- Session permissions come from the deployment preset (here `workspace-write`). The connector cannot lower them.
- `headless` is one-shot: it **cannot** inject into a live `dsh web` GUI session — that needs `/ext/bridge` or a host plugin.
- Task text travels via stdin, so Windows `.cmd` shell quoting cannot corrupt it.
- The npx-cache `dsh.cmd` path is version-pinned and unstable; prefer a global install (`%APPDATA%\npm\dsh.cmd`).

## Traps that cost real debugging

| Client | Trap |
|---|---|
| ZCode (智谱) | top-level key is `mcp.servers`, **not** `mcpServers` |
| MiniMax Code / CodeBuddy CLI | the stdio entry needs an explicit `"type": "stdio"` |
| Step Code (阶跃) | TOML `[mcp_servers.<name>]`; no legacy SSE; tool names become `dsh__dsh_ask` |
| Coze (扣子) / 讯飞星辰 | officially no stdio at all → HTTP mode only |
| Any client | the workspace path contains 中文 (`插件`); if spawn fails, copy the folder to an ASCII path |
| Kimi | CLI and the VS Code extension may not share one config file |

## Open questions — flag, never assert

- **Kimi entry `type` field**: the official schema omits it (a `command` implies stdio), yet another doc shows `"type": "stdio"`.
- **CodeBuddy project-level `.mcp.json` enable flags**: seen in one doc mirror only; user scope sidesteps it.
- **Kimi VS Code extension** reading `~/.kimi-code/mcp.json`: unverified — only the CLI is documented.
- **Is the client even installed?** Check `Get-Command` and the config directory before writing a config: configuring an absent client is a silent no-op. (In the environment this skill was written in, neither `kimi` nor `codebuddy` CLI existed, and neither `~/.zcode` nor `~/.stepcode` was present.)

Full paths, snippets and evidence levels: `references/client-configs.md`.
