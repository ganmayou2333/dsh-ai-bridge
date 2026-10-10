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

import { homedir } from 'node:os'
import { join } from 'node:path'
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
 * 构造只读路由（测试缝：`read` 可替换，于是密封测试不需要 DSH、也不需要真文件）。
 *
 * @param read 读数据的方式，默认读真实状态文件
 * @param path 路由路径
 * @returns 可直接交给 `ctx.webServer.register` 的路由数组
 */
export function createStatusRoutes({ read = () => readPanelJobs(), path = STATUS_API_PATH } = {}) {
  const handler = async (req, res) => {
    // 只读：GET 之外一律 405，且不解析请求体（POST 不可能有副作用）。
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' })
      res.end('method not allowed')
      return
    }
    try {
      const data = await read()
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
