/**
 * doubao-status-panel —— 浏览器半：侧栏底部的豆包状态徽章。
 *
 * 显示两件事（都是只读的）：
 *   1. **任务状态**（有活跃/刚结束的 job 时）：已接收 / 工作开始 / 进行中 x% /
 *      需要确认 / 已完成 / 失败；
 *   2. **豆包运行时**：当前模式（工作/对话）+ 当前模型。这一条是常驻的，因为
 *      「是不是工作模式」直接决定豆包能不能回报状态——派发前就该看得见。
 *
 * 这不是普通 ESM，而是 DSH 的模块装载器格式：`window.__ModuleLoader__.load`
 * 注册一个懒工厂，React 由浏览器的模块表提供（`require('react')`），所以不需要
 * tsc/tsdown 之类的构建链，手写即可。
 *
 * 纪律：
 *   - **注册一律 try/catch**：槽未声明或注册表不可用时静默不显示，绝不把整个
 *     Web 界面拖垮。
 *   - 每 2 秒轮询宿主半的**只读**接口 `/doubao-status/api`（宿主半自己带 15 秒
 *     快照缓存，不会每 2 秒连一次 CDP）；拿不到就隐藏徽章。
 *   - 只用主题 token（`--dsw-*`）着色，不 import 任何 `@deepseek-ai/dsh-client-*`
 *     包，亮/暗主题都由宿主决定。
 *   - 定时器在组件卸载时清掉，不留后台轮询。
 *
 * 已知取舍：界面文案是硬编码中文，没有走 Client locale 服务（第一版刻意不做，
 * 免得依赖一个可能不存在的服务把界面拖垮）。见 README「限制」。
 */

window.__ModuleLoader__.load({
  id: '@local/doubao-status-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 宿主半注册的只读接口（同源、同一个 DSH 端口）。 */
    const API_PATH = '/doubao-status/api'
    /** 轮询间隔：够快到能看见「已接收 → 工作开始」，又不至于把宿主吵醒。 */
    const POLL_MS = 2000
    /** 侧栏底部的常驻动作位（由 ui-sidebar 声明，list 类型，可多人共用）。 */
    const SLOT = 'sidebar.footer.action'

    /** 任务状态 → 中文（验收要求的那几个词）。 */
    const STATE_TEXT = {
      received: '已接收',
      started: '工作开始',
      progress: '进行中',
      need_input: '需要确认',
      done: '已完成',
      failed: '失败',
    }

    /** 任务状态 → 主题 token（不写死颜色，亮/暗主题各自正确）。 */
    const STATE_TONE = {
      received: 'var(--dsw-alias-state-idle-primary)',
      started: 'var(--dsw-alias-brand-primary)',
      progress: 'var(--dsw-alias-brand-primary)',
      need_input: 'var(--dsw-alias-state-warn-primary)',
      done: 'var(--dsw-alias-state-success-primary)',
      failed: 'var(--dsw-alias-state-error-primary)',
    }

    const IDLE_TONE = 'var(--dsw-alias-state-idle-primary)'

    /** 一条 job 显示成什么字。 */
    function labelOf(job) {
      const base = STATE_TEXT[job.state] ?? String(job.state)
      if (job.state === 'progress' && Number.isFinite(job.percent)) return `${base} ${job.percent}%`
      if (job.terminal !== true && job.stale === true) return `${base}（疑似卡死）`
      return base
    }

    /**
     * 从接口返回的 job 列表里挑「最该显示的那一条」。
     * 优先正在跑的，其次刚结束的（让「已完成」看得见），最后是疑似卡死的。
     * 都没有 → undefined（那一行不显示）。
     */
    function pickJob(jobs) {
      if (!Array.isArray(jobs) || jobs.length === 0) return undefined
      const sorted = [...jobs].sort((left, right) => (left.lastAt ?? 0) - (right.lastAt ?? 0))
      const running = sorted.filter((job) => job.terminal !== true && job.stale !== true)
      if (running.length > 0) return running[running.length - 1]
      const finished = sorted.filter((job) => job.terminal === true)
      if (finished.length > 0) return finished[finished.length - 1]
      return sorted[sorted.length - 1]
    }

    /**
     * 豆包运行时那一行：模式 + 模型。
     * 模式文字直接用页面读到的原文（`本地电脑` / `对话`），不自己翻译；
     * 对话模式明确标出「不回报状态」，因为那正是派发会被拒的原因。
     */
    function runtimeText(runtime) {
      if (runtime === undefined || runtime === null) return ''
      if (runtime.connected !== true) return '豆包未连接'
      const mode =
        runtime.modeRaw || (runtime.mode === 'work' ? '工作模式' : runtime.mode === 'chat' ? '对话' : '模式未知')
      const warn = runtime.capability === 'no' ? '（不回报状态）' : ''
      const model = typeof runtime.model === 'string' && runtime.model.length > 0 ? ` · ${runtime.model}` : ''
      return `${mode}${warn}${model}`
    }

    /** 没有任务时，用模式决定色点颜色：能回报状态=绿，不能=琥珀，读不到=灰。 */
    function runtimeTone(runtime) {
      if (runtime === undefined || runtime === null || runtime.connected !== true) return IDLE_TONE
      if (runtime.capability === 'yes') return 'var(--dsw-alias-state-success-primary)'
      if (runtime.capability === 'no') return 'var(--dsw-alias-state-warn-primary)'
      return IDLE_TONE
    }

    /** 悬停提示：任务与运行时的完整信息（正文可能很长，只放这里）。 */
    function tooltipFor(job, runtime) {
      const parts = []
      if (job !== undefined) {
        parts.push(`任务 ${job.job}：${labelOf(job)}`)
        if (typeof job.step === 'string' && job.step.length > 0) parts.push(`步骤：${job.step}`)
        if (typeof job.message === 'string' && job.message.length > 0) parts.push(`正文：${job.message}`)
      }
      if (runtime !== undefined && runtime !== null) {
        if (runtime.connected !== true) {
          parts.push('豆包未连接：调试端口 9222 未监听（用 --remote-debugging-port=9222 启动豆包）')
        } else {
          const ability =
            runtime.capability === 'yes' ? '可以' : runtime.capability === 'no' ? '不行' : '未知'
          parts.push(`模式：${runtime.modeRaw || runtime.mode}（状态回报：${ability}）`)
          if (typeof runtime.model === 'string' && runtime.model.length > 0) {
            parts.push(`模型：${runtime.model}${runtime.modelLevel ? `（档位 ${runtime.modelLevel}）` : ''}`)
          }
        }
        if (typeof runtime.error === 'string' && runtime.error.length > 0) parts.push(`读取失败：${runtime.error}`)
      }
      return parts.join('\n')
    }

    /** 一个「色点 + 文字」的行。 */
    function line(key, tone, text, extraStyle) {
      return h(
        'div',
        { key, style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, width: '100%', ...extraStyle } },
        [
          h('span', {
            key: 'dot',
            'aria-hidden': true,
            style: { flex: '0 0 auto', width: 8, height: 8, borderRadius: '50%', background: tone },
          }),
          h(
            'span',
            {
              key: 'text',
              style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            },
            text,
          ),
        ],
      )
    }

    /** 侧栏底部的状态徽章。owner 只给一个 `wide`（false = 56px 窄栏）。 */
    function DoubaoStatusBadge({ wide }) {
      // null = 「还没拿到可信数据」或「接口不通」；这两种情况都隐藏徽章。
      const [data, setData] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        let timer = null
        const tick = () => {
          let request
          try {
            request = fetch(API_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' })
          } catch {
            if (alive) setData(null)
            return
          }
          request
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
            .then((payload) => {
              if (alive) setData(payload !== null && typeof payload === 'object' ? payload : null)
            })
            .catch(() => {
              // 接口没挂上 / 网络抖动 / 返回的不是 JSON（例如 SPA fallback 的 HTML）：
              // 当作「没有可显示的状态」，不是错误状态。
              if (alive) setData(null)
            })
        }
        tick()
        timer = setInterval(tick, POLL_MS)
        return () => {
          alive = false
          if (timer !== null) clearInterval(timer)
        }
      }, [])

      if (data === null) return null
      const runtime = data.doubao
      const job = pickJob(data.jobs)
      const runtimeLabel = runtimeText(runtime)
      if (job === undefined && runtimeLabel.length === 0) return null

      const taskTone = job === undefined ? runtimeTone(runtime) : STATE_TONE[job.state] ?? IDLE_TONE
      const taskLabel = job === undefined ? runtimeLabel : labelOf(job)
      const showSecondLine = job !== undefined && runtimeLabel.length > 0

      return h(
        'div',
        {
          'data-dsh-plugin': 'doubao-status-panel',
          'data-dsh-part': 'badge',
          'data-doubao-state': job === undefined ? 'idle' : job.state,
          'data-doubao-mode': (runtime && runtime.mode) || 'unknown',
          role: 'status',
          'aria-label': `豆包：${taskLabel}`,
          title: tooltipFor(job, runtime),
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            justifyContent: 'center',
            gap: 2,
            minWidth: 0,
            maxWidth: '100%',
            boxSizing: 'border-box',
            padding: wide ? '4px 8px' : '6px',
            borderRadius: wide ? 10 : '50%',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: 12,
            lineHeight: '16px',
          },
        },
        wide
          ? [
              line('main', taskTone, taskLabel),
              showSecondLine
                ? line('runtime', runtimeTone(runtime), runtimeLabel, {
                    color: 'var(--dsw-alias-label-secondary)',
                    fontSize: 11,
                    lineHeight: '14px',
                  })
                : null,
            ]
          : [
              // 窄栏（56px rail）：只放一个状态色点，任务优先、否则表示模式。
              h('span', {
                key: 'dot',
                'aria-hidden': true,
                style: { alignSelf: 'center', width: 8, height: 8, borderRadius: '50%', background: taskTone },
              }),
            ],
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 槽注册整体包 try/catch：注册到未声明的槽会在加载时抛错，而一个装饰
        // 组件出错不应该让整个界面起不来。
        try {
          ctx.slots.inject(SLOT, () => {
            try {
              return ctx.slots.register({ name: SLOT, id: 'doubao-status-panel', order: 5 }, DoubaoStatusBadge)
            } catch {
              return () => {}
            }
          })
        } catch {
          /* 静默：没有徽章也比白屏好 */
        }
      },
    }
  },
})
