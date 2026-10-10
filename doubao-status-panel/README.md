# doubao-status-panel —— DSH Web 里的豆包任务状态徽章

把 `doubao-cdp` 的状态文件（`status.jsonl`）实时显示在 **DSH Web 界面侧栏底部**：
派发出去就显示「已接收」，豆包开工显示「工作开始」，然后「进行中 40%」，
最后「已完成」/「失败」；没有活跃任务时徽章**不占位置**。

以前只能 `node status.mjs list` 看状态，派发完还得切终端；这个插件把那一步搬进界面。

## 它长什么样

侧栏底部、设置按钮旁边多一枚小徽章（`sidebar.footer.action` 槽）：

| 状态 | 显示 | 颜色来源（主题 token） |
| --- | --- | --- |
| `received` | 已接收 | `--dsw-alias-state-idle-primary` |
| `started` | 工作开始 | `--dsw-alias-brand-primary` |
| `progress` | 进行中 40% | `--dsw-alias-brand-primary` |
| `need_input` | 需要确认 | `--dsw-alias-state-warn-primary` |
| `done` | 已完成 | `--dsw-alias-state-success-primary` |
| `failed` | 失败 | `--dsw-alias-state-error-primary` |

- 窄栏（56px rail）只显示一个状态色点，宽栏才带文字；鼠标悬停有 `job / 步骤 / 正文` 提示。
- 状态变化后 `已完成` 会再留 60 秒（`TERMINAL_LINGER_MS`），否则一发终态徽章就消失，看不见结果。
- 接口不通、或还没有任何任务 → 徽章隐藏，不显示错误、不弹东西。

## 五个文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle 清单：`exports` + `dsh.bundle.patch` + `dsh.client{platform:web, immediately:true, inject:["@deepseek-ai/dsh-client-ui-sidebar"]}` |
| `cordis.patch.yml` | 往 profile 插入一行插件行 `@local/doubao-status-panel` |
| `index.js` | **宿主半**：只读接口 `GET /doubao-status/api`，复用 DSH 自己的 webServer（不新开端口） |
| `client.js` | **浏览器半**：模块装载器格式，注册侧栏徽章，每 2 秒轮询接口 |
| `panel-selftest.mjs` | 密封测试：接口只读性、路径、状态折叠，不需要 DSH 也不需要豆包 |

宿主半**不引用任何 `@deepseek-ai/*` 运行时包**，只 import node 内置与同工作区的
`../doubao-cdp/status.mjs`（复用 `readStatusEvents` / `foldByJob` / `openJobs` / `loadConfig`）。
所以它是「一个真实文件」的薄转换层：既能脱离 DSH 做密封测试，也不会因为状态折叠
逻辑分叉出第二份实现。客户端半也不 import 任何 DSH 客户端包，只用主题 token。

## 接口

```
GET /doubao-status/api
```

```json
{
  "ok": true,
  "file": "C:\\Users\\<you>\\.dsh\\mcp-connector\\status.jsonl",
  "now": 1791623413590,
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
node panel-selftest.mjs        # 接口只读性 / 路径 / 折叠（无需 DSH、无需豆包）
node ..\doubao-cdp\status-selftest.mjs   # received 的写入、折叠、忙闲
node ..\doubao-cdp\dispatch-selftest.mjs # --no-send 不写 received；started 覆盖 received
```

接口通不通（DSH Web 起着的时候）：

```powershell
curl.exe -s http://127.0.0.1:43120/doubao-status/api
curl.exe -s -o NUL -w "%{http_code}`n" -X POST http://127.0.0.1:43120/doubao-status/api   # 期望 405
# 围栏：伪造一个非回环 Host，期望 403（证明没有绕过 GUI 鉴权）
curl.exe -s -o NUL -w "%{http_code}`n" -H "Host: 192.168.1.50:43120" http://127.0.0.1:43120/doubao-status/api   # 期望 403
```

真机验证要「看到界面上的变化」，不是只看到 JSON：派发一条真任务，看徽章走
`已接收 → 工作开始 → 进行中 → 已完成`。

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
