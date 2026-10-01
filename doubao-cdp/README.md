# doubao-cdp

用 Chrome DevTools Protocol 驱动**豆包桌面版**（Electron），把任务直接下发到它的聊天框，并读回回复。

零依赖：Node 24 自带全局 `WebSocket`，直接跟 CDP 通信，不需要 puppeteer / playwright。

## 前提：豆包必须带调试端口启动

CDP 只在启动时决定，运行中的实例无法挂载。所以需要（一次）：

```powershell
Get-Process Doubao -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process "E:\Doubao\app\Doubao.exe" -ArgumentList '--remote-debugging-port=9222','--remote-allow-origins=*'
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
node cdp.mjs probe                # 找输入框候选
node cdp.mjs send "任务文本"      # 聚焦输入框 → 插入文本 → 点发送 → 确认已提交
node cdp.mjs wait 120000          # 等这一轮答复稳定，打印回复
node cdp.mjs read 6               # 读最近 n 条消息（标注 user / assistant）
node cdp.mjs click <x> <y>        # 真实鼠标点击
node cdp.mjs eval "<js>"          # 在页面求值
```

一次完整的下发：

```powershell
node cdp.mjs send "帮我查一下明天上海天气" ; node cdp.mjs wait 180000
```

`send` 成功时会打印 `sent via send button: ...`；若输入框没清空会直接报错，不会假装成功。

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
