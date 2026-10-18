// The capture recorder (spec 27, "One recorder, one clock") - one small module shared by canvas
// frames (bridge.js) and the play stage (stage/main.tsx). It does nothing while no capture is open.
//
//   shell -> frame : sh:capture { id, on } · sh:capture-hello { nonce } · sh:probe { id, req, x, y }
//   frame -> shell : sh:capture-hello { nonce, captureDoc } · sh:probe { id, req, captureDoc, bundle }
//                    sh:trail { id, captureDoc, frame, seq, at, event, mode, ...payload }
//                    sh:capture-flushed { id, captureDoc, seq }
//
// `captureDoc` is a nonce drawn once per document load - the shell's load-bound handshake learns it,
// and drops anything from a document it did not bind. `at` is when the thing happened, on the one
// clock every document on this machine shares (timeOrigin + now); `seq` numbers this document's
// messages; `frame` is the frame it happened in, taken WHEN it happened (the stage swaps frames in one
// document, so a field changed on screen A and blurred on B is A's). Every element goes out through
// safeBundle, a field's value through fieldValue - interact and play are no exception. The clipboard
// is never read, keys outside fields are never recorded.
import { fieldValue, safeBundle } from './inspect.js'

const FIELD_IDLE_MS = 600
const HOVER_MS = 800
const HOVER_EVERY_MS = 2000
const HOVER_SLOP = 4
const SCROLL_SETTLE_MS = 400

const now = () => performance.timeOrigin + performance.now()
const nonce = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)

/**
 *   createRecorder({ post, getFrame, mode, trusted })
 *     post(msg)      send to the shell
 *     getFrame()     the frame showing now (static on canvas, the current screen in play)
 *     mode           'interact' (a canvas frame - the shell's overlay keeps canvas-mode clicks, so a
 *                    click that reaches the frame is interact) or 'play' (the stage)
 *     trusted(e)     is this message the shell's?
 *   returns { pick(el, e) -> boolean, screen(to), dispose() }
 */
export function createRecorder({ post, getFrame, mode, trusted }) {
  const captureDoc = nonce()
  let captureId = null
  let seq = 0
  // fields changed and not sent yet: element -> { id, frame, at, timer }
  const pending = new Map()
  const removers = []
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); removers.push(() => target.removeEventListener(type, fn, opts)) }

  const send = (id, event, payload, frame = getFrame(), at = now()) => {
    if (!id) return
    post({ type: 'sh:trail', id, captureDoc, frame, seq: ++seq, at, event, mode, ...payload })
  }
  const record = (event, payload, frame, at) => send(captureId, event, payload, frame, at)

  // ---- fields: sent when focus leaves the field, or after 600 ms idle --------------------------
  const sendField = (el) => {
    const p = pending.get(el)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(el)
    send(p.id, 'field', { bundle: safeBundle(el), value: fieldValue(el) }, p.frame, p.at)
  }
  const flushFields = (id) => { for (const [el, p] of [...pending]) if (!id || p.id === id) sendField(el) }
  const onField = (e) => {
    const el = e.target
    if (!captureId || !(el instanceof Element) || !el.matches('input, textarea, select')) return
    const was = pending.get(el)
    if (was && was.id !== captureId) sendField(el)   // a change from the capture before stays there
    const p = pending.get(el) ?? { id: captureId, frame: getFrame(), at: now(), timer: 0 }
    p.at = now()
    clearTimeout(p.timer)
    p.timer = setTimeout(() => sendField(el), FIELD_IDLE_MS)
    pending.set(el, p)
  }
  on(document, 'input', onField, true)
  on(document, 'change', onField, true)
  on(document, 'focusout', (e) => { if (e.target instanceof Element) sendField(e.target) }, true)

  // ---- clicks: passive - the click still happens; never while a pick mode is on -----------------
  let lastClickAt = 0
  on(window, 'click', (e) => {
    lastClickAt = Date.now()
    cancelHover()
    if (!captureId || window.__mvPick) return
    const el = e.target instanceof Element ? e.target : null
    if (!el) return
    record('click', { bundle: safeBundle(el, { x: e.clientX, y: e.clientY }), point: { x: e.clientX, y: e.clientY } })
  }, { capture: true, passive: true })

  // ---- hovers: held still 0.8 s without a click, at most one per 2 s ----------------------------
  let hoverTimer = 0
  let hoverFrom = null
  let lastHoverAt = 0
  const cancelHover = () => { clearTimeout(hoverTimer); hoverTimer = 0; hoverFrom = null }
  on(document, 'mousemove', (e) => {
    if (!captureId || window.__mvPick) { cancelHover(); return }
    if (hoverFrom && Math.hypot(e.clientX - hoverFrom.x, e.clientY - hoverFrom.y) <= HOVER_SLOP) return
    cancelHover()
    hoverFrom = { x: e.clientX, y: e.clientY }
    const frame = getFrame()
    hoverTimer = setTimeout(() => {
      const from = hoverFrom
      hoverTimer = 0
      if (!captureId || !from || Date.now() - lastHoverAt < HOVER_EVERY_MS || Date.now() - lastClickAt < HOVER_MS) return
      const el = document.elementFromPoint(from.x, from.y)
      if (!el || el === document.documentElement || el === document.body) return
      lastHoverAt = Date.now()
      record('hover', { bundle: safeBundle(el, from), point: from }, frame)
    }, HOVER_MS)
  }, true)
  on(document, 'mousedown', cancelHover, true)
  on(document, 'mouseleave', cancelHover)

  // ---- the final scroll ---------------------------------------------------------------------
  // the settle wait keeps the capture, frame, time and position it began with: `E` (or `S` -> `S`)
  // inside the wait sends it with the capture's flush, before `sh:capture-flushed` - never lost
  let scrollTimer = 0
  let pendingScroll = null
  const sendScroll = (id) => {
    if (!pendingScroll || (id && pendingScroll.id !== id)) return
    const p = pendingScroll
    pendingScroll = null
    clearTimeout(scrollTimer)
    send(p.id, 'scroll', { y: p.y }, p.frame, p.at)
  }
  on(window, 'scroll', () => {
    if (!captureId) return
    clearTimeout(scrollTimer)
    pendingScroll = { id: captureId, frame: getFrame(), at: performance.timeOrigin + performance.now(), y: Math.round(window.scrollY) }
    scrollTimer = setTimeout(() => sendScroll(), SCROLL_SETTLE_MS)
  }, { capture: true, passive: true })

  // ---- the shell ------------------------------------------------------------------------------
  on(window, 'message', (e) => {
    if (!trusted(e)) return
    const m = e.data
    if (!m || typeof m !== 'object') return
    if (m.type === 'sh:capture-hello' && typeof m.nonce === 'string') post({ type: 'sh:capture-hello', nonce: m.nonce, captureDoc })
    else if (m.type === 'sh:capture' && typeof m.id === 'string') {
      if (m.on) {
        if (captureId && captureId !== m.id) { flushFields(captureId); sendScroll(captureId) }   // `S` -> `S`: the first keeps its own
        captureId = m.id
      } else {
        // `E`: what this capture holds goes first, then the last seq - the shell seals after
        flushFields(m.id)
        sendScroll(m.id)
        if (captureId === m.id) { captureId = null; cancelHover() }
        post({ type: 'sh:capture-flushed', id: m.id, captureDoc, seq })
      }
    }
    else if (m.type === 'sh:probe' && typeof m.req !== 'undefined' && Number.isFinite(m.x) && Number.isFinite(m.y)) {
      // what is at this point, as a canvas-mode click would have hit it - nothing is clicked
      const el = document.elementFromPoint(m.x, m.y)
      const hit = el && el !== document.documentElement ? el : null
      post({ type: 'sh:probe', id: m.id, req: m.req, captureDoc, bundle: hit ? safeBundle(hit, { x: m.x, y: m.y }) : null })
    }
  })

  return {
    /** A laser click: inside a capture it is the capture's pick (true); outside, inspect copies the path. */
    pick(el, e) {
      if (!captureId) return false
      record('pick', { bundle: safeBundle(el, { x: e.clientX, y: e.clientY }), point: { x: e.clientX, y: e.clientY } })
      return true
    },
    /** The stage moved to another screen. */
    screen(to) { record('screen', { to }, to) },
    dispose() {
      removers.forEach((f) => f())
      for (const p of pending.values()) clearTimeout(p.timer)
      pending.clear(); cancelHover(); clearTimeout(scrollTimer)
    },
  }
}
