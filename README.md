# dsh-plugin-task-notify

DeepSeek Harness 任务完成通知插件（适配 **DSH 0.2.x**，已在 `0.2.1-rc.2` 桌面版验证）：**会话的一轮任务结束时提醒你**。

DSH 是 Web UI，任务跑完没有提醒——切到别的窗口等结果时容易错过。本插件提供**飞书式桌面通知**：DSH 宿主进程（Node 常驻进程）监听任务状态，任务完成时弹出**自定义置顶卡片**（无边框窗口，**不经过 Windows 通知管道，系统通知总开关关闭时依然显示**），**与浏览器页面是否打开无关**；页面内另有应用内 toast。

## 特性

- **桌面通知（自绘置顶卡片）**：由宿主进程触发（PowerShell + WinForms 自绘窗口），点击卡片**精确打开对应会话**，右上角 × 可关闭。**不依赖 Windows 通知设置**（这是与系统 Toast/气泡的关键区别）。默认开启。0.9.x 起为 **DPI-aware（Per-Monitor V2）自绘卡片**：GDI+ 渐变表面、图标徽章、两行省略、淡入淡出、悬停暂停、Win11 DWM 圆角；不抢焦点、单实例。
- **卡片样式可配置**（设置页）：主题（深/浅）、强调色（绿/蓝/橙/紫）、位置（四角）、显示时长（4/6/8/10 秒）、字号（小/标准/大/特大）、字体（微软雅黑/系统默认/宋体/黑体/楷体）。配置持久化在 `~/.dsh/plugins/task-notify.json`。**配色对齐 DSH 设计令牌**：深色卡片取 `--dsw-alias-bg-layer-1`（#232324）表面、浅色卡片白底，强调色取 DSH 的 success / deepseek / warn / red 状态色；设置页色板与宿主弹窗共用同一份色板定义。
- **设置页实时预览**（0.9.0）：设置页「任务完成通知」顶部新增与真实卡片同源的 HTML 预览，切换主题/强调色/字号/字体即时更新；「测试通知」仍触发真实桌面卡片。
- **提示音可配置**（设置页）：开关 + 音色（苹果三全音/叮/双响/系统提示音）+ **音量滑杆（0-100，拖动结束才写宿主）**。宿主合成 WAV（无需音频资产），页面关闭也能响；同一音色只保留最新音量档的 WAV 缓存。
- **等待输入/审批提醒**：计划模式下 agent 提问（`ask_user_question`）或提交计划等审批（`exit_plan_mode`）时，也会弹卡片+提示音+toast。DSH 0.2.x 起客户端等待标记位于 `uiSession.sessionStatus.pendingInteraction`（不再挂在会话列表行上），本插件已按新位置订阅；Host 半仍监听 `session/event` 的 `tool/call` 与 `approval/request`。
- **应用内 toast**：右下角浮层提示（`shell.overlay` 槽位），6 秒自动消失，可手动关闭，点击通过 `uiWorkspace.openSession` 跳转对应会话。
- **完成检测（双通道）**：
  - Host 半监听 `agent/status`（running→idle = 一轮任务完成），2 秒防抖。
  - Client 半订阅 `sessions.list` 快照做页面内提示。
- **出错提醒**：Host 半监听 `agent/error`，任务失败时弹**红色错误卡片**（独立 2 秒防抖），可在设置中关闭；桌面关闭、提示音开启时只播放提示音。
- **过滤子代理**：子代理会话不提醒，避免噪声。
- **设置行 + 设置页**：设置页 → General 一节新增"任务完成通知"快速行（桌面/应用内/提示音开关 + 测试）；设置导航新增完整页面「任务完成通知」，含通道开关、卡片样式、字体、提示音与音量配置及测试预览。

## 与 DSH 版本的对应变化

### 0.10.0（常驻渲染，延迟 1.8s → ~70ms）

- **常驻渲染进程**：插件启动时预创建并预热一个 PowerShell/WinForms 卡片进程（离屏 `Show`/`Hide`，DPI 和字体只初始化一次）；之后的通知只写 `command.json`，由渲染进程 20ms 轮询消费，通过 stdout 回传 `ready/recv/visible/closed/error` 事件。冷启动脚本保留为兜底。
- **耗时**：同一测量脚本下，冷启动端到端 1716–1754ms；常驻渲染 median 70ms、max 187ms（5 次；10 次重测 median 41ms、max 54ms），目标 300ms 达成。
- **回收**：渲染进程异常退出后 1s 自动重启；下一次通知若仍未就绪则回退冷启动；插件停止/更新时杀死渲染进程并清理临时目录。单实例、不抢焦点、精确会话跳转保持不变。
- **测量**：`scripts/measure-latency.ps1 -Mode persistent|cold -Count N`（需插件已挂载）；Host 端 `/task-notify/measure` 返回分段耗时；冷启动脚本内置 boot/types/form/shown/paint 埋点。
- **代价**：常驻进程工作集约 110MB（PowerShell + WinForms 基线），20 次通知后无增长；20ms 轮询带来极低空闲 CPU 开销。

### 0.9.x（卡片体验升级）

- **高 DPI**：PowerShell 卡片进程声明 Per-Monitor V2，尺寸按 `DpiX/96` 缩放，200% 缩放下不再整窗位图放大。
- **视觉**：Win11 DWM 圆角、移除系统浅色描边、自绘 1px 圆角描边；卡片高度 96→84 逻辑像素，更紧凑；关闭按钮 32×32 命中区与 hover 反馈；超长文案按宽度自适应并截断。
- **交互**：悬停暂停自动消失；点击卡片 → Host `/task-notify/action` → SSE `/task-notify/events` → 页面内 `uiWorkspace.openSession(sessionId)`，**精确打开对应会话**；卡片进程用 `AppActivate`/`SetForegroundWindow` 聚焦 DSH；卡片位置跟随 DSH 主窗口所在屏幕（兜底主屏）。
- **设置页**：新增实时预览卡；强调色/主题/字体/字号即时反映。
- **交互细节**：语义图标（成功 ✓ / 等待 ? / 错误 !）；`WS_EX_NOACTIVATE` + `ShowWithoutActivation` 确保卡片出现/点击不抢焦点；同一时刻只保留一张卡片（新通知替换旧卡），插件停止时关闭仍在显示的卡片；自绘卡片支持悬停暂停、两行省略与淡入淡出。
- **测试入口**：`POST /task-notify/test` 支持可选 `{ title, body, variant, sessionId }`，方便验收长文本、三种变体与点击跳转。
- **技术结论**：M1 spike 确认插件 Host 半运行在 Electron Node/utility 进程，拿不到 `BrowserWindow`/`WebContentsView`，**无法由插件直接创建 Electron HTML 卡片**；因此 0.9.x 采用 DPI-aware 原生卡片 + DWM 方案，HTML 卡片保留为 DSH 后续提供窗口 API 时的升级项。

### 0.8.x（DSH 0.2.x 适配）

插件 `0.8.0` 针对 **DSH 0.2.x** 适配，主要差异：

| 0.1.x 的写法 | 0.2.x 的写法 |
| --- | --- |
| `ctx.sessions.open(id)` 打开会话 | `ctx.uiWorkspace.openSession(id)` |
| 会话行的 `pendingInteraction` 标记等待 | `ctx.uiSession.sessionStatus`（`ReadonlyMap<SessionId, SessionStatus>`） |
| `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime"]` | `inject: []`（react 由平台 seed 提供，已无 `dsh-client-runtime` 包） |

其余使用到的接口在 0.2.1-rc.2 中保持兼容：`agent/status`、`agent/error`、`agent/disposed`、`session/event`（`tool/call`）、`approval/request`、`sessionTitle.get()`、`webServer.register({ kind: 'exact', path, handler })`、`slots.inject/register`、`locale.bind/register`、`settings.general.item` 与 `settings.section` 槽位。

## 架构

```
src/
  index.ts            # Host 半：事件检测 → 常驻渲染器/冷启动兜底 + HTTP/SSE 桥
  renderer.ps1        # 常驻 PowerShell/WinForms 渲染进程（预创建 + 预热 + 指令循环）
  renderer-manager.ts # 常驻进程生命周期、command.json 写入、stdout 事件解析
  client.ts           # Client 半入口：inject + apply（订阅、toast、SSE 跳转、注册槽位）
  theme.ts            # 卡片色板/令牌（Host 弹窗与设置页预览共用）
  client/
    types.ts          # sessions / uiSession / uiWorkspace / slots 服务的最小结构视图
    config.ts         # 客户端配置（localStorage：toast 开关）
    watcher.ts        # running→idle 完成检测 + pendingInteraction 等待检测
    toasts.ts         # toast store + shell.overlay 堆栈组件
    settings.ts       # settings.general.item 设置行 + 设置页（含实时预览）
    styles.ts         # 样式注入（含预览卡样式，主题变量）
```

**Host 半**（`src/index.ts` + `src/renderer-manager.ts`）：
- 插件启动时创建常驻渲染进程（`src/renderer.ps1`）：DPI/字体/窗口只初始化一次，离屏 `Show`/`Hide` 预热；后续通知写入 `command.json`，渲染进程每 20ms 轮询消费并通过 stdout 回传 `ready/recv/visible/closed/error`。
- 冷启动脚本（内嵌 `POPUP_SCRIPT`）保留为兜底：常驻进程未就绪/异常退出时使用，保证通知不丢。
- 注册 HTTP/SSE 桥（绑定 127.0.0.1，仅本机可访问）：
  - `GET  /task-notify/config` — 读完整通知配置
  - `POST /task-notify/config` — 写配置项（`{ "desktop": boolean, ... }`）
  - `POST /task-notify/test` — 立即弹测试卡片（支持 `{title, body, variant, sessionId}`）
  - `GET  /task-notify/events` — SSE：向页面广播"打开指定会话"
  - `POST /task-notify/action` — 卡片点击回调（`{ action: 'open', sessionId }`）
  - `POST /task-notify/measure` — 延迟测量（`{mode:'persistent'|'cold'}`），返回分段耗时

> 卡片点击由渲染进程回调 Host（HTTP action）→ SSE 通知页面执行 `uiWorkspace.openSession(sessionId)`，从而精确打开对应会话；页面未打开时回退为打开 DSH 根地址。卡片默认跟随 DSH 主窗口所在屏幕，可用环境变量 `DSH_WEB_URL` 覆盖打开地址。

**Client 半**：订阅 `sessions.list` 完成翻转与 `uiSession.sessionStatus` 等待标记 → 应用内 toast；订阅 `/task-notify/events` 处理桌面卡片点击的会话跳转；设置页通过 `fetch` 调 HTTP 桥控制宿主开关，并渲染同源卡片预览。客户端不使用浏览器 Notification API（系统级通知统一由宿主负责）。设置 UI 已接入 `ctx.locale`（中/英文案）。

## 构建

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # tsdown → lib/index.mjs + lib/client.js；copy-assets 复制 renderer.ps1 并写 BOM
pnpm smoke       # node scripts/smoke-client.mjs：模拟加载器验证 client bundle
```

产物 `lib/` 需提交（link: 挂载直接指向源码目录）。`renderer.ps1` 由 `scripts/copy-assets.mjs` 复制到 `lib/`，必须带 UTF-8 BOM（Windows PowerShell 5.1 依赖 BOM 识别中文）。

> Client 半的构建特殊性：DSH 客户端模块加载器要求 bundle 是
> `window.__ModuleLoader__.load({ id, factory })` 包装格式（classic script，
> CJS 风格 factory，react 经注入的 require 解析）。`tsdown.config.ts` 用
> format cjs + banner/footer 包外壳实现；不要改成普通 ESM 裸 import 输出。

## 延迟测量（可复现）

```powershell
# 需插件已挂载、DSH 正在运行；端口以实际 webServer 为准
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-latency.ps1 -Port 55803 -Mode persistent -Count 5
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-latency.ps1 -Port 55803 -Mode cold -Count 3
```

输出分段：`triggerToCmd / cmdToRecv / recvToShow / showToPaint / paintToHost / total`（cold 模式为 `triggerToSpawn / spawnToBoot / bootToTypes / typesToForm / formToShown / shownToPaint`）。

## 挂载到 DSH

DSH 桌面版默认使用 `desktop` profile（`~/.dsh/profiles/desktop`）；CLI Web 版常用 `web` profile。推荐用官方插件管理器安装（自动装依赖并并入 bundles 层）：

```bash
dsh plugin --profile desktop add "link:<本插件文件夹绝对路径>"
# CLI Web 版对应：dsh plugin --profile web add "link:<本插件文件夹绝对路径>"
```

也可以在本会话用 `plugin_manager` 工具的 `install_bundle` 安装本地目录。手动方式（等价）：

1. 编辑对应 profile 的 `package.json`：
   - `dependencies` 添加：`"dsh-plugin-task-notify": "link:<本插件文件夹绝对路径>"`
   - `dsh.profile.bundles` 数组追加：`"dsh-plugin-task-notify"`
2. 在 profile 目录执行 `pnpm install`。
3. 刷新页面；**Host 半变更需重启 dsh 进程**（client-modules 插件集合变更只在重启时重新扫描）。

> 注意：`cordis.yml` 是合成产物，**不要直接编辑**；配置覆盖写进 `cordis.patch.yml`。

## 使用

1. 打开 设置 → General → "任务完成通知"：
   - 顶部**卡片预览**会随主题/强调色/字号/字体实时变化。
   - **桌面通知**默认开启（DPI-aware 置顶卡片，独立于浏览器与系统通知开关）。
   - 点"测试"：桌面开则弹置顶卡片、提示音开则播放声音、应用内开则出 toast；三条通道任意一条开启即可测试。
2. 正常对话：每轮任务完成，桌面卡片 + 页面 toast；点击卡片会打开并定位到对应会话，点击 toast 也会跳转；悬停卡片可暂停自动消失。

## 已知限制

- 桌面通知**仅支持 Windows**（PowerShell + WinForms 置顶卡片）；其他平台暂只有应用内 toast。
- 插件 Host 半在 Electron Node/utility 进程内运行，**无法直接创建 Electron HTML 窗口**；当前卡片是 DPI-aware 原生窗口（Win11 DWM 圆角），不是 HTML 卡片。若后续 DSH 提供宿主窗口 API，可平滑升级。
- 常驻渲染：端到端 median ≈70ms、max <300ms（本机 200% 缩放实测）；常驻进程工作集约 **110MB**（PowerShell + WinForms 基线），20 次通知后无增长。常驻进程未就绪/异常退出时回退冷启动（约 1.7–1.8s），1s 后自动重启。
- 多屏策略为“跟随 DSH 主窗口所在屏幕”，当前仅在单屏环境验证；多屏/混合 DPI 需补充实机验证。
- 页面未打开时点击卡片只能打开 DSH 根地址，无法定位会话（SSE 无客户端）。
- 置顶卡片是自绘窗口（非系统通知），不会进入 Windows 通知中心历史。
- 连续多轮快速完成有 2 秒防抖合并；toast 栈最多保留 4 条，自动消失。

## 路线图

- [ ] 后台任务/工作流/子代理完成提醒
- [ ] 长任务完成后再提醒（防打扰）
- [ ] 非 Windows 桌面通知（macOS `osascript` / Linux `notify-send`）
