#!/usr/bin/env node
/**
 * doubao-cdp — drive the Doubao desktop app (Electron) over the Chrome DevTools
 * Protocol, to dispatch a task into its chat UI from outside.
 *
 * Requires Doubao to be running with:
 *   Doubao.exe --remote-debugging-port=9222 --remote-allow-origins=*
 *
 * Zero dependencies: Node's global WebSocket talks to CDP directly.
 *
 * Usage:
 *   node cdp.mjs doctor                     # 确认豆包是否可被驱动（不连也行）
 *   node cdp.mjs targets
 *   node cdp.mjs probe                      # find the chat input candidates
 *   node cdp.mjs send "任务文本"            # focus input, insert text, click send
 *   node cdp.mjs wait [timeoutMs]           # block until a new reply lands, print it
 *   node cdp.mjs read [n]                   # read the last n messages
 *   node cdp.mjs click <x> <y>
 *   node cdp.mjs key <key> [--ctrl] [--shift] [--alt] [--meta]
 *   node cdp.mjs eval "<expression>"
 *
 * Every command except `doctor` first runs the startup confirmation; add
 * --no-preflight to bypass it (then a closed port reports only "fetch failed").
 * Exit codes: 0 ok, 1 error, 2 wait timed out, 3 Doubao not ready.
 */

import { setTimeout as sleep } from 'node:timers/promises'
import {
  CDP_MATCH,
  CDP_PORT,
  PREFLIGHT_EXIT_CODE,
  formatDoubaoReport,
  inspectDoubao,
} from './doubao.mjs'

const PORT = CDP_PORT
const MATCH = CDP_MATCH

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return response.json()
}

async function pickTarget() {
  const targets = await listTargets()
  const page = targets.find((t) => t.type === 'page' && t.url.includes(MATCH))
  if (page === undefined) {
    throw new Error(`no page target matching "${MATCH}" on port ${PORT}`)
  }
  return page
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error(`cannot open CDP websocket at ${url}`))
    })
    const client = new Cdp(socket)
    socket.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      const entry = client.pending.get(message.id)
      if (entry === undefined) return
      client.pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    }
    return client
  }

  send(method, params = {}) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`page exception: ${detail}`)
    }
    return result.result.value
  }

  close() {
    this.socket.close()
  }
}

const PROBE_INPUT = `(() => {
  const nodes = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]')];
  return JSON.stringify(nodes.map((el, index) => ({
    index,
    tag: el.tagName,
    cls: String(el.className || '').slice(0, 140),
    placeholder: el.getAttribute('placeholder'),
    role: el.getAttribute('role'),
    contenteditable: el.getAttribute('contenteditable'),
    visible: Boolean(el.offsetWidth || el.offsetHeight),
    text: String(el.innerText || el.value || '').slice(0, 60),
  })), null, 2);
})()`

/** Focus the largest visible editable node — the chat composer. */
const FOCUS_INPUT = `(() => {
  const nodes = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
    .filter((el) => el.offsetWidth || el.offsetHeight);
  if (nodes.length === 0) return 'NO_INPUT';
  nodes.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
  const el = nodes[0];
  el.focus();
  el.click();
  return el.tagName + '|' + String(el.className || '').slice(0, 80);
})()`

/** The composer's current text, used to confirm a submission actually left it. */
const COMPOSER_TEXT = `(() => {
  const nodes = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
    .filter((el) => el.offsetWidth || el.offsetHeight);
  if (nodes.length === 0) return 'NO_INPUT';
  nodes.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
  return (nodes[0].innerText || '').trim();
})()`

const READ_MESSAGES = (count) => `(() => {
  const nodes = [...document.querySelectorAll('[data-testid="union_message"]')];
  const messages = nodes.map((el) => {
    const isUser = el.querySelector('[data-testid="send_message"]') !== null;
    const body = el.querySelector('[data-testid="message_text_content"]');
    return {
      role: isUser ? 'user' : 'assistant',
      text: String(body ? body.innerText : el.innerText || '').trim(),
    };
  }).filter((message) => message.text.length > 0);
  return JSON.stringify(messages.slice(-${count}));
})()`

/** Locate the send button and return its centre in CSS pixels. */
const FIND_SEND_BUTTON = `(() => {
  const candidates = [
    document.querySelector('.send-btn-wrapper'),
    ...document.querySelectorAll('button,[role="button"]'),
  ].filter(Boolean);
  for (const el of candidates) {
    const label = String(el.getAttribute('aria-label') || '') + String(el.className || '');
    if (!/send-btn|发送|send/i.test(label)) continue;
    const rect = el.getBoundingClientRect();
    if (!(rect.width || rect.height)) continue;
    return JSON.stringify({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
  }
  return null;
})()`

const COUNT_ASSISTANT = `document.querySelectorAll('[data-testid="receive_message"]').length`
const COUNT_USER = `document.querySelectorAll('[data-testid="send_message"]').length`

/**
 * Texts Doubao parks in the assistant slot while it is still working. These are
 * stable, so the "text stopped changing" heuristic would otherwise accept one
 * as the final answer — which is how a work-mode dispatch once reported
 * "正在思考" as a successful reply.
 */
const PLACEHOLDER = /^(正在思考|思考中|正在生成|正在分析|正在执行|正在处理|正在搜索|加载中|Thinking|Loading)/

/**
 * 'answered' when the conversation ends with an assistant message, 'awaiting'
 * when the last message is still the user's. Defined this way instead of
 * "count increased" because the reply often lands while `send` is still
 * confirming the submission.
 */
const TURN_STATE = `(() => {
  const nodes = [...document.querySelectorAll('[data-testid="union_message"]')];
  if (nodes.length === 0) return 'empty';
  const last = nodes[nodes.length - 1];
  return last.querySelector('[data-testid="send_message"]') ? 'awaiting' : 'answered';
})()`

const LAST_ASSISTANT = `(() => {
  const nodes = [...document.querySelectorAll('[data-testid="receive_message"]')];
  if (nodes.length === 0) return '';
  const body = nodes[nodes.length - 1].querySelector('[data-testid="message_text_content"]');
  return String(body ? body.innerText : nodes[nodes.length - 1].innerText).trim();
})()`

async function clickAt(client, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    await sleep(80)
  }
}

async function main() {
  // --no-preflight is stripped anywhere in argv so it never reaches a command.
  const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--no-preflight')
  const noPreflight = rawArgs.length !== process.argv.slice(2).length
  const [command, ...rest] = rawArgs

  // Confirm Doubao is actually drivable before doing anything else. Without
  // this the only failure signal is "error: fetch failed", which says nothing
  // about whether the app is closed, running without the debug flag, or simply
  // showing a different view.
  if (command === 'doctor') {
    const state = await inspectDoubao({ port: PORT, match: MATCH })
    process.stdout.write(`${formatDoubaoReport(state)}\n`)
    process.exitCode = state.ready ? 0 : PREFLIGHT_EXIT_CODE
    return
  }
  if (!noPreflight) {
    const state = await inspectDoubao({ port: PORT, match: MATCH })
    if (!state.ready) {
      process.stderr.write(`${formatDoubaoReport(state)}\n`)
      process.exitCode = PREFLIGHT_EXIT_CODE
      return
    }
  }

  if (command === 'targets') {
    const targets = await listTargets()
    for (const target of targets) {
      process.stdout.write(`[${target.type}] ${target.title}\n    ${target.url}\n`)
    }
    return
  }

  const target = await pickTarget()
  const client = await Cdp.connect(target.webSocketDebuggerUrl)
  await client.send('Runtime.enable')

  try {
    if (command === 'probe') {
      process.stdout.write(`${await client.evaluate(PROBE_INPUT)}\n`)
    } else if (command === 'eval') {
      process.stdout.write(`${JSON.stringify(await client.evaluate(rest.join(' ')), null, 2)}\n`)
    } else if (command === 'send') {
      const text = rest.join(' ')
      if (text.trim().length === 0) throw new Error('send needs text')
      const before = await client.evaluate(COUNT_USER)
      const focused = await client.evaluate(FOCUS_INPUT)
      if (focused === 'NO_INPUT') throw new Error('no visible editable element found in the chat page')
      await client.send('Input.insertText', { text })
      await sleep(400)

      // Enter does not submit in the ProseMirror composer; the send button does.
      const button = await client.evaluate(FIND_SEND_BUTTON)
      if (button !== null) {
        const { x, y } = JSON.parse(button)
        await clickAt(client, x, y)
      } else {
        for (const type of ['keyDown', 'keyUp']) {
          await client.send('Input.dispatchKeyEvent', {
            type,
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          })
        }
      }

      // Confirm the message actually left the composer instead of trusting the
      // click. Counting user-message elements is not enough on its own: work
      // mode renders the newest message differently, so the count can lag even
      // though the text was submitted. An empty composer is the real invariant.
      let submitted = false
      let lastComposer = ''
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await sleep(500)
        const counted = (await client.evaluate(COUNT_USER)) > before
        lastComposer = await client.evaluate(COMPOSER_TEXT)
        if (counted || lastComposer.trim().length === 0) {
          submitted = true
          break
        }
      }
      if (!submitted) {
        throw new Error(`message was not submitted (composer still holds: ${JSON.stringify(lastComposer.slice(0, 40))})`)
      }
      process.stdout.write(`sent via ${button !== null ? 'send button' : 'Enter'}: ${text.slice(0, 60)}\n`)
    } else if (command === 'wait') {
      const timeoutMs = Number(rest[0] ?? 120000)
      const deadline = Date.now() + timeoutMs

      // Phase 1: the conversation must end with an assistant message.
      while (Date.now() < deadline) {
        if ((await client.evaluate(TURN_STATE)) === 'answered') break
        await sleep(1000)
      }
      if ((await client.evaluate(TURN_STATE)) !== 'answered') {
        process.stdout.write(`still awaiting a reply after ${timeoutMs} ms\n`)
        process.exitCode = 2
        return
      }

      // Phase 2: wait for the text to stop changing, so a streaming reply is
      // not reported half-finished. A thinking placeholder is stable too, so it
      // must never count as the answer — work mode parks "正在思考" in the
      // assistant slot while the real reply is still being produced.
      let previous = ''
      let stableReads = 0
      let placeholderSeen = false
      while (Date.now() < deadline) {
        const current = await client.evaluate(LAST_ASSISTANT)
        if (PLACEHOLDER.test(current.trim())) {
          placeholderSeen = true
          previous = current
          stableReads = 0
          await sleep(1500)
          continue
        }
        if (current.length > 0 && current === previous) {
          stableReads += 1
          if (stableReads >= 2) {
            if (placeholderSeen) process.stderr.write('(a thinking placeholder was skipped; waited for the real reply)\n')
            process.stdout.write(`${current}\n`)
            return
          }
        } else {
          stableReads = 0
        }
        previous = current
        await sleep(1500)
      }
      process.stdout.write(`reply did not settle within ${timeoutMs} ms; last text:\n${previous}\n`)
      process.exitCode = 2
    } else if (command === 'key') {
      // Native key events. Synthetic KeyboardEvent dispatched from page JS is
      // ignored by the app's shortcut handler, so this goes through CDP input.
      const keyName = rest[0]
      if (keyName === undefined) throw new Error('key needs a key name, e.g. key Escape --ctrl --shift')
      const flags = new Set(rest.slice(1))
      const modifiers =
        (flags.has('--alt') ? 1 : 0) |
        (flags.has('--ctrl') ? 2 : 0) |
        (flags.has('--meta') ? 4 : 0) |
        (flags.has('--shift') ? 8 : 0)
      const isLetter = keyName.length === 1
      const code = isLetter ? `Key${keyName.toUpperCase()}` : keyName
      const virtualKey = isLetter ? keyName.toUpperCase().charCodeAt(0) : keyName === 'Escape' ? 27 : 0
      for (const type of ['keyDown', 'keyUp']) {
        await client.send('Input.dispatchKeyEvent', {
          type,
          modifiers,
          key: isLetter && flags.has('--shift') ? keyName.toUpperCase() : keyName,
          code,
          windowsVirtualKeyCode: virtualKey,
          nativeVirtualKeyCode: virtualKey,
        })
        await sleep(80)
      }
      process.stdout.write(`key ${keyName} modifiers=${modifiers}\n`)
    } else if (command === 'click') {
      const x = Number(rest[0])
      const y = Number(rest[1])
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('click needs x y')
      for (const type of ['mousePressed', 'mouseReleased']) {
        await client.send('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: 'left',
          clickCount: 1,
        })
        await sleep(80)
      }
      process.stdout.write(`clicked ${x},${y}\n`)
    } else if (command === 'read') {
      const count = Number(rest[0] ?? 6)
      const messages = JSON.parse(await client.evaluate(READ_MESSAGES(count)))
      for (const message of messages) {
        process.stdout.write(`--- ${message.role} ---\n${message.text}\n`)
      }
      process.stdout.write(`(${messages.length} message(s))\n`)
    } else {
      process.stdout.write('usage: targets | probe | send <text> | read [n] | eval <js>\n')
    }
  } finally {
    client.close()
  }
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`)
  process.exit(1)
})
