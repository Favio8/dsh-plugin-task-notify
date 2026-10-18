import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
//#region src/sound.ts
const SOUND_TYPES = [
	"apple",
	"ding",
	"double",
	"system"
];
const SAMPLE_RATE = 44100;
/** 正弦 + attack 防爆音 + 指数衰减包络。 */
function synthTone(freq, durationSec, volume) {
	const n = Math.max(1, Math.round(durationSec * SAMPLE_RATE));
	const out = new Float32Array(n);
	const attack = Math.min(.008, durationSec / 6);
	for (let i = 0; i < n; i++) {
		const t = i / SAMPLE_RATE;
		const atk = t < attack ? t / attack : 1;
		const env = Math.exp(-4.2 * (t / durationSec));
		out[i] = Math.sin(2 * Math.PI * freq * t) * atk * env * volume;
	}
	return out;
}
function mixTones(tones) {
	const total = Math.round(Math.max(...tones.map((t) => t.startSec + t.durationSec)) * SAMPLE_RATE);
	const out = new Float32Array(total);
	for (const tone of tones) {
		const seg = synthTone(tone.freq, tone.durationSec, tone.volume ?? .5);
		const offset = Math.round(tone.startSec * SAMPLE_RATE);
		for (let i = 0; i < seg.length && offset + i < total; i++) out[offset + i] += seg[i];
	}
	for (let i = 0; i < out.length; i++) if (out[i] > 1) out[i] = 1;
	else if (out[i] < -1) out[i] = -1;
	return out;
}
function buildWav(samples) {
	const dataLen = samples.length * 2;
	const buf = Buffer.alloc(44 + dataLen);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(36 + dataLen, 4);
	buf.write("WAVE", 8);
	buf.write("fmt ", 12);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(SAMPLE_RATE, 24);
	buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write("data", 36);
	buf.writeUInt32LE(dataLen, 40);
	for (let i = 0; i < samples.length; i++) {
		const v = Math.max(-1, Math.min(1, samples[i]));
		buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
	}
	return buf;
}
/** 合成指定音色（system 无合成产物）。volumePercent 0..100 为主音量增益。 */
function synthSound(type, volumePercent) {
	const gain = Math.max(0, Math.min(100, volumePercent)) / 100;
	const applyGain = (samples) => {
		const out = new Float32Array(samples.length);
		for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
		return out;
	};
	switch (type) {
		case "apple": return buildWav(applyGain(mixTones([
			{
				freq: 523.25,
				durationSec: .4,
				startSec: 0
			},
			{
				freq: 659.25,
				durationSec: .42,
				startSec: .18
			},
			{
				freq: 783.99,
				durationSec: .5,
				startSec: .36
			}
		])));
		case "ding": return buildWav(applyGain(mixTones([{
			freq: 783.99,
			durationSec: .7,
			startSec: 0
		}])));
		case "double": return buildWav(applyGain(mixTones([{
			freq: 660,
			durationSec: .15,
			startSec: 0
		}, {
			freq: 660,
			durationSec: .18,
			startSec: .25
		}])));
	}
}
//#endregion
//#region src/theme.ts
/** 强调色色板（rgb 分量）。 */
const ACCENT_COLORS = {
	/** --dsw-static-green-500 */
	green: {
		r: 34,
		g: 197,
		b: 94
	},
	/** --dsw-static-deepseek-500 */
	blue: {
		r: 65,
		g: 118,
		b: 230
	},
	/** --dsw-static-amber-500 */
	orange: {
		r: 245,
		g: 158,
		b: 11
	},
	/** DSH 无紫色 token，取与色板同一明度/饱和度的过渡色。 */
	purple: {
		r: 139,
		g: 92,
		b: 246
	},
	/** --dsw-static-red-500；仅用于错误卡片，不在设置页色板中展示。 */
	red: {
		r: 239,
		g: 68,
		b: 68
	}
};
//#endregion
//#region src/renderer-manager.ts
/**
* 常驻卡片渲染进程管理：进程/窗口只创建一次，后续通知只写 command.json。
* 冷启动路径仍由 index.ts 的 showPopup 作为兜底。
*/
var CardRenderer = class {
	child;
	ready = false;
	starting = false;
	stopped = false;
	seq = 0;
	dir;
	scriptPath;
	waitReadyResolvers = /* @__PURE__ */ new Set();
	onEvent;
	restartTimer;
	constructor(onEvent) {
		this.onEvent = onEvent;
		this.dir = join(tmpdir(), `dsh-task-notify-renderer-${process.pid}`);
		this.scriptPath = fileURLToPath(new URL("./renderer.ps1", import.meta.url));
	}
	get isReady() {
		return this.ready;
	}
	/** 启动常驻进程（幂等）。进程在插件生命周期内复用。 */
	start() {
		if (this.ready || this.starting || this.stopped) return;
		if (process.platform !== "win32") return;
		if (this.restartTimer !== void 0) {
			clearTimeout(this.restartTimer);
			this.restartTimer = void 0;
		}
		this.starting = true;
		try {
			mkdirSync(this.dir, { recursive: true });
		} catch {
			this.starting = false;
			return;
		}
		try {
			const child = spawn("powershell.exe", [
				"-NoProfile",
				"-STA",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				this.scriptPath,
				"-PipeDir",
				this.dir
			], {
				windowsHide: true,
				stdio: [
					"ignore",
					"pipe",
					"ignore"
				]
			});
			this.child = child;
			createInterface({ input: child.stdout }).on("line", (line) => {
				let event;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (typeof event?.type !== "string") return;
				if (event.type === "ready") {
					this.ready = true;
					this.starting = false;
					for (const resolve of this.waitReadyResolvers) resolve(true);
					this.waitReadyResolvers.clear();
				}
				this.onEvent(event);
			});
			child.on("error", () => {
				this.ready = false;
				this.starting = false;
			});
			child.on("exit", () => {
				this.ready = false;
				this.starting = false;
				this.child = void 0;
				for (const resolve of this.waitReadyResolvers) resolve(false);
				this.waitReadyResolvers.clear();
				if (!this.stopped && this.restartTimer === void 0) this.restartTimer = setTimeout(() => {
					this.restartTimer = void 0;
					this.start();
				}, 1e3);
			});
		} catch {
			this.starting = false;
		}
	}
	/** 写入下一条卡片指令；false 表示常驻进程未就绪。 */
	send(payload) {
		if (this.stopped || !this.ready) return false;
		const seq = ++this.seq;
		const file = join(this.dir, "command.json");
		const tmp = `${file}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify({
				...payload,
				seq
			}), "utf8");
			renameSync(tmp, file);
			return true;
		} catch {
			return false;
		}
	}
	/** 等待常驻进程 ready（用于测量与首次通知）。 */
	waitReady(timeoutMs = 3e3) {
		if (this.ready) return Promise.resolve(true);
		if (this.stopped) return Promise.resolve(false);
		this.start();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.waitReadyResolvers.delete(done);
				resolve(false);
			}, timeoutMs);
			const done = (value) => {
				clearTimeout(timer);
				resolve(value);
			};
			this.waitReadyResolvers.add(done);
		});
	}
	stop() {
		this.stopped = true;
		this.ready = false;
		this.starting = false;
		if (this.restartTimer !== void 0) {
			clearTimeout(this.restartTimer);
			this.restartTimer = void 0;
		}
		try {
			this.child?.kill();
		} catch {}
		this.child = void 0;
		try {
			rmSync(this.dir, {
				recursive: true,
				force: true
			});
		} catch {}
	}
};
//#endregion
//#region src/index.ts
const name = "task-notify";
const inject = ["webServer"];
/**
* dsh-plugin-task-notify — Host 半：桌面级完成通知。
*
* 监听 agent/status（running→idle = 一轮任务完成），任务完成时通过
* PowerShell 弹**飞书式置顶卡片**（自定义无边框窗口，不经过 Windows 通知
* 管道，因此系统通知总开关关闭时依然显示）——**与浏览器页面是否打开无关**。
* 卡片样式（主题/强调色/位置/时长/字号/字体）由配置驱动，可在设置页调整。
* 提示音：任务完成时播放可选提示音（默认苹果三全音，宿主合成 WAV，
* 经 SoundPlayer 播放；系统通知/页面是否打开均不影响），可开关、可选音色。
* 另注册 HTTP 桥，供客户端设置行/设置页调用：
*   GET  /task-notify/config       读取完整配置
*   POST /task-notify/config       局部更新（{ "desktop": ..., "accent": ... }）
*   POST /task-notify/test         按当前配置立即弹一条测试卡片
*   GET  /task-notify/events       SSE：向页面广播"打开指定会话"
*   POST /task-notify/action       卡片点击回调（{ action: 'open', sessionId }）
*
* 配置持久化在 ~/.dsh/plugins/task-notify.json，默认开启。
* 仅支持 Windows（powershell.exe + WinForms）；其他平台通道不可用但不影响启动。
*/
const THEMES = ["dark", "light"];
const ACCENTS = [
	"green",
	"blue",
	"orange",
	"purple"
];
const POSITIONS = [
	"br",
	"bl",
	"tr",
	"tl"
];
const DURATIONS = [
	4,
	6,
	8,
	10
];
const FONT_SIZES = [
	11,
	12,
	13,
	14
];
const FONT_FAMILIES = [
	"Microsoft YaHei UI",
	"Segoe UI",
	"SimSun",
	"SimHei",
	"KaiTi"
];
const DEFAULTS = {
	desktop: true,
	theme: "dark",
	accent: "green",
	position: "br",
	durationSec: 6,
	fontSize: 12,
	fontFamily: "Microsoft YaHei UI",
	sound: true,
	soundType: "apple",
	volume: 80,
	errorNotify: true
};
function isOneOf(value, list) {
	return list.includes(value);
}
function sanitizeConfig(raw) {
	const src = typeof raw === "object" && raw !== null ? raw : {};
	return {
		desktop: typeof src.desktop === "boolean" ? src.desktop : DEFAULTS.desktop,
		theme: isOneOf(src.theme, THEMES) ? src.theme : DEFAULTS.theme,
		accent: isOneOf(src.accent, ACCENTS) ? src.accent : DEFAULTS.accent,
		position: isOneOf(src.position, POSITIONS) ? src.position : DEFAULTS.position,
		durationSec: isOneOf(src.durationSec, DURATIONS) ? src.durationSec : DEFAULTS.durationSec,
		fontSize: isOneOf(src.fontSize, FONT_SIZES) ? src.fontSize : DEFAULTS.fontSize,
		fontFamily: isOneOf(src.fontFamily, FONT_FAMILIES) ? src.fontFamily : DEFAULTS.fontFamily,
		sound: typeof src.sound === "boolean" ? src.sound : DEFAULTS.sound,
		soundType: isOneOf(src.soundType, SOUND_TYPES) ? src.soundType : DEFAULTS.soundType,
		volume: typeof src.volume === "number" && Number.isFinite(src.volume) ? Math.max(0, Math.min(100, Math.round(src.volume))) : DEFAULTS.volume,
		errorNotify: typeof src.errorNotify === "boolean" ? src.errorNotify : DEFAULTS.errorNotify
	};
}
/** 子代理会话（origin=subagent 或存在 parentSession）不提醒，避免噪声。 */
function isSubagentSession(session) {
	const header = session?.header;
	return header?.origin === "subagent" || header?.parentSession !== void 0;
}
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const CONFIG_DIR = join(DSH_HOME, "plugins");
const CONFIG_PATH = join(CONFIG_DIR, "task-notify.json");
const SOUND_DIR = join(tmpdir(), "dsh-task-notify-sound");
let WEB_URL = process.env.DSH_WEB_URL ?? "http://127.0.0.1:3080";
/** 同一时刻只保留一张桌面卡片；新通知替换旧卡片，插件停止时兜底关闭。 */
let activePopupChild;
function closeActivePopup() {
	if (activePopupChild === void 0) return;
	const child = activePopupChild;
	activePopupChild = void 0;
	try {
		child.kill();
	} catch {}
}
/** 常驻卡片渲染器（插件生命周期内复用一个 PowerShell/WinForms 窗口）。 */
let cardRenderer;
let broadcastOpenSessionHandler;
let cardSeq = 0;
const pendingMeasure = /* @__PURE__ */ new Map();
const DEBOUNCE_MS = 2e3;
/** HTTP 桥 JSON body 大小上限（本地接口，防止异常请求占用内存）。 */
const MAX_JSON_BODY_BYTES = 65536;
/** 会话标题过长时截断，避免卡片溢出。 */
function truncateTitle(title, max = 26) {
	return title.length > max ? `${title.slice(0, max)}…` : title;
}
/** 从 agent/error 的 unknown error 提取可读摘要。 */
function errorSummary(error) {
	if (error instanceof Error && error.message !== "") return error.message;
	if (typeof error === "string" && error !== "") return error;
	return "未知错误";
}
/** 阻塞等待用户输入/审批的工具：出现 tool/call 即代表等待开始。 */
const BLOCKING_TOOLS = /* @__PURE__ */ new Set(["ask_user_question", "exit_plan_mode"]);
/** 从 tool/call 参数里提取可读的等待说明（问题文本 / 计划标题）。 */
function waitBody(name, argsRaw) {
	try {
		const args = argsRaw ? JSON.parse(argsRaw) : {};
		if (name === "ask_user_question") {
			const first = (Array.isArray(args.questions) ? args.questions : [])[0];
			const text = first?.header ?? first?.question;
			if (typeof text === "string" && text !== "") return truncateTitle(text, 40);
			return "智能体向你提出了一个问题，需要你回答";
		}
		if (name === "exit_plan_mode") {
			const plan = typeof args.plan === "string" ? args.plan : "";
			const match = /^#{1,6}\s+(.+?)\s*$/m.exec(plan);
			if (match?.[1] !== void 0) return `计划「${truncateTitle(match[1], 26)}」等待审批`;
			return "智能体提交了计划，等待你审批";
		}
	} catch {}
	return name === "ask_user_question" ? "智能体向你提出了一个问题，需要你回答" : "智能体提交了计划，等待你审批";
}
/** 等待输入/审批提醒：与完成通知共用通道（卡片+声音），独立防抖。 */
function createWaitNotifier() {
	let lastWaitNotifyAt = 0;
	return (title, body, sessionId) => {
		if (!config.desktop && !config.sound) return;
		const now = Date.now();
		if (now - lastWaitNotifyAt < DEBOUNCE_MS) return;
		lastWaitNotifyAt = now;
		if (config.desktop) notifyCard({
			title,
			text: body,
			variant: "wait",
			sessionId,
			soundOn: config.sound,
			soundType: config.soundType,
			accent: config.accent
		});
		else if (config.sound) playSoundOnly(config.soundType);
	};
}
/**
* 飞书式弹窗：自定义无边框置顶卡片（WinForms），**不经过 Windows 通知管道**，
* 因此系统通知总开关关闭时依然能显示（与飞书/微信桌面端同款做法）。
* 样式由参数驱动：主题（深/浅）、强调色、位置（四角）、显示时长、字号、字体。
* 点击卡片打开 DSH，右上角 × 可关闭，到时自动消失。
*/
/** PowerShell 强调色分支：由共享色板生成，避免与设置页色板漂移。 */
const ACCENT_CASES = Object.keys(ACCENT_COLORS).map((key) => {
	const { r, g, b } = ACCENT_COLORS[key];
	return `  '${key}' { $accentColor = [System.Drawing.Color]::FromArgb(${r}, ${g}, ${b}) }`;
}).join("\n");
const POPUP_SCRIPT = String.raw`param(
  [string]$Title, [string]$Text, [string]$Url,
  [string]$Theme, [string]$Accent, [string]$Position,
  [int]$DurationSec, [int]$FontSize, [string]$FontFamily,
  [string]$SoundOn, [string]$SoundType, [string]$SoundPath,
  [string]$SessionId, [string]$ActionBase, [int]$TargetPid, [string]$Variant,
  [string]$MeasureFile, [long]$T0
)
$ErrorActionPreference = 'SilentlyContinue'

$measureStart = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
function Write-Measure([string]$stage, [long]$t) {
  if ($MeasureFile -ne '') {
    try { Add-Content -Path $MeasureFile -Value ('{"stage":"' + $stage + '","t":' + $t + '}') } catch {}
  }
}
Write-Measure 'boot' $measureStart

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── 高 DPI：Per-Monitor V2，避免整窗被系统位图放大 ──
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DshNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr FindLargestWindow(uint pid) {
    IntPtr found = IntPtr.Zero;
    long best = 0;
    EnumWindows((h, l) => {
      uint p;
      GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      RECT r;
      GetWindowRect(h, out r);
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > best) { best = area; found = h; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
public sealed class DshCardForm : System.Windows.Forms.Form {
  protected override bool ShowWithoutActivation {
    get { return true; }
  }
  protected override System.Windows.Forms.CreateParams CreateParams {
    get {
      System.Windows.Forms.CreateParams cp = base.CreateParams;
      cp.ClassStyle |= 0x00020000; // CS_DROPSHADOW
      cp.ExStyle |= 0x08000000;    // WS_EX_NOACTIVATE：不抢焦点
      return cp;
    }
  }
}
"@ -ReferencedAssemblies System.Windows.Forms
try { [DshNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {
  try { [DshNative]::SetProcessDpiAwareness(2) | Out-Null } catch { [DshNative]::SetProcessDPIAware() | Out-Null }
}
Write-Measure 'types' ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())

# ── 缩放因子（DpiX / 96） ──
$scale = 1.0
try {
  $g0 = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
  $scale = [Math]::Max(1.0, $g0.DpiX / 96.0)
  $g0.Dispose()
} catch {}
function S([double]$v) { return [int][Math]::Round($v * $scale) }

# ── 提示音 ──
if ($SoundOn -eq 'true') {
  if ($SoundType -eq 'system') {
    [System.Media.SystemSounds]::Asterisk.Play()
  } elseif ($SoundPath -ne '') {
    try {
      $player = New-Object System.Media.SoundPlayer $SoundPath
      $player.Play()
    } catch {}
  }
}

# ── 主题色（对齐 DSH design-platform 令牌） ──
if ($Theme -eq 'light') {
  $bg = [System.Drawing.Color]::FromArgb(255, 255, 255)
  $bgTop = [System.Drawing.Color]::FromArgb(255, 255, 255)
  $bgBottom = [System.Drawing.Color]::FromArgb(247, 248, 250)
  $fg = [System.Drawing.Color]::FromArgb(15, 17, 21)
  $sub = [System.Drawing.Color]::FromArgb(97, 102, 107)
  $borderColor = [System.Drawing.Color]::FromArgb(229, 230, 235)
  $closeFg = [System.Drawing.Color]::FromArgb(129, 133, 140)
  $closeHover = [System.Drawing.Color]::FromArgb(241, 243, 245)
} else {
  $bg = [System.Drawing.Color]::FromArgb(35, 35, 36)
  $bgTop = [System.Drawing.Color]::FromArgb(42, 42, 44)
  $bgBottom = [System.Drawing.Color]::FromArgb(30, 30, 31)
  $fg = [System.Drawing.Color]::FromArgb(249, 250, 251)
  $sub = [System.Drawing.Color]::FromArgb(173, 178, 184)
  $borderColor = [System.Drawing.Color]::FromArgb(58, 58, 60)
  $closeFg = [System.Drawing.Color]::FromArgb(129, 133, 140)
  $closeHover = [System.Drawing.Color]::FromArgb(52, 52, 54)
}
$closeBg = $bg

switch ($Accent) {
__ACCENT_CASES__
  default  { $accentColor = [System.Drawing.Color]::FromArgb(34, 197, 94) }
}

# ── 文案与排版（物理像素，随 DPI 缩放） ──
if ($Title.Length -gt 30) { $Title = $Title.Substring(0, 30) + '…' }
if ($Text.Length -gt 120) { $Text = $Text.Substring(0, 120) + '…' }

$titleFont = New-Object System.Drawing.Font($FontFamily, ($FontSize + 1), [System.Drawing.FontStyle]::Bold)
$bodyFont = New-Object System.Drawing.Font($FontFamily, $FontSize)
$iconFont = New-Object System.Drawing.Font('Segoe UI', ($FontSize + 1), [System.Drawing.FontStyle]::Bold)
$closeFont = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Regular)

$measure = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
$titleWidth = 0.0
try { $titleWidth = $measure.MeasureString($Title, $titleFont).Width } catch {}

$formWidth = S 380
if ($titleWidth -gt (S 290)) {
  $formWidth = [int][Math]::Min((S 620), [Math]::Max((S 380), ($titleWidth + (S 150))))
}
$textMaxWidth = $formWidth - (S 100)

# 正文按字符换行，最多两行，尾行省略
$bodyLines = New-Object System.Collections.ArrayList
$line = ''
$consumed = 0
$maxLines = 2
foreach ($ch in $Text.ToCharArray()) {
  $candidate = $line + $ch
  $w = 0.0
  try { $w = $measure.MeasureString($candidate, $bodyFont).Width } catch {}
  if ($w -gt $textMaxWidth -and $line -ne '') {
    [void]$bodyLines.Add($line)
    $line = [string]$ch
    if ($bodyLines.Count -ge $maxLines) { break }
  } else {
    $line = $candidate
  }
  $consumed += 1
}
if ($bodyLines.Count -lt $maxLines -and $line -ne '') { [void]$bodyLines.Add($line) }
if ($bodyLines.Count -eq 0) { [void]$bodyLines.Add('') }
if ($consumed -lt $Text.Length -and $bodyLines.Count -gt 0) {
  $bodyLines[$bodyLines.Count - 1] = $bodyLines[$bodyLines.Count - 1] + '…'
}
$measure.Dispose()

$formHeight = S 84
if ($bodyLines.Count -ge 2) { $formHeight = S 96 }

$form = New-Object DshCardForm
$form.Text = 'dsh-task-notify'
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.BackColor = $bg
$form.Width = $formWidth
$form.Height = $formHeight
$form.DoubleBuffered = $true
$form.ResizeRedraw = $true
$form.Cursor = [System.Windows.Forms.Cursors]::Hand
$form.Opacity = 0.05
Write-Measure 'form' ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())

# Win11 DWM 圆角 + 去系统浅色描边
try {
  $corner = 2
  [DshNative]::DwmSetWindowAttribute($form.Handle, 33, [ref]$corner, 4) | Out-Null
  $darkFlag = if ($Theme -eq 'light') { 0 } else { 1 }
  [DshNative]::DwmSetWindowAttribute($form.Handle, 20, [ref]$darkFlag, 4) | Out-Null
  $noBorder = -2
  [DshNative]::DwmSetWindowAttribute($form.Handle, 34, [ref]$noBorder, 4) | Out-Null
} catch {}

$iconText = '✓'
if ($Variant -eq 'error') { $iconText = '!' }
elseif ($Variant -eq 'wait') { $iconText = '?' }

$closeRect = New-Object System.Drawing.RectangleF(($form.Width - (S 42)), (S 6), (S 32), (S 32))
$script:hoverClose = $false
$script:paused = $false
$script:closing = $false
$script:measurePainted = $false

function Begin-Close {
  if ($script:closing) { return }
  $script:closing = $true
  try { $script:fade.Start() } catch {}
}

$themeBrush = New-Object System.Drawing.SolidBrush($fg)
$subBrush = New-Object System.Drawing.SolidBrush($sub)
$accentBrush = New-Object System.Drawing.SolidBrush($accentColor)
$closeBrush = New-Object System.Drawing.SolidBrush($closeFg)
$iconBrush = New-Object System.Drawing.SolidBrush($accentColor)
$badgeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(32, $accentColor))
$borderPen = New-Object System.Drawing.Pen($borderColor, 1)
$titleFormat = New-Object System.Drawing.StringFormat
$titleFormat.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
$titleFormat.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
$centerFormat = New-Object System.Drawing.StringFormat
$centerFormat.Alignment = [System.Drawing.StringAlignment]::Center
$centerFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
$titleRect = New-Object System.Drawing.RectangleF((S 50), (S 11), ($form.Width - (S 106)), (S 24))
$bodyX = S 50
$bodyY = S 38
$lineHeight = S 18

$form.Add_Paint({
  param($sender, $e)
  $g = $e.Graphics
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  $rect = New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)
  $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $bgTop, $bgBottom, 90)
  $g.FillRectangle($gradient, $rect)
  $gradient.Dispose()

  $stripeRect = New-Object System.Drawing.Rectangle(0, 0, (S 3), $form.Height)
  $g.FillRectangle($accentBrush, $stripeRect)

  $badgeRect = New-Object System.Drawing.RectangleF((S 16), (S 14), (S 22), (S 22))
  $g.FillEllipse($badgeBrush, $badgeRect)
  $g.DrawString($iconText, $iconFont, $iconBrush, $badgeRect, $centerFormat)

  $g.DrawString($Title, $titleFont, $themeBrush, $titleRect, $titleFormat)

  $y = $bodyY
  foreach ($bodyLine in $bodyLines) {
    $g.DrawString($bodyLine, $bodyFont, $subBrush, (New-Object System.Drawing.PointF($bodyX, $y)))
    $y += $lineHeight
  }

  if ($script:hoverClose) {
    $g.FillEllipse((New-Object System.Drawing.SolidBrush($closeHover)), $closeRect)
  }
  $g.DrawString('×', $closeFont, $closeBrush, $closeRect, $centerFormat)

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = S 12
  $d = 2 * $r
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc(($form.ClientSize.Width - $d), 0, $d, $d, 270, 90)
  $path.AddArc(($form.ClientSize.Width - $d), ($form.ClientSize.Height - $d), $d, $d, 0, 90)
  $path.AddArc(0, ($form.ClientSize.Height - $d), $d, $d, 90, 90)
  $path.CloseFigure()
  $g.DrawPath($borderPen, $path)
  $path.Dispose()

  if ($MeasureFile -ne '' -and -not $script:measurePainted) {
    $script:measurePainted = $true
    Write-Measure 'paint' ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  }
})

# ── 点击 / 悬停 ──
$openAction = {
  $delivered = $false
  if ($ActionBase -ne '' -and $SessionId -ne '') {
    try {
      $payload = @{ action = 'open'; sessionId = $SessionId } | ConvertTo-Json -Compress
      $resp = Invoke-WebRequest -Uri ($ActionBase + '/task-notify/action') -Method Post -ContentType 'application/json' -Body $payload -UseBasicParsing -TimeoutSec 3
      if ($resp.StatusCode -eq 200) { $delivered = $true }
    } catch {}
  }
  if (-not $delivered) {
    try { Start-Process $Url } catch {}
  }
  if ($TargetPid -gt 0) {
    try {
      $wsh = New-Object -ComObject WScript.Shell
      $wsh.AppActivate($TargetPid) | Out-Null
    } catch {}
    if ($targetHwnd -ne [IntPtr]::Zero) {
      try {
        [DshNative]::ShowWindow($targetHwnd, 9) | Out-Null
        [DshNative]::SetForegroundWindow($targetHwnd) | Out-Null
      } catch {}
    }
  }
  Begin-Close
}

$form.Add_MouseMove({
  param($sender, $e)
  $p = $form.PointToClient([System.Windows.Forms.Cursor]::Position)
  $inside = $closeRect.Contains([float]$p.X, [float]$p.Y)
  if ($inside -ne $script:hoverClose) {
    $script:hoverClose = $inside
    $form.Invalidate()
  }
})
$form.Add_MouseLeave({
  $script:hoverClose = $false
  $script:paused = $false
  $form.Invalidate()
})
$form.Add_MouseEnter({ $script:paused = $true })
$form.Add_MouseDown({
  param($sender, $e)
  $p = $form.PointToClient([System.Windows.Forms.Cursor]::Position)
  if ($closeRect.Contains([float]$p.X, [float]$p.Y)) {
    Begin-Close
  } else {
    & $openAction
  }
})

# ── 自动消失（悬停暂停） ──
$script:remaining = $DurationSec * 1000
$script:lastTick = [Environment]::TickCount
$auto = New-Object System.Windows.Forms.Timer
$auto.Interval = 100
$auto.Add_Tick({
  $now = [Environment]::TickCount
  $inside = $form.Bounds.Contains([System.Windows.Forms.Cursor]::Position)
  if (-not $inside -and -not $script:closing) {
    $script:remaining -= ($now - $script:lastTick)
    if ($script:remaining -le 0) { Begin-Close }
  }
  $script:lastTick = $now
})

# ── 淡入 / 淡出 ──
$fade = New-Object System.Windows.Forms.Timer
$fade.Interval = 15
$fade.Add_Tick({
  if ($script:closing) {
    $form.Opacity -= 0.16
    if ($form.Opacity -le 0.04) {
      $fade.Stop()
      $form.Close()
    }
  } else {
    $form.Opacity += 0.16
    if ($form.Opacity -ge 1) {
      $form.Opacity = 1
      $fade.Stop()
    }
  }
})

$form.Add_Shown({
  Write-Measure 'shown' ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  $fade.Start()
  $auto.Start()
})

# ── 位置：跟随 DSH 主窗口所在屏幕（O3），兜底主屏 ──
$targetHwnd = [IntPtr]::Zero
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
if ($TargetPid -gt 0) {
  try {
    $targetHwnd = [DshNative]::FindLargestWindow([uint32]$TargetPid)
    if ($targetHwnd -ne [IntPtr]::Zero) {
      $screen = [System.Windows.Forms.Screen]::FromHandle($targetHwnd)
    }
  } catch {}
}
$area = $screen.WorkingArea
switch ($Position) {
  'bl' { $x = $area.Left + (S 16);      $y = $area.Bottom - $form.Height - (S 16) }
  'tr' { $x = $area.Right - $form.Width - (S 16); $y = $area.Top + (S 16) }
  'tl' { $x = $area.Left + (S 16);      $y = $area.Top + (S 16) }
  default { $x = $area.Right - $form.Width - (S 16); $y = $area.Bottom - $form.Height - (S 16) }
}
$form.Location = New-Object System.Drawing.Point($x, $y)

[System.Windows.Forms.Application]::Run($form)
`.replace("__ACCENT_CASES__", ACCENT_CASES).trimStart();
function loadConfig() {
	try {
		if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
		return sanitizeConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
	} catch {
		const fallback = { ...DEFAULTS };
		try {
			saveConfig(fallback);
		} catch {}
		return fallback;
	}
}
function saveConfig(cfg) {
	const tempPath = `${CONFIG_PATH}.tmp`;
	try {
		mkdirSync(CONFIG_DIR, { recursive: true });
		writeFileSync(tempPath, JSON.stringify(cfg, null, 2), "utf8");
		renameSync(tempPath, CONFIG_PATH);
	} catch (error) {
		try {
			unlinkSync(tempPath);
		} catch {}
		console.error("[task-notify] 保存配置失败:", error);
	}
}
/** 确保提示音 WAV 已生成（首用合成缓存到临时目录，文件名含音量），返回路径；失败返回空串。 */
function ensureSoundFile(type) {
	if (type === "system") return "";
	try {
		const file = join(SOUND_DIR, `${type}-${config.volume}.wav`);
		if (!existsSync(file)) {
			mkdirSync(SOUND_DIR, { recursive: true });
			writeFileSync(file, synthSound(type, config.volume));
			for (const old of readdirSync(SOUND_DIR)) {
				if (old === `${type}-${config.volume}.wav`) continue;
				if (!old.startsWith(`${type}-`) || !old.endsWith(".wav")) continue;
				try {
					unlinkSync(join(SOUND_DIR, old));
				} catch {}
			}
		}
		return file;
	} catch {
		return "";
	}
}
/** 仅播放提示音（桌面卡片关闭但提示音开启时；fire-and-forget，PlaySync 阻塞播放完）。 */
function playSoundOnly(soundType) {
	if (process.platform !== "win32") return;
	try {
		if (soundType === "system") {
			spawnHiddenPowerShell(`[System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 900`);
			return;
		}
		const soundPath = ensureSoundFile(soundType);
		if (soundPath === "") return;
		spawnHiddenPowerShell(Buffer.from(`$p = New-Object System.Media.SoundPlayer $env:DSH_TASK_NOTIFY_SOUND_PATH; $p.PlaySync()`, "utf16le").toString("base64"), { DSH_TASK_NOTIFY_SOUND_PATH: soundPath }, true);
	} catch (error) {
		console.error("[task-notify] 播放提示音失败:", error);
	}
}
/** 以隐藏窗口启动 PowerShell，返回已 unref 的 child（失败静默）。 */
function spawnHiddenPowerShell(commandOrEncoded, extraEnv = {}, encoded = false) {
	const child = spawn("powershell.exe", encoded ? [
		"-NoProfile",
		"-WindowStyle",
		"Hidden",
		"-EncodedCommand",
		commandOrEncoded
	] : [
		"-NoProfile",
		"-WindowStyle",
		"Hidden",
		"-Command",
		commandOrEncoded
	], {
		windowsHide: true,
		stdio: "ignore",
		env: {
			...process.env,
			...extraEnv
		}
	});
	child.unref();
	child.on("error", () => {});
}
/** 按当前配置弹飞书式置顶卡片（fire-and-forget，不阻塞宿主；不依赖系统通知开关）。 */
function showPopup(title, text, url = WEB_URL, soundOn = false, soundType = "apple", accent = config.accent, sessionId = "", variant = "success", measure) {
	if (process.platform !== "win32") return;
	const effectiveAccent = variant === "error" ? "red" : variant === "wait" ? "orange" : accent;
	const scriptPath = join(tmpdir(), `dsh-task-notify-popup-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
	const removeScript = () => {
		try {
			unlinkSync(scriptPath);
		} catch {}
	};
	try {
		writeFileSync(scriptPath, `﻿${POPUP_SCRIPT}`, "utf8");
		closeActivePopup();
		const child = spawn("powershell.exe", [
			"-NoProfile",
			"-WindowStyle",
			"Hidden",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			scriptPath,
			title,
			text,
			url,
			config.theme,
			effectiveAccent,
			config.position,
			String(config.durationSec),
			String(config.fontSize),
			config.fontFamily,
			soundOn ? "true" : "false",
			soundType,
			soundOn && soundType !== "system" ? ensureSoundFile(soundType) : "",
			sessionId,
			url.replace(/\/$/, ""),
			String(process.ppid),
			variant,
			measure?.file ?? "",
			String(measure?.t0 ?? 0)
		], {
			windowsHide: true,
			stdio: "ignore"
		});
		child.unref();
		if (measure !== void 0) try {
			appendFileSync(measure.file, `{"stage":"spawn","t":${Date.now()}}\n`);
		} catch {}
		activePopupChild = child;
		child.on("error", () => {
			removeScript();
		});
		child.on("exit", () => {
			if (activePopupChild === child) activePopupChild = void 0;
			removeScript();
		});
	} catch (error) {
		console.error("[task-notify] 弹通知失败:", error);
		removeScript();
	}
}
function buildCardPayload(id, args, t0, tCmd) {
	const accent = args.variant === "error" ? "red" : args.variant === "wait" ? "orange" : args.accent ?? config.accent;
	const soundPath = args.soundOn && args.soundType !== "system" ? ensureSoundFile(args.soundType) : "";
	return {
		id,
		t0,
		tCmd,
		title: args.title,
		body: args.text,
		variant: args.variant,
		theme: config.theme,
		accent,
		position: config.position,
		durationSec: config.durationSec,
		fontSize: config.fontSize,
		fontFamily: config.fontFamily,
		sessionId: args.sessionId,
		url: WEB_URL,
		actionBase: WEB_URL.replace(/\/$/, ""),
		targetPid: process.ppid,
		soundOn: args.soundOn,
		soundType: args.soundType,
		soundPath
	};
}
/** 走常驻渲染器；返回 null 表示渲染器未就绪（调用方走冷启动兜底）。 */
function sendPersistentCard(id, args) {
	if (cardRenderer === void 0 || !cardRenderer.isReady) return null;
	const t0 = Date.now();
	const tCmd = Date.now();
	const payload = buildCardPayload(id, args, t0, tCmd);
	if (!cardRenderer.send(payload)) return null;
	return {
		t0,
		tCmd
	};
}
function notifyCard(args) {
	const id = `${process.pid}-${++cardSeq}-${Date.now()}`;
	if (sendPersistentCard(id, args) !== null) return {
		mode: "persistent",
		id
	};
	showPopup(args.title, args.text, WEB_URL, args.soundOn, args.soundType, args.accent ?? config.accent, args.sessionId, args.variant);
	return { mode: "cold" };
}
function readJsonBody(req) {
	return new Promise((resolve) => {
		let data = "";
		let settled = false;
		req.on("data", (chunk) => {
			if (settled) return;
			data += chunk.toString("utf8");
			if (Buffer.byteLength(data, "utf8") > MAX_JSON_BODY_BYTES) {
				settled = true;
				req.pause();
				resolve({
					ok: false,
					status: 413,
					error: "请求体过大"
				});
			}
		});
		req.on("end", () => {
			if (settled) return;
			settled = true;
			try {
				resolve({
					ok: true,
					value: JSON.parse(data)
				});
			} catch {
				resolve({
					ok: false,
					status: 400,
					error: "请求体不是合法 JSON"
				});
			}
		});
		req.on("error", () => {
			if (settled) return;
			settled = true;
			resolve({
				ok: false,
				status: 400,
				error: "请求体读取失败"
			});
		});
	});
}
function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
let config = loadConfig();
function apply(ctx) {
	ctx.effect(() => () => closeActivePopup());
	if (process.platform === "win32") {
		cardRenderer = new CardRenderer((event) => {
			if (event.type === "action") {
				broadcastOpenSessionHandler?.(event.sessionId);
				return;
			}
			if (event.type === "visible") {
				const waiter = pendingMeasure.get(event.id);
				if (waiter === void 0) return;
				pendingMeasure.delete(event.id);
				const tHost = Date.now();
				waiter.resolve({
					triggerToCmd: waiter.tCmd - waiter.t0,
					cmdToRecv: event.tRecv - waiter.tCmd,
					recvToShow: event.tShow - event.tRecv,
					showToPaint: event.tPaint - event.tShow,
					paintToHost: tHost - event.tPaint,
					total: tHost - waiter.t0
				});
				return;
			}
			if (event.type === "error") console.error("[task-notify] 常驻渲染器错误:", event.message);
		});
		cardRenderer.start();
		ctx.effect(() => () => {
			cardRenderer?.stop();
			cardRenderer = void 0;
		});
	}
	const webServer = ctx.get("webServer");
	const sessionTitle = ctx.get("sessionTitle");
	const running = /* @__PURE__ */ new Map();
	let lastNotifyAt = 0;
	let lastErrorAt = 0;
	const fireWaitNotify = createWaitNotifier();
	const events = ctx;
	events.on("agent/status", (payload) => {
		const agent = payload.agent;
		const header = agent.session?.header;
		if (header?.origin === "subagent" || header?.parentSession !== void 0) return;
		const id = agent.id;
		const nowRunning = payload.status === "running";
		const was = running.get(id);
		running.set(id, nowRunning);
		if (was !== true || nowRunning) return;
		if (!config.desktop && !config.sound) return;
		const now = Date.now();
		if (now - lastNotifyAt < DEBOUNCE_MS) return;
		lastNotifyAt = now;
		const title = truncateTitle(sessionTitle?.get(agent.session)?.title ?? "DSH 会话");
		const sessionId = agent.session?.id ?? agent.id;
		if (config.desktop) notifyCard({
			title: "DSH 任务完成",
			text: `「${title}」已完成`,
			variant: "success",
			sessionId,
			soundOn: config.sound,
			soundType: config.soundType,
			accent: config.accent
		});
		else if (config.sound) playSoundOnly(config.soundType);
	});
	events.on("agent/error", (payload) => {
		if (isSubagentSession(payload.agent.session)) return;
		if (!config.errorNotify) return;
		if (!config.desktop && !config.sound) return;
		const now = Date.now();
		if (now - lastErrorAt < DEBOUNCE_MS) return;
		lastErrorAt = now;
		const title = truncateTitle(sessionTitle?.get(payload.agent.session)?.title ?? "DSH 会话");
		const message = truncateTitle(errorSummary(payload.error), 60);
		const sessionId = payload.agent.session?.id ?? payload.agent.id;
		if (config.desktop) notifyCard({
			title: "DSH 任务出错",
			text: `「${title}」执行出错：${message}`,
			variant: "error",
			sessionId,
			soundOn: config.sound,
			soundType: config.soundType,
			accent: "red"
		});
		else if (config.sound) playSoundOnly(config.soundType);
	});
	events.on("agent/disposed", (payload) => {
		running.delete(payload.agent.id);
	});
	if (process.env.DSH_WEB_URL === void 0 && webServer !== void 0 && typeof webServer.port === "number") WEB_URL = `http://127.0.0.1:${webServer.port}`;
	events.on("session/event", (session, event) => {
		if (isSubagentSession(session)) return;
		if (event?.type !== "tool/call") return;
		const name = event.data?.name;
		if (name === void 0 || !BLOCKING_TOOLS.has(name)) return;
		if (name === "ask_user_question") fireWaitNotify("需要你回答", waitBody(name, event.data?.arguments), session?.id ?? "");
		else fireWaitNotify("计划等待审批", waitBody(name, event.data?.arguments), session?.id ?? "");
	});
	events.on("approval/request", (req, next) => {
		if (!isSubagentSession(req.agent?.session)) {
			const sessionId = req.agent?.session?.id ?? req.agent?.id ?? "";
			fireWaitNotify("等待操作审批", "有一项操作等待你审批", sessionId);
		}
		return next();
	});
	if (webServer !== void 0) {
		const openSessionClients = /* @__PURE__ */ new Set();
		const broadcastOpenSession = (sessionId) => {
			const payload = JSON.stringify({
				type: "open-session",
				sessionId
			});
			let delivered = 0;
			for (const client of openSessionClients) try {
				client.write(`data: ${payload}\n\n`);
				delivered += 1;
			} catch {
				openSessionClients.delete(client);
			}
			return delivered;
		};
		broadcastOpenSessionHandler = (sessionId) => {
			broadcastOpenSession(sessionId);
		};
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/task-notify/events",
			handler: (req, res) => {
				res.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache, no-transform",
					connection: "keep-alive"
				});
				res.write(": connected\n\n");
				openSessionClients.add(res);
				const heartbeat = setInterval(() => {
					try {
						res.write(": ping\n\n");
					} catch {}
				}, 25e3);
				req.on("close", () => {
					clearInterval(heartbeat);
					openSessionClients.delete(res);
				});
			}
		}));
		ctx.effect(() => () => {
			for (const client of openSessionClients) try {
				client.end();
			} catch {}
			openSessionClients.clear();
		});
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/task-notify/action",
			handler: (req, res) => {
				if (req.method !== "POST") {
					sendJson(res, 405, {
						ok: false,
						error: "method not allowed"
					});
					return;
				}
				readJsonBody(req).then((result) => {
					if (!result.ok) {
						sendJson(res, result.status, {
							ok: false,
							error: result.error
						});
						return;
					}
					const body = typeof result.value === "object" && result.value !== null ? result.value : {};
					if (body.action !== "open" || typeof body.sessionId !== "string" || body.sessionId === "") {
						sendJson(res, 400, {
							ok: false,
							error: "action 或 sessionId 非法"
						});
						return;
					}
					sendJson(res, 200, {
						ok: true,
						delivered: broadcastOpenSession(body.sessionId)
					});
				});
			}
		}));
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/task-notify/config",
			handler: (req, res) => {
				if (req.method === "GET") {
					sendJson(res, 200, {
						...config,
						supported: process.platform === "win32"
					});
					return;
				}
				if (req.method === "POST") {
					readJsonBody(req).then((result) => {
						if (!result.ok) {
							sendJson(res, result.status, {
								ok: false,
								error: result.error
							});
							return;
						}
						const body = result.value;
						const patch = typeof body === "object" && body !== null ? body : {};
						const keys = Object.keys(patch);
						if (keys.length === 0) {
							sendJson(res, 400, {
								ok: false,
								error: "配置项不能为空"
							});
							return;
						}
						const known = {
							desktop: true,
							theme: true,
							accent: true,
							position: true,
							durationSec: true,
							fontSize: true,
							fontFamily: true,
							sound: true,
							soundType: true,
							volume: true,
							errorNotify: true
						};
						for (const key of keys) if (!Object.hasOwn(known, key)) {
							sendJson(res, 400, {
								ok: false,
								error: `未知配置项: ${key}`
							});
							return;
						}
						const next = sanitizeConfig({
							...config,
							...patch
						});
						for (const key of keys) {
							const value = patch[key];
							if (!(key === "desktop" ? typeof value === "boolean" : key === "theme" ? isOneOf(value, THEMES) : key === "accent" ? isOneOf(value, ACCENTS) : key === "position" ? isOneOf(value, POSITIONS) : key === "durationSec" ? isOneOf(value, DURATIONS) : key === "fontSize" ? isOneOf(value, FONT_SIZES) : key === "fontFamily" ? isOneOf(value, FONT_FAMILIES) : key === "sound" ? typeof value === "boolean" : key === "soundType" ? isOneOf(value, SOUND_TYPES) : key === "errorNotify" ? typeof value === "boolean" : typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)) {
								sendJson(res, 400, {
									ok: false,
									error: `非法值: ${key}`
								});
								return;
							}
						}
						config = next;
						saveConfig(config);
						sendJson(res, 200, {
							ok: true,
							...config
						});
					});
					return;
				}
				sendJson(res, 405, {
					ok: false,
					error: "method not allowed"
				});
			}
		}));
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/task-notify/test",
			handler: (req, res) => {
				if (req.method !== "POST") {
					sendJson(res, 405, {
						ok: false,
						error: "method not allowed"
					});
					return;
				}
				if (process.platform !== "win32") {
					sendJson(res, 200, {
						ok: false,
						supported: false,
						error: "桌面通知仅支持 Windows"
					});
					return;
				}
				if (!config.desktop && !config.sound) {
					sendJson(res, 200, {
						ok: false,
						supported: true,
						error: "桌面通知与提示音都已关闭"
					});
					return;
				}
				if (!config.desktop) {
					playSoundOnly(config.soundType);
					sendJson(res, 200, {
						ok: true,
						supported: true,
						channels: {
							desktop: false,
							sound: true
						}
					});
					return;
				}
				readJsonBody(req).then((result) => {
					const body = result.ok && typeof result.value === "object" && result.value !== null ? result.value : {};
					const title = typeof body.title === "string" && body.title !== "" ? body.title.slice(0, 80) : "任务完成通知（测试）";
					const text = typeof body.body === "string" && body.body !== "" ? body.body.slice(0, 160) : "桌面通知通道工作正常 ✓";
					const variant = body.variant === "wait" || body.variant === "error" ? body.variant : "success";
					notifyCard({
						title,
						text,
						variant,
						sessionId: typeof body.sessionId === "string" ? body.sessionId : "",
						soundOn: config.sound,
						soundType: config.soundType,
						accent: config.accent
					});
					sendJson(res, 200, {
						ok: true,
						supported: true,
						variant,
						channels: {
							desktop: true,
							sound: config.sound
						}
					});
				});
			}
		}));
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/task-notify/measure",
			handler: (req, res) => {
				if (req.method !== "POST") {
					sendJson(res, 405, {
						ok: false,
						error: "method not allowed"
					});
					return;
				}
				if (process.platform !== "win32") {
					sendJson(res, 200, {
						ok: false,
						supported: false,
						error: "桌面通知仅支持 Windows"
					});
					return;
				}
				readJsonBody(req).then((result) => {
					const body = result.ok && typeof result.value === "object" && result.value !== null ? result.value : {};
					const mode = body.mode === "persistent" ? "persistent" : "cold";
					const title = typeof body.title === "string" && body.title !== "" ? body.title.slice(0, 80) : "延迟测量卡片";
					const text = typeof body.body === "string" && body.body !== "" ? body.body.slice(0, 160) : "启动分段耗时测量";
					const variant = body.variant === "wait" || body.variant === "error" ? body.variant : "success";
					if (mode === "persistent") {
						const renderer = cardRenderer;
						if (renderer === void 0) {
							sendJson(res, 503, {
								ok: false,
								error: "常驻渲染器不可用"
							});
							return;
						}
						(async () => {
							if (!await renderer.waitReady(3e3)) {
								sendJson(res, 503, {
									ok: false,
									error: "常驻渲染器启动超时"
								});
								return;
							}
							const id = `measure-${++cardSeq}-${Date.now()}`;
							const t0 = Date.now();
							const tCmd = Date.now();
							const payload = buildCardPayload(id, {
								title,
								text,
								variant,
								sessionId: "",
								soundOn: false,
								soundType: "apple",
								accent: config.accent
							}, t0, tCmd);
							const result = new Promise((resolve) => {
								pendingMeasure.set(id, {
									resolve,
									t0,
									tCmd
								});
							});
							if (!renderer.send(payload)) {
								pendingMeasure.delete(id);
								sendJson(res, 503, {
									ok: false,
									error: "写入常驻渲染指令失败"
								});
								return;
							}
							const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 3e3));
							const segments = await Promise.race([result, timeout]);
							if (segments === null) {
								pendingMeasure.delete(id);
								sendJson(res, 504, {
									ok: false,
									error: "常驻渲染测量超时（3s）"
								});
								return;
							}
							sendJson(res, 200, {
								ok: true,
								mode,
								segments
							});
						})();
						return;
					}
					const file = join(tmpdir(), `dsh-task-notify-measure-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
					const t0 = Date.now();
					let finished = false;
					let poll;
					const finish = (status, payload) => {
						if (finished) return;
						finished = true;
						if (poll !== void 0) clearInterval(poll);
						sendJson(res, status, payload);
						try {
							unlinkSync(file);
						} catch {}
					};
					showPopup(title, text, WEB_URL, false, "apple", config.accent, "", variant, {
						file,
						t0
					});
					poll = setInterval(() => {
						let lines = [];
						try {
							lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
						} catch {
							return;
						}
						const stages = {};
						for (const line of lines) if (typeof line.stage === "string" && typeof line.t === "number") stages[line.stage] = line.t;
						if (stages.paint === void 0) return;
						const segments = {
							triggerToSpawn: stages.spawn !== void 0 ? stages.spawn - t0 : null,
							spawnToBoot: stages.boot !== void 0 && stages.spawn !== void 0 ? stages.boot - stages.spawn : null,
							bootToTypes: stages.types !== void 0 && stages.boot !== void 0 ? stages.types - stages.boot : null,
							typesToForm: stages.form !== void 0 && stages.types !== void 0 ? stages.form - stages.types : null,
							formToShown: stages.shown !== void 0 && stages.form !== void 0 ? stages.shown - stages.form : null,
							shownToPaint: stages.shown !== void 0 ? stages.paint - stages.shown : null,
							total: stages.paint - t0
						};
						finish(200, {
							ok: true,
							mode,
							segments,
							raw: stages
						});
					}, 20);
					setTimeout(() => finish(504, {
						ok: false,
						error: "测量超时（10s）"
					}), 1e4);
				});
			}
		}));
	}
}
//#endregion
export { apply, inject, name };
