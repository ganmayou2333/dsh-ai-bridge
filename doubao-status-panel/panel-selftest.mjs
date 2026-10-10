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
import { createStatusRoutes, createDoubaoStateCache, isLoopbackAddress, isLoopbackRequest, parseDoubaoState, readPanelJobs, resolveStatusEnv, STATUS_API_PATH } from './index.js'

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

/** 一个「来自本机」的请求替身（名称/头部可覆盖，用来演同网段来源）。 */
function fakeReq(method = 'GET', overrides = {}) {
  return {
    method,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:43120' },
    ...overrides,
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
    // 运行时快照的替身：密封测试不 spawn cdp.mjs、更不碰真豆包。
    const fakeState = {
      connected: true,
      mode: 'work',
      modeRaw: '本地电脑',
      capability: 'yes',
      model: '豆包 2.1 Lite',
      modelLevel: '低',
      at: 0,
    }
    const routes = createStatusRoutes({ readState: async () => fakeState })
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
    await route.handler(fakeReq('GET'), res)
    check(
      'GET 返回 200 + JSON',
      res.status === 200 && String(res.headers?.['content-type']).startsWith('application/json'),
      `${res.status} ${res.headers?.['content-type']}`,
    )
    const body = JSON.parse(res.body)
    check('响应标 ok 并给出状态文件路径（路径不一致时能一眼看出来）', body.ok === true && body.file === statusFile, `${body.ok} ${body.file}`)
    check('响应带上 ini 告警（配置有问题时看得见）', Array.isArray(body.warnings))
    check(
      '响应带上豆包运行时快照：模式 + 模型（面板据此显示「工作模式 / 模型名」）',
      body.doubao?.connected === true &&
        body.doubao?.mode === 'work' &&
        body.doubao?.modeRaw === '本地电脑' &&
        body.doubao?.capability === 'yes' &&
        body.doubao?.model === '豆包 2.1 Lite' &&
        body.doubao?.modelLevel === '低',
      JSON.stringify(body.doubao ?? null),
    )
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
      await readonlyRoute.handler(fakeReq(method), rejected)
      check(
        `${method} 返回 405 + Allow: GET（只读）`,
        rejected.status === 405 && rejected.headers?.allow === 'GET',
        `${method} -> ${rejected.status} allow=${rejected.headers?.allow}`,
      )
    }
    check('被拒的写请求没有触发任何读取（没有副作用）', readerCalled === 0, `readerCalled=${readerCalled}`)
    const allowed = fakeRes()
    await readonlyRoute.handler(fakeReq('GET'), allowed)
    check('GET 仍然可用', allowed.status === 200 && readerCalled === 1, `status=${allowed.status} called=${readerCalled}`)

    // ---------------------------------------------------------- 来源围栏
    // 真机实测：web 服务监听 0.0.0.0，而 GUI 页面本身对非本机访问要鉴权（GET / → 401）。
    // 插件路由跑在鉴权之前，所以只读路由也必须自己围栏，否则等于绕过鉴权。
    check(
      '回环判定：127.0.0.1 / ::1 / IPv4-mapped / 127.0.0.2',
      ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.2'].every((address) => isLoopbackAddress(address)),
    )
    check('回环判定：同网段地址不是回环', !isLoopbackAddress('192.168.1.50') && !isLoopbackAddress(undefined))
    check('请求围栏：本机 socket + 本机 Host 放行', isLoopbackRequest(fakeReq()))
    check(
      '请求围栏：LAN socket 拒绝',
      !isLoopbackRequest(fakeReq('GET', { socket: { remoteAddress: '192.168.1.50' } })),
    )
    check(
      '请求围栏：本机 socket 但 Host 是 LAN 地址也拒绝（绕过鉴权的典型形态）',
      !isLoopbackRequest(fakeReq('GET', { headers: { host: '192.168.1.50:43120' } })),
    )
    check(
      '请求围栏：跨站标记拒绝',
      !isLoopbackRequest(fakeReq('GET', { headers: { host: '127.0.0.1:43120', 'sec-fetch-site': 'cross-site' } })),
    )
    check(
      '请求围栏：同源 Origin 放行',
      isLoopbackRequest(fakeReq('GET', { headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120' } })),
    )

    let lanReaderCalled = 0
    const [lanRoute] = createStatusRoutes({
      read: () => {
        lanReaderCalled += 1
        return { jobs: [] }
      },
    })
    const lanRes = fakeRes()
    await lanRoute.handler(fakeReq('GET', { socket: { remoteAddress: '192.168.1.50' } }), lanRes)
    check(
      '同网段来源 GET → 403 且不读数据',
      lanRes.status === 403 && lanReaderCalled === 0 && JSON.parse(lanRes.body).code === 'forbidden',
      `${lanRes.status} called=${lanReaderCalled} ${lanRes.body?.trim()}`,
    )

    // ---------------------------------------------------------- 失败形态
    const [brokenRoute] = createStatusRoutes({
      read: () => {
        throw new Error('boom')
      },
    })
    const broken = fakeRes()
    await brokenRoute.handler(fakeReq('GET'), broken)
    const brokenBody = JSON.parse(broken.body)
    check(
      '读取抛错 → 500 并说明原因（不伪装成「没有任务」）',
      broken.status === 500 && brokenBody.ok === false && String(brokenBody.error).includes('boom'),
      `${broken.status} ${broken.body?.trim()}`,
    )

    process.env.DSH_QUEUE_FILE = join(scratch, 'empty', 'tasks.jsonl')
    const [emptyRoute] = createStatusRoutes({ readState: async () => fakeState })
    const empty = fakeRes()
    await emptyRoute.handler(fakeReq('GET'), empty)
    check(
      '状态文件不存在 → 200 + 空列表（面板隐藏，而不是报错）',
      empty.status === 200 && JSON.parse(empty.body).jobs.length === 0,
      `${empty.status} ${empty.body?.trim()}`,
    )

    // ---------------------------------------------------------- 运行时快照解析
    const parsedState = parseDoubaoState(
      '{"connected":true,"mode":"work","modeRaw":"本地电脑","capability":"yes","model":"豆包 2.1 Lite","modelLevel":"低","at":123}',
    )
    check(
      'parseDoubaoState 解析 cdp.mjs state 的输出',
      parsedState?.connected === true &&
        parsedState?.mode === 'work' &&
        parsedState?.model === '豆包 2.1 Lite' &&
        parsedState?.modelLevel === '低' &&
        parsedState?.capability === 'yes',
      JSON.stringify(parsedState ?? null),
    )
    check(
      'parseDoubaoState 对非 JSON / 非对象返回 null',
      parseDoubaoState('') === null && parseDoubaoState('<html>') === null && parseDoubaoState('[]') === null && parseDoubaoState('null') === null,
    )
    const emptyParsed = parseDoubaoState('{}')
    check(
      'parseDoubaoState 缺字段时给安全默认值（不猜模式）',
      emptyParsed?.connected === false && emptyParsed?.mode === 'unknown' && emptyParsed?.model === '',
      JSON.stringify(emptyParsed ?? null),
    )

    // ---------------------------------------------------------- 快照缓存
    let reads = 0
    let clock = 1000
    const cache = createDoubaoStateCache({
      read: async () => {
        reads += 1
        return { ...fakeState, at: clock }
      },
      ttlMs: 100,
      now: () => clock,
    })
    const first = await cache()
    check('缓存首次调用会真的去读一次', reads === 1 && first.model === '豆包 2.1 Lite', `reads=${reads}`)
    clock += 50
    await cache()
    check('TTL 内不再读（面板每 2 秒轮询不该每 2 秒连一次 CDP）', reads === 1, `reads=${reads}`)
    clock += 100
    const stale = await cache()
    check('TTL 过期时先把旧值交出去（不被一次 CDP 往返拖住）', stale.model === '豆包 2.1 Lite', JSON.stringify(stale))
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('并在后台完成一次刷新', reads === 2, `reads=${reads}`)
    clock += 50
    await cache()
    check('刷新后的值在 TTL 内被复用', reads === 2, `reads=${reads}`)

    const failing = createDoubaoStateCache({
      read: async () => {
        throw new Error('boom-state')
      },
      ttlMs: 100,
      now: () => clock,
    })
    const failedState = await failing()
    check(
      '快照读取失败降级为 connected:false（豆包没开是正常状态，不是错误）',
      failedState.connected === false && String(failedState.error).includes('boom-state'),
      JSON.stringify(failedState),
    )

    // 快照爆炸不能连累任务列表：接口仍 200，jobs 照旧
    process.env.DSH_QUEUE_FILE = queueFile
    const [resilientRoute] = createStatusRoutes({
      readState: async () => {
        throw new Error('nope')
      },
    })
    const resilient = fakeRes()
    await resilientRoute.handler(fakeReq('GET'), resilient)
    const resilientBody = JSON.parse(resilient.body)
    check(
      '快照读取抛错时接口仍 200，任务列表与降级快照都在',
      resilient.status === 200 && resilientBody.jobs.length === 3 && resilientBody.doubao?.connected === false && String(resilientBody.doubao?.error).includes('nope'),
      `${resilient.status} ${JSON.stringify(resilientBody.doubao ?? null)}`,
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
