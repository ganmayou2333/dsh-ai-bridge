# doubao-cdp

用 Chrome DevTools Protocol 驱动**豆包桌面版**（Electron），把任务直接下发到它的聊天框，并读回回复。

零依赖：Node 24 自带全局 `WebSocket`，直接跟 CDP 通信，不需要 puppeteer / playwright。

## 前提：豆包必须带调试端口启动

CDP 只在启动时决定，运行中的实例无法挂载。所以需要（一次）：

```powershell
Get-Process Doubao -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process "C:\Program Files\Doubao\app\Doubao.exe" -ArgumentList '--remote-debugging-port=9222','--remote-allow-origins=*'
```

验证：

```powershell
Invoke-WebRequest http://127.0.0.1:9222/json/version
```

恢复常态（关掉调试端口）：退出豆包后正常启动即可，不要带参数。

## 用法

```powershell
cd C:\tools\doubao-cdp
node cdp.mjs targets              # 列出所有 CDP 目标
node cdp.mjs doctor               # 连接前确认：豆包是否可被驱动（不连也行）
node cdp.mjs probe                # 找输入框候选
node cdp.mjs send "任务文本"      # 聚焦输入框 → 插入文本 → 点发送 → 确认已提交
node cdp.mjs wait 120000          # 等这一轮答复稳定，打印回复
node cdp.mjs read 6               # 读最近 n 条消息（标注 user / assistant）
node cdp.mjs click <x> <y>        # 真实鼠标点击
node cdp.mjs key s --ctrl --shift # 原生按键（合成 KeyboardEvent 会被应用忽略）
node cdp.mjs eval "<js>"          # 在页面求值
```

一次完整的下发：

```powershell
node cdp.mjs send "帮我查一下明天上海天气" ; node cdp.mjs wait 180000
```

`send` 成功时会打印 `sent via send button: ...`；若输入框没清空会直接报错，不会假装成功。

## 连接前先确认：`doctor` 与退出码 3

**每一条命令在连豆包之前都会先做一次启动确认。** 原因很实际：原来的失败长这样——

```
error: fetch failed
```

这句话没告诉用户任何事情，而实际上有三种完全不同的状态，处理方式也完全不同：

| 状态 | 说明 |
|---|---|
| 豆包没运行 | 去启动它 |
| **豆包在运行，但没开调试端口** | 它当初是正常启动的，**必须带参数重启**才能被驱动（最常见） |
| 端口通但没有匹配的页面 | 调试开着，但豆包停在别的视图（启动页 / 登录页） |

确认失败时打印的是这种可操作的报告，而不是 `fetch failed`：

```
豆包启动确认
  调试端口 127.0.0.1:9222 : 未监听（ECONNREFUSED）
  豆包进程                 : 运行中 (14 个进程，主进程 PID 35792)
  可执行文件               : C:\Program Files\Doubao\app\Doubao.exe  (来源: 运行中的进程)

  ✗ 不能连接：豆包正在运行，但没有开调试端口。
    也就是说它当初是正常启动的，需要带参数重启才能被驱动：
      1) 退出豆包
      2) 运行：
         "C:\Program Files\Doubao\app\Doubao.exe" --remote-debugging-port=9222 --remote-allow-origins=*
```

- 退出码 **3 = 豆包未就绪**，与 `1`（一般错误）、`2`（等待超时）区分开，方便脚本判断。
- `node cdp.mjs doctor` 单独跑这段确认（就绪退 0，未就绪退 3）。
- 确认只**检测与说明，不会去结束或重启豆包**——那属于你的操作。
- `--no-preflight` 可跳过（不推荐；跳过后又会退回 `error: fetch failed`）。
- 端口用 `DOUBAO_CDP_PORT`（兼容旧的 `CDP_PORT`）覆盖，可执行文件路径用 `DOUBAO_BIN` 指定。

派发器同样受这条闸门保护，而且**确认在任何副作用之前**：队列模式下如果确认不过，**不会往队列里留下任何任务**（这一点有断言钉着）。`--no-send` 的密封模式不需要豆包。

## 这个应用的 DOM 锚点（2026-10-01 实录，豆包 Chromium 147）

| 用途 | 锚点 |
|---|---|
| 聊天页面 target | url 含 `doubao-chat/chat`（另有 `doubao-launcher/chat`、`doubao-background`、drive iframe，别选错） |
| 输入框 | `.tiptap.ProseMirror`（contenteditable） |
| 发送按钮 | `.send-btn-wrapper` |
| 消息容器 | `[data-testid="message-list"]` |
| 单条消息 | `[data-testid="union_message"]` |
| 用户消息 | `[data-testid="send_message"]` |
| 助手消息 | `[data-testid="receive_message"]` |
| 消息正文 | `[data-testid="message_text_content"]` |

## `dispatch.mjs`：带副作用校验的派发器

```powershell
# 聊天模式：把任务发进去，返回它的回复
node dispatch.mjs "用一句话说明你在做什么"
node dispatch.mjs "做个调研" --status        # 聊天模式也带上状态契约（默认不带）

# 队列模式：入队 → 让豆包通过 MCP 连接器领取并回报 → 轮询队列直到完成为止
# （队列模式**自动**附带状态回报契约，不需要手动粘贴模板）
node dispatch.mjs "整理这份清单" --queue --timeout 300000 --worker doubao

# 只验证校验逻辑，不打扰聊天（正式回归测试用）
node dispatch.mjs "..." --queue --no-send
```

退出码：`0` 已派发并通过队列核实；`2` 超时/未核实；`1` 硬错误；`3` 豆包未就绪；`8` 无法识别。

**为什么需要它**：客户端可以回复「已调用 task_claim，status 为 ok」而实际上什么都没调。2026-10-01 实测就是这样——它这么说了，而队列里那条任务仍是 `pending`，豆包的 `agent_infra` 也没有任何任务执行记录。**信聊天回复的派发器会静默丢活。**

### 状态契约是自动带的

队列模式下，发给豆包的指令由 `buildQueueInstruction()` 拼装，包含两段：**走队列**（task_claim → 干活 → task_complete）和**状态回报契约**（动手前 `start`、结束 `done`/`fail`、可选 `progress`/`need-input`，job 就是本次派发标记）。措辞只有一份（`status-contract.mjs`），派发器与文档引用同一处，不会漂移。

由此派发器多出两个能力：

- **等待期间实时打印状态**：`[状态] 工作开始 · …`、`[状态] 工作结束 · …`，不用等超时才看到进展；
- **完成后核对状态**：队列说完成、但状态文件里没有 `started` 事件 → 明确点出「这条完成的成色要打折」——它没按契约先报开工。

### 密封测试（不需要豆包、不连 CDP）

```powershell
npm test          # 等价于 node dispatch-selftest.mjs
```

四个场景、共 22 项断言：

1. **指令内容**：入队指令必须同时含「走队列」与「状态契约」（含本次 job id 与五条命令）；
2. **成功路径**：一个脚本化 worker 照契约先报 `started`、再回报 → 派发器退出 `0`、打印 `VERIFIED`，并**实时打出状态变化**；
3. **没报状态的完成**：worker 直接完成、不发 `started` → 必须点出来；
4. **失败路径**：没人领取（复现豆包那种「嘴上说做了」）→ 退出 `2`、`UNVERIFIED`，并说明聊天回复不算证据。

因为 `--no-send` 让派发器完全不碰聊天，而失败路径对 CDP 不可达是容错的，所以这个测试在**没有豆包的机器和 CI 上都能跑**。

### 发送前预检

队列模式下，派发器会先读连接器的客户端记录（`clients.json`），把结论明写在输出里：

```
连接器记录到的客户端：无（它从未收到过任何 MCP 客户端的 initialize）
警告：没有任何 MCP 客户端连接过这个连接器，客户端很可能调不到这些工具，
      它回复"已完成"不可信。请先在客户端里启用该连接器，本次结果以队列记录为准。
```

这不是装饰：**超时 45 秒之后才发现「它根本没调工具」，等于每次失败都白等一轮**。有一条记录时它会打印该客户端与最后活动时间，也不再报警告——所以这行输出本身就是判断「连接器到底有没有被接上」的快速信号。

## 为什么豆包会说「做了」而其实没做

**根因：连接器没有在会话里启用，所以那些工具根本不在它的可调用列表里。**

让豆包如实列出工具即可当场证伪：

```powershell
node cdp.mjs send "请如实回答：你当前这个会话里有哪些可调用的工具或已启用的连接器？逐个列名字；一个都没有就直接说「没有」。"
node cdp.mjs wait 120000
```

2026-10-01 实测返回的是：

```
general_search、web.fetch、scholar_search、image_zoom_in、image_search、
visual_search、image_rotate、image_grounding、image_point、calculator、
doubao_code_interpreter、operate_saved_memory、poi.route_plan、medical_search
```

**里面没有 `dsh_ask` / `task_claim`。** 模型在工具不可用时不会报错，而是**编一个成功的调用记录**——所以：

1. 派发前先确认连接器已启用：侧栏 **「插件 · 技能 · 伙伴」** 里找到该连接器并启用（视版本可能还需要在会话里勾选）。
2. 任何「我已经调用 X 了」都必须回到**副作用**去核实——队列事件、文件、日志。这也是 `dispatch.mjs --queue` 存在的理由。

## 两种模式：对话 vs 工作任务（**工具集不同**）

豆包桌面版不是一个模式。输入框左侧的模式切换器（`[data-testid="chat_input_action_mode"]`）点开后是一个 `role="menu"`，四个选项：

```
对话 | 工作任务·本地电脑 | 工作任务·<本机名> | 工作任务·云电脑
```

**两种模式下它可调用的工具完全不同。** 2026-10-02 实测（同一条问题「请如实列出你可调用的工具」）：

| 模式 | 工具集 |
|---|---|
| **对话** | `general_search`、`web.fetch`、`scholar_search`、`calculator`、`doubao_code_interpreter`、`image_*`、`medical_search`、`read_skill`、`list_and_search_skills` 等——**纯检索与生成** |
| **工作任务·本地电脑** | 上面之外**多出本机操作能力**：`Bash`、`PowerShell`、`Read`、`Write`、`Edit`、`Glob`、`Grep`、`FileBatchUpload`、`Wait`、`TaskOutput`、`TaskStop`，以及 `computer_use_tool`、`interact` |

**实测它自称处于「完全访问」执行模式（无沙箱，命令直接在真实系统上执行）**——工作模式 + 本地电脑时，它是真的能在你机器上执行命令的。这既是能力也是风险。

**我们的 `dsh_*` 连接器工具在两种模式下都没有出现**，所以「让豆包通过 MCP 调我们的连接器」这条路，卡点始终是连接器没在该会话启用，而不是模式问题。

**但工作模式给了一条完全不同的路**：它自带 `Bash` / `PowerShell`，所以可以直接让它执行 `dsh --profile headless --json -`（任务走 stdin），而不必依赖我们的 MCP 工具。这条路的代价是「完全访问」——它同时也能执行别的命令。

## 状态回报：工作开始 / 结束 / 各种中间状态

`status.mjs` 让豆包（或任何调用方）在关键节点留下**可核对的副作用**，而不是只回一句「已开始」。

```powershell
node status.mjs received    --job DISPATCH-a1b2c3              # 派发器自己写：指令已送出（不是豆包的回报）
node status.mjs start       --job DISPATCH-a1b2c3              # 真正开始执行命令之前
node status.mjs progress    --job DISPATCH-a1b2c3 --percent 50 --step "拉取数据"
node status.mjs need-input  --job DISPATCH-a1b2c3 --message "要确认哪一步"
node status.mjs done        --job DISPATCH-a1b2c3 --message "结果摘要"
node status.mjs fail        --job DISPATCH-a1b2c3 --message "错误摘要"

node status.mjs list [--job <id>]     # 时间线
node status.mjs open                   # 谁还在跑（退出码 6 = 有未结束）
node status.mjs last <id>              # 最后状态（未知 job 退 5）
node status.mjs config                 # 打印生效配置（排查用）
```

状态写**独立文件**（默认队列同目录的 `status.jsonl`），**不污染任务队列**：`queue.mjs list` 的任务数不会因为状态而变。

### 行为由 `doubao-status.ini` 驱动

配置放在状态文件同目录，**改完立即生效**（脚本每次重读，不用重启）。带注释的样例见 `doubao-status.ini.sample`。

- 只认**固定词表**：`received` / `started` / `progress` / `need_input` / `done` / `failed`（别名 `start`/`finish`/`fail` 只是输入便利）。`received` 由**派发器**在指令真的发出去之后写，是发送侧事实，不是豆包的回报。
- 找不到或读坏 ini → 用内置默认值并**打印明确告警**，不会因为配置问题丢状态。
- 被 ini 关掉的状态：调用它是**静默 no-op**（退出 0、无输出），不打断豆包的工作。
- `received` / `started` / `done` / `failed` **永不因限流丢弃**；`progress` 默认 10 秒一次防刷。
- `started` 会覆盖 `received`（`received` 不是终态）；只要 job 还没到终态，`received` 或 `started` 都算「还占着」。
- 终态之后不再接受新状态；超长正文按 ini 截断。

### 推到 DSH 工作台会话（可选）

```powershell
node status-push.mjs --once                 # 处理积压后退出
node status-push.mjs                        # 常驻轮询
node status-push.mjs --dry-run --once       # 只打印要推什么
node status-push.mjs --create-session       # 没有会话时先建一个并打印 id
```

**只推阶段转换**（`started` / `need_input` / `done` / `failed`），`progress` 永远留在文件里——**每次推送 = 一次真实模型调用**，一个 10 分钟的任务约 4 次而不是几百次。没有配置目标会话时它会**明确报错**，绝不静默丢状态。游标存在 `.push-cursor.json`，重启不会重复推。

## 调用前五维识别

`doctor` 不只看端口，还会回答「现在**能不能**发」：

| 维度 | 判定依据 |
|---|---|
| 连通性 | 调试端口 + 目标页面 |
| **模式** | 页面上模式控件的文字（`对话` / `本地电脑`）；读不到就是 unknown，绝不猜 |
| **命令能力** | 由模式推导：工作模式有 shell，对话模式没有 |
| **忙闲** | 状态文件里「有 `received` 或 `started`、无终态」的 job；超 10 分钟无事件标为疑似卡死 |
| **通道** | 状态目录能否真的写进去 |

**忙闲这一维的连带影响**（真机踩到）：`cdp.mjs` 对除 `doctor` / `targets` 以外的**每个命令**都做调用前识别，而判定是「只要有一条 reason 就 `not-ready`」。于是有未终结 job 时，连 `wait` / `read` 都会被挡。派发器发送之后的 `wait` / `read` 因此带 `--no-preflight` 跳过识别——否则 chat 模式会被**自己刚写的 `received`** 挡住，每次都在拿到回复前先失败。发送前派发器已用自己的 `identify()` 判过一遍，发送后的读操作是对已发出消息取回复，再判一次没有意义。

**三态必须区分**：`0` 可以发 / `3` 未就绪（逐条给出原因）/ `8` **无法识别**（同样拒绝）。

- 任何一维不过就拒绝发送，且**不产生任何副作用**（队列里不会留下孤儿任务）。
- `--force` 可放行，但会在状态文件里留一条 `override` 记录，并在 stderr 明确告警。
- `--mode chat|work|unknown` 跳过 DOM 读取（诊断与测试用）。
- `doctor --json` 输出机器可读结果，派发器就是用它做前置判定的（只有一份实现）。

## 踩过的坑

1. **Enter 不提交**。ProseMirror 把 Enter 当换行；必须点发送按钮。而且要用 CDP 的**真实鼠标事件**（`Input.dispatchMouseEvent`），脚本 `.click()` 可能被 `isTrusted` 拦掉。
2. **文本要用 `Input.insertText`**，不要直接改 DOM 或 `innerText` —— ProseMirror 不认，发送后内容会被丢弃。
3. **回复可能在 `send` 的确认轮询期间就到达**。所以 `wait` 不能判「助手消息数是否增加」，要判「最后一条消息是不是助手消息」（`TURN_STATE`），再等文本稳定两拍，避免读到半截的流式回复。
4. **页面里有多个 target**（launcher / background / iframe），按 url 精确匹配。
5. 别用 `[class*=message]` 抓正文——会抓到「相关问题推荐」卡片。
6. **「正在思考」也是稳定文本**。工作模式下它会把这条占位放进助手槽位，`wait` 的「文本稳定两拍」判据会把它当成最终答复——实测真的发生过一次（派发器退出 0，答复却是「正在思考」）。现已用占位正则排除，并会在跳过时于 stderr 说明。
7. **提交确认不能只看用户消息计数**。工作模式渲染最新消息的方式不同，计数会滞后，于是发送其实成功了却被判「未提交」（实测退出 1、消息已送达）。现在的判据是「计数增加 **或** 输入框已空」——输入框空了才是真正的不变量。

## 安全

`--remote-debugging-port=9222` 意味着**本机任何进程都能接管你的豆包**：读全部聊天记录、以你的身份发消息。它只绑回环（外部网络进不来），但这仍是本地信任边界的扩大。

- 不用时：退出豆包并正常启动（去掉参数）。
- 不要把它和隧道/端口转发一起用。

## 局限

- **没有任何官方入站 API**：这条路是 GUI 自动化，不是受支持的集成。
- 上面所有选择器/锚点都是**版本相关**的，豆包升级后需要重新 `probe`。
- 与你手动操作豆包**会互相干扰**（同一个输入框、同一个会话）；不适合长期无人值守跑高频任务。
- 通过它下发的每一条都会**消耗你的豆包额度**，并留在你的会话历史里。
