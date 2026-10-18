import type { SessionListState, StatusStore } from './types'

export interface CompletionInfo {
  sessionId: string
  title: string
}

/**
 * 监听顶层会话的完成：
 *
 * - 订阅 sessions.list 快照存储，running→idle 即一轮任务完成（onComplete）。
 * - 只关心顶层会话（parentId 为空、origin 不是 subagent），子代理会话不提醒。
 * - blank（从未发过消息）的会话不参与。
 * - 首次调用只播种当前状态，不触发任何通知。
 *
 * @param list sessions.list 快照存储（getSnapshot + subscribe）。
 * @param onComplete 会话完成回调。
 * @returns 取消订阅函数，插件卸载时应调用。
 */
export function watchCompletions(
  list: { getSnapshot(): SessionListState; subscribe(fn: () => void): () => void },
  onComplete: (info: CompletionInfo) => void,
): () => void {
  const running = new Map<string, boolean>()

  const check = (): void => {
    const byId = list.getSnapshot().byId

    // 清理已从列表消失的会话
    for (const id of [...running.keys()]) {
      if (byId[id] === undefined) running.delete(id)
    }

    for (const id of Object.keys(byId)) {
      const row = byId[id]
      if (row === undefined) continue
      // 子代理会话不提醒
      if (row.parentId !== undefined || row.origin === 'subagent') {
        running.delete(id)
        continue
      }
      // 空会话（从未发过消息）不参与
      if (row.blank) {
        running.delete(id)
        continue
      }

      // 完成：running→idle
      const was = running.get(id)
      const now = row.running
      if (was === true && now === false) {
        onComplete({ sessionId: id, title: row.displayTitle })
        running.set(id, false)
      } else {
        running.set(id, now)
      }
    }
  }

  // 首次播种：只记录当前状态，不触发通知
  check()
  return list.subscribe(check)
}

/**
 * 监听会话进入“等待用户输入/审批”：
 *
 * - DSH 0.2.x 起该标记不再挂在会话列表行上，而在
 *   `uiSession.sessionStatus`（ReadonlyMap<SessionId, SessionStatus>）。
 * - pendingInteraction 从无到有 → onWaitStart；等待期间 agent 状态保持 running，
 *   完成通知不会触发，需要单独检测。
 * - 只关心顶层非空会话，子代理不提醒。
 * - 首次调用只播种当前状态，不触发任何通知。
 *
 * @param status uiSession.sessionStatus 快照存储。
 * @param list sessions.list 快照存储（用于标题与子代理过滤）。
 * @param onWaitStart 会话开始等待用户输入/审批的回调。
 * @returns 取消订阅函数，插件卸载时应调用。
 */
export function watchWaits(
  status: StatusStore,
  list: { getSnapshot(): SessionListState; subscribe(fn: () => void): () => void },
  onWaitStart: (info: CompletionInfo) => void,
): () => void {
  const waiting = new Set<string>()

  const check = (): void => {
    const snapshot = status.getSnapshot()
    const byId = list.getSnapshot().byId

    for (const id of [...waiting]) {
      const entry = snapshot.get(id)
      if (entry === undefined || entry.pendingInteraction === undefined) waiting.delete(id)
    }

    for (const [id, entry] of snapshot) {
      if (entry.pendingInteraction === undefined || waiting.has(id)) continue
      const row = byId[id]
      // 子代理/空会话/尚未出现在列表里的会话不提醒
      if (row === undefined || row.parentId !== undefined || row.origin === 'subagent' || row.blank) continue
      waiting.add(id)
      onWaitStart({ sessionId: id, title: row.displayTitle })
    }
  }

  // 首次播种：只记录当前状态，不触发通知
  check()
  const unwatchStatus = status.subscribe(check)
  const unwatchList = list.subscribe(check)
  return () => {
    unwatchStatus()
    unwatchList()
  }
}
