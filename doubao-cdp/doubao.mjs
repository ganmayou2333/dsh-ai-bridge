#!/usr/bin/env node
/**
 * doubao.mjs — 连接豆包之前先「确认它确实可被驱动」。
 *
 * 原来的失败长这样：
 *     error: fetch failed
 * 这句话没告诉用户任何事情。实际上有三种完全不同的状态，处理方式也不同：
 *
 *   1. 豆包没运行                    → 去启动它
 *   2. 豆包在运行，但没开调试端口     → 必须带参数重启（本模块最常见的情形）
 *   3. 端口通但没有匹配的页面         → 调试开着，但不是我们要驱动的那个视图
 *
 * 本模块只做**检测与说明**，不会去结束或重启豆包——那属于用户的操作。
 */

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

/** 调试端口：DOUBAO_CDP_PORT 优先，其次是历史变量 CDP_PORT，最后 9222。 */
export const CDP_PORT = Number(process.env.DOUBAO_CDP_PORT ?? process.env.CDP_PORT ?? 9222)

/** 需要驱动的页面。 */
export const CDP_MATCH = process.env.CDP_MATCH ?? 'doubao-chat/chat'

/** 确认失败时的退出码，与「一般错误 = 1」区分开，方便脚本判断。 */
export const PREFLIGHT_EXIT_CODE = 3

/** 探测调试端口是否在监听。 */
export async function probeDebugPort(port = CDP_PORT, timeoutMs = 2000) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { up: false, detail: `HTTP ${response.status}` }
    const version = await response.json().catch(() => ({}))
    return { up: true, detail: version.Browser ?? 'CDP endpoint', version }
  } catch (error) {
    const code = error?.cause?.code ?? error?.name ?? 'fetch failed'
    return { up: false, detail: String(code) }
  }
}

/** 列出可能的豆包可执行文件路径，供提示信息使用。 */
function candidatePaths() {
  return [
    process.env.DOUBAO_BIN?.trim(),
    'C:\\Program Files\\Doubao\\app\\Doubao.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Doubao', 'app', 'Doubao.exe'),
    join(process.env.PROGRAMFILES ?? '', 'Doubao', 'app', 'Doubao.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? '', 'Doubao', 'app', 'Doubao.exe'),
  ].filter((value) => typeof value === 'string' && value.length > 0)
}

/** 运行中的豆包进程（Windows；其它平台返回空数组）。 */
export function doubaoProcesses() {
  if (process.platform !== 'win32') return []
  const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Doubao.exe', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0 || typeof result.stdout !== 'string') return []
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('"'))
    .map((line) => {
      const columns = line.match(/"([^"]*)"/g)?.map((cell) => cell.slice(1, -1)) ?? []
      return { name: columns[0], pid: Number(columns[1]) }
    })
    .filter((entry) => Number.isFinite(entry.pid))
}

/** 正在运行的豆包可执行文件路径（Windows），拿不到就返回 undefined。 */
export function runningDoubaoPath() {
  if (process.platform !== 'win32') return undefined
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-Process Doubao -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path)',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 8000 },
  )
  const path = (result.stdout ?? '').trim()
  return path.length > 0 ? path : undefined
}

/** 解析用于提示的豆包可执行文件路径。 */
export function resolveDoubaoExe() {
  const fromEnv = process.env.DOUBAO_BIN?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return { path: fromEnv, source: 'DOUBAO_BIN' }
  const running = runningDoubaoPath()
  if (running !== undefined) return { path: running, source: '运行中的进程' }
  const existing = candidatePaths().find((candidate) => existsSync(candidate))
  if (existing !== undefined) return { path: existing, source: '常见安装路径' }
  return { path: 'Doubao.exe', source: '未找到，请用 DOUBAO_BIN 指定' }
}

/** 汇总一次完整的确认结果。 */
export async function inspectDoubao({ port = CDP_PORT, match = CDP_MATCH } = {}) {
  const probe = await probeDebugPort(port)
  const processes = doubaoProcesses()
  let targets = []
  if (probe.up) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })
      targets = await response.json()
    } catch {
      targets = []
    }
  }
  const matching = targets.filter((target) => target.type === 'page' && String(target.url).includes(match))
  return {
    port,
    match,
    probe,
    processes,
    targets,
    matching,
    exe: resolveDoubaoExe(),
    ready: probe.up && matching.length > 0,
  }
}

/** 把确认结果渲染成给人看的报告。 */
export function formatDoubaoReport(state) {
  const { port, match, probe, processes, matching, exe } = state
  const lines = ['豆包启动确认']
  lines.push(`  调试端口 127.0.0.1:${port} : ${probe.up ? `监听中（${probe.detail}）` : `未监听（${probe.detail}）`}`)
  lines.push(
    `  豆包进程                 : ${
      processes.length === 0
        ? '未检测到'
        : `运行中 (${processes.length > 1 ? `${processes.length} 个进程，主进程 PID ${processes[0].pid}` : `PID ${processes[0].pid}`})`
    }`,
  )
  if (probe.up) lines.push(`  目标页面 "${match}"     : ${matching.length} 个匹配 / 共 ${state.targets.length} 个页面`)
  lines.push(`  可执行文件               : ${exe.path}  (来源: ${exe.source})`)

  if (state.ready) {
    lines.push('', '  ✓ 已确认：可以连接并驱动豆包。')
    return lines.join('\n')
  }

  lines.push('')
  if (!probe.up && processes.length > 0) {
    lines.push('  ✗ 不能连接：豆包正在运行，但没有开调试端口。')
    lines.push('    也就是说它当初是正常启动的，需要带参数重启才能被驱动：')
    lines.push('      1) 退出豆包')
    lines.push('      2) 运行：')
    lines.push(`         "${exe.path}" --remote-debugging-port=${port} --remote-allow-origins=*`)
  } else if (!probe.up) {
    lines.push('  ✗ 不能连接：豆包没有运行，也没有调试端口。')
    lines.push('    带参数启动它：')
    lines.push(`      "${exe.path}" --remote-debugging-port=${port} --remote-allow-origins=*`)
  } else {
    lines.push(`  ✗ 不能连接：端口是通的，但没有 url 包含 "${match}" 的 page 目标。`)
    lines.push('    可能豆包停在了别的视图（启动页 / 登录页）。用下面这条看现有页面：')
    lines.push('      node cdp.mjs targets')
    lines.push(`    也可以换匹配串：$env:CDP_MATCH="doubao"; node cdp.mjs doctor`)
  }

  lines.push('')
  lines.push('  注意：开着调试端口期间，本机任意进程都能接管你的豆包')
  lines.push('        （读全部聊天记录、以你的身份发消息）。用完请退出豆包并正常启动，即可关掉。')
  lines.push('  确认这一段也可以单独跑：node cdp.mjs doctor')
  lines.push('  确实想跳过确认：加 --no-preflight')
  return lines.join('\n')
}

/** 需要时直接确认，失败就返回报告。 */
export async function ensureDoubao(options = {}) {
  const state = await inspectDoubao(options)
  return { ok: state.ready, state, report: formatDoubaoReport(state) }
}
