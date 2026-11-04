// The recorder's signals inside a document (spec 30 R5, R6): what a canvas frame (bridge.js) tells the shell beyond its
// ready and errors - its console errors and counted warnings (#28), its elements' load errors (#32), what its budget
// refused (#33) - and the React Profiler's minute, which the frames and the play stage post (#36). The shell takes the
// same rules for its own console and elements (recorder-signals.ts imports this module).
//
// Plain JS that ships verbatim beside bridge.js (build.ts copies it for published HTML frames): it repeats
// perf-records.ts `ERROR_BUDGET.frame` and the minute inline. Nothing runs at import; `startDocumentSignals` and
// `frameRenders` do nothing unless the document records (dev: its URL names the workspace, at the full level, in a
// shell's iframe) - a published canvas, a `core` run and a frame opened on its own pay one check.
//
// Limited at the source (#33): every count is taken BEFORE a message is formatted or posted. Errors, console errors and
// resource errors share 5 a second and 50 per document; what the budget refuses is counted by source and travels on
// its own, in counter-only `sh:dropped` messages (at most one a second, a final one at `pagehide`). A window error spends
// the budget but is never refused: it marks the frame failed (bridge.js, #5).

/** perf-records.ts `ERROR_BUDGET.frame`, repeated (this file ships verbatim). */
export const FRAME_BUDGET = { perSecond: 5, perDoc: 50, countsMs: 1000 }
/** perf-records.ts `RESOURCE_TAGS` (#32). */
export const RESOURCE_TAGS = ['img', 'script', 'link', 'video', 'audio', 'source']
const MAX = 200

/** Does this document record spec 30's signals? In a shell's iframe, on a page that records (its URL names the
 *  workspace, as `withWs()` writes it in dev), at the full level (`?mvrecorder=core` turns it off, #58). */
export function documentRecords(search = location.search) {
  try {
    if (window.parent === window) return false
    const q = new URLSearchParams(search)
    return q.has('ws') && q.get('mvrecorder') !== 'core'
  } catch { return false }
}

/** The period renders and warnings are counted over: a minute. A test shortens it (`__mvSignalsPeriodMs`, set before the
 *  document loads); nothing else does. */
export function periodMs() {
  const v = globalThis.__mvSignalsPeriodMs
  return typeof v === 'number' && v >= 100 ? v : 60000
}

const piece = (x) => {
  if (typeof x === 'string') return x
  if (x instanceof Error) return `${x.name && x.name !== 'Error' ? `${x.name}: ` : ''}${x.message}`
  if (x === null || typeof x !== 'object' && typeof x !== 'function') return String(x)
  if (typeof x === 'function') return `[function ${x.name || 'anonymous'}]`
  if (Array.isArray(x)) return `[Array(${x.length})]`
  // never a deep read: an object's own text is the code's to put in a string (#4)
  return `[${x.constructor?.name || 'Object'}]`
}
/** A console call's message as the code produced it (#4, #28): its strings, `%s`/`%d`/`%i`/`%f`/`%o`/`%O`
 *  substituted, `%c` styles dropped, errors by their message, objects by their kind - `max` characters, built no
 *  further than that. */
export function formatConsole(args, max = MAX) {
  let out = ''
  let i = 0
  if (typeof args[0] === 'string') {
    i = 1
    out = args[0].replace(/%[sdifoOc%]/g, (spec) => {
      if (spec === '%%') return '%'
      if (i >= args.length) return spec
      const a = args[i++]
      if (spec === '%c') return ''
      try { return spec === '%d' || spec === '%i' ? String(parseInt(a, 10)) : spec === '%f' ? String(Number(a)) : piece(a) } catch { return '?' }
    })
  }
  for (; i < args.length && out.length < max; i++) {
    let p
    try { p = piece(args[i]) } catch { p = '?' }
    out = out ? `${out} ${p}` : p
  }
  return out.slice(0, max)
}
/** The first error's first three stack lines among a console call's arguments, when it has them. */
export function stackOfArgs(args) {
  const err = args.find((a) => a instanceof Error)
  if (!err || typeof err.stack !== 'string') return undefined
  const lines = err.stack.split('\n')
  const chrome = lines.filter((l) => /^\s*at /.test(l))
  const out = (chrome.length ? chrome : lines.filter((l) => /@.*:\d+(:\d+)?$/.test(l.trim()))).slice(0, 3).map((l) => l.trim().slice(0, MAX))
  return out.length ? out : undefined
}
/** Vite's own echo of a server error into every document's console (overlay off): the shell's `vite:error` listener
 *  records it once (#29), so no console hook does. */
export const viteEcho = (args) => typeof args[0] === 'string' && args[0].startsWith('[vite] Internal Server Error')

/** #32: a same-origin URL's path without its query; another origin, its origin alone; any other scheme, the scheme. */
export function resourceUrl(raw, base = location.href) {
  try {
    const u = new URL(raw, base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.protocol
    return u.origin === new URL(base).origin ? u.pathname : u.origin
  } catch { return '' }
}
/** An element whose load failed, as #32 records it: its tag and URL, or null for anything else. */
export function resourceOf(target, base) {
  if (!target || typeof target.tagName !== 'string') return null
  const tag = target.tagName.toLowerCase()
  if (!RESOURCE_TAGS.includes(tag)) return null
  const raw = tag === 'link' ? target.href : (target.currentSrc || target.src || target.getAttribute?.('src') || '')
  return { tag, url: resourceUrl(String(raw ?? ''), base) }
}

/** #33: the document's budget - `perSecond` and `perDoc`, shared by every source. A refusal is told to `refused` with
 *  its source; `force` passes whatever the budget says (and counts against it). */
export function createBudget(limits, refused, now = () => performance.now()) {
  let used = 0, sec = NaN, inSec = 0
  return {
    take(source, force = false) {
      const s = Math.floor(now() / 1000)
      if (s !== sec) { sec = s; inSec = 0 }
      if (!force && (used >= limits.perDoc || inSec >= limits.perSecond)) { refused(source); return false }
      used++; inSec++
      return true
    },
  }
}

/** Counts that travel on their own: added up and sent at most once every `ms` (the first at once, after a quiet
 *  `ms`), a final send when asked - nothing when there is nothing to say. */
export function createCounter(ms, send, now = () => performance.now()) {
  let counts = null, timer = null, last = -Infinity
  const go = (final) => {
    if (timer !== null) { clearTimeout(timer); timer = null }
    if (!counts) return
    const c = counts
    counts = null
    last = now()
    send(c, final)
  }
  return {
    add(key, n = 1) {
      if (!counts) counts = {}
      counts[key] = (counts[key] ?? 0) + n
      if (timer === null) timer = setTimeout(() => go(false), Math.max(0, last + ms - now()))
    },
    final() { go(true) },
  }
}

// ---- a document's hooks (bridge.js) ------------------------------------------------------------------------------

/** a gesture runs on the canvas over this frame (`sh:gesture`): its commits count `inGesture` */
let gesture = false
let started = null
const consoleListeners = new Set()
/** Told every `console.error` of this document with its arguments, before any budget (the edits stream's #15 reads
 *  Vite's own failure message here). Returns the unsubscribe. */
export function onConsoleError(fn) { consoleListeners.add(fn); return () => { consoleListeners.delete(fn) } }

/**
 * A canvas frame's hooks, once (bridge.js, before anything else it posts): `console.error` and `console.warn` wrapped
 * (the original runs first), the capture-phase element error listener, the budget, the counters, and the shell's
 * `sh:gesture`. Returns `take(source, force?)` - the budget, which the bridge's own window errors spend with `force` -
 * or null when this document does not record.
 */
export function startDocumentSignals({ post, id, gen, boot }) {
  if (started) return started
  if (!documentRecords()) return null
  const dropped = createCounter(FRAME_BUDGET.countsMs, (counts, final) => post({ type: 'sh:dropped', id, boot, counts, ...(final ? { final: true } : {}) }))
  const budget = createBudget(FRAME_BUDGET, (source) => dropped.add(source, 1))
  const warns = createCounter(FRAME_BUDGET.countsMs, (counts, final) => post({ type: 'sh:warnings', id, boot, n: counts.n, ...(final ? { final: true } : {}) }))

  const error0 = console.error, warn0 = console.warn
  console.error = function (...args) {
    error0.apply(this, args)
    try {
      for (const fn of consoleListeners) { try { fn(args) } catch { /* one listener, not the rest */ } }
      if (viteEcho(args) || !budget.take('console')) return
      const stack = stackOfArgs(args)
      post({ type: 'sh:console', id, gen, boot, message: formatConsole(args), ...(stack ? { stack } : {}) })
    } catch { /* never in the way */ }
  }
  console.warn = function (...args) {
    warn0.apply(this, args)
    try { warns.add('n', 1) } catch { /* never in the way */ }
  }
  // an element's load error does not bubble: the capture phase at the window sees every one
  addEventListener('error', (e) => {
    try {
      if (!(e.target instanceof Element)) return
      const r = resourceOf(e.target)
      if (!r || !budget.take('resource')) return
      post({ type: 'sh:resource-error', id, gen, boot, tag: r.tag, url: r.url })
    } catch { /* never in the way */ }
  }, true)
  addEventListener('message', (e) => {
    if (e.source !== window.parent || window.parent === window || (e.origin && e.origin !== location.origin)) return
    if (e.data?.type === 'sh:gesture') gesture = !!e.data.on
  })
  addEventListener('pagehide', () => { dropped.final(); warns.final() })
  started = { take: (source, force) => budget.take(source, force) }
  return started
}

/**
 * #36: a document's React commits, by minute - the frame root's (frame-host/main.tsx) or the stage root's: `commits`,
 * `ms` (the sum of `actualDuration`), `maxMs` and `inGesture`, posted as `sh:renders` once the minute is over, and the
 * minute so far at `pagehide`. The Profiler's `onRender`, or null when this document does not record. No props, state
 * or text: numbers only.
 */
export function frameRenders(post, id, getBoot) {
  if (!documentRecords()) return null
  let minute = -1, commits = 0, ms = 0, maxMs = 0, inGesture = 0, timer = null
  const flush = () => {
    if (timer !== null) { clearTimeout(timer); timer = null }
    if (!commits) return
    post({ type: 'sh:renders', id, boot: getBoot() ?? '', minute, commits, ms: Math.round(ms * 10) / 10, maxMs: Math.round(maxMs * 10) / 10, inGesture })
    commits = 0; ms = 0; maxMs = 0; inGesture = 0
  }
  addEventListener('pagehide', flush)
  return (_id, _phase, actual) => {
    try {
      const p = periodMs(), now = Date.now(), m = Math.floor(now / p) * p
      if (m !== minute) { flush(); minute = m }
      commits++
      if (typeof actual === 'number' && actual > 0) { ms += actual; if (actual > maxMs) maxMs = actual }
      if (gesture) inGesture++
      if (timer === null) timer = setTimeout(flush, m + p - now + 50)
    } catch { /* never in the way */ }
  }
}
