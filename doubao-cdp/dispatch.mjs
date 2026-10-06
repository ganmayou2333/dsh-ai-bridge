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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { publishTask, listTasks, resolveQueueFile, resolveQueueDir } from '../dsh-mcp-connector/queue.mjs'
import { buildStatusDirective } from './status-contract.mjs'
import { foldByJob, loadConfig, readStatusEvents } from './status.mjs'

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

/**
 * 调用前五维识别（R27）。直接复用 `cdp.mjs doctor --json`，保证只有一份实现。
 * 返回 verdict / report / reasons；无法解析时按 unknown 处理（fail-closed）。
 */
async function identify() {
  const result = await runCdp(['doctor', '--json'], 45_000)
  try {
    return { ...JSON.parse(result.stdout), code: result.code }
  } catch {
    return {
      verdict: 'unknown',
      reasons: ['识别输出无法解析'],
      report: `调用前识别失败（cdp.mjs doctor 退出码 ${result.code}）\n${result.stderr || result.stdout || '(无输出)'}`,
      code: result.code,
    }
  }
}

/** 识别不过：打印报告并按三态给出退出码（0/3/8 之外：3=未就绪，8=无法识别）。 */
function refuse(pre) {
  process.stderr.write(`${pre.report ?? '(无报告)'}\n`)
  process.exitCode = pre.verdict === 'unknown' ? 8 : 3
}

/** 读某次派发最后已知的状态（超时诊断用，R12）。 */
async function lastStatus(job) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, 'status.mjs'), 'last', job], {
      cwd: HERE,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.on('close', () => resolve(stdout.trim()))
  })
}

function parseArgs(argv) {
  const options = { task: '', queue: false, noSend: false, force: false, status: false, timeoutMs: 300_000, worker: 'doubao' }
  const words = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--queue') options.queue = true
    else if (arg === '--no-send') options.noSend = true
    else if (arg === '--force') options.force = true
    else if (arg === '--status') options.status = true
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
  const cdpFlags = options.force ? ['--force'] : []

  // 调用前五维识别（R27）：识别不过就不发，且不产生任何副作用。
  // --no-send 是密封模式，本来就不碰豆包，所以跳过识别。
  const needsDoubao = !options.noSend
  if (needsDoubao) {
    const pre = await identify()
    if (pre.verdict !== 'ready') {
      if (!options.force) {
        refuse(pre)
        return
      }
      process.stderr.write(`warning: --force 跳过调用前识别（${pre.verdict}）：${(pre.reasons ?? []).join('；')}\n`)
    }
  }

  // ---- chat mode: the reply is the deliverable -------------------------------
  if (!options.queue) {
    // --status 时把状态契约一起发过去（默认不发：聊天模式是「问一句答一句」的语义）
    const prompt = options.status ? `${options.task}\n\n${buildStatusDirective({ job: marker })}` : options.task
    const sent = await runCdp(['send', prompt, ...cdpFlags], 60_000)
    if (sent.code !== 0) {
      process.stderr.write(`send failed: ${sent.stderr || sent.stdout}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`${sent.stdout}\n`)
    const reply = await runCdp(['wait', String(options.timeoutMs), ...cdpFlags], options.timeoutMs + 30_000)
    if (reply.code !== 0) {
      process.stderr.write(`no settled reply: ${reply.stdout || reply.stderr}\n`)
      process.exitCode = 2
      return
    }
    process.stdout.write(`${reply.stdout}\n`)
    if (options.status) {
      // 契约是否真的被执行：读文件，不信回复。
      const entry = foldByJob(await readStatusEvents(loadConfig().statusFile)).get(marker)
      if (entry === undefined) {
        process.stderr.write(`注意：--status 要求了状态回报，但状态文件里没有 ${marker} 的任何事件——它很可能没执行。\n`)
      } else {
        process.stdout.write(`状态时间线（${marker}）：${entry.events.map((event) => event.state).join(' → ')}\n`)
      }
    }
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
    // 状态回报契约与 skill 里的模板同一份措辞（buildQueueInstruction 里拼装）
    buildQueueInstruction(marker)

  if (!options.noSend) {
    const sent = await runCdp(['send', instruction], 60_000)
    process.stdout.write(`${sent.stdout || sent.stderr}\n`)
  } else {
    process.stdout.write('(--no-send: 未向豆包发送指令)\n')
  }

  // 等待期间把状态变化实时打出来——「它到底开始干了没有」不用等超时才知道。
  const statusFile = loadConfig().statusFile
  let printedEvents = 0
  const drainStatus = async () => {
    const entry = foldByJob(await readStatusEvents(statusFile)).get(marker)
    if (entry === undefined) return undefined
    for (const event of entry.events.slice(printedEvents)) {
      const label = { started: '工作开始', progress: '进度', need_input: '需要确认', done: '工作结束', failed: '工作失败' }[event.state] ?? event.state
      const extra = [
        Number.isFinite(event.percent) ? `${event.percent}%` : '',
        typeof event.step === 'string' ? event.step : '',
        typeof event.message === 'string' ? event.message : '',
      ].filter((part) => part.length > 0)
      process.stdout.write(`  [状态] ${label}${extra.length > 0 ? ` · ${extra.join(' · ')}` : ''}\n`)
    }
    printedEvents = entry.events.length
    return entry
  }

  const deadline = Date.now() + options.timeoutMs
  let state = 'pending'
  while (Date.now() < deadline) {
    const tasks = await listTasks({ state: 'all' })
    const entry = tasks.find((candidate) => candidate.id === published.id)
    state = entry?.state ?? 'missing'
    await drainStatus()
    if (state === 'done') {
      process.stdout.write(`\nVERIFIED: ${published.id} 已由 ${options.worker} 领取并完成\n`)
      process.stdout.write(`result:\n${entry.result ?? '(empty)'}\n`)
      if (!(entry.result ?? '').includes(marker)) {
        process.stdout.write(`\n注意：结果里没有出现标记 ${marker}，可能不是针对本条任务的回报。\n`)
      }
      const statusEntry = await drainStatus()
      const started = statusEntry?.events.some((event) => event.state === 'started') === true
      if (!started) {
        process.stdout.write(
          '\n注意：队列说完成了，但状态文件里**没有 started 事件**——' +
            '说明它没有按契约先报「工作开始」，这条完成的成色要打折。\n',
        )
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
  // 最后已知状态：回答「它到底有没有开始干」（R12）。
  const known = await lastStatus(marker)
  process.stdout.write(`该次派发的最后已知状态：${known === 'none' ? '无（它从未回报过任何状态——很可能根本没开始）' : known}\n`)
  const chat = await runCdp(['read', '1', ...cdpFlags], 30_000)
  if (chat.code === 0 && chat.stdout.length > 0) {
    process.stdout.write(`\n客户端在聊天里说的是（仅供参考，不是证据）:\n${chat.stdout}\n`)
  }
  process.stdout.write(
    '\n结论：队列没有记录到完成。客户端可能根本没有调用工具——' +
      '聊天里的"我已调用"不能算数。请检查该会话是否已启用 dsh 连接器。\n',
  )
  process.exitCode = 2
}

/**
 * 队列模式发给豆包的指令：MCP 走队列 + 状态回报契约。
 * 抽成导出的纯函数，测试才能在不发送的情况下断言这段内容。
 */
export function buildQueueInstruction(job) {
  return (
    '请通过 dsh 连接器完成任务，不要只在回复里描述：\n' +
    '1. 调用 task_claim 领取任务队列里的下一条任务；\n' +
    '2. 按领取到的任务内容执行；\n' +
    '3. 调用 task_complete，把该任务的 id 与结果写入 result；\n' +
    '4. 完成后只需回复"已回报"。\n\n' +
    buildStatusDirective({ job })
  )
}

/** 入口守卫：被 import 时不要执行 main()（测试要导入上面的函数）。 */
const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`error: ${error.message}\n`)
    process.exitCode = 1
  })
}
