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
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claimTask, completeTask, listTasks } from '../dsh-mcp-connector/queue.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DISPATCH = join(HERE, 'dispatch.mjs')

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail.length > 0 ? `\n      ${detail}` : ''}\n`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const firstLine = (text) => text.trim().split('\n').filter((line) => line.length > 0)[0] ?? ''

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
  await completeTask({ id: pending.id, status: 'ok', result: `${marker} done by the scripted worker` }, env)

  const result = await run.done
  check('the dispatcher exits 0 once the queue records completion', result.code === 0, `exit=${result.code}`)
  check('it reports VERIFIED', result.stdout.includes('VERIFIED'), firstLine(result.stdout))
  check('it quotes the recorded result', result.stdout.includes(marker))
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
}

async function main() {
  process.stdout.write(`doubao-dispatch selftest (node ${process.version}, platform ${process.platform})\n`)

  const scratch = mkdtempSync(join(tmpdir(), 'dispatch-selftest-'))
  try {
    await successPath({ DSH_QUEUE_FILE: join(scratch, 'success', 'tasks.jsonl') })
    await failurePath({ DSH_QUEUE_FILE: join(scratch, 'failure', 'tasks.jsonl') })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
