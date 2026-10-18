import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface CardPayload {
  id: string
  t0: number
  tCmd: number
  title: string
  body: string
  variant: 'success' | 'wait' | 'error'
  theme: string
  accent: string
  position: string
  durationSec: number
  fontSize: number
  fontFamily: string
  sessionId: string
  url: string
  actionBase: string
  targetPid: number
  soundOn: boolean
  soundType: string
  soundPath: string
}

export type RendererEvent =
  | { type: 'ready'; pid: number; ts: number }
  | { type: 'visible'; id: string; tRecv: number; tShow: number; tPaint: number }
  | { type: 'action'; id: string; sessionId: string }
  | { type: 'closed'; id: string }
  | { type: 'error'; message: string }

type EventHandler = (event: RendererEvent) => void

/**
 * 常驻卡片渲染进程管理：进程/窗口只创建一次，后续通知只写 command.json。
 * 冷启动路径仍由 index.ts 的 showPopup 作为兜底。
 */
export class CardRenderer {
  private child: ChildProcess | undefined
  private ready = false
  private starting = false
  private stopped = false
  private seq = 0
  private readonly dir: string
  private readonly scriptPath: string
  private readonly waitReadyResolvers = new Set<(ready: boolean) => void>()
  private readonly onEvent: EventHandler
  private restartTimer: ReturnType<typeof setTimeout> | undefined

  constructor(onEvent: EventHandler) {
    this.onEvent = onEvent
    this.dir = join(tmpdir(), `dsh-task-notify-renderer-${process.pid}`)
    this.scriptPath = fileURLToPath(new URL('./renderer.ps1', import.meta.url))
  }

  get isReady(): boolean {
    return this.ready
  }

  /** 启动常驻进程（幂等）。进程在插件生命周期内复用。 */
  start(): void {
    if (this.ready || this.starting || this.stopped) return
    if (process.platform !== 'win32') return
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    this.starting = true
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch {
      this.starting = false
      return
    }
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, '-PipeDir', this.dir],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )
      this.child = child
      const lines = createInterface({ input: child.stdout! })
      lines.on('line', (line) => {
        let event: RendererEvent
        try {
          event = JSON.parse(line) as RendererEvent
        } catch {
          return
        }
        if (typeof event?.type !== 'string') return
        if (event.type === 'ready') {
          this.ready = true
          this.starting = false
          for (const resolve of this.waitReadyResolvers) resolve(true)
          this.waitReadyResolvers.clear()
        }
        this.onEvent(event)
      })
      child.on('error', () => {
        this.ready = false
        this.starting = false
      })
      child.on('exit', () => {
        this.ready = false
        this.starting = false
        this.child = undefined
        for (const resolve of this.waitReadyResolvers) resolve(false)
        this.waitReadyResolvers.clear()
        // 异常退出后自动重启；下一次通知若仍未就绪则走冷启动兜底
        if (!this.stopped && this.restartTimer === undefined) {
          this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined
            this.start()
          }, 1000)
        }
      })
    } catch {
      this.starting = false
    }
  }

  /** 写入下一条卡片指令；false 表示常驻进程未就绪。 */
  send(payload: CardPayload): boolean {
    if (this.stopped || !this.ready) return false
    const seq = ++this.seq
    const file = join(this.dir, 'command.json')
    const tmp = `${file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify({ ...payload, seq }), 'utf8')
      renameSync(tmp, file)
      return true
    } catch {
      return false
    }
  }

  /** 等待常驻进程 ready（用于测量与首次通知）。 */
  waitReady(timeoutMs = 3000): Promise<boolean> {
    if (this.ready) return Promise.resolve(true)
    if (this.stopped) return Promise.resolve(false)
    this.start()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waitReadyResolvers.delete(done)
        resolve(false)
      }, timeoutMs)
      const done = (value: boolean): void => {
        clearTimeout(timer)
        resolve(value)
      }
      this.waitReadyResolvers.add(done)
    })
  }

  stop(): void {
    this.stopped = true
    this.ready = false
    this.starting = false
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    try {
      this.child?.kill()
    } catch {
      // 进程可能已退出
    }
    this.child = undefined
    try {
      rmSync(this.dir, { recursive: true, force: true })
    } catch {
      // 临时目录可能已被清理
    }
  }
}
