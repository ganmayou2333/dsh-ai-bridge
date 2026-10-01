#!/usr/bin/env node
/**
 * Self-test for the dsh-mcp-connector demo. Read-only with respect to DSH:
 * it never touches `~/.dsh` and never restarts a running service.
 *
 * Steps:
 *  1. Hermetic profile boot: run `dsh --profile headless --help` with DSH_HOME
 *     pointed at a scratch directory inside this folder. Proves that the CLI
 *     accepts the headless profile and that first-run profile init works,
 *     without writing to the real DSH home.
 *  2. MCP protocol round trip: start `server.mjs` as a child and speak real
 *     newline-delimited JSON-RPC over stdio (initialize -> tools/list -> tools/call).
 *  3. `dsh_cli_info`: a tool call that really spawns the dsh CLI end to end.
 *  4. Optional live run: set DSH_MCP_CONNECTOR_LIVE=1 to also call `dsh_ask`
 *     with a trivial task. That performs a real model request and is billed to
 *     your DSH account, so it is off by default.
 *
 * Usage:  node selftest.mjs
 */

import { mkdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runDsh } from './server.mjs'
import { publishTask, claimTask, completeTask, listTasks } from './queue.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRATCH_HOME = join(HERE, '.selftest-home')
const SCRATCH_QUEUE = join(HERE, '.selftest-queue', 'tasks.jsonl')
const SERVER_PATH = join(HERE, 'server.mjs')
const QUEUE_ENV = { DSH_QUEUE_FILE: SCRATCH_QUEUE }

let failures = 0
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) failures += 1
  process.stdout.write(`${mark}  ${name}${detail.length > 0 ? `\n      ${detail}` : ''}\n`)
}

/* ---------------------------------------------- step 1: hermetic profile boot */

async function stepProfileBoot() {
  process.stdout.write('\n[1] hermetically booting the headless profile (DSH_HOME is a scratch dir)\n')
  mkdirSync(SCRATCH_HOME, { recursive: true })
  try {
    const run = await runDsh(['--profile', 'headless', '--help'], {
      timeoutMs: 180_000,
      parseJsonLines: false,
      extraEnv: { DSH_HOME: SCRATCH_HOME },
    })
    const text = `${run.stdoutText}\n${run.stderr}`
    check('dsh --profile headless --help exits 0 with a fresh DSH_HOME', run.code === 0, `exit=${String(run.code)}`)
    check('profile help text mentions --session-id', text.includes('--session-id'), text.trim().split('\n').slice(0, 3).join(' | '))
  } catch (error) {
    check('dsh --profile headless --help exits 0 with a fresh DSH_HOME', false, String(error))
  } finally {
    rmSync(SCRATCH_HOME, { recursive: true, force: true })
  }
}

/* ------------------------------------------------- step 2: MCP child round trip */

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: HERE,
    env: { ...process.env, ...extraEnv },
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let nextId = 1
  let buffer = ''
  const stderrLines = []

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length > 0) {
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        const resolver = pending.get(message.id)
        if (resolver !== undefined) {
          pending.delete(message.id)
          resolver(message)
        }
      }
      index = buffer.indexOf('\n')
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => stderrLines.push(chunk))

  const request = (method, params, timeoutMs = 120_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout waiting for ${method}`))
      }, timeoutMs)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  return { child, request, notify, stderrLines }
}

async function stepMcpRoundTrip() {
  process.stdout.write('\n[2] MCP stdio round trip against server.mjs\n')
  const server = startServer(QUEUE_ENV)
  try {
    const init = await server.request('initialize', {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'selftest', version: '0.1.0' },
      capabilities: {},
    })
    const info = init.result
    check('initialize returns serverInfo', info?.serverInfo?.name === 'dsh-mcp-connector', JSON.stringify(info?.serverInfo))
    check('protocolVersion is echoed when supported', info?.protocolVersion === '2025-06-18', String(info?.protocolVersion))

    server.notify('notifications/initialized', {})

    const list = await server.request('tools/list', {})
    const names = (list.result?.tools ?? []).map((tool) => tool.name)
    check('tools/list exposes all six tools', names.length === 6 && names.includes('task_claim'), names.join(', '))
    const askTool = (list.result?.tools ?? []).find((tool) => tool.name === 'dsh_ask')
    check('dsh_ask declares a required task parameter', askTool?.inputSchema?.required?.includes('task') === true)

    const info2 = await server.request('tools/call', { name: 'dsh_cli_info', arguments: {} }, 90_000)
    const infoText = info2.result?.content?.[0]?.text ?? ''
    check('tools/call dsh_cli_info spawns the real CLI successfully', info2.result?.isError === false, infoText.split('\n').join(' | '))

    const bad = await server.request('tools/call', { name: 'nope', arguments: {} })
    check('unknown tool is reported as a JSON-RPC error', bad.error?.code === -32602, JSON.stringify(bad.error))

    if (process.env.DSH_MCP_CONNECTOR_LIVE === '1') {
      process.stdout.write('\n[3] LIVE run: one real dsh_ask call (billed to your DSH account)\n')
      const live = await server.request(
        'tools/call',
        { name: 'dsh_ask', arguments: { task: '请只回复四个字：连接器已就绪' } },
        900_000,
      )
      const text = live.result?.content?.[0]?.text ?? ''
      process.stdout.write(`${text}\n`)
      check('live dsh_ask returns a session id', /sessionId: \S/.test(text))
      check('live dsh_ask succeeded', live.result?.isError === false)
    } else {
      process.stdout.write('\n[3] skipped the live dsh_ask call (set DSH_MCP_CONNECTOR_LIVE=1 to include it)\n')
    }
  } catch (error) {
    check('MCP round trip completed', false, String(error))
  } finally {
    server.child.stdin.end()
    server.child.kill()
    // Let the child's handles close before this process exits; exiting while a
    // killed child is still tearing down trips a libuv assertion on Windows.
    if (server.child.exitCode === null) await once(server.child, 'exit').catch(() => {})
  }
}

/* ------------------------------------------------ step 4: HTTP transport */

async function stepHttpTransport() {
  process.stdout.write('\n[4] Streamable HTTP transport (for remote/cloud-hosted agents)\n')
  const port = 8791
  const token = 'selftest-token'
  const child = spawn(process.execPath, [SERVER_PATH, '--http', '--port', String(port), '--token', token], {
    cwd: HERE,
    env: { ...process.env, ...QUEUE_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderrText = ''
  child.stderr.setEncoding('utf8')
  const ready = new Promise((resolve) => {
    child.stderr.on('data', (chunk) => {
      stderrText += chunk
      if (stderrText.includes('streamable HTTP MCP endpoint')) resolve(true)
    })
    setTimeout(() => resolve(false), 15_000)
  })

  try {
    const isReady = await ready
    check('HTTP server announces its endpoint on stderr', isReady, stderrText.trim().split('\n')[0] ?? '')
    if (!isReady) return

    const url = `http://127.0.0.1:${port}/mcp`
    const call = (body, headers = {}) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })

    const noAuth = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    check('missing bearer token is rejected with 401', noAuth.status === 401, `status=${noAuth.status}`)

    const unlistedOrigin = await call(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { authorization: `Bearer ${token}`, origin: 'https://evil.example' },
    )
    check('unlisted Origin header is rejected with 403', unlistedOrigin.status === 403, `status=${unlistedOrigin.status}`)

    const initResponse = await call(
      { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { authorization: `Bearer ${token}` },
    )
    const initJson = await initResponse.json()
    check(
      'initialize over HTTP returns serverInfo',
      initJson?.result?.serverInfo?.name === 'dsh-mcp-connector',
      JSON.stringify(initJson?.result?.serverInfo),
    )

    const listResponse = await call({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, { authorization: `Bearer ${token}` })
    const listJson = await listResponse.json()
    const names = (listJson?.result?.tools ?? []).map((tool) => tool.name)
    check('tools/list over HTTP exposes all six tools', names.length === 6, names.join(', '))

    const notificationResponse = await call(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { authorization: `Bearer ${token}` },
    )
    check('notification-only POST answers 202', notificationResponse.status === 202, `status=${notificationResponse.status}`)

    const getResponse = await fetch(url, { method: 'GET' })
    check('non-POST method is rejected with 405', getResponse.status === 405, `status=${getResponse.status}`)

    const wrongPath = await fetch(`http://127.0.0.1:${port}/nope`, { method: 'POST' })
    check('wrong path is rejected with 404', wrongPath.status === 404, `status=${wrongPath.status}`)

    // Producer route: enqueue without going through an MCP client.
    const produced = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ task: 'queued over HTTP', source: 'selftest-http' }),
    })
    const producedBody = await produced.json()
    check('HTTP producer route enqueues a task', produced.status === 201 && typeof producedBody.id === 'string', `status=${produced.status} id=${String(producedBody.id)}`)

    const producedAnon = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'should be rejected' }),
    })
    check('HTTP producer route enforces the bearer token', producedAnon.status === 401, `status=${producedAnon.status}`)

    const queued = await listTasks({ state: 'pending' }, QUEUE_ENV)
    check(
      'the HTTP-enqueued task is actually claimable',
      queued.some((entry) => entry.task === 'queued over HTTP'),
      `${queued.length} pending`,
    )
  } catch (error) {
    check('HTTP transport checks completed', false, String(error))
  } finally {
    child.kill()
    if (child.exitCode === null) await once(child, 'exit').catch(() => {})
  }
}

/* -------------------------------------------------------- step 5: task queue */

async function stepQueue() {
  process.stdout.write('\n[5] task queue (pull-based dispatch)\n')
  rmSync(join(HERE, '.selftest-queue'), { recursive: true, force: true })

  try {
    const a = await publishTask({ task: 'task A' }, QUEUE_ENV)
    const b = await publishTask({ task: 'task B' }, QUEUE_ENV)
    check('publish returns distinct ids', a.id !== b.id, `${a.id} / ${b.id}`)

    const first = await claimTask({ worker: 'worker-1' }, QUEUE_ENV)
    check('claim hands out the oldest task first', first.claimed === true && first.id === a.id, JSON.stringify(first))

    const second = await claimTask({ worker: 'worker-2' }, QUEUE_ENV)
    check('a claimed task is never handed out twice', second.id === b.id, JSON.stringify(second))

    const empty = await claimTask({}, QUEUE_ENV)
    check('an exhausted queue reports nothing pending', empty.claimed === false, JSON.stringify(empty))

    const done = await completeTask({ id: a.id, status: 'ok', result: 'A finished' }, QUEUE_ENV)
    check('complete records a result', done.accepted === true && done.alreadyCompleted === false, JSON.stringify(done))

    const again = await completeTask({ id: a.id, status: 'ok', result: 'ignored' }, QUEUE_ENV)
    check('completing twice is a no-op (safe retries)', again.alreadyCompleted === true, JSON.stringify(again))

    let unknownRejected = false
    try {
      await completeTask({ id: 't-does-not-exist' }, QUEUE_ENV)
    } catch {
      unknownRejected = true
    }
    check('completing an unknown id is rejected', unknownRejected)

    const states = new Map((await listTasks({ state: 'all' }, QUEUE_ENV)).map((task) => [task.id, task.state]))
    check(
      'state fold separates done from claimed',
      states.get(a.id) === 'done' && states.get(b.id) === 'claimed',
      JSON.stringify([...states]),
    )

    // Concurrency: parallel claimants must never receive the same task.
    for (let index = 0; index < 6; index += 1) await publishTask({ task: `parallel ${index}` }, QUEUE_ENV)
    const raced = await Promise.all(Array.from({ length: 6 }, () => claimTask({ worker: 'race' }, QUEUE_ENV)))
    const taken = raced.filter((entry) => entry.claimed).map((entry) => entry.id)
    check('six concurrent claims take six distinct tasks', new Set(taken).size === 6, `took ${taken.length}: ${taken.join(', ')}`)

    // The MCP surface must reach the same queue.
    const server = startServer(QUEUE_ENV)
    try {
      await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
      server.notify('notifications/initialized', {})

      const published = await server.request('tools/call', {
        name: 'task_publish',
        arguments: { task: 'queued from an MCP client', source: 'selftest' },
      })
      const publishedText = published.result?.content?.[0]?.text ?? ''
      check(
        'task_publish works over MCP',
        published.result?.isError === false && publishedText.includes('published'),
        publishedText.split('\n')[0],
      )

      const claimed = await server.request('tools/call', { name: 'task_claim', arguments: { worker: 'mcp' } })
      const claimedText = claimed.result?.content?.[0]?.text ?? ''
      check(
        'task_claim hands the MCP client the queued task',
        claimed.result?.isError === false && claimedText.includes('queued from an MCP client'),
        claimedText.split('\n')[0],
      )

      const drained = await server.request('tools/call', { name: 'task_claim', arguments: {} })
      check(
        'a drained queue answers "no pending task"',
        (drained.result?.content?.[0]?.text ?? '').includes('no pending task'),
        (drained.result?.content?.[0]?.text ?? '').split('\n')[0],
      )

      const completed = await server.request('tools/call', {
        name: 'task_complete',
        arguments: { id: claimedText.match(/task id: (\S+)/)?.[1], status: 'ok', result: 'done by the MCP client' },
      })
      check('task_complete works over MCP', completed.result?.isError === false, completed.result?.content?.[0]?.text ?? '')
    } finally {
      server.child.stdin.end()
      server.child.kill()
      if (server.child.exitCode === null) await once(server.child, 'exit').catch(() => {})
    }
  } catch (error) {
    check('task queue checks completed', false, String(error))
  } finally {
    rmSync(join(HERE, '.selftest-queue'), { recursive: true, force: true })
  }
}

async function main() {
  process.stdout.write(`dsh-mcp-connector selftest (node ${process.version}, platform ${process.platform})\n`)
  await stepProfileBoot()
  await stepMcpRoundTrip()
  await stepHttpTransport()
  await stepQueue()
  process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  // Set the code and let the event loop drain instead of calling process.exit(),
  // which can abort inside libuv while child handles are still closing.
  process.exitCode = failures === 0 ? 0 : 1
}

main()
