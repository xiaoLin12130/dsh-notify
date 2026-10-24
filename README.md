# dsh-notify

DSH 会话停止时弹出桌面通知——类似 Codex 的完成提示：**完成、需要你选择、异常结束**都会提醒，即使你正在别的窗口（浏览器、游戏）里。

- 运行位置：DSH 宿主进程（host half），无浏览器依赖，无需客户端插件。
- 通知形式：默认是**置顶通知卡片**（右下角，圆角、按类型着色、点击关闭、自动消失），也可切到 Windows 原生 toast 或两者同时。
- 点击卡片：把 DSH 窗口切到前台，并自动打开对应会话（需要 GUI 页面在运行；最多约 1 秒生效）。
- DSH 窗口在前台时也会弹（`suppressWhenFocused: true` 可改成只在你不看 DSH 时提醒）。
- 零网络请求、零额外依赖；渲染通过本机 PowerShell 完成。

## 触发场景

| 场景 | 标题 | 说明 |
| --- | --- | --- |
| 一轮对话正常结束 | 会话完成 | 显示会话标题、用时、步数，以及最后一条助手回复的摘要 |
| 模型/工具报错，回合失败 | 会话异常结束 | 带错误信息（如 `ECONNRESET`） |
| 用户取消 / 回合被中断 | 会话已中止 | 可单独关闭 |
| 被策略阻断、达到输出上限 | 会话被阻断 / 输出达到上限 | 可单独关闭 |
| 等待批准（工具权限等） | 需要你的批准 | 显示工具名与原因 |
| 等待回答（`ask_user_question`、计划审阅） | 需要你的选择 / 计划待审阅 | 显示第一个问题与问题数量 |

子代理（subagent）会话默认不通知；`subagents: true` 可打开。

## 安装

要求：Windows + DeepSeek Harness Desktop（`web` profile 亦可用）。先关闭 DeepSeek Harness
（宿主进程会锁住 profile），安装后重启。

### 从 GitHub 安装（推荐）

```powershell
dsh plugin --profile desktop add github:xiaoLin12130/dsh-notify
```

若没有全局 `dsh`，用桌面端自带运行时（把 `<你>` 换成本机用户名）：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& "C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" `
  "C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  plugin --profile desktop add github:xiaoLin12130/dsh-notify
```

### 本地开发（link）

```powershell
git clone https://github.com/xiaoLin12130/dsh-notify.git
dsh plugin --profile desktop add link:<clone 得到的目录>
```

### 手动安装（等价于插件管理做的事）

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add github:xiaoLin12130/dsh-notify
# 再把 "dsh-notify" 加进 package.json 的 dsh.profile.bundles 数组
```

### 更新

```powershell
dsh plugin --profile desktop update dsh-notify
```

更新后重启 DeepSeek Harness（宿主启动时才会加载新 bundle）。

验证通知渲染是否正常（在**本地仓库目录**运行；安装后的包只带 `lib/` 与清单，不含 `test/`、`scripts/`）：

```powershell
cd <clone 得到的目录>
node scripts\visual-check.mjs
```

## 配置

插件配置写在 profile 的 `cordis.patch.yml`（桌面端位于
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`）里，追加一条同 id 的行即可覆盖默认值：

```yaml
- id: dsh-notify
  name: dsh-notify
  config:
    suppressWhenFocused: false
    openOnClick: true
    style: popup          # popup | toast | both
    position: bottom-right # bottom-right | bottom-left | top-right | top-left
    sound: true
    durationMs: 7000
    notifyCompleted: true
    notifyNeedsInput: true
    notifyError: true
    notifyAborted: true
    notifyBlocked: true
    notifyMaxTokens: true
    subagents: false
    showPreview: true
    maxBodyChars: 220
    debug: false
```

全部字段：

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `notifyCompleted` | `true` | 正常完成 |
| `notifyNeedsInput` | `true` | 提问 / 计划审阅 / 批准请求 |
| `notifyError` | `true` | 回合报错 |
| `notifyAborted` | `true` | 用户取消、中断 |
| `notifyBlocked` | `true` | 策略阻断 |
| `notifyMaxTokens` | `true` | 输出 token 上限 |
| `subagents` | `false` | 是否也给子代理会话通知 |
| `style` | `popup` | `popup` 卡片 / `toast` 原生通知 / `both` |
| `position` | `bottom-right` | 卡片位置（按鼠标所在显示器定位） |
| `sound` | `true` | 提示音（错误用警告音） |
| `suppressWhenFocused` | `false` | 设为 `true` 时，DSH 窗口在前台就静默 |
| `openOnClick` | `true` | 点击卡片时聚焦 DSH 并打开对应会话（`toast` 样式不支持） |
| `durationMs` | `7000` | 卡片停留毫秒数 |
| `maxConcurrent` | `3` | 同时显示的卡片数（超出排队） |
| `showPreview` | `true` | 完成通知附带最后一条助手回复摘要 |
| `maxBodyChars` | `220` | 正文最大字符数 |
| `maxTitleChars` | `96` | 标题最大字符数 |
| `powershell` | `powershell.exe` | 渲染用 PowerShell（只有 `pwsh` 时可改） |
| `toastAppId` | `''` | toast 的 AUMID 覆盖（默认用 Windows PowerShell 身份） |
| `debug` | `false` | 在宿主日志中输出每次决策 |

## 实现

- 宿主 half（`lib/index.js`）监听 `session/event`：
  `turn/end` 的 `completed` / `error` / `aborted` / `blocked` / `max-tokens` 决定标题与颜色；
  `approval/asked` 对应批准请求；`session/title` 用于显示会话名；`turn/start` + `step/end`
  用于计算用时与步数。
- 提问与计划审阅来自 `user-questions/request` waterfall：插件先发通知，再调用 `next()`
  把请求原样交给 GUI，绝不拦截或改变答案。
- 点击跳转：通知卡片携带本插件在本机 `webServer` 上注册的 `/dsh-notify/click` 地址；
  点击时 PowerShell 先 `SetForegroundWindow` 聚焦 DSH，再请求该地址，宿主记录待打开会话。
  浏览器 half（`lib/client.js`）每 700ms 轮询 `/dsh-notify/pending`，取到后调用
  `ctx.uiWorkspace.openSession(sessionId)` 切换会话。只接受回环地址请求。
- 完成通知的摘要来自 `session.deriveMessages()`（只读，延迟到事件提交之后），失败时自动省略。
- 通知去重（同一 turn/approval/callId 只弹一次）、并发槽位堆叠、渲染进程超时兜底。
- 渲染脚本 `lib/notify.ps1` 是纯 ASCII + UTF-8 stdin JSON，避免 PowerShell 代码页问题；
  C# 窗口以 `WS_EX_NOACTIVATE` 显示，**不会抢走前台焦点**（点击时才主动聚焦 DSH）。

## 边界说明

- 仅支持 Windows（通知渲染依赖 WinForms / WinRT）。
- `style: toast` 受 Windows 通知设置、专注助手与全屏游戏影响，可能被系统静音；默认的
  `popup` 置顶卡片不受这些设置影响（独占全屏游戏仍可能遮挡）。**点击跳转只对卡片生效**：
  原生 toast 无法被本插件拦截点击，切成 `toast` 后只能看、不能点。
- 点击跳转需要 GUI 页面处于打开状态（桌面端窗口或同源浏览器标签）。页面关闭时点击只会
  聚焦 DSH；待打开的会话在宿主内存里保留 2 分钟，期间页面恢复即可补跳。
- 浏览器里使用时，窗口标题需包含 `DeepSeek Harness` 才能被聚焦；后台标签页的轮询可能
  被浏览器节流，跳转最多延迟到标签页恢复活动。
- 宿主进程崩溃（不是回合报错）时插件本身也退出，无法发出通知。
- 弹窗由 PowerShell 子进程渲染，首次/每次弹出约有 1 秒启动延迟。
