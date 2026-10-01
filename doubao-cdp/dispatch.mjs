#!/usr/bin/env node
/**
 * doubao-dispatch — hand one task to the Doubao desktop app and (optionally)
 * verify it actually reached the shared task queue.
 *
 * Why this exists: a chat client can reply "I called task_claim and reported
 * ok" without having called anything. Measured on 2026-10-01, Doubao answered
 * exactly that while the queue still held the task in `pending` and no
 * agent_infra task had run at all. A dispatcher that trusts the reply is a
 * dispatcher that silently drops work.
 *
 * So there are two modes:
 *
 *   chat  (default)  send the task, return the client's reply.
 *   --queue          publish to the queue with an expected reply marker, ask
 *                    the client to claim it through the MCP connector and
 *                    complete it, then poll the QUEUE until the task is done.
 *                    The chat reply is only quoted as evidence on failure.
 *
 * Usage:
 *   node dispatch.mjs "任务文本" [--timeout 300000]
 *   node dispatch.mjs "任务文本" --queue [--timeout 300000] [--worker doubao]
 *   node dispatch.mjs "任务文本" --queue --no-send      # verify without touching the chat
 *
 * Exit codes: 0 dispatched and verified, 2 timeout / unverified, 1 hard error.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { publishTask, listTasks, resolveQueueFile, resolveQueueDir } from '../dsh-mcp-connector/queue.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CDP = join(HERE, 'cdp.mjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Which MCP clients the connector has ever seen, newest activity last.
 * Read straight from the connector's sidecar state so the dispatcher can warn
 * before spending a timeout on a client that may not be able to call anything.
 */
async function readClientRecords() {
  try {
    const parsed = JSON.parse(await readFile(join(resolveQueueDir(), 'clients.json'), 'utf8'))
    return Array.isArray(parsed?.clients) ? parsed.clients : []
  } catch {
    return []
  }
}

/** One factual line about the connector's client record, for the report. */
function describeClients(clients) {
  if (clients.length === 0) {
    return '连接器记录到的客户端：无（它从未收到过任何 MCP 客户端的 initialize）'
  }
  const latest = clients.reduce((a, b) => (a.lastSeenAt >= b.lastSeenAt ? a : b))
  const ageSeconds = Math.round((Date.now() - latest.lastSeenAt) / 1000)
  return (
    `连接器记录到的客户端：${clients.length} 个，最近是 ` +
    `${latest.name}${latest.version ? `@${latest.version}` : ''} via ${latest.transport}，${ageSeconds}s 前活动过`
  )
}

/** Run the CDP helper and capture its stdout. */
function runCdp(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CDP, ...args], { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

function parseArgs(argv) {
  const options = { task: '', queue: false, noSend: false, timeoutMs: 300_000, worker: 'doubao' }
  const words = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--queue') options.queue = true
    else if (arg === '--no-send') options.noSend = true
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++index] ?? options.timeoutMs)
    else if (arg === '--worker') options.worker = String(argv[++index] ?? options.worker)
    else words.push(arg)
  }
  options.task = words.join(' ').trim()
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.task.length === 0) {
    process.stderr.write('usage: dispatch.mjs <task text> [--queue] [--timeout ms] [--worker label] [--no-send]\n')
    process.exitCode = 1
    return
  }

  const marker = `DISPATCH-${randomBytes(3).toString('hex')}`

  // ---- chat mode: the reply is the deliverable -------------------------------
  if (!options.queue) {
    const sent = await runCdp(['send', options.task], 60_000)
    if (sent.code !== 0) {
      process.stderr.write(`send failed: ${sent.stderr || sent.stdout}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`${sent.stdout}\n`)
    const reply = await runCdp(['wait', String(options.timeoutMs)], options.timeoutMs + 30_000)
    if (reply.code !== 0) {
      process.stderr.write(`no settled reply: ${reply.stdout || reply.stderr}\n`)
      process.exitCode = 2
      return
    }
    process.stdout.write(`${reply.stdout}\n`)
    return
  }

  // ---- queue mode: the side effect is the deliverable ------------------------
  const published = await publishTask({ task: `${options.task}\n\n[回报时请把标记 ${marker} 原样写进 task_complete 的 result]`, source: 'doubao-dispatch' })
  process.stdout.write(`published ${published.id} -> ${resolveQueueFile()}\n`)

  // Pre-flight: a connector nobody has ever connected to cannot be called, and
  // the client will still answer "done". Saying so up front beats discovering it
  // after a timeout.
  const clients = await readClientRecords()
  process.stdout.write(`${describeClients(clients)}\n`)
  if (clients.length === 0) {
    process.stdout.write(
      '警告：没有任何 MCP 客户端连接过这个连接器，客户端很可能调不到这些工具，\n' +
        '      它回复"已完成"不可信。请先在客户端里启用该连接器，本次结果以队列记录为准。\n',
    )
  }

  const instruction =
    '请通过 dsh 连接器完成任务，不要只在回复里描述：\n' +
    '1. 调用 task_claim 领取任务队列里的下一条任务；\n' +
    '2. 按领取到的任务内容执行；\n' +
    '3. 调用 task_complete，把该任务的 id 与结果写入 result；\n' +
    '4. 完成后只需回复"已回报"。'

  if (!options.noSend) {
    const sent = await runCdp(['send', instruction], 60_000)
    process.stdout.write(`${sent.stdout || sent.stderr}\n`)
  } else {
    process.stdout.write('(--no-send: 未向豆包发送指令)\n')
  }

  const deadline = Date.now() + options.timeoutMs
  let state = 'pending'
  while (Date.now() < deadline) {
    const tasks = await listTasks({ state: 'all' })
    const entry = tasks.find((candidate) => candidate.id === published.id)
    state = entry?.state ?? 'missing'
    if (state === 'done') {
      process.stdout.write(`\nVERIFIED: ${published.id} 已由 ${options.worker} 领取并完成\n`)
      process.stdout.write(`result:\n${entry.result ?? '(empty)'}\n`)
      if (!(entry.result ?? '').includes(marker)) {
        process.stdout.write(`\n注意：结果里没有出现标记 ${marker}，可能不是针对本条任务的回报。\n`)
      }
      return
    }
    await sleep(2000)
  }

  // Timed out: quote what the client *said*, and make clear it is not evidence.
  const tasks = await listTasks({ state: 'all' })
  const entry = tasks.find((candidate) => candidate.id === published.id)
  process.stdout.write(`\nUNVERIFIED after ${options.timeoutMs} ms: task ${published.id} is "${state}"\n`)
  if (entry?.worker !== undefined) process.stdout.write(`claimed by: ${entry.worker}\n`)
  process.stdout.write(`${describeClients(await readClientRecords())}\n`)
  const chat = await runCdp(['read', '1'], 30_000)
  if (chat.code === 0 && chat.stdout.length > 0) {
    process.stdout.write(`\n客户端在聊天里说的是（仅供参考，不是证据）:\n${chat.stdout}\n`)
  }
  process.stdout.write(
    '\n结论：队列没有记录到完成。客户端可能根本没有调用工具——' +
      '聊天里的"我已调用"不能算数。请检查该会话是否已启用 dsh 连接器。\n',
  )
  process.exitCode = 2
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`)
  process.exitCode = 1
})
