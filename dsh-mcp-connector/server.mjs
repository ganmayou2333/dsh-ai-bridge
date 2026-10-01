#!/usr/bin/env node
/**
 * dsh-mcp-connector — an MCP stdio server that delivers messages into a local
 * DeepSeek Harness (DSH) installation.
 *
 * Design notes:
 * - Zero runtime dependencies. MCP's stdio transport is newline-delimited
 *   JSON-RPC 2.0, so the protocol half is implemented directly here.
 * - DSH is driven through `dsh --profile headless --json`, the one-shot profile
 *   that ships with the CLI. Nothing in the DSH installation is modified and no
 *   running `dsh web` service is touched.
 * - The task text is always piped through stdin (`-` argument) so that arbitrary
 *   text never has to survive shell/argv quoting on Windows.
 * - stdout is the MCP channel. Every diagnostic goes to stderr.
 *
 * Environment:
 * - DSH_BIN      absolute path to the dsh executable (default: `dsh` on PATH)
 * - DSH_ASK_TIMEOUT_MS  default timeout for one dsh_ask call (default 900000)
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const SERVER_NAME = 'dsh-mcp-connector'
const SERVER_VERSION = '0.1.0'

/** Protocol revisions this server knows how to answer with. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const FALLBACK_PROTOCOL_VERSION = '2025-11-25'

const DEFAULT_TIMEOUT_MS = Number(process.env.DSH_ASK_TIMEOUT_MS ?? 15 * 60 * 1000)
const MAX_RESULT_CHARS = 200_000
const MAX_STDOUT_BYTES = 32 * 1024 * 1024
const MAX_STDERR_CHARS = 20_000

/** Session ids travel through the child argv, so keep them to a safe alphabet. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/

/* ------------------------------------------------------------------ logging */

function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`)
}

/* ----------------------------------------------------------- dsh invocation */

/**
 * Resolve how to launch the dsh CLI.
 * On Windows the CLI is a `.cmd` shim, which Node cannot execute without a
 * shell. To avoid the "args with shell:true" deprecation hazard, the whole
 * command line is assembled here as a single shell string and passed with no
 * argv array. Only space-free, caller-controlled tokens ever reach it: the
 * task text itself travels through stdin, and session ids are validated.
 */
export function resolveDshCommand() {
  const bin = process.env.DSH_BIN?.trim()
  return { command: bin && bin.length > 0 ? bin : 'dsh' }
}

/** Quote one shell token for cmd.exe / POSIX sh. */
function quoteToken(token) {
  if (/^[A-Za-z0-9._:/\\=+-]+$/.test(token)) return token
  return `"${token.replace(/"/g, '\\"')}"`
}

/** Build the spawn() arguments for one dsh invocation. */
function buildSpawnPlan(args) {
  const { command } = resolveDshCommand()
  if (process.platform === 'win32') {
    const line = [command, ...args].map(quoteToken).join(' ')
    return { file: line, argv: [], shell: true }
  }
  return { file: command, argv: args, shell: false }
}

/**
 * Run the dsh CLI once and collect its output.
 * @param args - argv tokens appended after the executable.
 * @param options - stdin text, cwd, timeout, JSON-lines parsing.
 */
export function runDsh(args, options = {}) {
  const plan = buildSpawnPlan(args)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const cwd = options.cwd ?? process.cwd()

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(plan.file, plan.argv, {
        cwd,
        shell: plan.shell,
        env: options.extraEnv === undefined ? process.env : { ...process.env, ...options.extraEnv },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new Error(`failed to spawn "${[plan.file, ...plan.argv].join(' ')}": ${String(error)}`))
      return
    }

    const startedAt = Date.now()
    const records = []
    let stdoutBytes = 0
    let stdoutRemainder = ''
    let stdoutText = ''
    let stderrText = ''
    let overflowed = false
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* the process may already be gone */
      }
      reject(new Error(`dsh did not finish within ${timeoutMs} ms (killed)`))
    }, timeoutMs)

    const finish = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk, 'utf8')
      if (stdoutText.length < MAX_STDERR_CHARS) stdoutText += chunk
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        overflowed = true
        child.kill()
        return
      }
      if (!options.parseJsonLines) return
      stdoutRemainder += chunk
      let index = stdoutRemainder.indexOf('\n')
      while (index !== -1) {
        const line = stdoutRemainder.slice(0, index).trim()
        stdoutRemainder = stdoutRemainder.slice(index + 1)
        if (line.length > 0) {
          try {
            records.push(JSON.parse(line))
          } catch {
            records.push({ type: 'unparsed', raw: line.slice(0, 2000) })
          }
        }
        index = stdoutRemainder.indexOf('\n')
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderrText.length < MAX_STDERR_CHARS) stderrText += chunk
    })

    child.on('error', (error) => {
      finish(() => reject(new Error(`cannot run the dsh CLI (${command}): ${error.message}`)))
    })

    child.on('close', (code, signal) => {
      finish(() => {
        if (overflowed) {
          reject(new Error(`dsh produced more than ${MAX_STDOUT_BYTES} bytes on stdout; aborted`))
          return
        }
        if (options.parseJsonLines && stdoutRemainder.trim().length > 0) {
          try {
            records.push(JSON.parse(stdoutRemainder.trim()))
          } catch {
            /* trailing partial line: ignore */
          }
        }
        resolve({
          code,
          signal,
          stdout: records,
          stdoutText,
          stderr: stderrText,
          durationMs: Date.now() - startedAt,
        })
      })
    })

    if (options.stdin !== undefined) {
      child.stdin.on('error', () => {
        /* EPIPE when the child exits early; the close handler reports the result */
      })
      child.stdin.end(options.stdin)
    } else {
      child.stdin.end()
    }
  })
}

/**
 * Interpret the `--json` event projection of one headless run.
 * Shape is owned by @deepseek-ai/dsh-headless (`projectJsonRun`):
 *   {type:'session', sessionId, cwd}
 *   {type:'status', phase:'turn_start'|'step_start'|'step_end'|'turn_end', ...}
 *   {type:'thinking'|'text', text} | {type:'tool_call'|'tool_result', ...}
 *   {type:'final', text}
 */
export function summarizeRun(stdout) {
  let sessionId
  let answer = ''
  const toolCalls = []
  let turnEnd

  for (const record of stdout) {
    if (record === null || typeof record !== 'object') continue
    switch (record.type) {
      case 'session':
        if (typeof record.sessionId === 'string') sessionId = record.sessionId
        break
      case 'text':
        if (typeof record.text === 'string') answer += record.text
        break
      case 'final':
        if (typeof record.text === 'string') answer = record.text
        break
      case 'tool_call':
        toolCalls.push(typeof record.tool === 'string' ? record.tool : 'unknown')
        break
      case 'status':
        if (record.phase === 'turn_end') turnEnd = record
        break
      default:
        break
    }
  }

  return { sessionId, answer, toolCalls, turnEnd }
}

function truncate(text, limit = MAX_RESULT_CHARS) {
  if (text.length <= limit) return { text, truncated: false }
  return { text: `${text.slice(0, limit)}\n... [truncated, ${text.length - limit} more characters]`, truncated: true }
}

/** `dsh_ask` implementation: deliver one message and return the final answer. */
async function dshAsk(args) {
  const task = typeof args?.task === 'string' ? args.task : ''
  if (task.trim().length === 0) throw new Error('task must be a non-empty string')

  const sessionId = args?.sessionId
  if (sessionId !== undefined) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error('sessionId has an unexpected shape; use the id returned by a previous dsh_ask call')
    }
  }
  const cwd =
    typeof args?.cwd === 'string' && args.cwd.trim().length > 0
      ? args.cwd
      : process.env.DSH_WORKSPACE?.trim() || undefined
  const timeoutMs = Number.isFinite(args?.timeoutMs) ? Number(args.timeoutMs) : DEFAULT_TIMEOUT_MS

  // `-` makes headless read the task from stdin, so no task text reaches argv.
  const argv = ['--profile', 'headless', '--json']
  if (sessionId !== undefined) argv.push('--session-id', sessionId)
  argv.push('-')

  const run = await runDsh(argv, { stdin: task, cwd, timeoutMs, parseJsonLines: true })
  const summary = summarizeRun(run.stdout)

  const lines = []
  lines.push(summary.answer.trim().length > 0 ? summary.answer.trim() : '(DSH returned no final text)')
  lines.push('')
  lines.push('---')
  lines.push(`sessionId: ${summary.sessionId ?? '(none reported)'}`)
  if (summary.toolCalls.length > 0) lines.push(`tool calls: ${summary.toolCalls.join(', ')}`)
  lines.push(`duration: ${(run.durationMs / 1000).toFixed(1)}s, exit code: ${String(run.code)}`)
  if (run.code !== 0 || summary.answer.trim().length === 0) {
    const detail = run.stderr.trim() || '(no stderr)'
    lines.push(`stderr:\n${truncate(detail, 4000).text}`)
  }

  const text = lines.join('\n')
  if (run.code !== 0 && summary.answer.trim().length === 0) {
    return { text, isError: true }
  }
  return { text, isError: false, raw: args?.includeEvents === true ? run.stdout : undefined }
}

/** `dsh_cli_info` implementation: prove the connector can really reach DSH. */
async function dshCliInfo() {
  const { command } = resolveDshCommand()
  const run = await runDsh(['--version'], { timeoutMs: 60_000, parseJsonLines: false })
  const version = run.stderr.trim().length > 0 && run.code !== 0 ? run.stderr.trim() : '(see exit code)'
  const text = [
    `dsh executable: ${command}${process.platform === 'win32' ? '  (launched through the Windows shell)' : ''}`,
    `dsh --version exit code: ${String(run.code)}`,
    version !== '(see exit code)' ? `stderr: ${version}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n')
  return { text, isError: run.code !== 0 }
}

/* ------------------------------------------------------------ MCP protocol */

const TOOLS = [
  {
    name: 'dsh_ask',
    description:
      'Deliver one message to the local DeepSeek Harness and return its final answer. Omit sessionId to start a new DSH session; pass the sessionId returned by a previous call to continue that same session.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The message/task text handed to DSH. Required and must not be blank.' },
        sessionId: { type: 'string', description: 'Optional. Continue an existing DSH session by id.' },
        cwd: { type: 'string', description: 'Optional absolute working directory for the DSH run.' },
        timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds. Defaults to 900000.' },
        includeEvents: { type: 'boolean', description: 'Optional. Attach the raw event stream for debugging.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_cli_info',
    description:
      'Self-check: report which dsh executable this connector resolves and its version. Use it to confirm the connector can actually reach a local DSH installation.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function resultMessage(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function errorMessage(id, code, message, data) {
  return data === undefined
    ? { jsonrpc: '2.0', id, error: { code, message } }
    : { jsonrpc: '2.0', id, error: { code, message, data } }
}

function negotiateProtocolVersion(requested) {
  if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return requested
  return FALLBACK_PROTOCOL_VERSION
}

async function callTool(id, params) {
  const name = params?.name
  const args = params?.arguments ?? {}
  if (name !== 'dsh_ask' && name !== 'dsh_cli_info') {
    return errorMessage(id, -32602, `unknown tool: ${String(name)}`)
  }
  try {
    const outcome = name === 'dsh_ask' ? await dshAsk(args) : await dshCliInfo()
    const truncated = truncate(outcome.text)
    const content = [{ type: 'text', text: truncated.text }]
    if (outcome.raw !== undefined && !truncated.truncated) {
      content.push({ type: 'text', text: `\n[events]\n${JSON.stringify(outcome.raw, null, 2).slice(0, MAX_RESULT_CHARS)}` })
    }
    return resultMessage(id, { content, isError: outcome.isError === true })
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    log(`tool ${String(name)} failed: ${text}`)
    return resultMessage(id, { content: [{ type: 'text', text: `tool ${String(name)} failed: ${text}` }], isError: true })
  }
}

/**
 * Build the JSON-RPC response for one incoming message, or undefined when the
 * message is a notification (which must not be answered). Shared by both
 * transports so stdio and HTTP behave identically.
 */
export async function buildResponse(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined
  const id = message.id
  if (id === undefined || id === null) return undefined
  const { method, params } = message
  try {
    switch (method) {
      case 'initialize':
        return resultMessage(id, {
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            'This server forwards messages into a local DeepSeek Harness installation through `dsh --profile headless`. ' +
            'Messages delivered this way appear inside DSH as ordinary user messages, so state clearly in the task text that the request came from an external AI.',
        })
      case 'ping':
        return resultMessage(id, {})
      case 'tools/list':
        return resultMessage(id, { tools: TOOLS })
      case 'tools/call':
        return await callTool(id, params)
      case 'resources/list':
        return resultMessage(id, { resources: [] })
      case 'prompts/list':
        return resultMessage(id, { prompts: [] })
      default:
        return errorMessage(id, -32601, `method not found: ${String(method)}`)
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    return errorMessage(id, -32603, `internal error: ${text}`)
  }
}

/* ------------------------------------------------------------ stdio transport */

function runStdio() {
  let buffer = ''
  let stdinEnded = false
  let inflight = 0

  // Closing stdin terminates the server, but only after every in-flight request
  // has been answered: calling process.exit() while a response is still being
  // written can truncate it.
  const maybeExit = () => {
    if (stdinEnded && inflight === 0) process.exit(0)
  }

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length > 0) dispatchLine(line)
      index = buffer.indexOf('\n')
    }
  })
  process.stdin.on('end', () => {
    if (buffer.trim().length > 0) dispatchLine(buffer.trim())
    stdinEnded = true
    maybeExit()
  })
  log(`stdio ready (dsh binary: ${resolveDshCommand().command})`)

  function dispatchLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      log('ignored unparseable line from the client')
      return
    }
    if (message?.method === 'notifications/initialized') log('client initialized')
    inflight += 1
    buildResponse(message)
      .then((response) => {
        if (response !== undefined) send(response)
      })
      .catch((error) => {
        const text = error instanceof Error ? error.message : String(error)
        send(errorMessage(message?.id ?? null, -32603, `internal error: ${text}`))
      })
      .finally(() => {
        inflight -= 1
        maybeExit()
      })
  }
}

/* ------------------------------------ Streamable HTTP transport (MCP 2025-11-25) */

const MAX_HTTP_BODY_BYTES = 1024 * 1024

function tokenMatches(expected, presented) {
  if (typeof presented !== 'string' || presented.length === 0) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(presented, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_HTTP_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_HTTP_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

async function handleHttpRequest(req, res, options) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (url.pathname !== options.path) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain' })
    res.end('method not allowed')
    return
  }
  // MCP requires servers to validate Origin on incoming connections.
  const origin = req.headers.origin
  if (typeof origin === 'string' && !options.allowOrigins.has(origin)) {
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end(`origin not allowed: ${origin}`)
    return
  }
  const authorization = req.headers.authorization
  const presented =
    typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined
  if (!tokenMatches(options.token, presented)) {
    res.writeHead(401, { 'www-authenticate': 'Bearer', 'content-type': 'text/plain' })
    res.end('unauthorized')
    return
  }

  let parsed
  try {
    parsed = JSON.parse(await readBody(req))
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    sendJson(res, 400, errorMessage(null, -32700, `parse error: ${text}`))
    return
  }

  const batch = Array.isArray(parsed) ? parsed : [parsed]
  const responses = []
  for (const message of batch) {
    const response = await buildResponse(message)
    if (response !== undefined) responses.push(response)
  }
  if (responses.length === 0) {
    // Notifications only: acknowledge without a JSON-RPC body.
    res.writeHead(202)
    res.end()
    return
  }
  sendJson(res, 200, Array.isArray(parsed) ? responses : responses[0])
}

function runHttp(options) {
  const server = createServer((req, res) => {
    handleHttpRequest(req, res, options).catch((error) => {
      const text = error instanceof Error ? error.message : String(error)
      log(`http handler failed: ${text}`)
      if (!res.headersSent) sendJson(res, 500, errorMessage(null, -32603, 'internal error'))
      else res.destroy()
    })
  })
  server.listen(options.port, options.host, () => {
    log(`streamable HTTP MCP endpoint: http://${options.host}:${options.port}${options.path}`)
    log(
      `bearer token: ${options.token}` +
        (options.tokenGenerated ? '  (generated for this run; pin it with --token or DSH_MCP_TOKEN)' : ''),
    )
    if (options.host !== '127.0.0.1' && options.host !== 'localhost') {
      log('warning: bound beyond loopback; put a TLS reverse proxy in front and keep the token secret')
    }
  })
  server.on('error', (error) => {
    log(`cannot listen on ${options.host}:${options.port}: ${error.message}`)
    process.exit(1)
  })
}

/* ---------------------------------------------------------------- entry point */

const USAGE = `dsh-mcp-connector ${SERVER_VERSION}

Default is MCP over stdio, for local clients (Claude Code, Cursor, VS Code, Codex,
Qwen Code, Kimi CLI, CodeBuddy and any other stdio-capable MCP client).

  node server.mjs                       stdio transport
  node server.mjs --http                Streamable HTTP, for remote/cloud-hosted agents
  node server.mjs --http --port 8790 --host 127.0.0.1 --token <token>

Options:
  --http                  serve MCP over Streamable HTTP instead of stdio
  --host <host>           HTTP bind host (default 127.0.0.1)
  --port <port>           HTTP bind port (default 8790)
  --path <path>           HTTP endpoint path (default /mcp)
  --token <token>         bearer token required on every HTTP request
  --allow-origin <origin> allow one Origin header value (repeatable)
  -h, --help              show this help

Environment:
  DSH_BIN                 dsh executable (default: dsh on PATH)
  DSH_WORKSPACE           default DSH session working directory (default: the client's cwd)
  DSH_ASK_TIMEOUT_MS      default dsh_ask timeout (default 900000)
  DSH_MCP_TOKEN           bearer token for --http
  DSH_MCP_HTTP_PORT       port for --http
`

function parseArgs(argv) {
  const options = {
    mode: 'stdio',
    host: '127.0.0.1',
    port: Number(process.env.DSH_MCP_HTTP_PORT ?? 8790),
    path: '/mcp',
    token: process.env.DSH_MCP_TOKEN?.trim() || undefined,
    tokenGenerated: false,
    allowOrigins: new Set(),
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--http':
        options.mode = 'http'
        break
      case '--host':
        options.host = String(argv[++index] ?? options.host)
        break
      case '--port':
        options.port = Number(argv[++index] ?? options.port)
        break
      case '--path':
        options.path = String(argv[++index] ?? options.path)
        break
      case '--token':
        options.token = String(argv[++index] ?? '')
        break
      case '--allow-origin':
        options.allowOrigins.add(String(argv[++index] ?? ''))
        break
      case '-h':
      case '--help':
        options.help = true
        break
      default:
        break
    }
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) options.port = 8790
  if (!options.path.startsWith('/')) options.path = `/${options.path}`
  if (options.mode === 'http' && (options.token === undefined || options.token.length === 0)) {
    options.token = randomBytes(24).toString('base64url')
    options.tokenGenerated = true
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }
  if (options.mode === 'http') runHttp(options)
  else runStdio()
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) main()
