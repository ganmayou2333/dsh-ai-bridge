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
 *   node cdp.mjs state [--json]             # 只读快照：当前模式 + 当前模型（给面板用）
 *   node cdp.mjs mode <work|chat> [--json]  # 切换模式（写操作：点豆包 UI，点完用只读读数复核）
 *   node cdp.mjs quota [--json]             # 只读采样：额度用量 % + 重置次数 + 套餐（要点开账户菜单）
 *   node cdp.mjs models [--json]            # 只读采样：可选模型清单 + 当前项 + 状态标注（要点开模型菜单）
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
 *
 * Every command also runs the pre-call identification (five dimensions:
 * connectivity / mode / command capability / busy-idle / status channel).
 * ready → proceed; not-ready or unknown → refuse (exit 3 / 8). --force proceeds
 * anyway and leaves an override record. --mode <chat|work|unknown> skips the
 * DOM read (diagnostics and tests).
 *
 * Exit codes: 0 ok, 1 error, 2 wait timed out, 3 not ready, 4 disabled,
 *             5 unknown job, 6 a job is still open, 8 cannot identify.
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
import { resolveQueueDir } from '../dsh-mcp-connector/queue.mjs'
import {
  CDP_MATCH,
  CDP_PORT,
  PRECHECK_EXIT,
  PREFLIGHT_EXIT_CODE,
  commandCapability,
  formatDoubaoReport,
  formatPreCallReport,
  inspectDoubao,
  inspectPreCall,
  mapModeText,
  probeDebugPort,
  splitModelText,
} from './doubao.mjs'
import { loadConfig, recordOverride } from './status.mjs'

const PORT = CDP_PORT
const MATCH = CDP_MATCH

/** 输入框左侧的模式控件文字（对话 / 本地电脑 / …）。 */
const MODE_TEXT = `(() => {
  const el = document.querySelector('[data-testid="chat_input_action_mode"]');
  return el ? (el.innerText || '').trim() : '';
})()`

/** 通过 CDP 读当前模式；读不到就返回 unknown，绝不猜。 */
async function readModeViaCdp() {
  try {
    const target = await pickTarget()
    const client = await Cdp.connect(target.webSocketDebuggerUrl)
    try {
      await client.send('Runtime.enable')
      return mapModeText(await client.evaluate(MODE_TEXT))
    } finally {
      client.close()
    }
  } catch (error) {
    return { id: 'unknown', raw: '', error: error.message }
  }
}

/**
 * 面板要的「豆包现在长什么样」：模式 + 模型（含档位）。
 *
 * 一次 CDP 往返同时读两处，避免面板轮询时连两次：
 *   - 模式：`[data-testid=chat_input_action_mode]`
 *   - 模型：`[data-testid=chat_input_action_model]`，其 innerText 形如
 *     `豆包 2.1 Lite低`；末尾的档位是同层一个 `text-dbx-text-tertiary` span，
 *     单独取出来交给 splitModelText 剥后缀（真机实测，见 doubao.mjs 注释）。
 * 全部只读：只 querySelector + innerText，不点任何东西、不改任何状态。
 */
const STATE_DOM = `(() => {
  const text = (el) => (el && (el.innerText || el.textContent) ? (el.innerText || el.textContent).trim() : '');
  const modeEl = document.querySelector('[data-testid=chat_input_action_mode]');
  const modelEl = document.querySelector('[data-testid=chat_input_action_model]');
  let modelFull = '';
  let modelLevel = '';
  if (modelEl) {
    modelFull = text(modelEl);
    const levelEl = modelEl.querySelector('span[class*=text-dbx-text-tertiary]') || modelEl.querySelector('span.ml-4');
    modelLevel = levelEl ? (levelEl.textContent || '').trim() : '';
  }
  return { modeText: text(modeEl), modelFull, modelLevel };
})()`

/** 通过 CDP 读模式 + 模型；连不上就返回 undefined（调用方据此判「未连接」）。 */
async function readStateViaCdp() {
  const target = await pickTarget()
  const client = await Cdp.connect(target.webSocketDebuggerUrl)
  try {
    await client.send('Runtime.enable')
    return await client.evaluate(STATE_DOM)
  } finally {
    client.close()
  }
}

/**
 * 模式读取的 30 秒缓存（决策 12）：连续派发时不用每次都连一次 CDP。
 * 只缓存**认得出来**的模式——unknown 不缓存，否则修好了还要等 30 秒才发现。
 * 连通性与忙闲每次重算（它们变化更快，缓存它们会让「忙」漏过去）。
 */
const MODE_CACHE_TTL_MS = 30_000

async function readMode({ useCache = true } = {}) {
  const file = join(resolveQueueDir(), '.precheck-cache.json')
  if (useCache) {
    try {
      const cached = JSON.parse(await readFile(file, 'utf8'))
      if ((cached.mode === 'chat' || cached.mode === 'work') && Date.now() - Number(cached.at ?? 0) < MODE_CACHE_TTL_MS) {
        return { id: cached.mode, raw: `${cached.raw ?? ''}（30 秒内缓存）`, cached: true }
      }
    } catch {
      /* 没有缓存或读坏了：直接重新读 */
    }
  }
  const mode = await readModeViaCdp()
  if (mode.id === 'chat' || mode.id === 'work') {
    await writeFile(file, `${JSON.stringify({ mode: mode.id, raw: mode.raw, at: Date.now() })}\n`, 'utf8').catch(() => {})
  }
  return mode
}

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
const PLACEHOLDER = /^(正在|思考中|加载中|Thinking|Loading)/i

/**
 * 这句是不是「正在干活」的占位？
 *
 * 真机遇到过两种：`正在思考`（对话模式）与 `正在准备任务上下文`（工作模式）。
 * 写死列表会一直漏，所以规则是：**以「正在」开头且很短**——占位句天生短；
 * 长回复里出现「正在…」是正常内容，不能误伤。
 */
export function isPlaceholder(text) {
  const value = String(text ?? '').trim()
  if (value.length === 0) return false
  if (/^(Thinking|Loading)/i.test(value)) return true
  return PLACEHOLDER.test(value) && value.length <= 24
}

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

/** 原生按键（合成 KeyboardEvent 会被应用忽略）。用来关掉误开的菜单。 */
async function pressKey(client, keyName) {
  const virtualKey = keyName === 'Escape' ? 27 : 0
  for (const type of ['keyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', {
      type,
      modifiers: 0,
      key: keyName,
      code: keyName,
      windowsVirtualKeyCode: virtualKey,
      nativeVirtualKeyCode: virtualKey,
    })
    await sleep(60)
  }
}

/** 模式控件的可点中心（不可见时返回 null）。 */
const MODE_CONTROL_RECT = `(() => {
  const el = document.querySelector('[data-testid=chat_input_action_mode]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`

/** 模型控件的可点中心（不可见时返回 null）。 */
const MODEL_CONTROL_RECT = `(() => {
  const el = document.querySelector('[data-testid=chat_input_action_model]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`

/**
 * 菜单（点开模式控件后出现的那个）里目标选项的可点中心；找不到返回 null。
 *
 * 为什么这么绕：**菜单项和控件本身都会出现「对话」这两个字**，直接按文字找会点到
 * 控件自己。所以先定位「同时包含对话与本地电脑、且不包含控件」的最小容器（真机实测
 * 是 265×198 的那个浮层），再只在它内部找行——这样不会误点页面别处的同名标签。
 */
const modeOptionRect = (target) => `(() => {
  const want = ${JSON.stringify(target)};
  const control = document.querySelector('[data-testid=chat_input_action_mode]');
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const menus = [...document.querySelectorAll('div,ul,[role=menu],[role=listbox]')]
    .filter((el) => visible(el) && el !== control && !el.contains(control))
    .map((el) => ({ el, r: el.getBoundingClientRect(), text: (el.innerText || '').trim() }))
    .filter((x) => x.text.includes('对话') && x.text.includes('本地电脑')
      && x.r.height >= 80 && x.r.height <= 520 && x.r.width >= 120 && x.r.width <= 640)
    .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height);
  if (menus.length === 0) return null;
  const pattern = want === 'work' ? /本地电脑|工作/ : /^对话$/;
  const rows = [...menus[0].el.querySelectorAll('*')]
    .filter((el) => visible(el))
    .map((el) => { const r = el.getBoundingClientRect(); return { text: (el.innerText || '').trim(), r }; })
    .filter((x) => x.text.length > 0 && x.text.length < 40 && x.r.height >= 24 && x.r.height <= 64 && pattern.test(x.text))
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
  if (rows.length === 0) return null;
  const r = rows[0].r;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: rows[0].text };
})()`

/**
 * 切换豆包的模式（本地电脑 ↔ 对话）。**这是写操作：点它自己的 UI。**
 *
 * 纪律（与派发器同一条）：一步一步来，每一步都用**只读**读数复核——
 *   1. 先读当前模式；已经是目标就返回 changed:false（幂等，不白点一次）；
 *   2. 点模式控件 → 等菜单出现（找不到目标选项就按 Escape 关掉，报失败）；
 *   3. 点目标选项 → 轮询只读模式，直到它真的等于目标。
 * **点完读数没变就是失败**，绝不因为「我点过了」就声称切好了。返回里带上
 * modeBefore / modeAfter，让调用方能看出到底发生了什么。
 */
async function switchMode(target) {
  const before = await readModeViaCdp()
  if (before.id === target) {
    return { ok: true, changed: false, modeBefore: before.id, modeAfter: before.id }
  }
  const page = await pickTarget()
  const client = await Cdp.connect(page.webSocketDebuggerUrl)
  const readModeWith = async () => mapModeText(await client.evaluate(MODE_TEXT))
  try {
    await client.send('Runtime.enable')
    const control = await client.evaluate(MODE_CONTROL_RECT)
    if (control === null) {
      return { ok: false, changed: false, modeBefore: before.id, error: '找不到模式控件（豆包改版了？）' }
    }
    await clickAt(client, control.x, control.y)

    let option = null
    for (let attempt = 0; attempt < 12 && option === null; attempt += 1) {
      await sleep(200)
      option = await client.evaluate(modeOptionRect(target))
    }
    if (option === null) {
      await pressKey(client, 'Escape')
      return { ok: false, changed: false, modeBefore: before.id, error: '模式菜单里没找到目标选项' }
    }

    await clickAt(client, option.x, option.y)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(300)
      const now = await readModeWith()
      if (now.id === target) {
        return { ok: true, changed: true, modeBefore: before.id, modeAfter: now.id, option: option.text }
      }
    }
    const after = await readModeWith()
    await pressKey(client, 'Escape')
    return {
      ok: false,
      changed: false,
      modeBefore: before.id,
      modeAfter: after.id,
      option: option.text,
      error: `点了「${option.text}」但只读复核仍是 ${after.id}——当作没切成`,
    }
  } finally {
    client.close()
  }
}

/**
 * 账户/套餐入口的可点中心（在侧栏底部的 `sidebar_bottom` 里）。
 * **找不到就返回 null，不做「点一下试试」的兜底**——侧栏上乱点可能开出别的东西。
 */
const QUOTA_CHIP_RECT = `(() => {
  const sidebar = document.querySelector('[data-testid=sidebar_bottom]');
  if (!sidebar) return null;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const chip = [...sidebar.querySelectorAll('*')]
    .filter((el) => visible(el) && /套餐|免费版|会员|专业版/.test((el.innerText || '').trim()) && (el.innerText || '').trim().length < 24)
    .map((el) => ({ r: el.getBoundingClientRect() }))
    .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height)[0];
  if (chip === undefined) return null;
  const r = chip.r;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`

/**
 * 账户菜单打开后要读的东西：额度用量 + 重置次数 + 套餐名。
 *
 * 真机实测（豆包 2.x）：额度**不在常驻 DOM 里**，只在点开账户菜单后的浮层里出现，
 * 形如 `当前时段额度用量` + `0%`，另有 `1 次额度重置`。套餐名在侧栏那个 chip 上
 * （`干嘛呦23333 / 标准套餐`）——**只取套餐，不取账号名**。
 * 读不到就返回 null 字段（由调用方判失败），绝不猜一个数字。
 */
const QUOTA_DOM = `(() => {
  const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  const sidebar = document.querySelector('[data-testid=sidebar_bottom]');
  const sidebarParts = sidebar ? text(sidebar).split(/\\n/).map((p) => p.trim()).filter((p) => p.length > 0) : [];
  const plan = sidebarParts.find((part) => /套餐|免费版|会员/.test(part)) ?? '';

  const rows = [...document.querySelectorAll('div,span')]
    .filter((el) => visible(el) && text(el).includes('当前时段额度用量') && text(el).includes('%'))
    .sort((a, b) => text(a).length - text(b).length);
  if (rows.length === 0) return { menuFound: false, plan };
  const rowText = text(rows[0]).replace(/\\s+/g, ' ');
  const percent = /(\\d{1,3})\\s*%/.exec(rowText);

  const menu = [...document.querySelectorAll('div')]
    .filter((el) => visible(el) && text(el).includes('退出登录') && text(el).includes('当前时段额度用量'))
    .sort((a, b) => text(a).length - text(b).length)[0];
  const menuText = menu ? text(menu).replace(/\\s+/g, ' ') : '';
  const reset = /(\\d+)\\s*次额度重置/.exec(menuText);

  return {
    menuFound: true,
    plan,
    label: rowText.split(' ')[0] ?? '当前时段额度用量',
    usedPercent: percent ? Number(percent[1]) : null,
    resets: reset ? Number(reset[1]) : null,
  };
})()`

/** 可见弹层数量：用来确认「读完之后真的关干净了」。 */
const VISIBLE_DIALOGS = `[...document.querySelectorAll('[role=dialog],[role=menu]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length`

/**
 * 额度页文本 → 窗口数组。**纯函数**，真机文本已固定在测试里：
 *
 * ```
 * 标准套餐 / 订阅与额度管理 / 免费体验至10月25日 / … / 当前时段 / 已用 <1% /
 * 3 小时 35 分钟后重置 / 近 7 天 / 已用 2% / 10月17日 16:42 重置 / 额度重置 / 1 次 / 订阅记录
 * ```
 *
 * 注意 `已用 <1%` 这种写法：**不能读成 1%**。它表示「不到 1%」，所以数值取 0（下界），
 * 原文 `<1%` 原样留在 `usedText` 里，并标 `approximate: true`——界面显示原文，
 * 进度条按下界画。宁可条是空的，也不把「不到 1%」说成 1%。
 */
export function parseQuotaWindows(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const windows = []
  for (let index = 0; index < lines.length; index += 1) {
    const used = /^已用\s*([<＜]?\s*\d+(?:\.\d+)?)\s*%$/.exec(lines[index])
    if (used === null) continue
    const label = index > 0 ? lines[index - 1] : ''
    const approximate = /[<＜]/.test(used[1])
    const numeric = Number(String(used[1]).replace(/[^0-9.]/g, ''))
    windows.push({
      ...quotaWindowMeta(label),
      label,
      usedText: lines[index].replace(/^已用\s*/, ''),
      usedPercent: approximate ? 0 : Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0,
      approximate,
      resetText: /重置/.test(lines[index + 1] ?? '') ? lines[index + 1] : '',
    })
  }
  const resetIndex = lines.findIndex((line) => line === '额度重置')
  const resetMatch = resetIndex >= 0 ? /(\d+)\s*次/.exec(lines[resetIndex + 1] ?? '') : null
  const planLine = lines.find((line) => /套餐/.test(line) && line.length < 20)
  return {
    windows,
    resets: resetMatch ? Number(resetMatch[1]) : null,
    plan: planLine ?? '',
  }
}

/**
 * 窗口的短名。豆包页面上写的是「当前时段」和「近 7 天」，用户嘴里叫「5h / 7d」，
 * 所以两者都留着：`short` 给界面（短），`label` 给悬停提示（原文，不翻译）。
 */
function quotaWindowMeta(label) {
  if (/时段|小时/.test(label)) return { id: 'session', short: '5h' }
  if (/7\s*天|周/.test(label)) return { id: 'week', short: '7d' }
  return { id: 'window', short: label }
}

/** 额度页目标的 URL 特征（App 里是 iframe，外部浏览器里是普通页面）。 */
const QUOTA_PAGE_MATCH = 'member/quota-management'

/** 在「包含 退出登录 的最小浮层」内找文字完全等于 label 的最小可点元素中心。 */
const menuRowRect = (label) => `(() => {
  const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const scope = [...document.querySelectorAll('div')]
    .filter((el) => visible(el) && text(el).includes('退出登录') && text(el).includes('${label}'))
    .sort((a, b) => text(a).length - text(b).length)[0] ?? document;
  const rects = [...scope.querySelectorAll('*')]
    .filter((el) => visible(el) && text(el) === '${label}')
    .map((el) => el.getBoundingClientRect())
    .sort((a, b) => a.width * a.height - b.width * b.height);
  if (rects.length === 0) return null;
  const r = rects[0];
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`

/** 在全文档里找文字完全等于 label 的最小可见元素中心（用于独一无二的标签）。 */
const exactTextRect = (label) => `(() => {
  const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const rects = [...document.querySelectorAll('*')]
    .filter((el) => visible(el) && text(el) === '${label}')
    .map((el) => el.getBoundingClientRect())
    .sort((a, b) => a.width * a.height - b.width * b.height);
  if (rects.length === 0) return null;
  const r = rects[0];
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`

/** 读额度页的可见文本；在 timeoutMs 内没等到这个目标就返回 null。 */
async function readQuotaPageText({ timeoutMs = 12_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let target
    try {
      const targets = await listTargets()
      target = targets.find((candidate) => String(candidate.url).includes(QUOTA_PAGE_MATCH))
    } catch {
      target = undefined
    }
    if (target !== undefined) {
      const client = await Cdp.connect(target.webSocketDebuggerUrl)
      try {
        await client.send('Runtime.enable')
        return await client.evaluate('document.body.innerText')
      } finally {
        client.close()
      }
    }
    if (Date.now() >= deadline) return null
    await sleep(300)
  }
}

/**
 * 走 App 自己的入口读「订阅与额度管理」页：账户菜单 → 设置 → 订阅与额度管理 → 读 iframe。
 *
 * 为什么走这条（而不是 createTarget）：实测 `Target.createTarget` 会挂在一个
 * **1051×677 的可见窗口**上；而这条路是 App 自己的 iframe，不额外开窗口。
 * 代价是三次点击 + 设置面板会闪开一下；**iframe 会自己消失**，所以每次都重新打开。
 *
 * 无论成败都在 finally 里 Escape 两次，并确认没有残留可见弹层。
 */
async function readQuotaFromPage() {
  const page = await pickTarget()
  const client = await Cdp.connect(page.webSocketDebuggerUrl)
  try {
    await client.send('Runtime.enable')

    // 上一次没关干净时，设置面板可能还开着——那就直接点那一行，不重复开菜单。
    // 注意：这一行用**全文档**查找（`exactTextRect`），不能用账户菜单容器限定——
    // 设置面板渲染在那个浮层之外，限定后反而搜不到（真机踩过）。
    let row = await client.evaluate(exactTextRect('订阅与额度管理'))
    if (row === null) {
      const chip = await client.evaluate(QUOTA_CHIP_RECT)
      if (chip === null) return { ok: false, error: '找不到账户/套餐入口（豆包改版了？）' }
      await clickAt(client, chip.x, chip.y)

      let settings = null
      for (let attempt = 0; attempt < 12 && settings === null; attempt += 1) {
        await sleep(250)
        settings = await client.evaluate(menuRowRect('设置'))
      }
      if (settings === null) return { ok: false, error: '账户菜单里没找到「设置」' }
      await clickAt(client, settings.x, settings.y)

      for (let attempt = 0; attempt < 16 && row === null; attempt += 1) {
        await sleep(300)
        row = await client.evaluate(exactTextRect('订阅与额度管理'))
      }
      if (row === null) return { ok: false, error: '设置面板里没找到「订阅与额度管理」' }
    }

    await clickAt(client, row.x, row.y)
    await sleep(500)
    const text = await readQuotaPageText()
    if (text === null || String(text).trim().length === 0) {
      return { ok: false, error: '额度页没打开（没等到 iframe）' }
    }
    const parsed = parseQuotaWindows(text)
    if (parsed.windows.length === 0) {
      return { ok: false, error: '额度页里没解析出窗口（页面改版了？）', pageText: String(text).slice(0, 300) }
    }
    return { ok: true, plan: parsed.plan, resets: parsed.resets, windows: parsed.windows, at: Date.now() }
  } finally {
    try {
      await pressKey(client, 'Escape')
      await sleep(200)
      await pressKey(client, 'Escape')
      await sleep(200)
      const left = await client.evaluate(VISIBLE_DIALOGS)
      if (left > 0) await pressKey(client, 'Escape')
    } catch {
      /* 连接断了就算了 */
    }
    client.close()
  }
}

/**
 * 只读读额度（读数，不是闸门）：**先试额度页（有 5h/7d 两个窗口），失败就降级**到
 * 账户菜单里那个单窗口数字。降级时返回里带 `degraded: true` 与 `windowsError`，
 * 让调用方知道「只有一个窗口」不是因为页面只有这一个，而是因为没读到页面。
 *
 * 纪律（全程只读，不选任何菜单项、不改任何设置）：
 *   - 找不到入口 → 直接失败，不乱点；
 *   - 菜单/页面没出来 → 失败，不猜数字；
 *   - **无论成败都在 finally 里 Escape**，并确认没有残留可见弹层。
 */
async function readQuota() {
  const fromPage = await readQuotaFromPage().catch((error) => ({ ok: false, error: error.message }))
  if (fromPage.ok === true) return fromPage
  const fromMenu = await readQuotaFromMenu().catch((error) => ({ ok: false, error: error.message }))
  if (fromMenu.ok === true) {
    return { ...fromMenu, degraded: true, windowsError: fromPage.error }
  }
  return { ok: false, error: `${fromPage.error ?? '额度页失败'}；${fromMenu.error ?? '账户菜单也失败'}` }
}

/** 降级路径：只读账户菜单里那一个数字（`当前时段额度用量 N%`）。 */
async function readQuotaFromMenu() {
  const page = await pickTarget()
  const client = await Cdp.connect(page.webSocketDebuggerUrl)
  try {
    await client.send('Runtime.enable')
    const chip = await client.evaluate(QUOTA_CHIP_RECT)
    if (chip === null) {
      return { ok: false, error: '找不到账户/套餐入口（豆包改版了？）' }
    }
    await clickAt(client, chip.x, chip.y)

    let dom = null
    for (let attempt = 0; attempt < 12 && dom === null; attempt += 1) {
      await sleep(250)
      const candidate = await client.evaluate(QUOTA_DOM)
      if (candidate !== null && candidate.menuFound === true) dom = candidate
    }
    if (dom === null) {
      return { ok: false, error: '账户菜单没出现，读不到额度（不猜数字）' }
    }
    if (!Number.isFinite(dom.usedPercent)) {
      return { ok: false, plan: dom.plan || '', error: '菜单里没有找到额度百分比' }
    }
    return {
      ok: true,
      plan: dom.plan || '',
      usedPercent: dom.usedPercent,
      resets: Number.isFinite(dom.resets) ? dom.resets : null,
      at: Date.now(),
    }
  } finally {
    // 关掉菜单——成功也要关（这正是「采样」的代价）。
    try {
      await pressKey(client, 'Escape')
      await sleep(200)
      const left = await client.evaluate(VISIBLE_DIALOGS)
      if (left > 0) await pressKey(client, 'Escape')
    } catch {
      /* 连接断了就算了，进程结束后弹层也会随页面状态变化 */
    }
    client.close()
  }
}

/**
 * 模型菜单里要读的东西：可选模型清单 + 每项的状态标注 + 当前项。
 *
 * 真机实测（豆包 2.x，2026-10-11）：
 *   `豆包 2.1 Lite / 0921 新版`、`豆包 2.1 Pro`、`豆包 2.1 Turbo / 即将下线`
 * 每项是一个「豆包…」开头的行，第二行是标注（新版 / 即将下线）。同样**只读**：
 * 点开菜单 → 读 → finally 里 Escape，不选任何一项。
 */
const MODELS_DOM = `(() => {
  const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const control = document.querySelector('[data-testid=chat_input_action_model]');
  const inControl = (el) => control !== null && (el === control || control.contains(el));
  const current = text(control);

  const menus = [...document.querySelectorAll('div')]
    .filter((el) => visible(el) && !inControl(el))
    .map((el) => ({ el, r: el.getBoundingClientRect(), t: text(el) }))
    .filter((x) => (x.t.match(/豆包/g) || []).length >= 2 && x.r.height >= 80 && x.r.height <= 700 && x.r.width >= 120 && x.r.width <= 700)
    .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height);
  if (menus.length === 0) return { menuFound: false, current, items: [] };

  const rows = [...menus[0].el.querySelectorAll('*')]
    .filter((el) => visible(el) && !inControl(el))
    .map((el) => { const r = el.getBoundingClientRect(); return { t: text(el), r }; })
    .filter((x) => x.t.length > 0 && x.t.length < 48 && x.r.height >= 24 && x.r.height <= 68 && /豆包/.test(x.t))
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);

  const byRow = new Map();
  for (const row of rows) {
    const key = Math.round(row.r.y / 4);
    if (!byRow.has(key)) byRow.set(key, row);
  }
  const items = [...byRow.values()].map((row) => {
    const parts = row.t.split(/\\n/).map((p) => p.trim()).filter((p) => p.length > 0);
    return { name: parts[0] ?? '', note: parts.slice(1).join(' · ') };
  }).filter((item) => item.name.length > 0);
  return { menuFound: true, current, items };
})()`

/** 只读读模型清单。同样是采样：点开菜单、读完关掉（成功也关）。 */
async function readModels() {
  const page = await pickTarget()
  const client = await Cdp.connect(page.webSocketDebuggerUrl)
  try {
    await client.send('Runtime.enable')
    const control = await client.evaluate(MODEL_CONTROL_RECT)
    if (control === null) {
      return { ok: false, error: '找不到模型控件（豆包改版了？）' }
    }
    await clickAt(client, control.x, control.y)

    let dom = null
    for (let attempt = 0; attempt < 12 && dom === null; attempt += 1) {
      await sleep(250)
      const candidate = await client.evaluate(MODELS_DOM)
      if (candidate !== null && candidate.menuFound === true) dom = candidate
    }
    if (dom === null || dom.items.length === 0) {
      return { ok: false, error: '模型菜单没出现或没有可读项' }
    }
    // 注意：这里是 **Node 侧**的代码，不是送到页面的表达式字符串，
    // 所以换行用 /\n/（页面模板里才要写成 /\\n/）。
    const currentName = String(dom.current).split(/\n/)[0].trim()
    // 同一个模型名会出现多行（行容器 + 内层），按名字去重，优先保留带标注的那条。
    const byName = new Map()
    for (const item of dom.items) {
      const existing = byName.get(item.name)
      if (existing === undefined || (existing.note.length === 0 && item.note.length > 0)) byName.set(item.name, item)
    }
    return {
      ok: true,
      current: currentName,
      items: [...byName.values()].map((item) => ({ ...item, current: item.name === currentName })),
      at: Date.now(),
    }
  } finally {
    try {
      await pressKey(client, 'Escape')
      await sleep(200)
      const left = await client.evaluate(VISIBLE_DIALOGS)
      if (left > 0) await pressKey(client, 'Escape')
    } catch {
      /* 同上 */
    }
    client.close()
  }
}

async function main() {
  // Flags are stripped anywhere in argv so they never reach a command.
  const argv = process.argv.slice(2)
  const flags = new Set()
  const positionalArgs = []
  let modeOverride
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--no-preflight' || arg === '--force' || arg === '--json') flags.add(arg)
    else if (arg === '--mode') {
      const value = String(argv[++index] ?? '')
      modeOverride = value === 'chat' || value === 'work' || value === 'unknown' ? { id: value, raw: `--mode ${value}` } : { id: 'unknown', raw: value }
    } else positionalArgs.push(arg)
  }
  const noPreflight = flags.has('--no-preflight')
  const force = flags.has('--force')
  const asJson = flags.has('--json')
  const [command, ...rest] = positionalArgs

  /** 五维识别：模式来自 DOM（或 --mode），其余来自 doubao.mjs。 */
  const identify = async () => {
    if (modeOverride !== undefined) return inspectPreCall({ port: PORT, match: MATCH, mode: modeOverride })
    const probe = await probeDebugPort(PORT)
    const mode = probe.up ? await readMode({ useCache: !flags.has('--no-cache') }) : { id: 'unknown', raw: '' }
    return inspectPreCall({ port: PORT, match: MATCH, mode })
  }

  // doctor: report all five dimensions and exit with the verdict's code.
  if (command === 'doctor') {
    const pre = await identify()
    const connectivity = pre.dimensions.connectivity.ok ? undefined : await inspectDoubao({ port: PORT, match: MATCH })
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ ...pre, report: formatPreCallReport(pre) }, null, 2)}\n`)
    } else {
      process.stdout.write(`${formatPreCallReport(pre)}\n`)
      // 连通性不过时补上「怎么把豆包带调试参数启起来」那段可操作说明。
      if (connectivity !== undefined) process.stdout.write(`\n${formatDoubaoReport(connectivity)}\n`)
    }
    process.exitCode = PRECHECK_EXIT[pre.verdict]
    return
  }

  // state: 面板要的只读快照（当前模式 + 当前模型）。
  // 刻意**不做调用前识别、也永远退出 0**——它是诊断读数，不是放行闸门：连不上
  // 豆包时正需要它告诉面板「未连接」，所以不能因为 not-ready 就自己失败。
  // 全部只读：读两个 data-testid 的文字，不点、不改。
  if (command === 'state') {
    const snapshot = {
      connected: false,
      mode: 'unknown',
      modeRaw: '',
      capability: 'unknown',
      model: '',
      modelLevel: '',
      at: Date.now(),
    }
    const probe = await probeDebugPort(PORT)
    if (probe.up) {
      try {
        const dom = await readStateViaCdp()
        const mode = mapModeText(dom?.modeText)
        const { model, level } = splitModelText(dom?.modelFull, dom?.modelLevel)
        snapshot.connected = true
        snapshot.mode = mode.id
        snapshot.modeRaw = mode.raw
        snapshot.capability = commandCapability(mode.id)
        snapshot.model = model
        snapshot.modelLevel = level
      } catch (error) {
        snapshot.error = error.message
      }
    } else {
      snapshot.error = probe.detail
    }
    if (asJson) {
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
    } else {
      process.stdout.write(
        [
          `连通性   : ${snapshot.connected ? '通' : `不通（${snapshot.error ?? '未知'}）`}`,
          `模式     : ${snapshot.modeRaw || snapshot.mode}（${snapshot.mode}）`,
          `命令能力 : ${snapshot.capability}`,
          `模型     : ${snapshot.model || '(读不到)'}${snapshot.modelLevel ? ` · 档位 ${snapshot.modelLevel}` : ''}`,
        ].join('\n') + '\n',
      )
    }
    return
  }

  // mode <work|chat>: 切换豆包的工作模式。**写操作**（点它的 UI），所以：
  //   - 也放在通用预检之前：预检要求在「工作模式」才放行，而切模式恰恰是模式不对
  //     的时候才要用的，用它自己的闸门挡住自己就没意义了；
  //   - 自己先探连通性，连不上就明确报「豆包没在跑」，绝不空转；
  //   - 成败一律以**只读复核**为准（见 switchMode）。
  if (command === 'mode') {
    const target = String(rest[0] ?? '').trim()
    if (target !== 'work' && target !== 'chat') {
      process.stderr.write('usage: cdp.mjs mode <work|chat> [--json]\n')
      process.exitCode = 1
      return
    }
    const probe = await probeDebugPort(PORT)
    let result
    if (!probe.up) {
      result = {
        ok: false,
        changed: false,
        modeBefore: 'unknown',
        error: `豆包没在跑或没开调试端口（${probe.detail}）`,
      }
    } else {
      try {
        result = await switchMode(target)
      } catch (error) {
        result = { ok: false, changed: false, modeBefore: 'unknown', error: error.message }
      }
    }
    const payload = { ...result, target, at: Date.now() }
    if (asJson) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    } else if (payload.ok) {
      process.stdout.write(
        payload.changed
          ? `模式已切换：${payload.modeBefore} → ${payload.modeAfter}${payload.option ? `（点了「${payload.option}」）` : ''}\n`
          : `本来就是 ${payload.modeAfter}，没有动它\n`,
      )
    } else {
      process.stdout.write(`切换失败：${payload.error}\n`)
    }
    process.exitCode = payload.ok ? 0 : 1
    return
  }

  // quota / models: **只读采样**——必须点开一次菜单才读得到（额度在账户菜单里，
  // 模型清单在模型菜单里），读完立刻关掉。与 state 一样不走通用预检：预检会因为
  // 「有未终结 job」而拒绝，而额度/模型清单跟忙不忙无关。
  // 失败一律退 1 并说明原因，绝不猜一个数字/编一份清单。
  if (command === 'quota' || command === 'models') {
    const probe = await probeDebugPort(PORT)
    let result
    if (!probe.up) {
      result = { ok: false, error: `豆包没在跑或没开调试端口（${probe.detail}）` }
    } else {
      try {
        result = command === 'quota' ? await readQuota() : await readModels()
      } catch (error) {
        result = { ok: false, error: error.message }
      }
    }
    const payload = { ...result, command, at: Number.isFinite(result.at) ? result.at : Date.now() }
    if (asJson) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    } else if (command === 'quota') {
      if (payload.ok !== true) {
        process.stdout.write(`读不到额度：${payload.error}\n`)
      } else if (Array.isArray(payload.windows) && payload.windows.length > 0) {
        const lines = payload.windows.map(
          (window) => `  ${window.short}  ${window.usedText}${window.resetText ? `  （${window.resetText}）` : ''}`,
        )
        const resets = Number.isFinite(payload.resets) ? `\n  可重置 ${payload.resets} 次` : ''
        const degraded = payload.degraded === true ? `\n  （降级：只读到账户菜单那一个数字——${payload.windowsError ?? ''}）` : ''
        process.stdout.write(`额度${payload.plan ? `（${payload.plan}）` : ''}：\n${lines.join('\n')}${resets}${degraded}\n`)
      } else {
        process.stdout.write(
          `额度：${payload.usedPercent}%${payload.plan ? `（${payload.plan}）` : ''}${Number.isFinite(payload.resets) ? ` · 剩余重置 ${payload.resets} 次` : ''}\n`,
        )
      }
    } else {
      process.stdout.write(
        payload.ok
          ? `模型（当前 ${payload.current}）：\n${payload.items
              .map((item) => `  ${item.current ? '*' : ' '} ${item.name}${item.note ? `  ${item.note}` : ''}`)
              .join('\n')}\n`
          : `读不到模型清单：${payload.error}\n`,
      )
    }
    process.exitCode = payload.ok ? 0 : 1
    return
  }

  if (!noPreflight) {
    const pre = await identify()
    if (pre.verdict !== 'ready') {
      if (!force) {
        process.stderr.write(`${formatPreCallReport(pre)}\n`)
        process.exitCode = PRECHECK_EXIT[pre.verdict]
        return
      }
      // --force：放行，但必须留痕，便于事后回答「为什么这次没拦住」。
      const config = loadConfig()
      await recordOverride(
        { job: `precheck-${new Date().toISOString()}`, message: pre.reasons.join('；'), reason: 'forced before call' },
        config,
      ).catch(() => {})
      process.stderr.write(`warning: --force 跳过调用前识别（${pre.verdict}）：${pre.reasons.join('；')}\n`)
      process.stderr.write('         已在状态文件里留了一条 override 记录\n')
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
        if (isPlaceholder(current)) {
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
      process.stdout.write('usage: doctor | state [--json] | mode <work|chat> | quota [--json] | models [--json] | targets | probe | send <text> | read [n] | eval <js>\n')
    }
  } finally {
    client.close()
  }
}

/** 入口守卫：被 import 时不要执行 main()（测试要导入 isPlaceholder）。 */
const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`error: ${error.message}\n`)
    process.exit(1)
  })
}
