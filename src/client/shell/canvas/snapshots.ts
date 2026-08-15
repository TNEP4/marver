/**
 * SPEC-M5 slice 1: the lean-frame facade coordinator. Imperative on purpose - the facade is a
 * `<iframe class="sh-lean" sandbox="allow-same-origin">` driven by setting .srcdoc directly, so no
 * FrameNode subscribes to snapshot state and a pan/zoom tick triggers zero React renders.
 *
 * The lean tier is a DOM SNAPSHOT, not a bitmap: the shell serialises the live frame's document
 * (same origin) into self-contained static html (post-render DOM + full inlined CSS, JS stripped) and
 * shows it over the live iframe while #sh-world is in motion. Real DOM + real CSS: exact color,
 * native reflow on resize, theme-flip by attribute mutation (no re-capture). Captures run
 * one-at-a-time at idle, NEVER during motion.
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

const keyOf = (m: SnapMeta) => m.sourceRevision            // content identity; theme/size need no re-capture
const genOf = (k: string) => gen.get(k) ?? 0
const bumpGen = (k: string) => gen.set(k, genOf(k) + 1)    // invalidate any in-flight capture/onload for k

const inMotion = (): boolean => {
  const w = document.getElementById('sh-world')
  return !!w && (w.classList.contains('sh-gesturing') || w.classList.contains('sh-preset'))
}

/** Apply a node's current theme to its lean doc via attribute mutation (allow-same-origin lets the
 *  shell touch the doc; the full CSS is inlined so only which rules match changes - no re-capture). */
function applyTheme(doc: Document, theme: string): void {
  doc.documentElement.dataset.theme = theme
  doc.documentElement.classList.toggle('dark', theme === 'dark')
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

/** Live theme flip: update stored theme + mutate the mounted lean doc (no re-capture). */
export function setLeanTheme(nodeKey: string, theme: string): void {
  const e = byNode.get(nodeKey)
  if (e) e.theme = theme
  const doc = frames.get(nodeKey)?.contentDocument
  if (doc) applyTheme(doc, theme)
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

/** Request a fresh lean snapshot for a ready/quiet frame. Coalesces to the latest per node. */
export function scheduleCapture(nodeKey: string, live: HTMLIFrameElement, meta: SnapMeta): void {
  if (byNode.get(nodeKey)?.key === keyOf(meta)) return   // already have this content revision
  pending.set(nodeKey, { live, meta })
  pump()
}

function pump(): void {
  if (capturing || !pending.size) return
  if (inMotion()) { idle(pump); return }                 // never serialise/parse mid-gesture
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
  // settle: fonts + two stable paints, each bounded so a slow frame can't hang the coordinator
  await withDeadline(doc.fonts?.ready ?? Promise.resolve(), 400).catch(() => {})
  await rafSettle()
  // bail if the world changed under us during settle: superseded (drop/reload), a newer request
  // landed, the frame renavigated, or a gesture/preset started (serialising+parsing now would jank).
  if (genOf(nodeKey) !== myGen || pending.has(nodeKey) || live.contentDocument !== doc) return
  if (inMotion()) { pending.set(nodeKey, { live, meta }); return }   // requeue for the next idle tick
  let result: SerializeResult
  try { result = serializeDoc(doc, doc.URL) }   // <base> = the frame's own URL, so relative url()/img/font resolve
  catch { return }                              // fail soft: keep live pixels
  const theme = doc.documentElement.dataset.theme || meta.theme   // theme AT capture, not a stale closure
  byNode.set(nodeKey, { key: keyOf(meta), html: result.html, scrollMap: result.scrollMap, degraded: result.degraded, theme, gen: myGen })
  install(nodeKey)
}
