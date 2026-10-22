// Preloaded (`node --import`) into a process that starts a canvas, so a test can ask what Marver's own
// code left running: every fs.watch, setTimeout and setInterval whose immediate caller is a file under
// MV_HANDLES_SRC (the repo's src/) - never one Vite or another package made - until it is closed,
// cleared or has fired. `globalThis.__marverLive()` lists what is still live. (startup.test.ts, spec 28 A1.1)
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const SRC = process.env.MV_HANDLES_SRC ?? ''
const live = new Map()

/** Whether the first frame outside node's internals and this file is Marver's. */
const mine = () => {
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 20
  const stack = new Error().stack ?? ''
  Error.stackTraceLimit = limit
  for (const line of stack.split('\n').slice(1)) {
    if (line.includes('marver-handles.mjs') || /\(node:|at node:/.test(line)) continue
    return !!SRC && line.includes(SRC) && !line.includes('/node_modules/')
  }
  return false
}
const where = () => (new Error().stack ?? '').split('\n').slice(1).find((l) => l.includes(SRC))?.trim() ?? '?'

const { setTimeout: st, clearTimeout: ct, setInterval: si, clearInterval: ci } = globalThis
globalThis.setTimeout = function (fn, ms, ...args) {
  if (typeof fn !== 'function' || !mine()) return st(fn, ms, ...args)
  const t = st(function (...a) { live.delete(t); return fn.apply(this, a) }, ms, ...args)
  live.set(t, `setTimeout(${ms ?? 0}) ${where()}`)
  return t
}
globalThis.clearTimeout = function (t) { live.delete(t); return ct(t) }
globalThis.setInterval = function (fn, ms, ...args) {
  if (typeof fn !== 'function' || !mine()) return si(fn, ms, ...args)
  const t = si(fn, ms, ...args)
  live.set(t, `setInterval(${ms ?? 0}) ${where()}`)
  return t
}
globalThis.clearInterval = function (t) { live.delete(t); return ci(t) }

const watch = fs.watch
fs.watch = function (...a) {
  const w = watch.apply(this, a)
  if (mine()) {
    live.set(w, `fs.watch ${a[0]} ${where()}`)
    const close = w.close.bind(w)
    w.close = () => { live.delete(w); return close() }
  }
  return w
}
syncBuiltinESMExports()

globalThis.__marverLive = () => [...live.values()]
