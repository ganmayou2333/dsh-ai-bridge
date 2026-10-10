# doubao-status-panel —— DSH Web 里的豆包状态徽章

把 `doubao-cdp` 的状态显示在 **DSH Web 界面侧栏底部**，两行都是只读的：

1. **任务状态**：派发出去就显示「已接收」，豆包开工显示「工作开始」，然后「进行中 40%」，
   最后「已完成」/「失败」；
2. **豆包运行时**（常驻）：当前**模式**（`本地电脑` / `对话`）+ 当前**模型**
   （例如「豆包 2.1 Lite」）。「是不是工作模式」直接决定豆包能不能回报状态——
   派发之前就该看得见，而不是被拒之后才知道。

以前只能 `node status.mjs list` 看状态、只能 `node cdp.mjs doctor` 看模式；这个插件把那两步搬进界面。

## 它长什么样

侧栏底部、设置按钮旁边一枚小徽章（`sidebar.footer.action` 槽）。宽栏两行，窄栏（56px）只有一个色点。

任务那一行：

| 状态 | 显示 | 颜色来源（主题 token） |
| --- | --- | --- |
| `received` | 已接收 | `--dsw-alias-state-idle-primary` |
| `started` | 工作开始 | `--dsw-alias-brand-primary` |
| `progress` | 进行中 40% | `--dsw-alias-brand-primary` |
| `need_input` | 需要确认 | `--dsw-alias-state-warn-primary` |
| `done` | 已完成 | `--dsw-alias-state-success-primary` |
| `failed` | 失败 | `--dsw-alias-state-error-primary` |

运行时那一行（常驻）：

| 情况 | 显示 | 色点 |
| --- | --- | --- |
| 工作模式 | `本地电脑 · 豆包 2.1 Lite` | 绿（`state-success-primary`） |
| 对话模式 | `对话（不回报状态） · 豆包 2.1 Lite` | 琥珀（`state-warn-primary`，就是会被派发拒绝的那档） |
| 豆包没带调试端口 | `豆包未连接` | 灰（`state-idle-primary`） |
| 没有任务时 | 只有运行时那一行 | 按模式定 |

- 鼠标悬停有完整提示：`job / 步骤 / 正文`、模式与「状态回报：可以/不行」、模型档位、读取失败原因。
- 状态变化后 `已完成` 会再留 60 秒（`TERMINAL_LINGER_MS`），否则一发终态徽章就消失，看不见结果。
- 接口本身不通（宿主半没挂上）→ 徽章隐藏；**豆包没开**不算接口故障，会照实显示「豆包未连接」。

## 六个文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle 清单：`exports` + `dsh.bundle.patch` + `dsh.client{platform:web, immediately:true, inject:["@deepseek-ai/dsh-client-ui-sidebar"]}` |
| `cordis.patch.yml` | 往 profile 插入一行插件行 `@local/doubao-status-panel` |
| `index.js` | **宿主半**：只读接口 `GET /doubao-status/api`，复用 DSH 自己的 webServer（不新开端口） |
| `client.js` | **浏览器半**：模块装载器格式，注册侧栏徽章，每 2 秒轮询接口 |
| `panel-selftest.mjs` | 密封测试：接口只读性、来源围栏、路径解析、状态折叠、运行时快照与缓存，不需要 DSH 也不需要豆包 |
| `README.md` | 本文件 |

宿主半**不引用任何 `@deepseek-ai/*` 运行时包**，只 import node 内置与同工作区的
`../doubao-cdp/status.mjs`（复用 `readStatusEvents` / `foldByJob` / `openJobs` / `loadConfig`）。
「模式 + 模型」则 **spawn `../doubao-cdp/cdp.mjs state --json`** 拿（DOM 选择器只有那一份实现），
宿主半自己不连 CDP。客户端半也不 import 任何 DSH 客户端包，只用主题 token。

## 接口

```
GET /doubao-status/api
```

```json
{
  "ok": true,
  "file": "C:\\Users\\<you>\\.dsh\\mcp-connector\\status.jsonl",
  "now": 1791623413590,
  "doubao": {
    "connected": true,
    "mode": "work",
    "modeRaw": "本地电脑",
    "capability": "yes",
    "model": "豆包 2.1 Lite",
    "modelLevel": "低",
    "at": 1791623413000
  },
  "jobs": [
    {
      "job": "DISPATCH-ff00aa",
      "state": "progress",
      "phase": "started",
      "terminal": false,
      "percent": 40,
      "step": "拉取",
      "message": "正在拉取",
      "receivedAt": 1791623410000,
      "startedAt": 1791623412000,
      "lastAt": 1791623413500,
      "idleMs": 90,
      "stale": false
    }
  ]
}
```

- **只读**：只有 `GET`，其余方法一律 `405` + `Allow: GET`，不解析请求体。
- **来源围栏**：只放行**本机**请求（回环 socket + 回环 `Host`，非跨站）。理由是真机实测：
  DSH 的 web 服务监听 `0.0.0.0:43120`，而 GUI 页面本身对非本机访问要鉴权（`GET /` 返回 `401`）；
  插件路由跑在鉴权之前，没有围栏就等于**绕过 GUI 的鉴权**，把 job id / 正文 / 结果摘要
  暴露给同网段的人。非本机来源返回 `403 {"ok":false,"code":"forbidden"}`，且**不读数据**。
  代价：从 LAN 地址打开 GUI 时徽章会隐藏（拿不到数据就隐藏，见「限制」）。
- **不新增端口**：注册在 DSH 自己的 webServer 上（本机是 43120），路径是相对路径。
- `doubao` = 豆包运行时快照，来自 `cdp.mjs state --json`（只读两个 `data-testid` 的文字，
  不点、不改）。**带 15 秒缓存**（`DOUBAO_STATE_TTL_MS`）：面板每 2 秒轮询，但不会每 2 秒
  连一次 CDP；缓存过期时**先把旧值交出去**再后台刷新，所以响应不会被一次 CDP 往返拖住。
  豆包没开时是 `{"connected":false,"mode":"unknown","error":"..."}`——**降级，不是 500**。
- `jobs` = 还占着的 job（`received` / `started` / `progress` / `need_input`，含疑似卡死）
  **加上** 60 秒内刚终结的 job（让「已完成」看得见），按 `lastAt` 升序。
- 状态文件不存在/无事件 → `200` + `jobs: []`；读取代码本身抛错才 `500`。

## 安装 / 回滚

```powershell
# 安装（link: 指向本目录，改代码即改插件，不需要重新发布；路径换成你自己的）
dsh plugin --profile web add link:<本目录的绝对路径>

# 回滚
dsh plugin --profile web remove @local/doubao-status-panel
```

装完**刷新或重启 DSH Web**。真机实测：宿主半的**模块代码在进程启动时就已加载**，改源码后
连「禁用再启用插件」都不会重新 import（Node 的模块缓存），所以改了宿主半必须**重启 DSH Web**，
只刷新页面只能更新客户端半。

前提：`doubao-status.ini` 的 `enabled` 列表必须包含 `received`，否则状态脚本会按设计
**静默 no-op**，面板就看不到「已接收」这一步。默认值已包含；用旧 ini 的话手动加一项。

## 验证（只信副作用）

```powershell
node panel-selftest.mjs        # 接口只读性 / 来源围栏 / 路径解析 / 折叠 / 快照与缓存（无需 DSH、无需豆包）
node ..\doubao-cdp\status-selftest.mjs    # received 的写入、折叠、忙闲
node ..\doubao-cdp\dispatch-selftest.mjs  # --no-send 不写 received；started 覆盖 received
node ..\doubao-cdp\preflight-selftest.mjs # 模式/模型文字的拆分；state 是读数不是闸门
```

只看「模式 + 模型」（不经过界面，直接问 cdp）：

```powershell
node ..\doubao-cdp\cdp.mjs state          # 人类可读
node ..\doubao-cdp\cdp.mjs state --json   # 结构化（面板宿主半用的就是这条）
```

接口通不通（DSH Web 起着的时候）：

```powershell
curl.exe -s http://127.0.0.1:43120/doubao-status/api
curl.exe -s -o NUL -w "%{http_code}`n" -X POST http://127.0.0.1:43120/doubao-status/api   # 期望 405
# 围栏：伪造一个非回环 Host，期望 403（证明没有绕过 GUI 鉴权）
curl.exe -s -o NUL -w "%{http_code}`n" -H "Host: 192.168.1.50:43120" http://127.0.0.1:43120/doubao-status/api   # 期望 403
```

真机验证要「看到界面上的变化」，不是只看到 JSON：派发一条真任务，看徽章走
`已接收 → 工作开始 → 进行中 → 已完成`，并确认运行时那一行显示的正是豆包 App 里
选中的模式与模型。

### 实测记录（2026-10-10，本机）

| 项 | 结果 |
| --- | --- |
| 宿主半已挂载 | `GET /doubao-status/api` → `200` + JSON；`POST` → `405`；伪造非回环 `Host` → `403`（围栏生效） |
| 路径正确 | 接口返回 `file` = `%USERPROFILE%\.dsh\mcp-connector\status.jsonl`，`warnings` 为空（宿主进程没有 `DSH_HOME`，靠 `resolveStatusEnv` 回退；修之前它读的是 `~\.dsh-mcp-connector`） |
| 客户端半已注册 | `Slots` 查询 `sidebar.footer.action` 的占用者含 `doubao-status-panel`（order 5，active） |
| **界面渲染** | **已确认**：侧栏最底部（齿轮「设置」行上方）出现胶囊徽章，灰点 + 文字「已接收」 |
| 状态推进 | 用真实 `status.mjs` 写入一条合成 job（`PANEL-VISUAL-*`，5～7 个阶段、每阶段 20 秒），状态文件与接口逐条返回 `received → started → progress 35% → progress 70% → done`；界面上的**逐阶段切换**没有逐帧截图 |
| 真任务（豆包） | **已完成**：chat 模式（带 `--force`，因为对话模式没有 shell）真发一条，豆包真回复「做不到 / 2+2 等于 4」，7 秒内状态文件写下 `received → done`，接口返回 `state:done`，退出码 0 |
| 模式 + 模型读取 | **已确认**（真豆包）：`cdp.mjs state --json` → `{connected:true, mode:"work", modeRaw:"本地电脑", capability:"yes", model:"豆包 2.1 Lite", modelLevel:"低"}`；宿主半走真实链路（真路由 + 真 spawn，`DSH_HOME` 清空模拟宿主进程）也拿到同一份快照 |
| 界面上的「模式 + 模型」 | **待确认**：宿主半改了源码，需要重启 DSH Web 才会加载新代码（见上） |

## 限制（第一版刻意不做的事）

- 界面文案硬编码中文，没有走 Client locale 服务——少一个可能不存在的依赖，
  界面的可用性优先。要多语言时再补 `ctx.locale.register`。
- 徽章不可点击：第一版只做「看得见」；点开历史列表/详情是后续的事。
- 轮询（2 秒）而不是事件推送：状态文件是本地追加型 JSONL，轮询足够且没有长连接风险。
- 只显示「最近一条」job，历史仍在 `node status.mjs list` 里。
- `stale`（>10 分钟无事件）在界面上只体现为「疑似卡死」后缀，不自动收尾——收尾是派发器的职责。
- **远程访问时徽章隐藏**：来源围栏只放行本机。想从 LAN / 手机看，就把 `index.js` 里
  `createStatusRoutes` 的 `fence` 换成 `() => true`——那等于把任务状态开给同网段，请先想清楚。
  改宿主半之后要重启 DSH Web（模块缓存）。
- **徽章现在常驻**：为了让你随时看到「是不是工作模式」，没有任务时也不隐藏（只剩运行时那一行）。
  想在豆包没连接时彻底隐藏，改 `client.js` 里 `runtimeText()` 返回空串的分支即可。
- **运行时快照依赖豆包的 DOM**：模型来自 `[data-testid=chat_input_action_model]`，档位来自它内部
  的 `text-dbx-text-tertiary` span。豆包改版换了选择器 → 模型会显示为空（不显示错的），
  模式读取则一直有 `cdp.mjs doctor` 那一套兜底。这条路径**只读**，不点任何控件、不切模式、不换模型。
- **模型是「显示」不是「选择」**：面板不会替你切模型（那需要点豆包的 UI，属于写操作）。
