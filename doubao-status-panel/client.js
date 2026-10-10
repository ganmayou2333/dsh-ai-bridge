/**
 * doubao-status-panel —— 浏览器半：侧栏底部的一枚状态徽章。
 *
 * 这不是普通 ESM，而是 DSH 的模块装载器格式：`window.__ModuleLoader__.load`
 * 注册一个懒工厂，React 由浏览器的模块表提供（`require('react')`），所以不需要
 * tsc/tsdown 之类的构建链，手写即可。
 *
 * 纪律（对应验收标准与技能要求）：
 *   - **注册一律 try/catch**：槽未声明或注册表不可用时静默不显示，绝不把整个
 *     Web 界面拖垮。第一版极小。
 *   - 每 2 秒轮询宿主半的**只读**接口 `/doubao-status/api`，拿不到就隐藏徽章
 *     （不显示错误、不弹东西）。
 *   - 只用主题 token（`--dsw-*`）着色，不 import 任何 `@deepseek-ai/dsh-client-*`
 *     包，这样亮/暗主题都由宿主决定。
 *   - 定时器在组件卸载时清掉（`useEffect` 的 cleanup），不留后台轮询。
 *   - 没有活跃 job 时返回 null —— 平常它就不占位置。
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

    /** 状态 → 中文（验收要求的那几个词）。 */
    const STATE_TEXT = {
      received: '已接收',
      started: '工作开始',
      progress: '进行中',
      need_input: '需要确认',
      done: '已完成',
      failed: '失败',
    }

    /** 状态 → 主题 token（不写死颜色，亮/暗主题各自正确）。 */
    const STATE_TONE = {
      received: 'var(--dsw-alias-state-idle-primary)',
      started: 'var(--dsw-alias-brand-primary)',
      progress: 'var(--dsw-alias-brand-primary)',
      need_input: 'var(--dsw-alias-state-warn-primary)',
      done: 'var(--dsw-alias-state-success-primary)',
      failed: 'var(--dsw-alias-state-error-primary)',
    }

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
     * 都没有 → undefined → 徽章隐藏。
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

    /** 侧栏底部的状态徽章。owner 只给一个 `wide`（false = 56px 窄栏）。 */
    function DoubaoStatusBadge({ wide }) {
      // null = 「还没拿到可信数据」或「接口不通」；这两种情况都隐藏徽章。
      const [jobs, setJobs] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        let timer = null
        const tick = () => {
          let request
          try {
            request = fetch(API_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' })
          } catch {
            if (alive) setJobs(null)
            return
          }
          request
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
            .then((data) => {
              if (alive) setJobs(Array.isArray(data?.jobs) ? data.jobs : [])
            })
            .catch(() => {
              // 接口没挂上 / 网络抖动 / 返回的不是 JSON（例如 SPA fallback 的 HTML）：
              // 当作「没有可显示的状态」，不是错误状态。
              if (alive) setJobs(null)
            })
        }
        tick()
        timer = setInterval(tick, POLL_MS)
        return () => {
          alive = false
          if (timer !== null) clearInterval(timer)
        }
      }, [])

      const job = pickJob(jobs)
      if (job === undefined) return null

      const text = labelOf(job)
      const detail = [job.job, text, job.step, job.message].filter((part) => typeof part === 'string' && part.length > 0).join(' · ')

      return h(
        'div',
        {
          'data-dsh-plugin': 'doubao-status-panel',
          'data-dsh-part': 'badge',
          'data-doubao-state': job.state,
          role: 'status',
          'aria-label': `豆包任务状态：${text}`,
          title: detail,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: wide ? 'flex-start' : 'center',
            gap: 6,
            minWidth: 0,
            maxWidth: '100%',
            boxSizing: 'border-box',
            padding: wide ? '4px 8px' : '6px',
            borderRadius: wide ? 999 : '50%',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: 12,
            lineHeight: '16px',
          },
        },
        [
          h('span', {
            key: 'dot',
            'aria-hidden': true,
            style: {
              flex: '0 0 auto',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: STATE_TONE[job.state] ?? 'var(--dsw-alias-state-idle-primary)',
            },
          }),
          wide
            ? h(
                'span',
                {
                  key: 'text',
                  style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                },
                text,
              )
            : null,
        ],
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 槽注册整体包 try/catch：注册到未声明的槽会在加载时抛错，而一个装饰
        // 组件出错不应该让整个界面起不来（第一版的首要目标是「不添乱」）。
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
