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

# 队列模式：入队 → 让豆包通过 MCP 连接器领取并回报 → 轮询队列直到完成为止
node dispatch.mjs "整理这份清单" --queue --timeout 300000 --worker doubao

# 只验证校验逻辑，不打扰聊天（正式回归测试用）
node dispatch.mjs "..." --queue --no-send
```

退出码：`0` 已派发并通过队列核实；`2` 超时/未核实；`1` 硬错误。

**为什么需要它**：客户端可以回复「已调用 task_claim，status 为 ok」而实际上什么都没调。2026-10-01 实测就是这样——它这么说了，而队列里那条任务仍是 `pending`，豆包的 `agent_infra` 也没有任何任务执行记录。**信聊天回复的派发器会静默丢活。**

### 密封测试（不需要豆包、不连 CDP）

```powershell
npm test          # 等价于 node dispatch-selftest.mjs
```

三个场景、共 15 项断言：

1. **成功路径**：一个脚本化 worker 扮演守规矩的客户端，领取并回报 → 派发器必须退出 `0` 且打印 `VERIFIED`；
2. **失败路径**：没人领取（复现豆包那种「嘴上说做了」）→ 必须退出 `2`、打印 `UNVERIFIED`，并明确说明聊天回复不算证据；
3. **预检**：连接器有客户端记录时不报警告、没有记录时**发送前就警告**。

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

## 踩过的坑

1. **Enter 不提交**。ProseMirror 把 Enter 当换行；必须点发送按钮。而且要用 CDP 的**真实鼠标事件**（`Input.dispatchMouseEvent`），脚本 `.click()` 可能被 `isTrusted` 拦掉。
2. **文本要用 `Input.insertText`**，不要直接改 DOM 或 `innerText` —— ProseMirror 不认，发送后内容会被丢弃。
3. **回复可能在 `send` 的确认轮询期间就到达**。所以 `wait` 不能判「助手消息数是否增加」，要判「最后一条消息是不是助手消息」（`TURN_STATE`），再等文本稳定两拍，避免读到半截的流式回复。
4. **页面里有多个 target**（launcher / background / iframe），按 url 精确匹配。
5. 别用 `[class*=message]` 抓正文——会抓到「相关问题推荐」卡片。

## 安全

`--remote-debugging-port=9222` 意味着**本机任何进程都能接管你的豆包**：读全部聊天记录、以你的身份发消息。它只绑回环（外部网络进不来），但这仍是本地信任边界的扩大。

- 不用时：退出豆包并正常启动（去掉参数）。
- 不要把它和隧道/端口转发一起用。

## 局限

- **没有任何官方入站 API**：这条路是 GUI 自动化，不是受支持的集成。
- 上面所有选择器/锚点都是**版本相关**的，豆包升级后需要重新 `probe`。
- 与你手动操作豆包**会互相干扰**（同一个输入框、同一个会话）；不适合长期无人值守跑高频任务。
- 通过它下发的每一条都会**消耗你的豆包额度**，并留在你的会话历史里。
