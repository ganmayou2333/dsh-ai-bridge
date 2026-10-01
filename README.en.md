# dsh-ai-bridge

Two zero-dependency tools that connect an external AI client to a local
**DeepSeek Harness (DSH)** — and one that drives the **Doubao desktop app**
from the outside. Nothing in the DSH installation is modified.

[中文说明](README.md)

```
External AI client ──MCP──▶ dsh-mcp-connector ──▶ dsh --profile headless ──▶ DSH
   (Claude Code / Cursor / VS Code / Codex / Kimi Code / CodeBuddy / Qoder /
    TRAE / ZCode / Step Code / MiniMax Code / Coze, …)

DSH / scripts / HTTP ──enqueue──▶ tasks.jsonl ──task_claim──▶ any MCP client
                                 (pull-based task queue)

scripts / DSH ──CDP──▶ doubao-cdp ──▶ Doubao desktop (dispatch into its chat box)
```

## Why this exists

A DSH installation ships an MCP **client** (`dsh-mcp-client`) but no MCP
**server** half, and its Web API is fenced by a browser cookie plus Host/Origin
checks that a third-party process cannot hold. So letting another AI send
messages *into* DSH requires a separate bridge — that is the first tool.

The reverse direction (handing work to another vendor's AI) has **no official
inbound API at all**, so it can only be GUI automation — that is the second tool.

And because MCP tools only run inside the client's own turn, work cannot be
pushed to a client; the only shape that scales is **pull**: a producer enqueues,
the client claims. That is built into the first tool.

## Layout

| Path | What it is |
|---|---|
| [`dsh-mcp-connector/`](dsh-mcp-connector/) | MCP server (stdio + Streamable HTTP) exposing `dsh_ask`, `dsh_cli_info`, `connector_status` and four task-queue tools, driving `dsh --profile headless` |
| [`doubao-cdp/`](doubao-cdp/) | Chrome DevTools Protocol driver for the Doubao desktop app: `cdp.mjs` sends and reads back, `dispatch.mjs` dispatches with **side-effect verification** |
| [`skills/dsh-mcp-connector/`](skills/dsh-mcp-connector/) | Agent skill: config matrix for 17 MCP clients, a traps table, and an explicit list of unverified claims |
| [`docs/design-notes.md`](docs/design-notes.md) | Design notes (Chinese): why a bridge is unavoidable, DSH's five machine entry points, why the queue pulls, the two compliance directions, known failure modes |

## Quick start

```bash
git clone https://github.com/ganmayou2333/dsh-ai-bridge
cd dsh-ai-bridge

npm test                       # both hermetic suites: no DSH, no Doubao needed

cd dsh-mcp-connector
node selftest.mjs              # the full selftest, including two checks that need a local DSH

# then add a stdio server in your MCP client:
#   command: node
#   args:    <path>/dsh-ai-bridge/dsh-mcp-connector/server.mjs
#   env:     DSH_BIN=<dsh executable>   DSH_WORKSPACE=<DSH session working directory>
# Per-client paths and snippets: dsh-mcp-connector/README.md
```

Requirements: Node ≥ 20, and a working DSH installation (`dsh` on PATH).

## Verification status

| Item | Evidence |
|---|---|
| `dsh-mcp-connector` selftest | **34 assertions pass, exit 0** — hermetic headless-profile bootstrap, stdio round trip, HTTP transport auth (401/403/404/405/202) and producer route (201), queue semantics, 6-way concurrent claims without collision, self-observation and the pipelined-handshake gate |
| Offline selftest (CI) | 31 pass / 2 skipped, exit 0 — skips the two checks that need a local `dsh` |
| Real model call | one message answered in 3.7 s, returning a `sessionId`; a second message with that id continued the same session |
| `doubao-cdp` round trips | three consecutive dispatch/reply pairs |
| `dispatch.mjs` verification | both paths measured: success (queue completed → exit 0 `VERIFIED`) and failure (client claimed success while the queue still held the task → exit 2 `UNVERIFIED`); the hermetic test passes **9 assertions** with neither Doubao nor CDP present |
| Single entry point | `npm test` at the repository root runs the connector's offline selftest plus the dispatcher selftest, exit 0 |

The selftest spends nothing by default; `DSH_MCP_CONNECTOR_LIVE=1 node selftest.mjs`
adds one real billed call.

## Security notes

- The connector's **stdio** mode trusts the spawning client process; its
  **HTTP** mode requires a bearer token, binds `127.0.0.1` by default and
  answers 403 to any `Origin` that is not explicitly allowed. Put TLS in front
  before exposing it, and replace the sample token.
- Messages delivered into DSH arrive with `{kind:"user"}` and are
  **indistinguishable from the human's own input** — make the downstream label
  the origin in the task text.
- **Never trust an AI client's "I already called the tool."** Measured: with the
  connector not enabled in the conversation, Doubao replied "called task_claim,
  status ok" while the queued task was still `pending`. Verify side effects —
  queue events, files, logs. `doubao-cdp/dispatch.mjs` is built on that rule.
- `doubao-cdp` needs Doubao started with `--remote-debugging-port`, which means
  **any local process can drive your Doubao** (read chats, send messages as
  you). Close it when you are done.
- Both tools only **deliver messages**. Do not point them at a subscription
  account to power a third-party model backend; that violates the vendors'
  consumer terms.

## License

MIT — see [LICENSE](LICENSE).
