/**
 * 冒烟测试：模拟 DSH 0.2.x 客户端模块加载器加载 lib/client.js。
 * 验证：① bundle 注册了 factory；② factory(require) 产出 { inject, apply }；
 * ③ apply(ctx) 用最小桩可端到端执行不抛错（订阅 + 槽位注册 + uiSession 等待）；
 * ④ 会话列表 running→idle 与 uiSession pendingInteraction 变化不抛错。
 * 用法：node scripts/smoke-client.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── 浏览器全局桩 ──────────────────────────────────────────────
let handoff = null
globalThis.window = {
  __ModuleLoader__: {
    load: (h) => {
      handoff = h
    },
  },
}
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null },
  setItem(k, v) { this._m.set(k, String(v)) },
  removeItem(k) { this._m.delete(k) },
}
globalThis.document = {
  head: { appendChild: () => {} },
  querySelector: () => null,
  createElement: () => ({ dataset: {} }),
}
globalThis.Notification = undefined

// react 桩：任意属性/调用都返回函数，能过模块加载即可
const reactStub = new Proxy(function () {}, {
  get: () => reactStub,
  apply: () => reactStub,
})

// ── 可订阅快照存储桩（sessions.list / uiSession.sessionStatus） ──
function makeStore(initial) {
  let state = initial
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    set(next) {
      state = next
      for (const fn of [...listeners]) fn()
    },
    get watched() {
      return listeners.size
    },
  }
}

// ── 加载 bundle ───────────────────────────────────────────────
const code = readFileSync(join(root, 'lib/client.js'), 'utf8')
// eslint-disable-next-line no-eval
eval(code)
if (handoff === null) {
  console.error('FAIL: bundle 没有调用 window.__ModuleLoader__.load')
  process.exit(1)
}
console.log('✓ bundle 注册了 factory, id =', handoff.id)

// ── 执行 factory（等价于加载器 materialize）──────────────────
const makeRequire = (spec) => {
  if (spec === 'react') return reactStub
  throw new Error(`unexpected require: ${spec}`)
}
const exportsObj = handoff.factory(makeRequire)
const inject = exportsObj.inject
const apply = exportsObj.apply
console.log('✓ exports:', Object.keys(exportsObj).join(', '))
console.log('✓ inject =', JSON.stringify(inject))
if (!Array.isArray(inject) || inject.join(',') !== 'sessions,slots,locale') {
  console.error('FAIL: inject 不是 ["sessions","slots","locale"]')
  process.exit(1)
}
if (typeof apply !== 'function') {
  console.error('FAIL: apply 不是函数')
  process.exit(1)
}

// ── 执行 apply（最小 ctx 桩，模拟 0.2.x 服务）─────────────────
const listStore = makeStore({ byId: {} })
const statusStore = makeStore(new Map())

const sessionsStub = {
  list: {
    getSnapshot: () => listStore.getSnapshot(),
    subscribe: (fn) => listStore.subscribe(fn),
  },
}

const sessionStatus = {
  getSnapshot: () => statusStore.getSnapshot(),
  subscribe: (fn) => statusStore.subscribe(fn),
}

const slotNames = []
const ctxStub = {
  effect: (cb) => {
    const cleanup = cb()
    return () => { if (typeof cleanup === 'function') cleanup() }
  },
  inject: (deps, cb) => {
    cb(ctxStub)
    return () => {}
  },
  get: (name) => {
    if (name === 'sessions') return sessionsStub
    if (name === 'slots') return slotsStub
    if (name === 'locale') return { bind: () => () => '', register: () => () => {} }
    if (name === 'uiSession') return { sessionStatus }
    if (name === 'uiWorkspace') return { openSession: () => {} }
    return undefined
  },
}
const slotsStub = {
  inject: (key, cb) => { cb(); return () => {} },
  register: (options) => { slotNames.push(options.name); return () => {} },
}
apply(ctxStub)
console.log('✓ apply(ctx) 端到端执行通过（订阅 + 槽位注册 + uiSession 等待路径无异常）')

for (const required of ['shell.overlay', 'settings.general.item', 'settings.section']) {
  if (!slotNames.includes(required)) {
    console.error(`FAIL: 未注册槽位 ${required}`)
    process.exit(1)
  }
}
console.log('✓ 槽位注册:', slotNames.join(', '))

// ── 会话完成 + 等待交互的事件路径（0.2.x 形状）────────────────
listStore.set({
  byId: {
    s1: { displayTitle: '会话一', running: true, blank: false },
  },
})
listStore.set({
  byId: {
    s1: { displayTitle: '会话一', running: false, blank: false },
  },
})
statusStore.set(new Map([['s1', { running: true, pendingInteraction: { key: 'k', kind: 'question' } }]]))
statusStore.set(new Map([['s1', { running: false }]]))
console.log('✓ running→idle 与 pendingInteraction 变化路径无异常')

console.log('\nSMOKE TEST PASSED')
