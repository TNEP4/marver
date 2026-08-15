// SPEC-M5 de-risk harness. Vanilla DOM (no React) so the perf numbers measure the lean
// docs, not our own framework. Serves at /__mv/proto/ - same origin as the frames, which is
// what lets us read a live frame's cssRules and serialize it. Two questions to answer:
//   1. FIDELITY (Nic's eyes): does the lean copy match the live app across resize/theme/device?
//   2. PERF (the number): does reflowing ~30 lean docs during a device sweep stay under 16ms?
import { serializeDoc, type SerializeResult } from '../frame-host/serialize.ts'
import { ROUTE } from '../const.ts'

interface FrameMeta { id: string; kind: string; title?: string; viewport?: string }
const DEVICES = { phone: 390, tablet: 834, laptop: 1440 } as const
const H = 720

const $ = <T extends HTMLElement>(t: string, props: Partial<T> = {}, css = ''): T => {
  const el = document.createElement(t) as unknown as T
  Object.assign(el, props); if (css) el.setAttribute('style', css)
  return el
}
const liveUrl = (id: string, theme: string) => `${ROUTE}/frame/?id=${encodeURIComponent(id)}&theme=${theme}&r=0`

const root = document.getElementById('root')!
document.body.setAttribute('style', 'margin:0;font:13px/1.5 -apple-system,system-ui,sans-serif;background:#0b0b0d;color:#e7e7ea')

let state = { id: '', theme: 'light', width: DEVICES.phone as number, overlay: false, snap: null as SerializeResult | null }

// ---- layout -----------------------------------------------------------------------------
const bar = $('div', {}, 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 14px;background:#141417;border-bottom:1px solid #26262b;position:sticky;top:0;z-index:5')
const sel = $<HTMLSelectElement>('select', {}, 'background:#1d1d22;color:#e7e7ea;border:1px solid #33333a;border-radius:6px;padding:5px 8px;max-width:280px')
const mkBtn = (label: string, on = () => {}) => { const b = $<HTMLButtonElement>('button', { textContent: label }, 'background:#1d1d22;color:#e7e7ea;border:1px solid #33333a;border-radius:6px;padding:5px 10px;cursor:pointer'); b.onclick = on; return b }
const widthLabel = $('span', {}, 'font-variant-numeric:tabular-nums;color:#a8a8b0;min-width:120px')
const wSlider = $<HTMLInputElement>('input', { type: 'range', min: '320', max: '1600', value: String(state.width) }, 'width:200px')
const notes = $('div', {}, 'padding:8px 14px;font-size:12px;color:#8a8a93;background:#141417;border-bottom:1px solid #26262b;white-space:pre-wrap')
const perfOut = $('div', {}, 'padding:10px 14px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c7c7cf;background:#0e0e11;border-bottom:1px solid #26262b;white-space:pre-wrap')
const stage = $('div', {}, 'display:flex;gap:0;align-items:flex-start;padding:20px;overflow:auto')

const pane = (title: string, accent: string) => {
  const wrap = $('div', {}, 'display:flex;flex-direction:column;gap:8px')
  const head = $('div', { textContent: title }, `font:600 11px system-ui;letter-spacing:.08em;text-transform:uppercase;color:${accent}`)
  const holder = $('div', {}, 'position:relative;background:#fff;box-shadow:0 8px 40px rgba(0,0,0,.5);border-radius:8px;overflow:hidden')
  wrap.append(head, holder)
  return { wrap, holder }
}
const livePane = pane('live · real app', '#5ac8fa')
const leanPane = pane('lean · DOM snapshot (0 JS)', '#34c759')

const liveFrame = $<HTMLIFrameElement>('iframe', { title: 'live' }, `width:${state.width}px;height:${H}px;border:0;display:block`)
let leanFrame = $<HTMLIFrameElement>('iframe', { title: 'lean' }, `width:${state.width}px;height:${H}px;border:0;display:block`)
leanFrame.setAttribute('sandbox', 'allow-same-origin')   // codex P1 fix: same-origin so fonts/assets resolve, still NO allow-scripts
livePane.holder.append(liveFrame)
leanPane.holder.append(leanFrame)

bar.append(
  $('strong', { textContent: 'SPEC-M5 lean-frame' }, 'color:#fff;margin-right:6px'), sel,
  mkBtn('Phone', () => setWidth(DEVICES.phone)), mkBtn('Tablet', () => setWidth(DEVICES.tablet)), mkBtn('Laptop', () => setWidth(DEVICES.laptop)),
  wSlider, widthLabel,
  mkBtn('◑ theme', toggleTheme),
  mkBtn('⤢ overlay diff', toggleOverlay),
  mkBtn('↻ re-serialize', () => reserialize()),
  mkBtn('▶ device sweep', () => sweepBoth()),
  mkBtn('⏱ perf: 30-frame sweep', () => perfTest(30)),
)
stage.append(livePane.wrap, leanPane.wrap)
root.append(bar, notes, perfOut, stage)

// ---- controls ---------------------------------------------------------------------------
function setWidth(w: number, animate = false) {
  state.width = w; wSlider.value = String(w); widthLabel.textContent = `${w}px  ·  ${w <= 480 ? 'phone' : w <= 1024 ? 'tablet' : 'laptop'}`
  for (const f of [liveFrame, leanFrame]) { if (animate) f.style.transition = 'width .5s cubic-bezier(.3,.7,.3,1)'; f.style.width = w + 'px' }
  if (animate) setTimeout(() => { liveFrame.style.transition = leanFrame.style.transition = '' }, 520)
}
wSlider.oninput = () => setWidth(Number(wSlider.value))

function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light'
  // live: the real bridge path (postMessage, no reload)
  liveFrame.contentWindow?.postMessage({ type: 'sh:set-theme', theme: state.theme }, '*')
  // lean: the codex-approved attribute flip - allow-same-origin lets us touch the doc directly,
  // full CSS (both themes) is already inlined, so only which rules MATCH changes. No re-capture.
  const d = leanFrame.contentDocument
  if (d) { d.documentElement.dataset.theme = state.theme; d.documentElement.classList.toggle('dark', state.theme === 'dark') }
}

function toggleOverlay() {
  state.overlay = !state.overlay
  if (state.overlay) {
    // stack lean on top of live, half-opacity, for a by-eye pixel diff
    leanPane.wrap.style.display = 'none'
    leanFrame.style.cssText = `width:${state.width}px;height:${H}px;border:0;display:block;position:absolute;inset:0;opacity:.5;mix-blend-mode:difference`
    livePane.holder.append(leanFrame)
  } else {
    leanFrame.style.cssText = `width:${state.width}px;height:${H}px;border:0;display:block`
    leanPane.holder.append(leanFrame); leanPane.wrap.style.display = ''
  }
}

// ---- capture ----------------------------------------------------------------------------
/** wait for the live frame to actually finish rendering (bridge posts sh:ready), then fonts+paint settle */
function whenLiveReady(id: string): Promise<Document> {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('live frame never became ready (8s)')), 8000)
    const onMsg = (e: MessageEvent) => {
      if (e.source !== liveFrame.contentWindow) return
      if (e.data?.type === 'sh:ready') { cleanup(); settle().then(resolve) }
      if (e.data?.type === 'sh:error') { cleanup(); reject(new Error('live frame errored: ' + e.data.message)) }
    }
    const cleanup = () => { clearTimeout(to); window.removeEventListener('message', onMsg) }
    window.addEventListener('message', onMsg)
    const settle = async () => {
      const d = liveFrame.contentDocument!
      try { await (d.fonts?.ready ?? Promise.resolve()) } catch { /* */ }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      return d
    }
    void id
  })
}

async function reserialize() {
  const d = liveFrame.contentDocument
  if (!d) return
  try { await (d.fonts?.ready ?? Promise.resolve()) } catch { /* */ }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const snap = serializeDoc(d, liveUrl(state.id, state.theme))
  state.snap = snap
  applyLean(snap.html)
  notes.textContent =
    `snapshot: ${(snap.html.length / 1024).toFixed(0)} KB html · ${(snap.cssBytes / 1024).toFixed(0)} KB css` +
    (snap.degraded.length ? `\n⚠ degraded: ${snap.degraded.join(', ')}` : '  ·  clean (no degradation)') +
    (snap.notes.length ? '\n' + snap.notes.map((n) => '• ' + n).join('\n') : '')
}

function applyLean(html: string) {
  // rebuild the lean iframe fresh so srcdoc parses from clean state
  const fresh = leanFrame.cloneNode(false) as HTMLIFrameElement
  fresh.setAttribute('sandbox', 'allow-same-origin')
  fresh.srcdoc = html
  leanFrame.replaceWith(fresh); leanFrame = fresh
  leanFrame.style.width = state.width + 'px'
  leanFrame.onload = () => {
    const d = leanFrame.contentDocument
    if (d && state.theme !== 'light') { d.documentElement.dataset.theme = state.theme; d.documentElement.classList.toggle('dark', state.theme === 'dark') }
  }
}

async function loadFrame(id: string) {
  state.id = id
  notes.textContent = 'loading live frame + serializing…'
  liveFrame.src = liveUrl(id, state.theme)
  try {
    await whenLiveReady(id)
    await reserialize()
  } catch (e) { notes.textContent = '⚠ ' + (e as Error).message }
}

// ---- device sweep (visual, both panes) --------------------------------------------------
function sweepBoth() {
  const seq = [DEVICES.phone, DEVICES.laptop, DEVICES.tablet, DEVICES.phone]
  let i = 0
  const step = () => { if (i >= seq.length) return; setWidth(seq[i++], true); setTimeout(step, 620) }
  step()
}

// ---- perf: N lean docs reflowing through a device sweep ---------------------------------
async function perfTest(n: number) {
  if (!state.snap) { perfOut.textContent = 'serialize a frame first'; return }
  perfOut.textContent = `building ${n} lean frames…`
  const grid = $('div', {}, `position:fixed;inset:0;top:0;left:0;z-index:99;background:#0b0b0d;overflow:hidden;display:grid;grid-template-columns:repeat(6,1fr);gap:2px;padding:2px`)
  const frames: HTMLIFrameElement[] = []
  await new Promise<void>((done) => {
    let loaded = 0
    for (let k = 0; k < n; k++) {
      const f = $<HTMLIFrameElement>('iframe', {}, 'width:100%;height:180px;border:0;transform-origin:top left')
      f.setAttribute('sandbox', 'allow-same-origin')
      f.onload = () => { if (++loaded === n) done() }
      f.srcdoc = state.snap!.html
      frames.push(f); grid.append(f)
    }
    document.body.append(grid)
    setTimeout(() => done(), 6000)   // safety: don't hang if a frame never fires load
  })

  // animate each frame's INNER document width (real reflow) over ~1.4s, phone->laptop->phone
  perfOut.textContent = `sweeping ${n} lean docs (reflow every tick)…`
  const dts: number[] = []
  let longTasks = 0
  const po = 'PerformanceObserver' in window ? new PerformanceObserver((l) => { longTasks += l.getEntries().length }) : null
  try { po?.observe({ entryTypes: ['longtask'] }) } catch { /* */ }

  await new Promise<void>((done) => {
    const T = 1400; let start = 0, last = 0
    const frame = (ts: number) => {
      if (!start) { start = ts; last = ts; requestAnimationFrame(frame); return }
      dts.push(ts - last); last = ts
      const p = Math.min(1, (ts - start) / T)
      const tri = p < 0.5 ? p * 2 : 2 - p * 2               // 0->1->0
      const w = Math.round(DEVICES.phone + (DEVICES.laptop - DEVICES.phone) * tri)
      // reflow each lean doc by resizing its iframe viewport (media queries fire natively)
      for (const f of frames) f.style.width = w + 'px'
      if (p >= 1) return done(); requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
  po?.disconnect()

  const sorted = dts.slice(1).sort((a, b) => a - b)   // drop first (warmup)
  const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
  const dropped = sorted.filter((d) => d > 18).length
  const p50 = pct(.5), p95 = pct(.95), max = sorted[sorted.length - 1] ?? 0
  const verdict = p95 < 16 ? '✅ under 16ms gate' : p95 < 24 ? '⚠ over gate, borderline' : '❌ blows the gate'
  perfOut.textContent =
    `PERF · ${n} lean docs · device sweep (phone↔laptop, reflow every frame)\n` +
    `  frame time  p50 ${p50.toFixed(1)}ms   p95 ${p95.toFixed(1)}ms   max ${max.toFixed(1)}ms\n` +
    `  dropped(>18ms) ${dropped}/${sorted.length}   long-tasks ${longTasks}\n` +
    `  ${verdict}   (M4 raster pan baseline was p95 9.3ms)\n` +
    `  note: this is the WORST case - every doc reflowing simultaneously. Pan/zoom (no width change) reflows nothing.`
  const close = mkBtn('✕ close perf grid', () => { grid.remove(); close.remove() })
  close.setAttribute('style', 'position:fixed;top:8px;right:8px;z-index:100;background:#c0392b;color:#fff;border:0;border-radius:6px;padding:8px 12px;cursor:pointer')
  document.body.append(close)
}

// ---- boot -------------------------------------------------------------------------------
async function boot() {
  setWidth(state.width)
  try {
    const manifest = await (await fetch('/design/manifest.json')).json() as { frames: FrameMeta[] }
    const frames = manifest.frames.filter((f) => f.kind === 'tsx' || f.kind === 'html')
    for (const f of frames) sel.append($<HTMLOptionElement>('option', { value: f.id, textContent: `${f.title ?? f.id}${f.viewport ? '  · ' + f.viewport : ''}` }))
    sel.onchange = () => loadFrame(sel.value)
    // default to a rich, themed, responsive frame if present
    const pref = frames.find((f) => /dashboard|landing|pricing|checkout/.test(f.id)) ?? frames[0]
    if (pref) { sel.value = pref.id; await loadFrame(pref.id) }
  } catch (e) { notes.textContent = 'could not load manifest: ' + (e as Error).message }
}
boot()
