/**
 * Compositor diagnostic. Installed once at boot; every method is inert until called from the
 * console, so it adds no per-frame work.
 *
 * Observed in Chromium: a `backdrop-filter` element (all our glass chrome: pill, panel, menus,
 * node headers) flashes WHITE while the surface it samples is being re-rasterised. `.sh-content`
 * (the rzpp scale+translate surface) was NOT promoted to a compositing layer, so every zoom
 * re-rasterised it and the blurred chrome sampled an actively re-rasterising surface = white
 * flashes (worst case: a persistent white block over the top-right toolbar). The fix promotes
 * `.sh-content` permanently (Blink then scales a cached texture instead of re-rastering). This
 * module is how you SEE the gesture cadence and A/B the fix live.
 *
 * WHOLE-SCREEN flash: when the flash covers the ENTIRE viewport (canvas + frames + the fixed app
 * chrome), the cause is Chrome recomputing every backdrop-filter blur against the transforming
 * canvas each frame and blanking the whole frame. The default fix drops the blur only WHILE a
 * camera gesture is live (styles.css, keyed off #sh-world.sh-camera). Use the bisection toggles
 * below to confirm the lever on your GPU: flip ONE, zoom, see if the flash stops.
 *
 *   __mvDiag.watch()        start logging class churn on #sh-world (with cadence deltas)
 *   __mvDiag.unwatch()      stop
 *   __mvDiag.layers()       inventory: backdrop-filter chrome + iframe layer counts
 *   __mvDiag.noBlur(true)   ALL backdrop-filter off, always (is the blur the cause?)
 *   __mvDiag.solid(true)    the fix, but always on (opaque chrome, no blur)
 *   __mvDiag.leanOnly(true) hide the 15 live iframes ALWAYS (they are already auto-hidden during
 *                           a camera move; this forces it at rest too, to isolate GPU cost)
 *   __mvDiag.churn(true)    un-promote .sh-content (the pre-fix transformed-layer state)
 *   __mvDiag.disableFix(true) turn the camera flash-fix OFF - blur + live stay on during zoom,
 *                           so the ORIGINAL flash returns (the honest A/B for the fix itself)
 *   __mvDiag.reset()        clear every toggle
 *
 * LIVE DEBUG (Nic's ask - log everything while interacting; the flash is a compositor STALL):
 *   __mvDiag.debug()        on-screen HUD + rolling log (fps, scale, stalls, longtasks, heap, err)
 *   __mvDiag.mark('flash')  tag the instant you SEE a flash, to align the log to it
 *   __mvDiag.dump()         print the event log + a stalls-only view (the flashes, with scale)
 *   __mvDiag.debug(false)   stop
 */

let obs: MutationObserver | null = null
let lastClasses = ''
let lastAt = 0

const world = () => document.getElementById('sh-world')
const now = () => Math.round(performance.now())

const GLASS = '.sh-ctx, .sh-panel, .sh-fab, .sh-pill, .sh-pill-fab, .sh-menu, .sh-banner, .sh-toast, .sh-update, .sh-node-head, .cm-card, .cm-modal-wrap, .cm-modal'

/** Elements whose backdrop-filter samples the canvas - the surfaces that flash white.
 *  Truly-visible only: a collapsed panel keeps its box (offsetParent) but is opacity:0. */
function backdropEls(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(GLASS)].filter((el) => {
    const cs = getComputedStyle(el)
    const bf = cs.backdropFilter || (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter || 'none'
    return bf !== 'none' && el.offsetParent !== null && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.01
  })
}

// combined signal: #sh-world gesture classes + a `cam` marker for body.sh-cam (the class the
// flash fix actually keys off - set for EVERY camera path incl. programmatic setTransform).
function camState(): string {
  const wc = (world()?.className ?? '').split(/\s+/).filter((c) => c.startsWith('sh-'))
  if (document.body.classList.contains('sh-cam')) wc.push('cam')
  return wc.sort().join(' ')
}

function watch(): void {
  if (obs) return
  const w = world()
  if (!w) { console.warn('[mvDiag] #sh-world not mounted yet - retry after the board loads'); return }
  lastClasses = camState()
  lastAt = now()
  obs = new MutationObserver(() => {
    const cls = camState()
    if (cls === lastClasses) return
    const t = now()
    const before = new Set(lastClasses.split(/\s+/).filter(Boolean))
    const after = new Set(cls.split(/\s+/).filter(Boolean))
    const parts: string[] = []
    for (const c of [...after].filter((c) => !before.has(c))) parts.push(`+${c}`)
    for (const c of [...before].filter((c) => !after.has(c))) parts.push(`-${c}`)
    if (parts.length) {
      const content = document.querySelector('.sh-content') as HTMLElement | null
      const wc = content ? getComputedStyle(content).willChange : '?'
      console.log(`[mvDiag] ${String(t).padStart(7)}ms (+${t - lastAt}ms)  ${parts.join(' ')}   will-change(.sh-content)=${wc}`)
    }
    lastClasses = cls
    lastAt = t
  })
  obs.observe(w, { attributes: true, attributeFilter: ['class'] })
  obs.observe(document.body, { attributes: true, attributeFilter: ['class'] })
  console.log('[mvDiag] watching camera state. Zoom/pan now; each +cam/-cam brackets the window where the flash fix drops the blur (body.sh-cam). +sh-camera/-sh-camera = the wheel/rzpp gesture cadence.')
}

function unwatch(): void { obs?.disconnect(); obs = null; console.log('[mvDiag] stopped') }

function layers() {
  const bd = backdropEls()
  const live = document.querySelectorAll('iframe.sh-live').length
  const lean = document.querySelectorAll('iframe.sh-lean[data-ready]').length
  const content = document.querySelector('.sh-content') as HTMLElement | null
  const report = {
    backdropChrome: bd.length,
    backdropList: bd.map((el) => `${el.className.split(' ')[0]} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`),
    liveIframes: live,
    leanIframesReady: lean,
    contentWillChange: content ? getComputedStyle(content).willChange : '(no .sh-content)',
    churnForced: document.body.classList.contains('mv-churn'),
  }
  console.table(report.backdropList)
  return report
}

/** A/B: force-promote .sh-content (body.mv-churn -> will-change:transform). Reproduces the
 *  blank/white-frame-at-high-zoom regression; default (off) leaves it un-promoted. */
function churn(on: boolean): void {
  document.body.classList.toggle('mv-churn', on)
  console.log(`[mvDiag] promote .sh-content ${on ? 'ON (force will-change:transform - may blank frames at high zoom)' : 'OFF (default, un-promoted)'}`)
}

/** Bisection toggles - flip ONE, zoom, and see whether the whole-screen flash stops. */
function bisect(cls: string, label: string) {
  return (on: boolean): void => {
    document.body.classList.toggle(cls, on)
    console.log(`[mvDiag] ${label} ${on ? 'ON' : 'OFF'}`)
  }
}
const noBlur = bisect('mv-noblur', 'all backdrop-filter off (always)')
const solid = bisect('mv-solid', 'opaque chrome (always)')
const leanOnly = bisect('mv-leanonly', 'live iframes hidden (always)')
const disableFix = bisect('mv-nofix', 'camera flash-fix OFF (reproduce the flash)')

function reset(): void {
  document.body.classList.remove('mv-noblur', 'mv-solid', 'mv-leanonly', 'mv-churn', 'mv-nofix')
  console.log('[mvDiag] all toggles cleared')
}

// ------------------------------------------------------------------------------------------------
// LIVE DEBUG: an on-screen HUD + a rolling, timestamped event log. The white flash is a compositor
// STALL - the GPU misses one or more refreshes while it re-rasters/evicts tiles - so a large
// inter-frame gap (rAF delta) is our JS-visible proxy for it. We log every stall with the zoom
// scale + recent context, so `dump()` after interacting shows exactly WHAT (which scale, after
// which event) coincides with each flash. __mvDiag.debug() to start, .dump() to read, .mark() to
// tag the instant you SEE a flash.
// ------------------------------------------------------------------------------------------------
type Ev = { t: number; kind: string; info: string }
const evlog: Ev[] = []
const EVMAX = 400
let dbgOn = false
let dbgRaf = 0
let dbgLast = 0
let hud: HTMLDivElement | null = null
let dbgObs: PerformanceObserver | null = null
const win2s = { stalls: 0, maxMs: 0, longtasks: 0 }   // rolling 2s counters for the HUD
let errCount = 0
let lastErr = ''
const onErr = (e: ErrorEvent) => { errCount++; lastErr = String(e.message).slice(0, 80); logEv('error', lastErr) }
const onRej = (e: PromiseRejectionEvent) => { errCount++; lastErr = String(e.reason).slice(0, 80); logEv('reject', lastErr) }

function scaleNow(): number {
  const c = document.querySelector('.sh-content') as HTMLElement | null
  if (!c) return 0
  try { return new DOMMatrix(getComputedStyle(c).transform).a } catch { return 0 }
}
function frameUnderView(): string {
  // the largest on-screen frame + its rastered pixel size (w*scale) - the flash correlates with this
  const s = scaleNow()
  let best = 0, label = '-'
  for (const n of document.querySelectorAll<HTMLElement>('.sh-node')) {
    const r = n.getBoundingClientRect()
    const vis = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0))
    if (vis > best) { best = vis; label = `${n.querySelector('.id')?.textContent?.slice(0, 16) ?? '?'} ${Math.round(r.width)}px` }
  }
  return `${label} @${s.toFixed(2)}x`
}
function logEv(kind: string, info: string): void {
  evlog.push({ t: Math.round(performance.now()), kind, info })
  if (evlog.length > EVMAX) evlog.shift()
}

/** Public log hook for other shell modules (snapshots.ts logs capture/serialize cost here, so the
 *  rolling log shows a heavy serialize aligned to a stall). Always records; shows in dump(). */
export function diagLog(kind: string, info: string): void { logEv(kind, info) }
const heapMB = (): string => {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  return m ? `${Math.round(m.usedJSHeapSize / 1048576)}MB` : 'n/a'
}

function tickDbg(t: number): void {
  let dt = 0
  if (dbgLast) {
    dt = t - dbgLast
    if (dt > win2s.maxMs) win2s.maxMs = dt
    // STALL = a missed refresh streak. 45ms ~ >2 dropped frames at 60Hz; 90ms is a hard hitch (flash).
    if (dt > 45) { win2s.stalls++; logEv(dt > 90 ? 'STALL!!' : 'stall', `${Math.round(dt)}ms  ${frameUnderView()}`) }
  }
  dbgLast = t
  if (hud) {
    const fps = dt ? Math.round(1000 / dt) : 0
    hud.textContent =
      `scale ${scaleNow().toFixed(3)}   fps~${fps}\n` +
      `maxΔ(2s) ${Math.round(win2s.maxMs)}ms   stalls ${win2s.stalls}   longtasks ${win2s.longtasks}\n` +
      `live ${document.querySelectorAll('iframe.sh-live').length}  lean ${document.querySelectorAll('iframe.sh-lean[data-ready]').length}  heap ${heapMB()}  err ${errCount}\n` +
      `cam ${document.body.classList.contains('sh-cam') ? 'MOVING' : 'rest'}   ${frameUnderView()}`
  }
  dbgRaf = requestAnimationFrame(tickDbg)
}

let hudReset = 0
function debug(on = true): void {
  if (on === dbgOn) return
  dbgOn = on
  if (on) {
    hud = document.createElement('div')
    hud.id = 'mv-hud'
    hud.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;pointer-events:none;' +
      'font:11px/1.5 ui-monospace,Menlo,monospace;white-space:pre;color:#0f0;background:rgba(0,0,0,.82);' +
      'padding:8px 10px;border-radius:8px;max-width:60vw'
    document.body.appendChild(hud)
    dbgLast = 0
    win2s.stalls = 0; win2s.maxMs = 0; win2s.longtasks = 0
    hudReset = window.setInterval(() => { win2s.stalls = 0; win2s.maxMs = 0; win2s.longtasks = 0 }, 2000)
    dbgRaf = requestAnimationFrame(tickDbg)
    try {
      dbgObs = new PerformanceObserver((l) => { for (const e of l.getEntries()) { win2s.longtasks++; logEv('longtask', `${Math.round(e.duration)}ms`) } })
      dbgObs.observe({ type: 'longtask', buffered: false })
    } catch { /* Safari */ }
    // log camera + wheel + gesture so stalls align to what triggered them
    const app = document.querySelector('.sh-app')
    app?.addEventListener('wheel', ((e: WheelEvent) => logEv('wheel', `${e.ctrlKey || e.metaKey ? 'ZOOM' : 'pan'} dy${Math.round(e.deltaY)} @${scaleNow().toFixed(2)}x`)) as EventListener, { capture: true, passive: true })
    window.addEventListener('error', onErr)
    window.addEventListener('unhandledrejection', onRej)
    if (!obs) watch()
    console.log('%c[mvDiag] LIVE DEBUG ON', 'color:#0f0;font-weight:bold', '- HUD bottom-left. Interact/zoom, then run __mvDiag.dump(). Call __mvDiag.mark("flash") the instant you SEE a flash.')
  } else {
    cancelAnimationFrame(dbgRaf); clearInterval(hudReset); dbgObs?.disconnect(); dbgObs = null
    window.removeEventListener('error', onErr); window.removeEventListener('unhandledrejection', onRej)
    hud?.remove(); hud = null
    console.log('[mvDiag] live debug off')
  }
}

/** Tag the instant you SEE a flash, so the log around this timestamp shows what caused it. */
function mark(label = 'MARK'): void { logEv('👁 MARK', label); console.log(`[mvDiag] marked "${label}" @${Math.round(performance.now())}ms`) }

/** Print the rolling event log (default last 60) + a summary. Stalls are the flash proxy. */
function dump(n = 60): void {
  const rows = evlog.slice(-n)
  const stalls = evlog.filter((e) => e.kind.startsWith('stall') || e.kind === 'STALL!!')
  const worst = stalls.reduce((m, e) => Math.max(m, parseInt(e.info) || 0), 0)
  console.log(`%c[mvDiag] ${evlog.length} events · ${stalls.length} stalls · worst ${worst}ms · ${errCount} errors`, 'color:#0f0;font-weight:bold')
  console.table(rows.map((e) => ({ t_ms: e.t, kind: e.kind, info: e.info })))
  // stalls-only view = the flashes, with the scale/frame each happened at
  if (stalls.length) { console.log('%c— stalls (the flashes) —', 'color:#f80'); console.table(stalls.slice(-30).map((e) => ({ t_ms: e.t, ms: e.info }))) }
}

export function startDiag(): void {
  const g = window as unknown as { __mvDiag?: unknown }
  if (g.__mvDiag) return
  g.__mvDiag = { watch, unwatch, layers, churn, noBlur, solid, leanOnly, disableFix, reset, debug, dump, mark }
}
