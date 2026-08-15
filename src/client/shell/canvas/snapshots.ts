/**
 * SPEC-M5 slice 1: the lean-frame facade coordinator. Imperative on purpose - the facade is a
 * `<iframe class="sh-lean" sandbox="allow-same-origin">` driven by setting .srcdoc directly, so no
 * FrameNode subscribes to snapshot state and a pan/zoom tick triggers zero React renders.
 *
 * The lean tier is a DOM SNAPSHOT, not a bitmap: the shell serialises the live frame's document
 * (same origin) into self-contained static html (post-render DOM + full inlined CSS, JS stripped) and
 * shows it over the live iframe while #sh-world is in motion. Because it is real DOM + real CSS it
 * reflows on resize, theme-flips by an attribute mutation (no re-capture), and matches the live app's
 * color exactly. Captures run one-at-a-time at idle, NEVER during motion.
 *
 * Correctness beats the flash-guard (codex): a frame the serialiser cannot render faithfully
 * (canvas/video/shadow-dom/cross-origin-css, or an unrestorable scroller) is left DEGRADED - no
 * `data-ready`, no cover, live pixels stay.
 */
import { serializeDoc, type SerializeResult } from '../../frame-host/serialize.ts'

export interface SnapMeta { sourceRevision: string; theme: string }

interface Entry { key: string; html: string; scrollMap: SerializeResult['scrollMap']; degraded: string[]; theme: string }
const byNode = new Map<string, Entry>()                    // nodeKey -> current lean snapshot
const frames = new Map<string, HTMLIFrameElement>()        // nodeKey -> the facade <iframe> element

const keyOf = (m: SnapMeta) => m.sourceRevision            // content identity; theme/size need no re-capture

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
 *  scroller could not be resolved (virtualised / missing) - the frame then degrades to live. */
function restoreScroll(doc: Document, scrollMap: Entry['scrollMap']): boolean {
  let ok = true
  for (const s of scrollMap) {
    const el = s.sel === ':root' ? doc.documentElement : doc.querySelector<HTMLElement>(s.sel)
    if (!el) { ok = false; continue }
    el.scrollTop = s.top; el.scrollLeft = s.left
  }
  return ok
}

/** Install the stored snapshot into a node's lean iframe: parse srcdoc, then on load restore
 *  scroll + theme and mark ready ONLY if nothing degraded. */
function install(nodeKey: string): void {
  const iframe = frames.get(nodeKey)
  const e = byNode.get(nodeKey)
  if (!iframe) return
  delete iframe.dataset.ready
  if (!e) { iframe.removeAttribute('srcdoc'); return }
  if (e.degraded.length) { iframe.removeAttribute('srcdoc'); return }   // degraded = no cover, keep live
  iframe.onload = () => {
    const doc = iframe.contentDocument
    if (!doc) return
    const scrollOk = restoreScroll(doc, e.scrollMap)
    applyTheme(doc, e.theme)
    if (scrollOk) iframe.dataset.ready = '1'                            // CSS shows only a [data-ready] cover
    else { const cur = byNode.get(nodeKey); if (cur) cur.degraded = [...cur.degraded, 'scroll'] }
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

/** Drop a node's snapshot (node removed, or its content changed and the old picture is now wrong). */
export function dropSnapshot(nodeKey: string): void {
  byNode.delete(nodeKey)
  const iframe = frames.get(nodeKey)
  if (iframe) { delete iframe.dataset.ready; iframe.removeAttribute('srcdoc') }
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
  const wantKey = keyOf(meta)
  const doc = live.contentDocument
  if (!doc) return
  // settle: fonts + two stable paints, each bounded so a slow frame can't hang the coordinator
  await withDeadline(doc.fonts?.ready ?? Promise.resolve(), 400).catch(() => {})
  await rafSettle()
  // generation guard: the frame may have renavigated during settle - if a newer request landed
  // (or the doc unloaded), drop this stale capture instead of installing old pixels.
  if (pending.has(nodeKey) || live.contentDocument !== doc) return
  let result: SerializeResult
  try { result = serializeDoc(doc, doc.URL) }   // <base> = the frame's own URL, so relative url()/img/font resolve
  catch { return }   // fail soft: keep live pixels
  byNode.set(nodeKey, { key: wantKey, html: result.html, scrollMap: result.scrollMap, degraded: result.degraded, theme: meta.theme })
  install(nodeKey)
}
