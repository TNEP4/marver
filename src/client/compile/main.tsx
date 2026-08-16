// SPEC-M7 compile harness. Playwright navigates here per capture; this page hosts the REAL frame-host
// iframe (so the bridge's parent-only postMessage works), waits for the frame to settle, runs the SAME
// serializeDoc as the runtime lean, rewrites URLs to be portable, and exposes the result on
// window.__mvArtifact for the server compiler to read. One capture per fresh browser context (isolation).
import { serializeDoc } from '../frame-host/serialize.ts'

const ROUTE = '/__mv'
const p = new URLSearchParams(location.search)
const id = p.get('id') ?? ''
const theme = p.get('theme') ?? 'light'
const width = Math.max(1, Number(p.get('width') ?? 1280))
const height = Math.max(1, Number(p.get('height') ?? 900))
const kind = p.get('kind') === 'html' ? 'html' : 'tsx'

interface Result { ok: boolean; html: string; degraded: string[]; notes?: string[]; note?: string; ms: number }
;(window as unknown as { __mvArtifact: Result | null }).__mvArtifact = null
const t0 = performance.now()
const finish = (r: Omit<Result, 'ms'>) => {
  const w = window as unknown as { __mvArtifact: Result | null }
  if (w.__mvArtifact) return
  w.__mvArtifact = { ...r, ms: Math.round(performance.now() - t0) }
}

// mount the frame at its real device size (width/height drive the layout viewport = correct reflow)
const iframe = document.createElement('iframe')
iframe.id = 'mv-compile-frame'
iframe.style.cssText = `width:${width}px;height:${height}px`
iframe.src = kind === 'html'
  ? `${ROUTE}/frame/?id=${encodeURIComponent(id)}&theme=${encodeURIComponent(theme)}&html=1&r=compile`
  : `${ROUTE}/frame/?id=${encodeURIComponent(id)}&theme=${encodeURIComponent(theme)}&r=compile`
document.body.appendChild(iframe)

// bounded DOM-quiet: wait for mutations (mermaid renders its SVG after ready, late images) to settle
function domQuiet(doc: Document, quietMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let timer = 0; let done = false
    const fin = () => { if (done) return; done = true; clearTimeout(timer); clearTimeout(hard); mo.disconnect(); resolve() }
    const mo = new MutationObserver(() => { clearTimeout(timer); timer = window.setTimeout(fin, quietMs) })
    try { mo.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }) } catch { return resolve() }
    timer = window.setTimeout(fin, quietMs)
    const hard = window.setTimeout(fin, maxMs)
  })
}

async function capture(): Promise<void> {
  const doc = iframe.contentDocument
  if (!doc) return finish({ ok: false, html: '', degraded: ['no-document'] })
  try { await (doc.fonts?.ready ?? Promise.resolve()) } catch { /* font timeout */ }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))   // two paints
  await domQuiet(doc, 150, 2500)
  try {
    const res = serializeDoc(doc, doc.URL)
    // portable URLs (codex): rewrite this dev origin to root-relative so the artifact isn't pinned to a port
    const html = res.html.split(location.origin).join('')
    finish({ ok: res.degraded.length === 0, html, degraded: res.degraded, notes: res.notes })
  } catch (e) { finish({ ok: false, html: '', degraded: ['serialize-throw'], note: String((e as Error).message ?? e) }) }
}

// settle trigger: the frame reports sh:ready to us (the parent). Fallback: capture after a bounded wait.
const fallback = window.setTimeout(capture, 5000)
window.addEventListener('message', (e) => {
  if (e.source !== iframe.contentWindow) return
  const m = e.data
  if (m?.type === 'sh:ready') { clearTimeout(fallback); void capture() }
  else if (m?.type === 'sh:error') { clearTimeout(fallback); finish({ ok: false, html: '', degraded: ['frame-error'], note: String(m.message ?? '') }) }
})
