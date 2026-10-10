#!/usr/bin/env node
/**
 * doubao-status-panel 的密封测试 —— 不需要 DSH，也不需要豆包。
 *
 * 验的是验收标准里那几条「只信副作用」的硬要求：
 *   1. received 折叠正确：只有 received、还没 started 的 job 也要出现在列表里；
 *   2. 接口只读：POST/PUT/DELETE/PATCH 一律 405，而且**没有触发任何读取**（无副作用）；
 *   3. 不新增端口：只注册一条相对路径的 exact 路由，宿主半源码里没有 listen/createServer；
 *   4. 读文件的失败不会伪装成崩溃，也不会伪装成「没有任务」；
 *   5. 清单/补丁/客户端半的关键形态没写错（模块装载器 id、try/catch 兜底、无 DSH 客户端依赖）。
 *
 * Usage: node panel-selftest.mjs
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStatusRoutes, readPanelJobs, resolveStatusEnv, STATUS_API_PATH } from './index.js'

const HERE = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail.length > 0 ? `\n      ${detail}` : ''}\n`)
}

/** node:http 响应的最小替身：只记录 writeHead/end。 */
function fakeRes() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(text) {
      this.body = text
    },
  }
}

/** 直接往状态文件追加事件（和 status.mjs 的落盘格式一致）。 */
function writeEvents(file, events) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, events.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8')
}

async function main() {
  process.stdout.write(`doubao-status-panel selftest (node ${process.version}, platform ${process.platform})\n`)

  const scratch = mkdtempSync(join(tmpdir(), 'panel-selftest-'))
  const savedQueue = process.env.DSH_QUEUE_FILE
  const queueFile = join(scratch, 'default', 'tasks.jsonl')
  const statusFile = join(scratch, 'default', 'status.jsonl')
  process.env.DSH_QUEUE_FILE = queueFile

  try {
    // ---------------------------------------------------------- 静态形态（清单）
    const manifest = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
    check(
      '清单声明了 bundle patch 与 web 客户端半',
      manifest.dsh?.bundle?.patch === './cordis.patch.yml' && manifest.dsh?.client?.platform === 'web',
      JSON.stringify(manifest.dsh ?? null),
    )
    check(
      'client inject 指向槽的声明者（ui-sidebar）',
      (manifest.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-client-ui-sidebar'),
      JSON.stringify(manifest.dsh?.client?.inject ?? null),
    )
    check(
      'exports 同时给出宿主半与客户端半',
      manifest.exports?.['.'] === './index.js' && manifest.exports?.['./client'] === './client.js',
      JSON.stringify(manifest.exports ?? null),
    )
    check('声明了 type: module（宿主半是 ESM）', manifest.type === 'module')
    check('private 包不会被误发布', manifest.private === true)

    const patch = readFileSync(join(HERE, 'cordis.patch.yml'), 'utf8')
    check(
      '补丁插入的插件行名与包名一致',
      patch.includes('insert') && patch.includes(`'${manifest.name}'`),
      patch.trim().split('\n').join(' | '),
    )

    // ---------------------------------------------------------- 不新增端口
    const hostSource = readFileSync(join(HERE, 'index.js'), 'utf8')
    check('宿主半没有起任何监听（不新增端口）', !/createServer|\.listen\s*\(/.test(hostSource))
    check('宿主半不 import 任何 DSH 运行时包', !/from\s+['"]@deepseek-ai\//.test(hostSource))
    const clientSource = readFileSync(join(HERE, 'client.js'), 'utf8')
    check(
      '客户端半是模块装载器格式，且 id 与包名一致',
      clientSource.includes('__ModuleLoader__.load') && clientSource.includes(`id: '${manifest.name}'`),
    )
    check('客户端半的槽注册有 try/catch 兜底（注册失败不带崩界面）', (clientSource.match(/catch/g) ?? []).length >= 2)
    check('客户端半不 import DSH 客户端包', !/from\s+['"]@deepseek-ai\//.test(clientSource))

    // ---------------------------------------------------------- 路径解析
    // 真机实测：DSH Web 宿主进程没有 DSH_HOME，插件会去读 ~/.dsh-mcp-connector，
    // 而豆包桥写的是 ~/.dsh/mcp-connector —— 接口 200 但面板永远空。
    check(
      '缺省 env 时补上 DSH 默认 home（否则读错目录）',
      resolveStatusEnv({}).DSH_HOME === join(homedir(), '.dsh'),
      String(resolveStatusEnv({}).DSH_HOME),
    )
    check('显式 DSH_HOME 不被覆盖', resolveStatusEnv({ DSH_HOME: 'D:/custom' }).DSH_HOME === 'D:/custom')
    const withQueue = resolveStatusEnv({ DSH_QUEUE_FILE: 'D:/q/tasks.jsonl' })
    check(
      '显式 DSH_QUEUE_FILE 时不动 DSH_HOME（用户说了算）',
      withQueue.DSH_QUEUE_FILE === 'D:/q/tasks.jsonl' && withQueue.DSH_HOME === undefined,
      JSON.stringify(withQueue),
    )

    // ---------------------------------------------------------- 路由形状
    const routes = createStatusRoutes()
    check('只注册一条路由', routes.length === 1, `n=${routes.length}`)
    const [route] = routes
    check('路由是 exact 精确匹配', route.kind === 'exact')
    check(
      '路径是相对路径（复用 DSH 自己的端口，而不是另开）',
      route.path === STATUS_API_PATH && route.path.startsWith('/') && !/^[a-z]+:\/\//i.test(route.path),
      route.path,
    )

    // ---------------------------------------------------------- 折叠（真实文件）
    const now = Date.now()
    writeEvents(statusFile, [
      { v: 1, type: 'status', job: 'P-1', state: 'received', at: now - 9000, message: '派发器已送出指令，等待豆包开工' },
      { v: 1, type: 'status', job: 'P-1', state: 'started', at: now - 7000 },
      { v: 1, type: 'status', job: 'P-1', state: 'progress', at: now - 3000, percent: 40, step: '拉取' },
      { v: 1, type: 'status', job: 'P-2', state: 'received', at: now - 8000 },
      { v: 1, type: 'status', job: 'P-3', state: 'done', at: now - 2000, message: '完成' },
      { v: 1, type: 'status', job: 'P-4', state: 'failed', at: now - 500_000, message: '很久以前失败' },
    ])

    const res = fakeRes()
    await route.handler({ method: 'GET' }, res)
    check(
      'GET 返回 200 + JSON',
      res.status === 200 && String(res.headers?.['content-type']).startsWith('application/json'),
      `${res.status} ${res.headers?.['content-type']}`,
    )
    const body = JSON.parse(res.body)
    check('响应标 ok 并给出状态文件路径（路径不一致时能一眼看出来）', body.ok === true && body.file === statusFile, `${body.ok} ${body.file}`)
    check('响应带上 ini 告警（配置有问题时看得见）', Array.isArray(body.warnings))
    const byJob = new Map(body.jobs.map((job) => [job.job, job]))
    check(
      '进行中的 job：state=progress 且 phase=started',
      byJob.get('P-1')?.state === 'progress' && byJob.get('P-1')?.phase === 'started',
      JSON.stringify(byJob.get('P-1') ?? null),
    )
    check(
      'percent / step / 最早的 message 都带上了',
      byJob.get('P-1')?.percent === 40 && byJob.get('P-1')?.step === '拉取' && byJob.get('P-1')?.message === '派发器已送出指令，等待豆包开工',
      JSON.stringify(byJob.get('P-1') ?? null),
    )
    check(
      '只有 received、还没 started 的 job 也显示（phase=received）',
      byJob.get('P-2')?.state === 'received' && byJob.get('P-2')?.phase === 'received' && byJob.get('P-2')?.terminal === false,
      JSON.stringify(byJob.get('P-2') ?? null),
    )
    check(
      '刚完成的 job 留在列表里（让「已完成」看得见）',
      byJob.get('P-3')?.state === 'done' && byJob.get('P-3')?.terminal === true,
      JSON.stringify(byJob.get('P-3') ?? null),
    )
    check('很久以前结束的 job 不出现（这不是历史列表）', byJob.has('P-4') === false)
    check(
      '按 lastAt 升序（最后一条 = 最近发生的）',
      body.jobs.every((job, index, list) => index === 0 || (list[index - 1].lastAt ?? 0) <= (job.lastAt ?? 0)),
      body.jobs.map((job) => `${job.job}:${job.lastAt}`).join(' '),
    )

    // readPanelJobs 直接调用也要能工作（宿主半的公开面）
    const direct = await readPanelJobs()
    check('readPanelJobs 直接可调用（接口只是它的薄包装）', direct.jobs.length === 3 && direct.file === statusFile, `n=${direct.jobs.length}`)

    // ---------------------------------------------------------- 只读
    let readerCalled = 0
    const [readonlyRoute] = createStatusRoutes({
      read: () => {
        readerCalled += 1
        return { file: statusFile, now: 0, jobs: [] }
      },
    })
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const rejected = fakeRes()
      await readonlyRoute.handler({ method }, rejected)
      check(
        `${method} 返回 405 + Allow: GET（只读）`,
        rejected.status === 405 && rejected.headers?.allow === 'GET',
        `${method} -> ${rejected.status} allow=${rejected.headers?.allow}`,
      )
    }
    check('被拒的写请求没有触发任何读取（没有副作用）', readerCalled === 0, `readerCalled=${readerCalled}`)
    const allowed = fakeRes()
    await readonlyRoute.handler({ method: 'GET' }, allowed)
    check('GET 仍然可用', allowed.status === 200 && readerCalled === 1, `status=${allowed.status} called=${readerCalled}`)

    // ---------------------------------------------------------- 失败形态
    const [brokenRoute] = createStatusRoutes({
      read: () => {
        throw new Error('boom')
      },
    })
    const broken = fakeRes()
    await brokenRoute.handler({ method: 'GET' }, broken)
    const brokenBody = JSON.parse(broken.body)
    check(
      '读取抛错 → 500 并说明原因（不伪装成「没有任务」）',
      broken.status === 500 && brokenBody.ok === false && String(brokenBody.error).includes('boom'),
      `${broken.status} ${broken.body?.trim()}`,
    )

    process.env.DSH_QUEUE_FILE = join(scratch, 'empty', 'tasks.jsonl')
    const [emptyRoute] = createStatusRoutes()
    const empty = fakeRes()
    await emptyRoute.handler({ method: 'GET' }, empty)
    check(
      '状态文件不存在 → 200 + 空列表（面板隐藏，而不是报错）',
      empty.status === 200 && JSON.parse(empty.body).jobs.length === 0,
      `${empty.status} ${empty.body?.trim()}`,
    )
  } catch (error) {
    check('panel selftest 完整跑完', false, String(error?.stack ?? error))
  } finally {
    if (savedQueue === undefined) delete process.env.DSH_QUEUE_FILE
    else process.env.DSH_QUEUE_FILE = savedQueue
    rmSync(scratch, { recursive: true, force: true })
  }

  process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
