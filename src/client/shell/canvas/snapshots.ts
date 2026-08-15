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
 * fresh capture is admitted before it is shown again. Captures run one-at-a-time at idle, never busy.
 *
 * Correctness beats the flash-guard (codex): a frame the serialiser cannot render faithfully
 * (canvas/video/shadow-dom/cross-origin-css, or an unrestorable scroller) is left DEGRADED - no
 * `data-ready`, no cover, live pixels stay. Every install is guarded by a per-node GENERATION token
 * so an in-flight capture can never paint a stale/wrong-node cover after a reload or unmount.
 */
import { serializeDoc, type SerializeResult } from '../../frame-host/serialize.ts'

export interface SnapMeta { sourceRevision: string; theme: string }

interface Entry { key: string; html: string; scrollMap: SerializeResult['scrollMap']; degraded: string[]; theme: string; gen: number }
const byNode = new Map<string, Entry>()                    // nodeKey -> current lean snapshot
const frames = new Map<string, HTMLIFrameElement>()        // nodeKey -> the facade <iframe> element
const gen = new Map<string, number>()                      // nodeKey -> generation (bumped on drop/reload)

// content identity INCLUDES theme: content whose colors are baked into the DOM at render time
// (mermaid SVG) cannot be re-themed by the cover's attribute mutation, so a theme change must
// re-capture after the live frame re-renders. Size still needs no re-capture (the lean doc reflows).
const keyOf = (m: SnapMeta) => `${m.sourceRevision}|${m.theme}`
const genOf = (k: string) => gen.get(k) ?? 0
const bumpGen = (k: string) => gen.set(k, genOf(k) + 1)    // invalidate any in-flight capture/onload for k

const inMotion = (): boolean => {
  const w = document.getElementById('sh-world')
  return !!w && (w.classList.contains('sh-gesturing') || w.classList.contains('sh-preset'))
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
    applyTheme(doc, cur.theme)
    // font+paint readiness gate (F3): the srcdoc doc reloads fonts independently, so mark ready only
    // after its fonts settle + two paints, else a fallback-font seam shows on the swap.
    const markReady = () => { if (genOf(nodeKey) === myGen && frames.get(nodeKey) === iframe) iframe.dataset.ready = '1' }
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
  const iframe = frames.get(nodeKey)
  if (iframe) delete iframe.dataset.ready
}

/** Drop a node's snapshot (unmount, or content changed / frame reloaded). Cancels queued + in-flight
 *  work via the generation bump and clears the cover. */
export function dropSnapshot(nodeKey: string): void {
  bumpGen(nodeKey)
  byNode.delete(nodeKey)
  pending.delete(nodeKey)
  const iframe = frames.get(nodeKey)
  if (iframe) { iframe.onload = null; delete iframe.dataset.ready; iframe.removeAttribute('srcdoc') }
}

// ---- capture coordinator: single-in-flight, idle-scheduled, never during motion --------------------
const pending = new Map<string, { live: HTMLIFrameElement; meta: SnapMeta }>()   // nodeKey -> latest request
let capturing = false
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
  if (!force && byNode.get(nodeKey)?.key === keyOf(meta)) return   // already have this content revision
  pending.set(nodeKey, { live, meta })
  pump()
}

function pump(): void {
  if (capturing || !pending.size) return
  if (busy()) { idle(pump); return }                     // never serialise mid-gesture or during laser/comment
  capturing = true
  const [nodeKey, req] = pending.entries().next().value as [string, { live: HTMLIFrameElement; meta: SnapMeta }]
  pending.delete(nodeKey)
  const done = () => { capturing = false; idle(pump) }
  void capture(nodeKey, req.live, req.meta).then(done, done)
}

async function capture(nodeKey: string, live: HTMLIFrameElement, meta: SnapMeta): Promise<void> {
  const myGen = genOf(nodeKey)
  const doc = live.contentDocument
  if (!doc) return
  // settle: fonts, two stable paints, THEN a DOM-quiet window so async content (mermaid renders its
  // SVG after 'ready', late images) is captured - not a diagram-less frame. All bounded.
  await withDeadline(doc.fonts?.ready ?? Promise.resolve(), 400).catch(() => {})
  await rafSettle()
  await domQuiet(doc, 180, 1500)
  // bail if the world changed under us during settle: superseded (drop/reload), a newer request
  // landed, the frame renavigated, or a gesture/preset started (serialising+parsing now would jank).
  if (genOf(nodeKey) !== myGen || pending.has(nodeKey) || live.contentDocument !== doc) return
  if (busy()) { pending.set(nodeKey, { live, meta }); return }       // requeue for the next idle tick
  let result: SerializeResult
  try { result = serializeDoc(doc, doc.URL) }   // <base> = the frame's own URL, so relative url()/img/font resolve
  catch { return }                              // fail soft: keep live pixels
  const theme = doc.documentElement.dataset.theme || meta.theme   // theme AT capture, not a stale closure
  byNode.set(nodeKey, { key: keyOf(meta), html: result.html, scrollMap: result.scrollMap, degraded: result.degraded, theme, gen: myGen })
  install(nodeKey)
}
