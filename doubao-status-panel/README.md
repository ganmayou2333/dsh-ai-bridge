# doubao-status-panel —— DSH Web 里的豆包状态徽章

把 `doubao-cdp` 的状态显示在 **DSH Web 界面侧栏底部**，两行都是只读的：

1. **任务状态**：派发出去就显示「已接收」，豆包开工显示「工作开始」，然后「进行中 40%」，
   最后「已完成」/「失败」；
2. **豆包运行时**（常驻）：当前**模式**（`本地电脑` / `对话`）+ 当前**模型**
   （例如「豆包 2.1 Lite」）。「是不是工作模式」直接决定豆包能不能回报状态——
   派发之前就该看得见，而不是被拒之后才知道；**不是工作模式时还给一个 `切到工作` 按钮**，
   点一下就把豆包切过去（并重新读一遍确认真的切成了）。

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
| 对话模式 | `对话（不回报状态） · 豆包 快速` **+ `切到工作` 按钮** | 琥珀（`state-warn-primary`，就是会被派发拒绝的那档） |
| 豆包没带调试端口 | `豆包未连接` | 灰（`state-idle-primary`） |
| 没有任务时 | 只有运行时那一行 | 按模式定 |

- **`切到工作` 按钮只在「豆包在线且不是工作模式」时出现**：点它就把豆包切到「本地电脑」（工作模式），
  成功后立刻重取（不用等下一个轮询）。工作模式或未连接时它不显示——那种情况下它没有意义。
  切换失败按钮变红色「重试」，悬停能看到失败原因（**不假装成功**）。
- 鼠标悬停有完整提示：`job / 步骤 / 正文`、模式与「状态回报：可以/不行」、模型档位、读取失败原因。
- 状态变化后 `已完成` 会再留 60 秒（`TERMINAL_LINGER_MS`），否则一发终态徽章就消失，看不见结果。
- 接口本身不通（宿主半没挂上）→ 徽章隐藏；**豆包没开**不算接口故障，会照实显示「豆包未连接」。

## 六个文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle 清单：`exports` + `dsh.bundle.patch` + `dsh.client{platform:web, immediately:true, inject:["@deepseek-ai/dsh-client-ui-sidebar"]}` |
| `cordis.patch.yml` | 往 profile 插入一行插件行 `@local/doubao-status-panel` |
| `index.js` | **宿主半**：只读接口 `GET /doubao-status/api` + 模式切换 `POST /doubao-status/api/mode`，复用 DSH 自己的 webServer（不新开端口） |
| `client.js` | **浏览器半**：模块装载器格式，注册侧栏徽章，每 2 秒轮询接口；不是工作模式时给出「切到工作」按钮 |
| `panel-selftest.mjs` | 密封测试：接口只读性、来源围栏、路径解析、状态折叠、运行时快照与缓存、模式切换端点的白名单/围栏/失败语义，不需要 DSH 也不需要豆包 |
| `README.md` | 本文件 |

宿主半**不引用任何 `@deepseek-ai/*` 运行时包**，只 import node 内置与同工作区的
`../doubao-cdp/status.mjs`（复用 `readStatusEvents` / `foldByJob` / `openJobs` / `loadConfig`）。
「模式 + 模型」与「切换模式」则 **spawn `../doubao-cdp/cdp.mjs state|mode`**（DOM 选择器与点击逻辑
只有那一份实现），宿主半自己不连 CDP。客户端半也不 import 任何 DSH 客户端包，只用主题 token。

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

### 模式切换（写端点，单独一条路径）

```
POST /doubao-status/api/mode
Content-Type: application/json

{"mode": "work"}      # 或 "chat"
```

```json
{ "ok": true, "changed": true, "modeBefore": "chat", "modeAfter": "work",
  "option": "工作任务\n本地电脑", "mode": "work" }
```

**写操作比读操作严**（这条会点你的豆包界面）：

- **单独路径**：只读接口继续只认 `GET`，这条只认 `POST`（其余 `405` + `Allow: POST`）。
- **只放行本机**：同一个来源围栏；LAN 来源 `403` 且**根本不会去点**。
- **模式白名单**：只接受 `work` / `chat`，其它值 `400`，**不会**透传成任何命令。
- **成败以只读复核为准**：底层 `cdp.mjs mode` 点完之后会重新读一次模式，读不到目标就算失败；
  接口原样返回 `modeBefore` / `modeAfter`，让你能看出到底发生了什么。
- 切换失败是**预期结果**（豆包没开 / 菜单没找到）：返回 `200` + `ok:false` + `error`，
  不是 500——「豆包没开」不是「接口坏了」。
- 成功后立刻让快照缓存失效，面板下一次轮询就能看到新模式（否则还会显示 15 秒旧模式）。
- 超时**不当成失败**：返回 `unsettled:true` + 「结果未知」，因为 `cdp` 可能已经点成功了——
  这时该做的是去读一次 `state`，而不是谎报失败。

命令行等价物（双向都能切；面板 UI 只提供「切到工作」这一个方向）：

```powershell
node ..\doubao-cdp\cdp.mjs mode work [--json]
node ..\doubao-cdp\cdp.mjs mode chat [--json]
```

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
node panel-selftest.mjs        # 只读性 / 围栏 / 路径 / 折叠 / 快照与缓存 / 模式切换端点的白名单与失败语义
node ..\doubao-cdp\status-selftest.mjs    # received 的写入、折叠、忙闲
node ..\doubao-cdp\dispatch-selftest.mjs  # --no-send 不写 received；started 覆盖 received
node ..\doubao-cdp\preflight-selftest.mjs # 模式/模型文字的拆分；state 是读数不是闸门；mode 的非法目标与离线语义
```

只看「模式 + 模型」、以及切换模式（不经过界面，直接问 cdp）：

```powershell
node ..\doubao-cdp\cdp.mjs state          # 人类可读
node ..\doubao-cdp\cdp.mjs state --json   # 结构化（面板宿主半用的就是这条）
node ..\doubao-cdp\cdp.mjs mode work      # 切到「本地电脑」（工作模式）
node ..\doubao-cdp\cdp.mjs mode chat      # 切回「对话」
```

接口通不通、能不能切（DSH Web 起着的时候）：

```powershell
curl.exe -s http://127.0.0.1:43120/doubao-status/api
curl.exe -s -o NUL -w "%{http_code}`n" -X POST http://127.0.0.1:43120/doubao-status/api   # 期望 405
# 围栏：伪造一个非回环 Host，期望 403（证明没有绕过 GUI 鉴权）
curl.exe -s -o NUL -w "%{http_code}`n" -H "Host: 192.168.1.50:43120" http://127.0.0.1:43120/doubao-status/api   # 期望 403
# 模式切换端点（写操作）：只认 POST，且只放行本机
curl.exe -s -X POST -H "content-type: application/json" -d '{\"mode\":\"work\"}' http://127.0.0.1:43120/doubao-status/api/mode
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:43120/doubao-status/api/mode                                       # 期望 405
curl.exe -s -o NUL -w "%{http_code}`n" -H "Host: 192.168.1.50:43120" -X POST -d '{\"mode\":\"work\"}' http://127.0.0.1:43120/doubao-status/api/mode   # 期望 403
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
| 模式切换（写操作） | **已确认**（真豆包，双向）：`cdp.mjs mode chat` → `{ok:true, changed:true, modeBefore:"work", modeAfter:"chat", option:"对话"}`；`cdp.mjs mode work` → `{ok:true, changed:true, modeBefore:"chat", modeAfter:"work", option:"工作任务\n本地电脑"}`；再切一次 work → `changed:false`（幂等，不白点）。每次都再用 `state` 复核过 |
| 模式与模型是绑定的 | **实测**：对话模式是 `豆包 快速`，切到工作模式后变成 `豆包 2.1 Lite（档位 低）`——徽章上两行会一起变 |
| 快照缓存的真机行为 | **已确认**：切换后接口在 TTL 内仍返回旧的 `chat`，跨过 15 秒自动刷新为 `work`（正是设计行为） |
| 界面上的「模式 + 模型」 | **待确认**：宿主半改了源码，需要重启 DSH Web 才会加载新代码（见上） |
| 界面上的「切到工作」按钮 | **待确认**：同上；端点本身的逻辑已由密封测试与 `cdp.mjs mode` 真机切换覆盖 |

## 限制（第一版刻意不做的事）

- 界面文案硬编码中文，没有走 Client locale 服务——少一个可能不存在的依赖，
  界面的可用性优先。要多语言时再补 `ctx.locale.register`。
- 任务那一行不可点击（点开历史列表/详情是后续的事）；**只有「切到工作」按钮是可点的**。
- 轮询（2 秒）而不是事件推送：状态文件是本地追加型 JSONL，轮询足够且没有长连接风险。
- 只显示「最近一条」job，历史仍在 `node status.mjs list` 里。
- `stale`（>10 分钟无事件）在界面上只体现为「疑似卡死」后缀，不自动收尾——收尾是派发器的职责。
- **远程访问时徽章隐藏**：来源围栏只放行本机。想从 LAN / 手机看，就把 `index.js` 里
  `createStatusRoutes` 的 `fence` 换成 `() => true`——那等于把任务状态开给同网段，请先想清楚。
  改宿主半之后要重启 DSH Web（模块缓存）。
- **徽章常驻**：为了让你随时看到「是不是工作模式」，没有任务时也不隐藏（只剩运行时那一行）。
  想在豆包没连接时彻底隐藏，改 `client.js` 里 `runtimeText()` 返回空串的分支即可。
- **运行时快照依赖豆包的 DOM**：模型来自 `[data-testid=chat_input_action_model]`，档位来自它内部
  的 `text-dbx-text-tertiary` span。豆包改版换了选择器 → 模型会显示为空（不显示错的），
  模式读取则一直有 `cdp.mjs doctor` 那一套兜底。
- **模式切换也是在点豆包的 UI**（模式控件 → 菜单里选目标项），所以它跟 DOM 一样脆：
  豆包改版后 `cdp.mjs mode` 会报「找不到模式控件 / 菜单里没找到目标选项」而不是乱点。
  失败时**不会**有任何副作用被假装成成功：接口返回 `ok:false` + 原因，徽章按钮变红。真机上
  菜单项与控件都会出现「对话」两个字，所以实现是先在浮层里定位、再只在浮层内找行
  （见 `cdp.mjs` 的 `modeOptionRect`），避免误点页面别处的同名标签。
- **UI 只提供「切到工作」一个方向**：反向（切回对话）用 `cdp.mjs mode chat`。少一个按钮就少一次误点。
- **模型是「显示」不是「选择」**：面板不会替你换模型。真机上模式与模型绑定，切模式会连带换模型。
