#!/usr/bin/env node
/**
 * Hermetic test for the promise `dispatch.mjs` exists to keep: a task counts as
 * dispatched only when the QUEUE records the completion, never because the chat
 * client said it did.
 *
 * Neither direction needs Doubao or CDP:
 *   - success: a scripted worker claims and completes the task
 *   - failure: nobody claims it, which is exactly the measured Doubao behaviour
 *     ("I called task_claim" while the task stayed pending)
 *
 * `--no-send` keeps the dispatcher away from the chat; the failure path only
 * tries CDP to quote the reply, and tolerates it being unreachable.
 *
 * Usage: node dispatch-selftest.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claimTask, completeTask, listTasks } from '../dsh-mcp-connector/queue.mjs'
import { buildQueueInstruction } from './dispatch.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DISPATCH = join(HERE, 'dispatch.mjs')
const STATUS = join(HERE, 'status.mjs')

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail.length > 0 ? `\n      ${detail}` : ''}\n`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const firstLine = (text) => text.trim().split('\n').filter((line) => line.length > 0)[0] ?? ''

/** 跑 status.mjs（脚本化 worker 用它来「照契约回报」）。 */
function runStatus(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [STATUS, ...args], {
      cwd: HERE,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.on('close', (code) => resolve({ code, stdout: stdout.trim() }))
  })
}

/** Start the dispatcher and expose a promise for its exit. */
function startDispatch(args, env) {
  const child = spawn(process.execPath, [DISPATCH, ...args], {
    cwd: HERE,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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
  const done = new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
  return { child, done }
}

async function successPath(env) {
  process.stdout.write('\n[1] success: a scripted worker claims and completes the task\n')
  const run = startDispatch(['密封任务：派发器必须等到队列记录完成', '--queue', '--no-send', '--timeout', '30000'], env)

  let pending
  for (let attempt = 0; attempt < 40 && pending === undefined; attempt += 1) {
    await sleep(250)
    const tasks = await listTasks({ state: 'pending' }, env)
    pending = tasks[0]
  }
  check('the dispatcher published the task', pending !== undefined)
  if (pending === undefined) {
    run.child.kill()
    await run.done
    return
  }

  const marker = /DISPATCH-[0-9a-f]+/.exec(pending.task)?.[0] ?? ''
  check('the published task carries a verification marker', marker.length > 0, marker)

  const claimed = await claimTask({ worker: 'scripted-worker' }, env)
  check('a worker can claim the published task', claimed.claimed === true && claimed.id === pending.id, claimed.id)

  // 契约要求先报「工作开始」。脚本化 worker 照做，派发器应当把它实时打出来。
  await runStatus(['start', '--job', marker, '--message', '脚本化 worker 开工'], env)
  await completeTask({ id: pending.id, status: 'ok', result: `${marker} done by the scripted worker` }, env)
  await runStatus(['done', '--job', marker, '--message', '脚本化 worker 收工'], env)

  const result = await run.done
  check('the dispatcher exits 0 once the queue records completion', result.code === 0, `exit=${result.code}`)
  check('it reports VERIFIED', result.stdout.includes('VERIFIED'), firstLine(result.stdout))
  check('it quotes the recorded result', result.stdout.includes(marker))
  check(
    'it warns before sending when no client has ever connected',
    result.stdout.includes('警告：没有任何 MCP 客户端连接过'),
    result.stdout.trim().split('\n')[1],
  )
  check(
    'it prints the status transitions it observed',
    result.stdout.includes('[状态] 工作开始') && result.stdout.includes('[状态] 工作结束'),
    result.stdout.split('\n').filter((line) => line.includes('[状态]')).join(' | '),
  )
  check(
    'a task that did report started is not flagged',
    !result.stdout.includes('没有 started 事件'),
  )
}

/** 队列说完成了、但状态契约没被执行 —— 派发器必须点出来。 */
async function statuslessSuccessPath(scratch) {
  process.stdout.write('\n[1b] success without status events: the contract was ignored\n')
  const env = { DSH_QUEUE_FILE: join(scratch, 'statusless', 'tasks.jsonl') }
  const run = startDispatch(['不报状态的任务', '--queue', '--no-send', '--timeout', '30000'], env)

  let pending
  for (let attempt = 0; attempt < 40 && pending === undefined; attempt += 1) {
    await sleep(250)
    pending = (await listTasks({ state: 'pending' }, env))[0]
  }
  check('the statusless case published its task', pending !== undefined)
  if (pending === undefined) {
    run.child.kill()
    await run.done
    return
  }
  const marker = /DISPATCH-[0-9a-f]+/.exec(pending.task)?.[0] ?? ''
  await claimTask({ worker: 'lazy-worker' }, env)
  await completeTask({ id: pending.id, status: 'ok', result: `${marker} 没报状态` }, env)

  const result = await run.done
  check(
    'completion without a started event is called out',
    result.stdout.includes('没有 started 事件'),
    result.stdout.split('\n').filter((line) => line.includes('注意')).join(' | '),
  )
}

async function failurePath(env) {
  process.stdout.write('\n[2] failure: nobody claims the task (the measured Doubao behaviour)\n')
  const run = startDispatch(['这条任务不会被任何 worker 领取', '--queue', '--no-send', '--timeout', '2500'], env)
  const result = await run.done

  check('the dispatcher exits 2 when the queue never records completion', result.code === 2, `exit=${result.code}`)
  check('it reports UNVERIFIED', result.stdout.includes('UNVERIFIED'), firstLine(result.stdout))
  check(
    'it states that the chat reply is not evidence',
    result.stdout.includes('不能算数'),
    result.stdout.trim().split('\n').slice(-1)[0],
  )

  const tasks = await listTasks({ state: 'all' }, env)
  check(
    'the task is genuinely still pending',
    tasks.length === 1 && tasks[0].state === 'pending',
    JSON.stringify(tasks.map((task) => task.state)),
  )
  check(
    'the timeout report states the connector client record',
    result.stdout.includes('连接器记录到的客户端：无'),
    result.stdout.trim().split('\n').slice(-2)[0],
  )
}

/**
 * When the connector has recorded a client, the warning must not fire: the
 * pre-flight line is a diagnosis, not decoration.
 */
async function preflightWithClient(scratch) {
  process.stdout.write('\n[3] pre-flight: a recorded client suppresses the warning\n')
  const queueFile = join(scratch, 'with-client', 'tasks.jsonl')
  const env = { DSH_QUEUE_FILE: queueFile }
  await mkdir(join(scratch, 'with-client'), { recursive: true })
  await writeFile(
    join(scratch, 'with-client', 'clients.json'),
    `${JSON.stringify({
      clients: [
        {
          name: 'kimi-code',
          version: '1.2.3',
          transport: 'stdio',
          protocolVersion: '2025-06-18',
          firstSeenAt: Date.now(),
          lastSeenAt: Date.now(),
          initializations: 2,
        },
      ],
    })}\n`,
    'utf8',
  )

  const run = startDispatch(['这条任务不会被领取', '--queue', '--no-send', '--timeout', '2000'], env)
  const result = await run.done

  check('the pre-flight line names the recorded client', result.stdout.includes('kimi-code@1.2.3'), firstLine(result.stdout))
  check(
    'no "never connected" warning when a client is on record',
    !result.stdout.includes('没有任何 MCP 客户端连接过'),
  )
  check('it still refuses to claim success', result.code === 2 && result.stdout.includes('UNVERIFIED'), `exit=${result.code}`)
}

async function main() {
  process.stdout.write(`doubao-dispatch selftest (node ${process.version}, platform ${process.platform})\n`)

  const scratch = mkdtempSync(join(tmpdir(), 'dispatch-selftest-'))
  try {
    // 入队指令必须同时带上「走队列」和「状态回报契约」，否则豆包不会报状态。
    const instruction = buildQueueInstruction('DISPATCH-ab12cd')
    check('the queue instruction still asks for task_claim + task_complete', instruction.includes('task_claim') && instruction.includes('task_complete'))
    check(
      'and it carries the status contract with this job id',
      instruction.includes('status.mjs') &&
        instruction.includes('DISPATCH-ab12cd') &&
        ['start --job', 'done --job', 'fail --job', 'need-input --job', 'progress --job'].every((part) => instruction.includes(part)),
    )
    check(
      'the contract says a prose reply is not enough',
      instruction.includes('不算数') && instruction.includes('动手之前'),
    )

    await successPath({ DSH_QUEUE_FILE: join(scratch, 'success', 'tasks.jsonl') })
    await statuslessSuccessPath(scratch)
    await failurePath({ DSH_QUEUE_FILE: join(scratch, 'failure', 'tasks.jsonl') })
    await preflightWithClient(scratch)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
