/**
 * SPEC-M5 slice 1: the lean-frame facade coordinator. Imperative on purpose - the facade is a
 * `<iframe class="sh-lean" sandbox="allow-same-origin">` driven by setting .srcdoc directly, so no
 * FrameNode subscribes to snapshot state and a pan/zoom tick triggers zero React renders.
 *
 * The lean tier is a DOM SNAPSHOT, not a bitmap: the shell serialises the live frame's document
 * (same origin) into self-contained static html (post-render DOM + full inlined CSS, JS stripped).
 * LEAN-PRIMARY: this snapshot is what you SEE for a passive frame - at rest AND during pan/zoom - so
 * there is NO per-gesture swap between the lean and the live iframe (two documents never render
 * pixel-identically; the swap shifted text ~1-2px = jiggle, and flashed mermaid/theme). The live app
 * shows underneath only when the frame is interacted, in laser/comment mode, or while the lean is
 * being (re)built. Real DOM + real CSS: exact color, native reflow on resize. Theme change / focus
 * INVALIDATE the lean (never mutate a displayed one - baked mermaid can't re-theme in place) and a
 * fresh capture is admitted before it is shown again. Captures run bounded-parallel, viewport-first, at idle, never while busy.
 *
 * Correctness beats the flash-guard (codex): a frame the serialiser cannot render faithfully
 * (canvas/video/shadow-dom/cross-origin-css, or an unrestorable scroller) is left DEGRADED - no
 * `data-ready`, no cover, live pixels stay. Every install is guarded by a per-node GENERATION token
 * so an in-flight capture can never paint a stale/wrong-node cover after a reload or unmount.
 */
import { serializeDoc, type SerializeResult } from '../../frame-host/serialize.ts'
import { diagLog } from '../diag.ts'

export interface SnapMeta { sourceRevision: string; theme: string }

interface Entry { key: string; html: string; scrollMap: SerializeResult['scrollMap']; degraded: string[]; theme: string; gen: number; live: HTMLIFrameElement; meta: SnapMeta }
const byNode = new Map<string, Entry>()                    // nodeKey -> current lean snapshot
const frames = new Map<string, HTMLIFrameElement>()        // nodeKey -> the facade <iframe> element
const gen = new Map<string, number>()                      // nodeKey -> generation (bumped on drop/reload)
const recheck = new Map<string, number>()                  // nodeKey -> a one-shot re-capture timer (slow async)
const rechecked = new Set<string>()                        // nodes whose one-shot recheck already fired (no re-arm loop)
const MAX_LEAN_BYTES = 4 * 1024 * 1024                     // over this a frame is too heavy to inline - stay live
// serializeDoc is a SYNCHRONOUS main-thread DOM-clone + full-CSS-inline. On a heavy frame (big DOM +
// Tailwind-sized CSS) it - and the lean's subsequent style recalc - can block for SECONDS, freezing
// the whole app (measured 3-7s stalls = the "white flash"). Two guards keep it off the main thread's
// back: a cheap node-count PRE-check skips obviously-heavy frames before serialising at all, and any
// frame whose serialize actually exceeds the time budget is marked `tooHeavy` and never re-serialised
// (kills the recurring freezes from recheck/blur re-captures). A tooHeavy frame simply stays LIVE.
const NODE_BUDGET = 6000        // >this many elements -> skip serialise (stay live). Tune from diag data.
const SERIALIZE_BUDGET_MS = 200 // a serialise slower than this marks the frame no-lean (never retry)
const tooHeavy = new Set<string>()   // nodeKeys that froze the serialiser once - never serialise again

// content identity INCLUDES theme: content whose colors are baked into the DOM at render time
// (mermaid SVG) cannot be re-themed by the cover's attribute mutation, so a theme change must
// re-capture after the live frame re-renders. Size still needs no re-capture (the lean doc reflows).
const keyOf = (m: SnapMeta) => `${m.sourceRevision}|${m.theme}`
const genOf = (k: string) => gen.get(k) ?? 0
const bumpGen = (k: string) => gen.set(k, genOf(k) + 1)    // invalidate any in-flight capture/onload for k

const inMotion = (): boolean => {
  const w = document.getElementById('sh-world')
  // sh-gesturing = pointer gesture; sh-preset = device/tidy animation; body.sh-cam = ANY camera move
  // incl. programmatic zoom/fit (set from onTransformed, cleared 180ms after the last transform). All
  // three are windows where a synchronous serialise would jank - defer capture past them.
  return (!!w && (w.classList.contains('sh-gesturing') || w.classList.contains('sh-preset'))) || document.body.classList.contains('sh-cam')
}
// never serialise while laser/comment mode is on: those inject outline styles + hover chrome into the
// live doc, which the shell-side clone would bake into the lean (visible after the mode ends).
const modeActive = (): boolean => document.body.classList.contains('sh-laser') || document.body.classList.contains('sh-commenting')
const busy = (): boolean => inMotion() || modeActive()

/** Apply a node's current theme to its lean doc via attribute mutation (allow-same-origin lets the
 *  shell touch the doc; the full CSS is inlined so only which rules match changes - no re-capture). */
function applyTheme(doc: Document, theme: string): void {
  doc.documentElement.dataset.theme = theme
  doc.documentElement.classList.toggle('dark', theme === 'dark')
  // pin the cover's color-scheme to the FRAME theme, not the viewer's OS. A srcdoc doc otherwise
  // follows the OS: on a dark-mode Mac the UA canvas + any prefers-color-scheme rules go dark and
  // bleed into the cover (dark mermaid boxes) while data-theme says light. This holds it to light.
  doc.documentElement.style.colorScheme = theme
}

/** Restore captured scroll offsets shell-side (the lean doc runs no JS). Returns false if any mapped
 *  scroller cannot be resolved OR the offset did not stick (clamped by a differently-reflowed lean
 *  doc) - the frame then degrades to live rather than showing a mis-scrolled cover. */
function restoreScroll(doc: Document, scrollMap: Entry['scrollMap']): boolean {
  for (const s of scrollMap) {
    const el = s.sel === ':root' ? doc.documentElement : doc.querySelector<HTMLElement>(s.sel)
    if (!el) return false
    el.scrollTop = s.top; el.scrollLeft = s.left
    if (Math.abs(el.scrollTop - s.top) > 2 || Math.abs(el.scrollLeft - s.left) > 2) return false
  }
  return true
}

/** Install the stored snapshot into a node's lean iframe: parse srcdoc, then on load restore scroll,
 *  apply theme, and (only if nothing degraded AND fonts+paint have settled) mark ready. Every step is
 *  generation-guarded so a superseded capture or an about:blank reset never re-admits a cover. */
function install(nodeKey: string): void {
  const iframe = frames.get(nodeKey)
  if (!iframe) return
  iframe.onload = null                                     // detach any prior handler (about:blank reset can't re-admit)
  delete iframe.dataset.ready
  const e = byNode.get(nodeKey)
  if (!e || e.degraded.length) { iframe.removeAttribute('srcdoc'); return }   // degraded = no cover, keep live
  const myGen = e.gen
  iframe.onload = () => {
    if (genOf(nodeKey) !== myGen || frames.get(nodeKey) !== iframe) return    // superseded / remounted
    const cur = byNode.get(nodeKey)
    const doc = iframe.contentDocument
    if (!cur || !doc) return
    if (!restoreScroll(doc, cur.scrollMap)) { cur.degraded = [...cur.degraded, 'scroll']; iframe.removeAttribute('srcdoc'); return }
    // CSP guard (codex): if a hardened host blocked the inline <style> (style-src 'self'), the lean is
    // unstyled - the sentinel custom prop won't resolve. Stay live rather than show an unstyled cover.
    if (getComputedStyle(doc.documentElement).getPropertyValue('--mv-lean-ok').trim() !== '1') { iframe.removeAttribute('srcdoc'); return }
    applyTheme(doc, cur.theme)
    // font+paint readiness gate (F3): the srcdoc doc reloads fonts independently, so mark ready only
    // after its fonts settle + two paints, else a fallback-font seam shows on the swap.
    const markReady = () => {
      if (genOf(nodeKey) !== myGen || frames.get(nodeKey) !== iframe) return
      iframe.dataset.ready = '1'
      // slow-async guard: a data fetch / route change that lands AFTER the capture window would leave
      // the lean frozen on a loading state. ONE bounded re-capture ~3s after admit catches it; later
      // changes self-heal on focus. `rechecked` makes it truly one-shot - the recheck's own recapture
      // must not re-arm the timer (that was an endless ~3s loop), so a long-poll can't thrash.
      clearTimeout(recheck.get(nodeKey))
      if (cur.live && !rechecked.has(nodeKey)) recheck.set(nodeKey, window.setTimeout(() => {
        recheck.delete(nodeKey); rechecked.add(nodeKey)
        if (genOf(nodeKey) === myGen) scheduleCapture(nodeKey, cur.live, cur.meta, true)
      }, 3000))
    }
    void (doc.fonts?.ready ?? Promise.resolve()).then(() => requestAnimationFrame(() => requestAnimationFrame(markReady)))
  }
  iframe.srcdoc = e.html
}

/** FrameNode registers its facade <iframe> on mount so the coordinator can drive it imperatively. */
export function registerLeanFrame(nodeKey: string, iframe: HTMLIFrameElement | null): void {
  if (!iframe) { frames.delete(nodeKey); return }
  frames.set(nodeKey, iframe)
  if (byNode.has(nodeKey)) install(nodeKey)
}

/** Hide the lean at once (show the live app underneath) and cancel in-flight work. Used when a frame
 *  is focused/interacted, or its theme changes: a baked mermaid SVG cannot be re-themed in place, so
 *  we never mutate a DISPLAYED snapshot across themes - we drop it and rebuild a fresh one, which is
 *  only shown once it passes admission. Live stays visible in the meantime (live-fallback). */
export function invalidateLean(nodeKey: string): void {
  bumpGen(nodeKey)
  pending.delete(nodeKey)
  clearTimeout(recheck.get(nodeKey)); recheck.delete(nodeKey); rechecked.delete(nodeKey)
  const iframe = frames.get(nodeKey)
  if (iframe) delete iframe.dataset.ready
}

/** Drop a node's snapshot (unmount, or content changed / frame reloaded). Cancels queued + in-flight
 *  work via the generation bump and clears the cover. */
export function dropSnapshot(nodeKey: string): void {
  bumpGen(nodeKey)
  byNode.delete(nodeKey)
  pending.delete(nodeKey)
  clearTimeout(recheck.get(nodeKey)); recheck.delete(nodeKey); rechecked.delete(nodeKey)
  const iframe = frames.get(nodeKey)
  if (iframe) { iframe.onload = null; delete iframe.dataset.ready; iframe.removeAttribute('srcdoc') }
}

// ---- capture coordinator: bounded-parallel, viewport-first, idle-scheduled, never while busy --------
const pending = new Map<string, { live: HTMLIFrameElement; meta: SnapMeta }>()   // nodeKey -> latest request
const inflightNodes = new Set<string>()   // nodes currently being captured - never capture one twice at once
const MAX_CONCURRENT = 3   // overlap the per-frame settle waits (mostly timers) so a big board's leans
let inflight = 0           // land in ~1/3 the wall-clock of strictly-serial, without janking the loop
const idle = (fn: () => void) =>
  (window as unknown as { requestIdleCallback?: (f: () => void, o?: object) => void }).requestIdleCallback?.(fn, { timeout: 600 }) ?? setTimeout(fn, 80)
const rafSettle = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
const withDeadline = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))])

/** Wait until the frame's DOM stops mutating for `quietMs` (bounded by `maxMs`). Async content -
 *  lazily-imported mermaid renders its SVG well after the frame reports 'ready', late images/webfont
 *  swaps, entrance animations - all land here. Capturing before this quiet window yields a cover
 *  missing the diagram (the mermaid pop-in/out bug). Same-origin, so the shell can observe the doc. */
function domQuiet(doc: Document, quietMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let timer = 0, done = false
    const finish = () => { if (done) return; done = true; clearTimeout(timer); clearTimeout(hard); mo.disconnect(); resolve() }
    const mo = new MutationObserver(() => { clearTimeout(timer); timer = window.setTimeout(finish, quietMs) })
    try { mo.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }) }
    catch { return resolve() }
    timer = window.setTimeout(finish, quietMs)
    const hard = window.setTimeout(finish, maxMs)
  })
}

/** Request a fresh lean snapshot for a ready/quiet frame. Coalesces to the latest per node. `force`
 *  recaptures even when the key is unchanged - used on blur, where the live state changed under the
 *  same revision/theme (typed input, toggled UI) and the old lean is now wrong. */
export function scheduleCapture(nodeKey: string, live: HTMLIFrameElement, meta: SnapMeta, force = false): void {
  if (tooHeavy.has(nodeKey)) return                               // known to freeze the serialiser - stay live
  if (!force && byNode.get(nodeKey)?.key === keyOf(meta)) return   // already have this content revision
  pending.set(nodeKey, { live, meta })
  pump()
}

/** The next node to capture: the pending frame nearest the viewport centre, on-screen before off. So
 *  the frames the user is actually looking at get their lean first (perceived-instant), and the rest
 *  fill in behind - instead of registration order, which pops in arbitrary corners of a big board. */
function pickNext(): string | null {
  let best: string | null = null, bestScore = Infinity
  const vw = window.innerWidth, vh = window.innerHeight
  for (const [k, req] of pending) {
    if (inflightNodes.has(k)) continue                   // that node is mid-capture; its re-request waits
    const r = req.live.getBoundingClientRect()
    const off = r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw
    const dx = r.left + r.width / 2 - vw / 2, dy = r.top + r.height / 2 - vh / 2
    const score = (off ? 1e7 : 0) + Math.hypot(dx, dy)   // on-screen first, then by distance to centre
    if (score < bestScore) { bestScore = score; best = k }
  }
  return best
}

function pump(): void {
  if (busy()) { if (pending.size) idle(pump); return }   // never serialise mid-gesture or during laser/comment
  while (inflight < MAX_CONCURRENT) {
    const nodeKey = pickNext()
    if (!nodeKey) break
    const req = pending.get(nodeKey)!
    pending.delete(nodeKey)
    inflightNodes.add(nodeKey); inflight++
    const done = () => { inflightNodes.delete(nodeKey); inflight--; idle(pump) }
    void capture(nodeKey, req.live, req.meta).then(done, done)
  }
}

async function capture(nodeKey: string, live: HTMLIFrameElement, meta: SnapMeta): Promise<void> {
  const myGen = genOf(nodeKey)
  const doc = live.contentDocument
  if (!doc) return
  // settle: fonts, two stable paints, THEN a DOM-quiet window so async content (mermaid renders its
  // SVG after 'ready', late images) is captured - not a diagram-less frame. All bounded.
  await withDeadline(doc.fonts?.ready ?? Promise.resolve(), 400).catch(() => {})
  await rafSettle()
  await domQuiet(doc, 180, 2500)   // still-loading frames wait longer so async data lands in-capture
  // bail if the world changed under us during settle: superseded (drop/reload), a newer request
  // landed, the frame renavigated, or a gesture/preset started (serialising+parsing now would jank).
  if (genOf(nodeKey) !== myGen || pending.has(nodeKey) || live.contentDocument !== doc) return
  if (busy()) { pending.set(nodeKey, { live, meta }); return }       // requeue for the next idle tick
  // cheap PRE-check: an oversized DOM would make the synchronous serialise (and the lean's style
  // recalc) freeze the main thread for seconds. Skip it - the frame stays live. getElementsByTagName
  // is O(n) but ~free vs. cloneNode+outerHTML+CSS-regex on the same tree.
  const nodeCount = doc.getElementsByTagName('*').length
  if (nodeCount > NODE_BUDGET) {
    tooHeavy.add(nodeKey); diagLog('lean-skip', `${nodeCount}nodes > budget - stay live · ${nodeKey}`)
    return
  }
  let result: SerializeResult
  const t0 = performance.now()
  try { result = serializeDoc(doc, doc.URL) }   // <base> = the frame's own URL, so relative url()/img/font resolve
  catch { return }                              // fail soft: keep live pixels
  const serMs = Math.round(performance.now() - t0)
  diagLog('serialize', `${serMs}ms ${nodeCount}nodes ${Math.round(result.cssBytes / 1024)}KB · ${nodeKey}`)
  // a serialise that blew the budget froze the app once; never serialise this frame again (recheck +
  // blur re-captures would repeat the freeze). It keeps the lean it just built; it just won't rebuild.
  if (serMs > SERIALIZE_BUDGET_MS) { tooHeavy.add(nodeKey); diagLog('lean-heavy', `${serMs}ms - no more re-captures · ${nodeKey}`) }
  // budget: a pathologically heavy frame (huge inlined CSS/DOM) would multiply memory across the board
  // and jank the main thread parsing it - over the cap, degrade (stay live) AND drop the html so the
  // giant string is not retained in byNode (keeping it would defeat the memory bound).
  const oversized = result.html.length > MAX_LEAN_BYTES
  const degraded = oversized ? [...result.degraded, 'oversized'] : result.degraded
  const theme = doc.documentElement.dataset.theme || meta.theme   // theme AT capture, not a stale closure
  byNode.set(nodeKey, { key: keyOf(meta), html: oversized ? '' : result.html, scrollMap: oversized ? [] : result.scrollMap, degraded, theme, gen: myGen, live, meta })
  install(nodeKey)
}
