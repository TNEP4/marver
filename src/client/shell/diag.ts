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
 *   __mvDiag.leanOnly(true) hide the 15 live iframes (is it live-frame GPU cost?)
 *   __mvDiag.churn(true)    un-promote .sh-content (the pre-fix transformed-layer state)
 *   __mvDiag.reset()        clear every toggle
 */

let obs: MutationObserver | null = null
let lastClasses = ''
let lastAt = 0

const world = () => document.getElementById('sh-world')
const now = () => Math.round(performance.now())

const GLASS = '.sh-ctx, .sh-panel, .sh-fab, .sh-pill, .sh-pill-fab, .sh-menu, .sh-banner, .sh-toast, .sh-update, .sh-node-head'

/** Elements whose backdrop-filter samples the canvas - the surfaces that flash white.
 *  Truly-visible only: a collapsed panel keeps its box (offsetParent) but is opacity:0. */
function backdropEls(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(GLASS)].filter((el) => {
    const cs = getComputedStyle(el)
    const bf = cs.backdropFilter || (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter || 'none'
    return bf !== 'none' && el.offsetParent !== null && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.01
  })
}

function watch(): void {
  if (obs) return
  const w = world()
  if (!w) { console.warn('[mvDiag] #sh-world not mounted yet - retry after the board loads'); return }
  lastClasses = w.className
  lastAt = now()
  obs = new MutationObserver(() => {
    const cls = (world()?.className ?? '')
    if (cls === lastClasses) return
    const t = now()
    const before = new Set(lastClasses.split(/\s+/).filter(Boolean))
    const after = new Set(cls.split(/\s+/).filter(Boolean))
    const added = [...after].filter((c) => !before.has(c) && c.startsWith('sh-'))
    const removed = [...before].filter((c) => !after.has(c) && c.startsWith('sh-'))
    const parts: string[] = []
    for (const c of added) parts.push(`+${c}`)
    for (const c of removed) parts.push(`-${c}`)
    if (parts.length) {
      const content = document.querySelector('.sh-content') as HTMLElement | null
      const wc = content ? getComputedStyle(content).willChange : '?'
      console.log(`[mvDiag] ${String(t).padStart(7)}ms (+${t - lastAt}ms)  ${parts.join(' ')}   will-change(.sh-content)=${wc}`)
    }
    lastClasses = cls
    lastAt = t
  })
  obs.observe(w, { attributes: true, attributeFilter: ['class'] })
  console.log('[mvDiag] watching #sh-world class churn. Zoom now; each +sh-camera/-sh-camera brackets one canvas gesture (the window where the glass re-samples the surface below it).')
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

/** A/B: restore the un-promoted pre-fix surface (body.mv-churn forces will-change:auto in CSS). */
function churn(on: boolean): void {
  document.body.classList.toggle('mv-churn', on)
  console.log(`[mvDiag] churn ${on ? 'ON (pre-fix: .sh-content un-promoted)' : 'OFF (fix: stable promoted layer)'}`)
}

/** Bisection toggles - flip ONE, zoom, and see whether the whole-screen flash stops. */
function bisect(cls: string, label: string) {
  return (on: boolean): void => {
    document.body.classList.toggle(cls, on)
    console.log(`[mvDiag] ${label} ${on ? 'ON' : 'OFF'}`)
  }
}
const noBlur = bisect('mv-noblur', 'all backdrop-filter off')
const solid = bisect('mv-solid', 'opaque chrome (the fix, always on)')
const leanOnly = bisect('mv-leanonly', 'live iframes hidden')

function reset(): void {
  document.body.classList.remove('mv-noblur', 'mv-solid', 'mv-leanonly', 'mv-churn')
  console.log('[mvDiag] all toggles cleared')
}

export function startDiag(): void {
  const g = window as unknown as { __mvDiag?: unknown }
  if (g.__mvDiag) return
  g.__mvDiag = { watch, unwatch, layers, churn, noBlur, solid, leanOnly, reset }
}
