/**
 * Frame screenshots without a dependency - the system's own Chrome, driven over CDP
 * (Node 22 ships a WebSocket client, so this is ~zero cost).
 *
 * This exists for Live Jam's verify loop: a jam agent has no shell (deliberately - the job
 * packet carries untrusted text), so "look at what you built" must be a capability the dev
 * server provides, not a command the agent runs. The /api/shot endpoint calls this; the
 * `marver shot` CLI and a plain WebFetch both reach that endpoint.
 *
 * Readiness is DETERMINISTIC, not a sleep: poll until #root (or body, for html frames) has
 * children, then wait for fonts. A frame that never mounts fails with the page's own
 * exception text - which is exactly what the agent needs to fix it.
 */
import { slideSize } from '../client/const.ts'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROUTE } from '../cli/name.ts'

const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
]

/** The browser binary to drive, or null. MARVER_CHROME overrides; otherwise first known install. */
export function findChrome(): string | null {
  const env = process.env.MARVER_CHROME
  if (env) return existsSync(env) ? env : null
  return CHROMES.find((p) => existsSync(p)) ?? null
}

/** `scale` = device pixels per CSS px (1-4; default 2). The full-height path may step it
 *  DOWN (never up) to fit Chrome's capture surface - the result reports what was used. */
export interface ShotRequest {
  url: string; width: number; height: number; out: string; fullHeight?: boolean; timeoutMs?: number; scale?: number
  /** Capture only this element (a CSS selector) instead of the viewport - the poster generator's
   *  way of shooting a video's first frame at the clip's own size. Excludes fullHeight. */
  clip?: string
}
export type ShotResult =
  | { ok: true; width: number; height: number; scale: number; truncated?: boolean; note?: string }
  | { ok: false; error: string }

const slug = (frameId: string) => frameId.replace(/\//g, '--')
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** How to size a frame's shot, matching the SETTLED canvas (store.ts measureNode): a frame
 *  with contentWidth is a content frame and ALWAYS auto-fits its height; a valid meta.viewport
 *  overrides only the WIDTH. Non-content frames use their viewport (or mobile), fixed height. */
export interface FrameSizing { width: number; initialHeight: number; fullHeight: boolean }
/** Optional canvas-node size - the copy-as-image contract: the frame at the NODE'S WIDTH.
 *  Slides ignore it (the artwork is 1280×720; the canvas fit only scales it), content frames
 *  take the width only (the whole document is captured, never the node's scroll window),
 *  fixed frames take both (clamped to the canvas node range 120..3840 × 80..2160). */
export interface SizeOverride { w?: number; h?: number }
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
export function planShot(
  frame: { viewport?: string; contentWidth?: number; slide?: boolean },
  viewports: Record<string, { width: number; height: number }>,
  override: SizeOverride = {},
): FrameSizing {
  const cw = num(frame.contentWidth)
  const vpObj = frame.viewport ? viewports[frame.viewport] : undefined      // undefined if the name is unknown
  const ow = num(override.w), oh = num(override.h)
  // the slide intrinsic beats everything - the Slide root IS 1280×720
  const sl = slideSize(frame)
  if (sl) return { width: sl.width, initialHeight: sl.height, fullHeight: false }
  const fallback = viewports.mobile ?? { width: 390, height: 844 }
  if (cw) {
    const width = clamp(ow ?? vpObj?.width ?? cw, 320, 1600)                 // node > vpw > contentWidth
    return { width, initialHeight: Math.round(width * 0.75), fullHeight: true }
  }
  const vp = vpObj ?? fallback
  if (ow || oh) return { width: clamp(ow ?? vp.width, 120, 3840), initialHeight: clamp(oh ?? vp.height, 80, 2160), fullHeight: false }
  return { width: vp.width, initialHeight: vp.height, fullHeight: false }
}

/** Resolve a frame from the manifest and screenshot it - the shared core behind BOTH
 *  transports (the HTTP /api/shot endpoint and the file-drop inbox), so they validate and
 *  name output identically. `origin` is the dev server's own base URL. */
export async function shootFrame(opts: {
  root: string
  viewports: Record<string, { width: number; height: number }>
  frameId: string
  theme: string
  origin: string
  scale?: number          // 1-4, default 2; anything else is refused
  size?: SizeOverride     // the canvas node's size, when the caller wants "what the node shows"
}): Promise<{ ok: true; path: string; width: number; height: number; scale: number; truncated?: boolean; note?: string } | { ok: false; error: string }> {
  const { root, viewports, frameId, theme, origin, scale = 2, size } = opts
  if (!/^[a-z0-9-]+$/i.test(theme)) return { ok: false, error: 'invalid theme' }
  if (!Number.isInteger(scale) || scale < 1 || scale > 4) return { ok: false, error: 'invalid scale' }
  let manifest: { frames?: { id: string; file: string; kind: string; viewport?: string; contentWidth?: number; slide?: boolean }[] } = {}
  try { manifest = JSON.parse(readFileSync(join(root, 'design', 'manifest.json'), 'utf8')) } catch { /* no manifest yet */ }
  const frame = (manifest.frames ?? []).find((f) => f.id === frameId)
  if (!frame) return { ok: false, error: `unknown frame "${frameId}" - ids are in design/manifest.json` }
  const plan = planShot(frame, viewports, size)
  // the frame's own posterless clips first, so the first shot of a never-seen frame already
  // carries its posters (build does the same before copying assets)
  if (frame.kind !== 'html') {
    try {
      const { scanAssetRefs } = await import('./build.ts')
      const { ensurePoster } = await import('./poster.ts')
      const refs = scanAssetRefs(readFileSync(join(root, frame.file), 'utf8'), frame.file)   // file is design/-relative to root
      for (const r of refs) if (r.endsWith('.poster.png')) await ensurePoster(join(root, 'design', 'assets'), r.slice(0, -'.poster.png'.length))
    } catch { /* a scan that cannot run never blocks the shot */ }
  }
  const shotsDir = join(root, 'design', '.local', 'shots')
  mkdirSync(shotsDir, { recursive: true })
  sweepTemps(shotsDir)
  // File naming. A DEFAULT request (no explicit scale - the CLI, the jam inbox) keeps the legacy
  // unsuffixed name whatever scale the capture settled on, so nothing an agent reads moves; an
  // explicit 2x that lands at 2x is the same picture, same name. Any other EXPLICIT scale gets its
  // own file (`@4x`), so it never overwrites the agent's default shot; when
  // the capture had to step down, the name says both (`@4x-as-2x`) so `@4x` never lies.
  const explicit = opts.scale !== undefined
  const relFor = (used: number) => {
    const tag = !explicit || (scale === 2 && used === 2) ? '' : used === scale ? `@${scale}x` : `@${scale}x-as-${used}x`
    return `design/.local/shots/${slug(frameId)}--${theme}${tag}.png`
  }
  const tmp = join(shotsDir, `.${slug(frameId)}--${theme}.${randomBytes(6).toString('hex')}.tmp.png`)
  const target = frame.kind === 'html'
    ? `${origin}/${frame.file}?theme=${encodeURIComponent(theme)}`
    : `${origin}${ROUTE}/frame/?id=${encodeURIComponent(frameId)}&theme=${encodeURIComponent(theme)}`
  const result = await capture({ url: target, width: plan.width, height: plan.initialHeight, out: tmp, fullHeight: plan.fullHeight, scale })
  if (!result.ok) { rmSync(tmp, { force: true }); return result }
  const rel = relFor(result.scale)
  // rename, with the Windows replace fallback the boards writer uses; the temp never outlives this call
  try {
    try { renameSync(tmp, join(root, rel)) } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'EPERM') throw err
      copyFileSync(tmp, join(root, rel))
    }
  } catch (err) { return { ok: false, error: `could not write the shot - ${(err as Error).message}` } }
  finally { rmSync(tmp, { force: true }) }
  return { ok: true, path: rel, width: result.width, height: result.height, scale: result.scale, ...(result.truncated ? { truncated: true } : {}), ...(result.note ? { note: result.note } : {}) }
}

/** A crashed process can leave a `.tmp.png` behind; sweep them (older than a minute, so an in-
 *  flight capture in this process is never touched) at the next shot. */
const sweptAt = new Map<string, number>()
function sweepTemps(dir: string) {
  if (Date.now() - (sweptAt.get(dir) ?? 0) < 60_000) return
  sweptAt.set(dir, Date.now())
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.tmp.png')) continue
      const p = join(dir, f)
      try { if (Date.now() - statSync(p).mtimeMs > 60_000) rmSync(p, { force: true }) } catch { /* gone */ }
    }
  } catch { /* dir vanished */ }
}

/** One capture at a time PER LANE: shots are seconds apart at most, and a Chrome per
 *  concurrent request would stampede the machine mid-jam. Posters have their own lane - a
 *  frame being shot may ask for its poster mid-render, and on the shot's lane that request
 *  would wait for the very shot that is waiting for it. */
const chains = new Map<string, Promise<unknown>>()

export function capture(req: ShotRequest, lane = 'shot'): Promise<ShotResult> {
  const prev = chains.get(lane) ?? Promise.resolve()
  const run = prev.then(() => captureNow(req), () => captureNow(req))
  chains.set(lane, run)
  return run
}

/** The capture budget. Chrome's surface tops out near 16384 device px per SIDE, and a bitmap is
 *  also bounded by its AREA: 64M device px (~256 MiB RGBA) is comfortably rendered, encoded and
 *  pasted, where a 3840×2160@4 (133M px) can stall the renderer or the paste target. Both limits
 *  are exported so the tests hold the same numbers. */
export const SURFACE = 16384
export const AREA = 64_000_000
const fits = (w: number, h: number, dsf: number) => w * dsf <= SURFACE && h * dsf <= SURFACE && w * h * dsf * dsf <= AREA
/** The tallest CSS height a full-height capture of `width` can hold at `dsf`. */
const capFor = (width: number, dsf: number) => Math.max(1, Math.min(Math.floor(SURFACE / dsf), Math.floor(AREA / (width * dsf * dsf))))

async function captureNow({ url, width, height, out, fullHeight = false, timeoutMs = 30_000, scale: wantScale = 2, clip }: ShotRequest): Promise<ShotResult> {
  // fixed-size frames: step the scale down until the bitmap fits the budget (never up)
  let scale = Math.min(4, Math.max(1, Math.round(wantScale)))
  while (scale > 1 && !fits(width, height, scale)) scale--
  const bin = findChrome()
  if (!bin) return { ok: false, error: 'no Chrome/Chromium found - install one or set MARVER_CHROME to a browser binary' }

  const profile = mkdtempSync(join(tmpdir(), 'mv-shot-'))
  const chrome = spawn(bin, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  let ws: WebSocket | null = null
  let watchdog: ReturnType<typeof setTimeout> | undefined
  try {
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let buf = ''
      const to = setTimeout(() => reject(new Error('the browser did not expose devtools in time')), 15_000)
      chrome.stderr?.on('data', (d: Buffer) => {
        buf += d
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf)
        if (m) { clearTimeout(to); resolve(m[1]) }
      })
      chrome.on('error', (e) => { clearTimeout(to); reject(e) })
      chrome.on('exit', () => { clearTimeout(to); reject(new Error('the browser exited before exposing devtools')) })
    })

    ws = new WebSocket(wsUrl)
    await new Promise<void>((res, rej) => { ws!.onopen = () => res(); ws!.onerror = () => rej(new Error('devtools socket failed')) })

    let seq = 0
    const pending = new Map<number, (m: any) => void>()
    let lastException = ''
    // If the socket dies (Chrome crashed, or the watchdog killed it), settle every in-flight
    // send so no `await send(...)` hangs forever - a hung capture would otherwise wedge the
    // whole serialized queue (every later shot waits behind it for the rest of the session).
    const failPending = (why: string) => { for (const [id, cb] of pending) { pending.delete(id); cb({ error: { message: why } }) } }
    ws.onclose = () => failPending('devtools socket closed')
    ws.onerror = () => failPending('devtools socket error')
    ws.onmessage = (e) => {
      let m: any
      try { m = JSON.parse(String(e.data)) } catch { return }   // CDP is always JSON; ignore anything else
      if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params?.exceptionDetails
        lastException = String(d?.exception?.description ?? d?.text ?? '').split('\n')[0]
      }
    }
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<any>((res, rej) => {
        const id = ++seq
        pending.set(id, (m) => m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))
        try { ws!.send(JSON.stringify({ id, method, params, sessionId })) } catch (e) { pending.delete(id); rej(e as Error) }
      })
    // Per-call deadline: the outer watchdog only fires at timeoutMs+15s, so a single hung CDP
    // call (a wedged measure, a stuck setDeviceMetricsOverride/captureScreenshot) would hold the
    // SERIALIZED shot queue for that whole window. Bound each call in the full-height settle path.
    const sendD = (method: string, params: Record<string, unknown>, ms = 1500) =>
      Promise.race([
        send(method, params, sessionId),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${method} timed out`)), ms)),
      ])

    // Overall watchdog: kill Chrome past a hard deadline, which closes the socket and rejects
    // any pending send. Covers the CDP calls that have no timeout of their own (setup, the
    // final captureScreenshot) - the readiness loop below bounds itself, these do not.
    const hardBy = Date.now() + timeoutMs + 15_000
    watchdog = setTimeout(() => { try { chrome.kill('SIGKILL') } catch { /* already gone */ } }, timeoutMs + 15_000)
    // Everything discretionary (settles, grow passes) is budgeted against the watchdog with this
    // reserve kept back for the REQUIRED final resize (<=5s) and capture (<=15s), so a frame that
    // took most of `timeoutMs` to mount can never push the capture into the kill.
    const RESERVE = 21_000
    const discretionary = () => hardBy - RESERVE - Date.now()

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }, sessionId)
    await send('Page.enable', {}, sessionId)
    await send('Runtime.enable', {}, sessionId)
    // A failed navigation (connection refused, DNS, cert) returns errorText AND still paints
    // Chrome's own error page - which has DOM, so the readiness check below would call it a
    // successful shot. Catch it here so "the site can't be reached" never masquerades as a frame.
    const nav = await send('Page.navigate', { url }, sessionId)
    if (nav?.errorText && nav.errorText !== 'net::ERR_ABORTED') {
      return { ok: false, error: `could not load the frame (${nav.errorText}) - is the dev server reachable at ${new URL(url).origin}?` }
    }

    const t0 = Date.now()
    let ready = false
    while (Date.now() - t0 < timeoutMs) {
      const r = await send('Runtime.evaluate', {
        expression: `(() => { const el = document.getElementById('root') ?? document.body; return !!el && el.childElementCount > 0 && document.readyState !== 'loading' })()`,
        returnByValue: true,
      }, sessionId).catch(() => null)
      if (r?.result?.value) { ready = true; break }
      await new Promise((r2) => setTimeout(r2, 150))
    }
    if (!ready) return { ok: false, error: `the frame never rendered${lastException ? ` - the page threw: ${lastException}` : ' (no exception surfaced - is the dev server reachable from this machine?)'}` }

    // Content settle, for EVERY path (a fixed frame or a slide has charts, diagrams and images
    // too): tell the LOD pipeline the camera is at rest at 1:1 (it decodes full-res on that), then
    // wait - bounded by an absolute deadline, every probe on sendD so a wedged CDP call cannot hold
    // the queue - for the async work a rendered frame still has in flight: fonts, LOD decodes, in-
    // viewport <img> loads (lazy ones included - a lazy image outside the viewport is not in the
    // picture), echarts instances (a lazy chunk; the SVG lands after init), mermaid diagrams (the
    // SVG lands after an async render, or the error card shows). Then two frames for the paint.
    // A frame that never settles still captures once the budget is spent: quality, never a hang.
    const SETTLED = `(() => {
      if (typeof window.__mvLodBusy === 'function' && window.__mvLodBusy() > 0) return false
      if (typeof window.__mvPosterBusy === 'function' && window.__mvPosterBusy() > 0) return false
      const H = window.innerHeight, W = window.innerWidth
      for (const im of document.images) {
        if (im.complete) continue
        const r = im.getBoundingClientRect()
        if (r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) continue
        return false
      }
      for (const c of document.querySelectorAll('.mv-chart')) if (!c.querySelector('svg, canvas')) return false
      for (const d of document.querySelectorAll('.mv-diagram')) if (!d.querySelector('.mv-diagram-svg svg, .mv-diagram-err')) return false
      return true
    })()`
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    // `budgetMs` is clamped to what the watchdog reserve leaves; every call inside, the rAF wait
    // and the tail margin included, is bounded by that same absolute deadline. With no budget
    // left it returns at once - the capture still happens, just unsettled.
    const settle = async (budgetMs: number): Promise<boolean> => {
      const total = Math.min(budgetMs, discretionary())
      if (total <= 0) return false
      const by = Date.now() + total
      const left = () => Math.max(1, by - Date.now())
      await sendD('Runtime.evaluate', { expression: `window.postMessage({type:'sh:camera',moving:false,scale:1}, location.origin)`, returnByValue: true }, left()).catch(() => null)
      await sendD('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)', awaitPromise: true, returnByValue: true }, left()).catch(() => null)
      let ok = false
      while (Date.now() < by) {
        const r = await sendD('Runtime.evaluate', { expression: SETTLED, returnByValue: true }, left()).catch(() => null)
        if (r?.result?.value === true) { ok = true; break }
        await wait(Math.min(100, left()))
      }
      if (Date.now() < by) await sendD('Runtime.evaluate', { expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))', awaitPromise: true, returnByValue: true }, Math.min(1000, left())).catch(() => null)
      if (Date.now() < by) await wait(Math.min(ok ? 150 : 250, left()))   // decode margin (images paint after `complete`)
      return ok
    }
    await settle(3000)

    // A frame that THREW renders the frame-host's error card - which has DOM, so readiness
    // above passed. The host stamps the crash on window.__mvFrameError; surface it so an agent
    // reading only the JSON result (not the PNG) still learns the frame broke.
    const errEval = await send('Runtime.evaluate', { expression: 'window.__mvFrameError || ""', returnByValue: true }, sessionId).catch(() => null)
    const frameError = typeof errEval?.result?.value === 'string' ? errEval.result.value : ''
    if (frameError) return { ok: false, error: `the frame rendered an error - ${frameError}` }

    // Capture geometry. Non-content frames keep the fixed viewport set above (at `scale`). Content
    // frames auto-fit height: grow the viewport so all content lays out (lazy images load, LOD
    // first-decode pins each image's aspect-ratio -> stable height), measure, then capture full.
    let capW = width, capH = height, truncated = false, note = ''
    if (fullHeight) {
      const measureH = async (): Promise<number> => {
        const r = await sendD('Runtime.evaluate', {
          expression: `Math.ceil((document.querySelector('.mv-doc')||document.getElementById('root')||document.body).getBoundingClientRect().height)`,
          returnByValue: true,
        }).catch(() => null)
        const v = r?.result?.value
        return typeof v === 'number' && Number.isFinite(v) ? v : 0
      }
      // 0 = no LOD decode running/queued (aspect-ratios pinned); true when the frame has no LOD
      // images or the probe is absent. One input to trustworthy height - the two-consecutive-reads
      // stability check below is the fallback that also catches late NON-LOD layout (mermaid, fonts).
      const lodIdle = async (): Promise<boolean> => {
        const r = await sendD('Runtime.evaluate', {
          expression: `(typeof window.__mvLodBusy==='function')?window.__mvLodBusy():0`, returnByValue: true,
        }).catch(() => null)
        const v = r?.result?.value
        return typeof v === 'number' ? v === 0 : true
      }
      let measured = 0
      // Grow-to-fit at a given scale/cap. Bounded by iterations AND an absolute deadline so a
      // never-settling frame can't wedge the single-flight queue. Breaks only when the height
      // FITS the viewport AND is stable across two reads (so a late layout shift is caught even
      // when __mvLodBusy is absent), or the cap is hit.
      const growFit = async (dsf: number, capCss: number, deadline: number) => {
        let h = Math.max(height, 2000), prev = -1
        for (let i = 0; i < 8 && Date.now() < deadline; i++) {
          // Guard each timed await on the deadline so the WHOLE settle is bounded to
          // deadline + at most one in-flight per-call timeout, never a full extra iteration.
          await sendD('Emulation.setDeviceMetricsOverride', { width, height: Math.min(h, capCss), deviceScaleFactor: dsf, mobile: false }).catch(() => {})
          if (Date.now() >= deadline) break
          await sendD('Runtime.evaluate', { expression: 'document.fonts.ready.then(()=>true)', awaitPromise: true, returnByValue: true }).catch(() => null)
          if (Date.now() >= deadline) break
          for (let j = 0; j < 10 && Date.now() < deadline && !(await lodIdle()); j++) await wait(100)
          if (Date.now() >= deadline) break
          await wait(150)
          if (Date.now() >= deadline) break
          const m = await measureH()
          if (m > 0) measured = m
          const capped = Math.min(h, capCss)
          if (capped >= capCss) break                     // hit the cap - stop growing
          if (m > 0 && m <= capped && m === prev) break    // fits AND stable across two reads
          prev = m
          h = Math.max(m, capped)
        }
      }
      // ONE absolute budget for the discretionary settle work (every grow pass + the optional
      // sharpen). New timed awaits stop starting once it passes; only an already-in-flight per-call
      // deadline (<=1.5s) can overrun. The REQUIRED final resize (<=5s) and capture (<=15s) run
      // after with their own per-call deadlines, so total is bounded well under the 45s watchdog -
      // a never-settling frame can never wedge the single-flight queue. All grow passes SHARE this.
      // The ladder: try the asked scale; a frame taller than that scale's cap steps DOWN to 2, then
      // to 1 (DPR1 fits the tallest within the surface budget); only past the 1x cap is it truncated.
      const settleDeadline = Date.now() + Math.max(0, Math.min(6000, discretionary()))
      const asked = scale
      await growFit(scale, capFor(width, scale), settleDeadline)
      if (measured > capFor(width, scale) && scale > 2) { scale = 2; await growFit(2, capFor(width, 2), settleDeadline) }
      if (measured > capFor(width, scale) && scale > 1) { scale = 1; await growFit(1, capFor(width, 1), settleDeadline) }
      const cap = capFor(width, scale)
      capW = width
      if (measured > cap) { capH = cap; truncated = true; note = `frame is ${measured}px tall; captured the top ${cap}px - split it or reduce its height` }
      else capH = clamp(measured || height, 80, cap)
      if (scale < asked && !truncated) note = `frame is ${measured}px tall - too tall for ${asked}x, captured at ${scale}x`
      // Final viewport IS the capture box (and fixes deviceScaleFactor to `scale`). Do NOT swallow
      // this failure: a wrong viewport would make the returned dimensions/scale disagree with the
      // PNG. Let it throw -> ok:false. Its own 5s per-call deadline bounds it.
      await sendD('Emulation.setDeviceMetricsOverride', { width: capW, height: capH, deviceScaleFactor: scale, mobile: false }, 5000)
      // The final viewport is what gets captured: settle AGAIN in it (the general check - LOD at
      // full-res, images now in view, charts/diagrams), with whatever is left of the settle budget
      // plus a floor, so a late load never ships half-drawn. img-lod DEBOUNCES 220ms before
      // enqueuing a sharpen, so the floor covers that too.
      await wait(Math.min(300, Math.max(0, discretionary())))
      await settle(Math.max(1200, settleDeadline - Date.now()))
      // a late load in the final viewport (a below-fold image without reserved size) can still
      // grow the document: remeasure once and, within the cap, take the taller box
      const m2 = await measureH()
      if (m2 > capH) {
        if (m2 <= cap) capH = m2
        else { capH = cap; truncated = true; note = `frame is ${m2}px tall; captured the top ${cap}px - split it or reduce its height` }
        await sendD('Emulation.setDeviceMetricsOverride', { width: capW, height: capH, deviceScaleFactor: scale, mobile: false }, 5000)
        await settle(600)
      }
    }

    // element clip: the selector's box, in CSS px, at the viewport's scale
    let capX = 0, capY = 0
    if (clip) {
      const r = await sendD('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(clip)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })()`,
        returnByValue: true,
      }, 2000).catch(() => null)
      const box = r?.result?.value as { x: number; y: number; w: number; h: number } | null
      if (!box || box.w < 1 || box.h < 1) return { ok: false, error: `nothing to capture at "${clip}"` }
      capX = Math.max(0, Math.floor(box.x)); capY = Math.max(0, Math.floor(box.y))
      capW = Math.max(1, Math.round(box.w)); capH = Math.max(1, Math.round(box.h))
    }
    // clip in DIP + scale:1 so the PNG is exactly capW*deviceScaleFactor x capH*deviceScaleFactor;
    // captureBeyondViewport is a belt-and-suspenders for the clip. Deadline-bounded (a tall capture
    // is legitimately a few seconds) so a hung capture can't wedge the queue either.
    const shot = await sendD('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: capX, y: capY, width: capW, height: capH, scale: 1 } }, 15000)
    writeFileSync(out, Buffer.from(String(shot.data), 'base64'))
    return { ok: true, width: capW, height: capH, scale, ...(truncated ? { truncated: true } : {}), ...(note ? { note } : {}) }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  } finally {
    if (watchdog) clearTimeout(watchdog)
    try { ws?.close() } catch { /* already gone */ }
    chrome.kill('SIGKILL')
    // rm after the process actually exits - Chrome flushes its profile on the way down
    chrome.once('exit', () => { try { rmSync(profile, { recursive: true, force: true }) } catch { /* temp cleanup only */ } })
  }
}
