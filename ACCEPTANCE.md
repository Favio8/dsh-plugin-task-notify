# ACCEPTANCE — 通知卡片常驻渲染改造（0.10.0）

> 环境：Windows 11 build 26200、DSH 桌面版 `0.2.1-rc.2`、200% 缩放（2880×1800 物理 / 1440×900 逻辑）、`desktop` profile。
> 日期：2026-10-18。截图/测量为本地复跑结果。

## 1. 构建

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `pnpm typecheck` | ✅ |
| 构建 | `pnpm build` | ✅ `lib/index.mjs`、`lib/client.js`、`lib/renderer.ps1`（UTF-8 BOM） |
| 冒烟 | `pnpm smoke` | ✅ PASSED |

## 2. 延迟测量（同一脚本、同一触发入口）

复跑命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-latency.ps1 -Port 55803 -Mode persistent -Count 5
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-latency.ps1 -Port 55803 -Mode cold -Count 3
```

### 2.1 冷启动基线（改前）

| Run | triggerToSpawn | spawnToBoot | bootToTypes | typesToForm | formToShown | shownToPaint | total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 100 | 730 | 441 | 189 | 159 | 135 | 1754 |
| 2 | 134 | 719 | 402 | 191 | 152 | 118 | 1716 |
| 3 | 105 | 734 | 415 | 191 | 149 | 156 | 1750 |

**主要瓶颈**：PowerShell 进程启动（`spawnToBoot` ≈ 728ms）+ Add-Type/脚本解析（`bootToTypes` ≈ 419ms）+ 窗口创建与首帧（`typesToForm`+`formToShown`+`shownToPaint` ≈ 450ms）。这些正是常驻化可以消除的冷启动环节。

### 2.2 常驻渲染（改后，5 次）

| Run | triggerToCmd | cmdToRecv | recvToShow | showToPaint | paintToHost | total |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 59 | 44 | 84 | 0 | 187 |
| 2 | 0 | 11 | 6 | 26 | 0 | 43 |
| 3 | 0 | 32 | 6 | 26 | 1 | 65 |
| 4 | 0 | 34 | 3 | 61 | 1 | 99 |
| 5 | 0 | 31 | 4 | 35 | 0 | 70 |

**汇总**：min 43ms / median **70ms** / max **187ms**（另一次 10 连测：median 41ms / max 54ms）。**≤300ms 目标达成**。
说明：进程未就绪的首次通知会走冷启动兜底（约 1.75s），插件启动 1–2s 后即进入常驻路径。

## 3. 功能与行为验收

| 编号 | 项 | 方法 | 结果 |
| --- | --- | --- | --- |
| A-01 | 常驻卡片显示 | `POST /task-notify/test` | ✅ 卡片正常显示，GDI+ 自绘、渐变、徽章、圆角 |
| A-02 | 三种变体 | `test` 传 `variant=success/wait/error` | ✅ 绿 ✓ / 琥珀 ? / 红 ! |
| A-03 | 悬停暂停 | 悬停 8s（时长 6s）→ 移开 8s | ✅ 悬停不消失；移开后消失 |
| A-04 | 点击卡片 | 点击卡片中心 | ✅ 卡片关闭，前台窗口为 DSH（聚焦成功） |
| A-05 | 不抢焦点 | 记录出现前后 `GetForegroundWindow` | ✅ 前后均为 DSH 主窗口 |
| A-06 | 单实例/替换 | 连续 6 次通知 | ✅ 同时最多 1 张，结束后 0 张 |
| A-07 | 冷启动兜底 | 杀掉渲染进程后立即触发 | ✅ 约 1794ms 后显示冷启动卡片；1s 后渲染进程自动重启 |
| A-08 | 插件停止清理 | disable 插件后检查进程 | ✅ renderer 进程数 0 |
| A-09 | 内存 | 20 次通知后查看工作集 | ✅ 约 110MB，无增长（进程复用，不新建） |
| A-10 | 精确会话 | `/action` → SSE → `uiWorkspace.openSession`（客户端 ack） | ✅ 链路验证；渲染器点击走同一 HTTP action |
| A-11 | 设置页预览 | 代码构建；未视觉核对 | ⚠️ 未截图 |
| A-12 | 100%/150% 缩放 | 当前系统固定 200% | ⚠️ 未测 |
| A-13 | 多屏/混合 DPI | 单屏环境 | ⚠️ 未测 |
| A-14 | 真实完成/错误/等待事件 | 未触发真实结束态事件 | ⚠️ 用 test 入口验证形态 |

## 4. 风险与回滚

| 风险 | 说明 | 应对 |
| --- | --- | --- |
| 常驻进程内存 110MB | PowerShell/WinForms 基线，长时间驻留 | 进程复用、20 次通知无增长；可在后续改为原生小型宿主 |
| 轮询空闲 CPU | 20ms 指令轮询 | 实测开销很低；可调到 30–50ms 换取更低 CPU（延迟仍 <300ms） |
| 渲染进程崩溃 | 通知丢失/延迟 | 冷启动兜底 + 1s 自动重启；下次通知恢复常驻 |
| 首次通知 | 插件刚启动时进程未 ready | 走冷启动（约 1.75s），之后常驻 |
| 中文脚本编码 | Windows PowerShell 依赖 BOM | `scripts/copy-assets.mjs` 构建时写入 BOM；验收含 `lib/renderer.ps1` BOM 检查 |

**回滚方式**：回退到 `0.9.2`（删除 `renderer.ps1`/`renderer-manager.ts` 集成、恢复 `notifyCard` 直接调用 `showPopup`），或撤销本次提交并重新 `pnpm build` + 重载插件。冷启动路径始终保留，回滚不影响既有通知行为。

## 5. 未验证项

| 项 | 原因 | 影响 | 后续 |
| --- | --- | --- | --- |
| 100%/150% 缩放 | 系统固定 200% | 中 | 切换缩放复测 |
| 多屏/混合 DPI | 单屏 | 中 | 外接屏复测 |
| 设置页预览视觉 | 无浏览器控制 | 中 | 打开设置页截图 |
| 真实完成/错误/等待事件 | 未触发结束态 | 中 | 下一轮任务完成验收 |
| 淡入/淡出时长 | 未逐帧测量 | 低 | 录屏采样 |
| 柔和阴影 | 仍未观察到明显阴影 | 低 | 后续分层窗口方案 |
