import type { Context } from '@deepseek-ai/cordis'
import type {
  SessionsFace,
  SlotsFace,
  StatusStore,
  UiSessionFace,
  UiWorkspaceFace,
} from './client/types'
import { getConfig } from './client/config'
import { disposeToasts, pushToast, setOpenSession, ToastStack } from './client/toasts'
import { watchCompletions, watchWaits, type CompletionInfo } from './client/watcher'
import { TaskNotifySettings, TaskNotifySection } from './client/settings'
import { injectStyles } from './client/styles'
import { DICTS, NS, setTranslator, t } from './client/locales'

export const inject = ['sessions', 'slots', 'locale']

interface LocaleFace {
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
}

/**
 * dsh-plugin-task-notify — 任务完成通知（Client 半），适配 DSH 0.2.x。
 *
 * 机制：订阅 ctx.sessions.list 快照存储，监听顶层会话 running→idle 翻转
 * （即一轮任务完成）触发应用内 toast；等待用户输入/审批则订阅
 * ctx.uiSession.sessionStatus 的 pendingInteraction。**系统级桌面通知由
 * Host 半负责**（agent/status，独立于浏览器页面），客户端只做页面内提示
 * 与设置行（通过 /task-notify/* HTTP 桥控制宿主开关）。
 * 点击 toast 用 ctx.uiWorkspace.openSession 打开对应会话（0.2.x 移除了
 * sessions.open）。UI 全部走槽位：shell.overlay（toast 堆栈）+
 * settings.general.item（设置行）+ settings.section（完整设置页）。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => injectStyles(), 'task-notify: styles')

  // 卸载时清理 toast 定时器与监听
  ctx.effect(() => disposeToasts)

  const sessions = ctx.get('sessions') as unknown as SessionsFace
  const slots = ctx.get('slots') as unknown as SlotsFace
  const locale = ctx.get('locale') as LocaleFace | undefined

  if (locale !== undefined) {
    const translate = locale.bind(NS)
    setTranslator((key, params) => (params !== undefined ? translate(key, params) : translate(key)))
    ctx.effect(() => locale.register(NS, DICTS), 'task-notify: dictionaries')
  }

  // 点击应用内 toast → 打开对应会话（由 uiWorkspace 负责导航）
  setOpenSession((sessionId) => {
    try {
      const workspace = ctx.get('uiWorkspace') as UiWorkspaceFace | undefined
      workspace?.openSession(sessionId)
    } catch {
      // 会话可能已不存在，忽略
    }
  })

  // 桌面卡片点击：Host 通过 SSE 广播 open-session，页面内精确打开对应会话
  ctx.effect(() => {
    if (typeof EventSource === 'undefined') return () => {}
    let source: EventSource | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let closed = false

    const connect = (): void => {
      if (closed) return
      source = new EventSource('/task-notify/events')
      source.onmessage = (event: MessageEvent<string>) => {
        try {
          const data = JSON.parse(event.data) as { type?: unknown; sessionId?: unknown }
          if (data.type !== 'open-session' || typeof data.sessionId !== 'string' || data.sessionId === '') return
          const workspace = ctx.get('uiWorkspace') as UiWorkspaceFace | undefined
          workspace?.openSession(data.sessionId)
          window.focus()
        } catch {
          // 忽略非法事件
        }
      }
      source.onerror = () => {
        source?.close()
        if (closed) return
        retry = setTimeout(connect, 2000)
      }
    }
    connect()

    return () => {
      closed = true
      if (retry !== undefined) clearTimeout(retry)
      source?.close()
    }
  }, 'task-notify: open-session stream')

  const notifyComplete = (info: CompletionInfo): void => {
    const cfg = getConfig()
    if (!cfg.toast) return
    const title = info.title !== '' ? info.title : t('toast.untitled')
    pushToast({ title, body: t('toast.done'), sessionId: info.sessionId })
  }

  const notifyWait = (info: CompletionInfo): void => {
    const cfg = getConfig()
    if (!cfg.toast) return
    const title = info.title !== '' ? info.title : t('toast.untitled')
    pushToast({ title, body: t('toast.wait'), sessionId: info.sessionId })
  }

  // 会话完成（running→idle）→ 应用内 toast（桌面通知由 Host 半负责）
  const unwatch = watchCompletions(sessions.list, notifyComplete)
  ctx.effect(() => unwatch)

  // 会话等待用户输入/审批（0.2.x：uiSession.sessionStatus.pendingInteraction）。
  // 该服务可能晚于本插件就绪，用 ctx.inject 等它出现后再订阅。
  ctx.inject(['uiSession'], (scope) => {
    const uiSession = scope.get('uiSession') as UiSessionFace | undefined
    const sessionStatus: StatusStore | undefined = uiSession?.sessionStatus
    if (sessionStatus === undefined) return
    const unwatchWait = watchWaits(sessionStatus, sessions.list, notifyWait)
    ctx.effect(() => unwatchWait)
  })

  // 应用内 toast 堆栈（全局浮层）
  slots.inject('shell.overlay', () =>
    slots.register({ name: 'shell.overlay', id: 'task-notify-toasts', order: 100 }, ToastStack),
  )

  // 设置行（设置页 General 一节）
  slots.inject('settings.general.item', () =>
    slots.register({ name: 'settings.general.item', id: 'task-notify', order: 30 }, TaskNotifySettings),
  )

  // 完整设置页（设置导航新增「任务完成通知」；label 用 thunk，与官方设置页写法一致）
  slots.inject('settings.section', () =>
    slots.register(
      { name: 'settings.section', id: 'task-notify', order: 25, label: () => t('settings.title') },
      TaskNotifySection,
    ),
  )
}
