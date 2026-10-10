/**
 * doubao-status-panel —— 宿主半：把 doubao-cdp 的状态文件暴露成一个**只读**接口。
 *
 * 为什么要有这一半：浏览器半拿不到文件系统，而状态文件是唯一可信的事实来源
 * （`status.jsonl` 是按 job 关联的追加型 JSONL）。所以宿主半只做一件事——读文件、
 * 折叠成「当前活跃 job」，再用 DSH 自己的 webServer 发出去。
 *
 * 纪律（对应验收标准）：
 *   - **只读**：只有 GET，其余方法一律 405；不接收任何请求体，不写任何文件。
 *   - **不新增端口**：注册在 DSH 自己的 webServer 上（本机就是 43120）。
 *   - 不引用任何 `@deepseek-ai/*` 运行时包：只 import node 内置与同工作区的
 *     `doubao-cdp/status.mjs`，这样它是「一个真实文件」的薄转换层，可以脱离
 *     DSH 直接做密封测试。
 *   - 读文件失败不是崩溃：接口返回 200 + 空 job 列表（面板据此隐藏）。
 *     只有真正的代码缺陷才返回 500，好让面板和后端日志能区分「没任务」和「坏了」。
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { foldByJob, loadConfig, openJobs, readStatusEvents } from '../doubao-cdp/status.mjs'

/** Cordis 插件名（与 package.json 的名字一致，便于在 profile 里定位）。 */
export const name = 'doubao-status-panel'

/** 本插件依赖的服务：DSH 的 HTTP 承载服务。 */
export const inject = ['webServer']

/** 只读接口路径。复用 DSH 自己的端口，不新开监听。 */
export const STATUS_API_PATH = '/doubao-status/api'

/** 多久没有新事件就算「疑似卡死」，与 status.mjs 的默认值保持一致。 */
const STALE_AFTER_MS = 600_000

/**
 * 终态在面板上再留一会儿，让「已完成 / 失败」真的被看见。
 * 只留活跃 job 的话，done 一到就消失，用户看到的是「徽章闪一下没了」。
 */
export const TERMINAL_LINGER_MS = 60_000

/** 豆包运行时快照（模式 + 模型）的缓存时长：面板每 2 秒轮询，但一次 CDP 往返不该每 2 秒做一次。 */
export const DOUBAO_STATE_TTL_MS = 15_000

/** 一次 `cdp.mjs state` 子进程的上限；超时就杀掉并按「读不到」处理。 */
const DOUBAO_STATE_TIMEOUT_MS = 8_000

/** 复用 cdp.mjs 这一份实现（DOM 选择器只有一份），宿主半自己不连 CDP。 */
const CDP_SCRIPT = fileURLToPath(new URL('../doubao-cdp/cdp.mjs', import.meta.url))

/** 读不到时的降级值：面板据此显示「豆包未连接」，而不是 500。 */
function doubaoStateUnavailable(error) {
  return {
    connected: false,
    mode: 'unknown',
    modeRaw: '',
    capability: 'unknown',
    model: '',
    modelLevel: '',
    at: Date.now(),
    ...(error === undefined ? {} : { error: String(error) }),
  }
}

/**
 * 解析 `cdp.mjs state --json` 的输出。不是合法 JSON / 不是对象 → null（按失败处理）。
 * 抽成纯函数是为了能密封测试：不用起豆包、不用连 CDP。
 */
export function parseDoubaoState(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text ?? '').trim())
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return {
    connected: parsed.connected === true,
    mode: typeof parsed.mode === 'string' ? parsed.mode : 'unknown',
    modeRaw: typeof parsed.modeRaw === 'string' ? parsed.modeRaw : '',
    capability: typeof parsed.capability === 'string' ? parsed.capability : 'unknown',
    model: typeof parsed.model === 'string' ? parsed.model : '',
    modelLevel: typeof parsed.modelLevel === 'string' ? parsed.modelLevel : '',
    at: Number.isFinite(parsed.at) ? parsed.at : Date.now(),
    ...(typeof parsed.error === 'string' && parsed.error.length > 0 ? { error: parsed.error } : {}),
  }
}

/**
 * 读豆包当前的模式 + 模型：spawn `cdp.mjs state --json` 并解析。
 *
 * 为什么用子进程而不是 import：cdp.mjs 是 CLI（`main()` + CDP 连接），跑在独立的
 * 进程里，卡住或崩掉都不会拖累 DSH 的 web 服务；而且 DOM 选择器只有它那一份。
 * **任何失败都降级成 connected:false**——「豆包没开」是正常状态，不是接口错误。
 */
export function readDoubaoState({ timeoutMs = DOUBAO_STATE_TIMEOUT_MS, script = CDP_SCRIPT, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let timer
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(value)
    }
    const fail = (error) => finish(doubaoStateUnavailable(error?.message ?? error))

    let child
    try {
      child = spawnImpl(process.execPath, [script, 'state', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      fail(error)
      return
    }

    let stdout = ''
    let stderr = ''
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出了 */
      }
      fail(`state 读取超时（${timeoutMs}ms）`)
    }, timeoutMs)

    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on?.('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on?.('data', (chunk) => {
      stderr += chunk
    })
    child.on?.('error', (error) => fail(error))
    child.on?.('close', (code) => {
      const parsed = parseDoubaoState(stdout)
      if (parsed === null) {
        fail(stderr.trim() || `state 输出无法解析（退出码 ${code}）`)
        return
      }
      finish(parsed)
    })
  })
}

/**
 * 快照缓存（stale-while-revalidate）：
 *   - TTL 内直接用缓存，不打 CDP；
 *   - 过期后**先把旧值回给面板**，后台刷新一次——面板每 2 秒轮询，不该被一次
 *     最长 8 秒的 CDP 往返拖住；
 *   - 首次没有任何值时，才等这一次刷新；
 *   - 失败也进缓存（带 error），免得豆包没开时每 2 秒 spawn 一个进程。
 */
export function createDoubaoStateCache({ read = readDoubaoState, ttlMs = DOUBAO_STATE_TTL_MS, now = Date.now } = {}) {
  let cached
  let inflight
  return async function readCached() {
    if (cached !== undefined && now() - cached.at < ttlMs) return cached.state
    if (inflight === undefined) {
      inflight = Promise.resolve()
        .then(() => read())
        .catch((error) => doubaoStateUnavailable(error?.message ?? error))
        .then((state) => {
          cached = { at: now(), state }
          return state
        })
        .finally(() => {
          inflight = undefined
        })
    }
    return cached !== undefined ? cached.state : inflight
  }
}

/** 宿主半默认用的那一份缓存（整个进程一个）。 */
const defaultReadState = createDoubaoStateCache()

/** 状态标签（宿主半只用于日志/调试，界面文案在客户端半）。 */
export const STATE_LABELS = {
  received: '已接收',
  started: '工作开始',
  progress: '进行中',
  need_input: '需要确认',
  done: '已完成',
  failed: '失败',
}

/** 从时间线里取「最后已知」的正文/步骤/百分比（后到者胜，缺省则沿用早先的值）。 */
function latestExtras(events) {
  let message
  let step
  let percent
  for (const event of events) {
    if (typeof event.message === 'string' && event.message.length > 0) message = event.message
    if (typeof event.step === 'string' && event.step.length > 0) step = event.step
    if (Number.isFinite(event.percent)) percent = event.percent
  }
  return { message, step, percent }
}

/** 折叠后的 job 条目 → 面板条目（只做形状转换，不做判断）。 */
export function summarizeJob(entry, { now = Date.now(), staleAfterMs = STALE_AFTER_MS } = {}) {
  const receivedAt = entry.events.find((event) => event.state === 'received')?.at
  const startedAt = entry.events.find((event) => event.state === 'started')?.at
  const { message, step, percent } = latestExtras(entry.events)
  const idleMs = now - (entry.lastAt ?? now)
  return {
    job: entry.job,
    state: entry.state,
    // 阶段：派发器写的 received 在前，豆包写的 started 在后（started 覆盖 received）。
    phase: startedAt !== undefined ? 'started' : receivedAt !== undefined ? 'received' : 'unknown',
    terminal: entry.terminal === true,
    ...(message !== undefined ? { message } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(percent !== undefined ? { percent } : {}),
    receivedAt: receivedAt ?? null,
    startedAt: startedAt ?? null,
    lastAt: entry.lastAt ?? null,
    idleMs,
    stale: idleMs > staleAfterMs,
  }
}

/**
 * 解析读取状态文件要用的 env。
 *
 * 为什么要多这一步（真机实测，不是猜的）：`queue.mjs` 的解析顺序是
 * `DSH_QUEUE_FILE` → `$DSH_HOME/mcp-connector` → `~/.dsh-mcp-connector`。而
 * **DSH Web 的宿主进程里没有 DSH_HOME**（它只注入到 agent 的 shell 里），
 * 于是插件会去读 `~/.dsh-mcp-connector/status.jsonl`，而豆包桥实际写的是
 * `~/.dsh/mcp-connector/status.jsonl` —— 接口能返回 200，但面板永远是空的。
 *
 * 所以：只有两个环境变量都没给时，才把 DSH_HOME 补成 DSH 自己的默认 home
 * （`~/.dsh`），与 CLI 侧的默认行为对齐。显式配置永远优先，绝不被覆盖。
 *
 * @param env 进程环境
 * @returns 可用于 loadConfig 的 env
 */
export function resolveStatusEnv(env = process.env) {
  if (env.DSH_QUEUE_FILE?.trim() || env.DSH_HOME?.trim()) return env
  return { ...env, DSH_HOME: join(homedir(), '.dsh') }
}

/**
 * 读状态文件，给出面板要的 job 列表。
 *
 * 「面板要的」= 还占着的（received/started/progress/need_input，含疑似卡死）
 *            + 刚终结的（TERMINAL_LINGER_MS 之内，让「已完成」可见）。
 * 按 lastAt 升序返回，调用方取最后一条即「最近发生的」。
 *
 * @param env 环境覆盖（决定 ini 与状态文件位置；测试用）
 * @param now 当前时间（测试用）
 */
export async function readPanelJobs({ env = process.env, now = Date.now(), lingerMs = TERMINAL_LINGER_MS } = {}) {
  const config = loadConfig({ env: resolveStatusEnv(env) })
  const folded = foldByJob(await readStatusEvents(config.statusFile))
  const jobs = openJobs(folded, { now }).map((entry) => summarizeJob(folded.get(entry.job), { now }))
  const seen = new Set(jobs.map((job) => job.job))
  for (const entry of folded.values()) {
    if (entry.terminal !== true) continue
    if (seen.has(entry.job)) continue
    if (now - (entry.lastAt ?? 0) > lingerMs) continue
    jobs.push(summarizeJob(entry, { now }))
  }
  jobs.sort((left, right) => (left.lastAt ?? 0) - (right.lastAt ?? 0))
  return { file: config.statusFile, now, warnings: config.warnings, jobs }
}

/* ---------------------------------------------------------------- 来源围栏 */

/**
 * 为什么要有围栏：真机实测，DSH 的 web 服务**监听 0.0.0.0:43120**，而 GUI 页面
 * 本身对非本机访问是要鉴权的（`GET /` 返回 401）。插件路由跑在鉴权之前，
 * 所以一条不加围栏的只读路由 = **绕过 GUI 的鉴权**，把任务的 job id / 正文 /
 * 结果摘要暴露给同网段的人。dsh-update 的写接口就是因此加了同样的围栏。
 *
 * 语义（与 dsh-family 共用的 loopback 围栏一致，减少分叉）：
 * socket 地址属于 127/8、::1、或 IPv4-mapped ::ffff:127/8，**并且** Host 头
 * 也是回环地址（localhost / [::1] / 127/8），并且不是浏览器标记的跨站请求。
 * socket 地址是权威依据，永不信任 X-Forwarded-For。
 *
 * 代价（如实说明）：从**远程**（手机 / LAN 地址）打开 GUI 时，徽章拿不到数据会
 * 自动隐藏。想放开就把下方 `createStatusRoutes` 的 `fence` 换成 `() => true`，
 * 但要清楚那等于把任务状态开给同网段。
 */
function isIPv4Loopback(value) {
  const parts = String(value).split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** socket 地址是不是回环（127/8、::1、IPv4-mapped）。 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Host 头的主机名是不是回环（localhost、[::1]、127/8）。 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/** 请求级围栏：回环 socket + 回环 Host + 非跨站标记。 */
export function isLoopbackRequest(req) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false
  const host = req?.headers?.host
  if (typeof host !== 'string' || host.length === 0) return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/* ---------------------------------------------------------------- 路由 */

/** 只写 JSON 响应体的小工具（不引入任何框架）。 */
function writeJson(res, status, body) {
  const text = `${JSON.stringify(body)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

/**
 * 构造只读路由（测试缝：`read` / `readState` / `fence` 可替换，于是密封测试
 * 不需要 DSH、不需要真文件、也不需要豆包，就能把本机与同网段两种来源都走一遍）。
 *
 * 默认载荷 = 状态文件的 job 列表 + 豆包运行时快照（模式 + 模型）。
 *
 * @param read 读 job 数据的方式，默认读真实状态文件（与快照合成）
 * @param path 路由路径
 * @param fence 来源围栏，默认只放行本机
 * @param readState 读豆包运行时快照的方式，默认 spawn `cdp.mjs state`（带 15 秒缓存）
 * @returns 可直接交给 `ctx.webServer.register` 的路由数组
 */
export function createStatusRoutes({
  read,
  path = STATUS_API_PATH,
  fence = isLoopbackRequest,
  readState = defaultReadState,
} = {}) {
  const readAll =
    read ??
    (async () => ({
      ...(await readPanelJobs()),
      // 快照读取自己已经降级过一次；这里再兜一层：一个坏掉的 state 读取
      // 绝不能把「任务列表」这个主功能一起带下去。
      doubao: await readState().catch((error) => doubaoStateUnavailable(error?.message ?? error)),
    }))
  const handler = async (req, res) => {
    // 只读：GET 之外一律 405，且不解析请求体（POST 不可能有副作用）。
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' })
      res.end('method not allowed')
      return
    }
    // 非本机来源：拒绝（否则这条路由等于绕过 GUI 的鉴权）。
    if (!fence(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden' })
      return
    }
    try {
      const data = await readAll()
      writeJson(res, 200, { ok: true, ...data })
    } catch (error) {
      // 真出错了就说清楚，不要伪装成「没有任务」。
      writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }
  return [{ kind: 'exact', path, handler }]
}

/**
 * 宿主半入口：把只读路由挂到 DSH 自己的 webServer 上。
 * 用 `ctx.effect` 管理生命周期，卸载插件时路由会被摘掉（不留下悬空 handler）。
 *
 * @param ctx 宿主插件上下文（需要 webServer 服务）
 */
export function apply(ctx) {
  ctx.effect(() => {
    const disposers = createStatusRoutes().map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'doubao-status-panel: 只读状态接口')
}
