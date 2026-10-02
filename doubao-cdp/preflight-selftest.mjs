#!/usr/bin/env node
/**
 * Hermetic test for the Doubao startup confirmation (`doubao.mjs`, wired into
 * `cdp.mjs` and `dispatch.mjs`).
 *
 * All four states are reproducible without Doubao, because the confirmation
 * only speaks CDP-over-HTTP: a closed port, an open port answering /json/* with
 * no matching page, an open port with a matching page, and the escape hatch.
 *
 * Usage: node preflight-selftest.mjs
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CDP = join(HERE, 'cdp.mjs')
const DISPATCH = join(HERE, 'dispatch.mjs')

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail.length > 0 ? `\n      ${detail}` : ''}\n`)
}

function runCli(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
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
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** A port nobody is listening on: bind, note the number, release. */
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** A stand-in CDP endpoint describing the pages we want it to report. */
function fakeCdp(port, pages) {
  const server = createServer((request, response) => {
    if (request.url.startsWith('/json/version')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ Browser: 'FakeCDP/1.0' }))
      return
    }
    if (request.url.startsWith('/json/list')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(pages))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{}')
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

const CHAT_PAGE = [{ type: 'page', title: '豆包', url: 'doubao://doubao-chat/chat?viewId=1', webSocketDebuggerUrl: 'ws://127.0.0.1/1' }]
const LAUNCHER_ONLY = [{ type: 'page', title: '豆包', url: 'doubao://doubao-launcher/chat', webSocketDebuggerUrl: 'ws://127.0.0.1/2' }]

async function main() {
  process.stdout.write(`doubao-preflight selftest (node ${process.version}, platform ${process.platform})\n`)
  const scratch = mkdtempSync(join(tmpdir(), 'preflight-selftest-'))

  try {
    // --- state 1: nothing listening -----------------------------------------
    const closed = await freePort()
    const down = await runCli(CDP, ['doctor'], { DOUBAO_CDP_PORT: String(closed) })
    check('a closed port makes doctor exit with the preflight code', down.code === 3, `exit=${down.code}`)
    check(
      'the report names the port it probed',
      down.stdout.includes(`127.0.0.1:${closed}`),
      down.stdout.split('\n')[1],
    )
    check(
      'the report explains how to restart Doubao with the debug flag',
      down.stdout.includes('--remote-debugging-port') && down.stdout.includes('退出豆包'),
    )
    check('the report warns about the widened trust boundary', down.stdout.includes('本机任意进程都能接管你的豆包'))

    check(
      'a normal command is gated too, not just doctor',
      (await runCli(CDP, ['targets'], { DOUBAO_CDP_PORT: String(closed) })).code === 3,
    )
    const bypass = await runCli(CDP, ['targets', '--no-preflight'], { DOUBAO_CDP_PORT: String(closed) })
    check(
      '--no-preflight bypasses the gate and returns the raw failure',
      bypass.code === 1 && bypass.stderr.includes('fetch failed'),
      `exit=${bypass.code} ${bypass.stderr.trim()}`,
    )

    // --- state 2: port open, no matching page --------------------------------
    const noMatchPort = await freePort()
    const noMatchServer = await fakeCdp(noMatchPort, LAUNCHER_ONLY)
    try {
      const noMatch = await runCli(CDP, ['doctor'], { DOUBAO_CDP_PORT: String(noMatchPort) })
      check('an open port without a chat page is not "ready"', noMatch.code === 3, `exit=${noMatch.code}`)
      check('the report distinguishes this third state', noMatch.stdout.includes('端口是通的'), noMatch.stdout.split('\n').filter((l) => l.includes('✗'))[0])
    } finally {
      noMatchServer.close()
    }

    // --- state 3: port open with the expected page ---------------------------
    const readyPort = await freePort()
    const readyServer = await fakeCdp(readyPort, CHAT_PAGE)
    try {
      // The fake endpoint cannot serve a CDP websocket, so the DOM read fails
      // and the mode stays unknown: fail-closed must refuse (exit 8).
      const unknownMode = await runCli(CDP, ['doctor'], { DOUBAO_CDP_PORT: String(readyPort) })
      check('a reachable app whose mode cannot be read is "unknown", not ready', unknownMode.code === 8, `exit=${unknownMode.code}`)
      check('and it says it could not identify rather than "not ready"', unknownMode.stdout.includes('无法识别，拒绝发送'), unknownMode.stdout.split('\n').filter((l) => l.includes('?')).join(''))
      check('the page is still counted in the report', unknownMode.stdout.includes('1 个匹配'), unknownMode.stdout.split('\n').find((l) => l.includes('连通性')))

      // Work mode: everything satisfied → send is allowed.
      const ready = await runCli(CDP, ['doctor', '--mode', 'work'], { DOUBAO_CDP_PORT: String(readyPort) })
      check('work mode with everything satisfied exits 0', ready.code === 0, `exit=${ready.code}`)
      check('and the report says it may send', ready.stdout.includes('✓ 可以发送'), ready.stdout.split('\n').filter((l) => l.includes('✓'))[0])
      check('every dimension is reported', ['连通性', '模式', '命令能力', '忙闲', '通道'].every((label) => ready.stdout.includes(label)))

      // Chat mode has no shell → status reporting is impossible → refuse.
      const chat = await runCli(CDP, ['doctor', '--mode', 'chat'], { DOUBAO_CDP_PORT: String(readyPort) })
      check('chat mode is refused because it has no shell', chat.code === 3 && chat.stdout.includes('没有 shell'), `exit=${chat.code}`)

      // --force proceeds and leaves an override record.
      const forceQueue = join(scratch, 'force')
      const forced = await runCli(CDP, ['targets', '--force'], {
        DOUBAO_CDP_PORT: String(readyPort),
        DSH_QUEUE_FILE: join(forceQueue, 'tasks.jsonl'),
      })
      check('--force proceeds past the gate', forced.code === 0 && forced.stdout.includes('page'), `exit=${forced.code}`)
      check('and it warns instead of silently ignoring the verdict', forced.stderr.includes('--force 跳过调用前识别'), forced.stderr.split('\n')[0])
      const overrideFile = join(forceQueue, 'status.jsonl')
      check(
        'a forced run leaves an override record',
        existsSync(overrideFile) && readFileSync(overrideFile, 'utf8').includes('"type":"override"'),
        overrideFile,
      )

      // A job that started and never finished makes the app "busy".
      const busyQueue = join(scratch, 'busy')
      mkdirSync(busyQueue, { recursive: true })
      writeFileSync(
        join(busyQueue, 'status.jsonl'),
        `${JSON.stringify({ v: 1, type: 'status', job: 'JOB-BUSY', state: 'started', at: Date.now() })}\n`,
        'utf8',
      )
      const busy = await runCli(CDP, ['doctor', '--mode', 'work'], {
        DOUBAO_CDP_PORT: String(readyPort),
        DSH_QUEUE_FILE: join(busyQueue, 'tasks.jsonl'),
      })
      check('an unfinished job makes the app busy and refuses', busy.code === 3 && busy.stdout.includes('JOB-BUSY'), `exit=${busy.code}`)
      check('the busy report names the job', busy.stdout.includes('有未结束的任务在跑'), busy.stdout.split('\n').find((l) => l.includes('忙闲')))
    } finally {
      readyServer.close()
    }

    // --- dispatcher integration ---------------------------------------------
    const queueFile = join(scratch, 'gated', 'tasks.jsonl')
    const gated = await runCli(DISPATCH, ['任务', '--queue'], {
      DOUBAO_CDP_PORT: String(closed),
      DSH_QUEUE_FILE: queueFile,
    })
    check('the dispatcher refuses to dispatch when Doubao is not ready', gated.code === 3, `exit=${gated.code}`)
    check(
      'and it confirms before writing anything: no task is left behind',
      !existsSync(queueFile),
      queueFile,
    )

    const hermetic = await runCli(DISPATCH, ['任务', '--queue', '--no-send', '--timeout', '1500'], {
      DOUBAO_CDP_PORT: String(closed),
      DSH_QUEUE_FILE: join(scratch, 'hermetic', 'tasks.jsonl'),
    })
    check(
      '--no-send still needs no Doubao at all',
      hermetic.code === 2 && hermetic.stdout.includes('UNVERIFIED'),
      `exit=${hermetic.code}`,
    )
  } catch (error) {
    check('the preflight selftest completed', false, String(error))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
