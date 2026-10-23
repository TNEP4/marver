/**
 * Frame screenshots without a dependency - the system's own Chrome, driven over CDP through
 * its debugging pipe (cdp.ts has the transport and the lifetime story).
 *
 * This exists for Live Jam's verify loop: a jam agent has no shell (deliberately - the job
 * packet carries untrusted text), so "look at what you built" must be a capability the dev
 * server provides, not a command the agent runs. The /api/shot and /api/shots endpoints call
 * this; the `marver shot` CLI and the file-drop inbox both reach those.
 *
 * Readiness is DETERMINISTIC, not a sleep: poll until #root (or body, for html frames) has
 * children, then wait for fonts. A frame that never mounts fails with the page's own
 * exception text - which is exactly what the agent needs to fix it.
 *
 * One browser per OPERATION (a shot, a batch, a poster), N frames at a time inside a batch,
 * and the browser closed in the operation's finally - never idle, never shared, never
 * outliving the server.
 */
import { slideSize } from '../client/const.ts'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROUTE } from '../cli/name.ts'
import { Browser, CHROMES, findChrome, PROFILE_PREFIXES } from './cdp.ts'
import { staleSurface } from './stale.ts'
import { logJam } from './perf-jam.ts'

export { findChrome }

/** `scale` = device pixels per CSS px (1-4; default 2). The full-height path may step it
 *  DOWN (never up) to fit Chrome's capture surface - the result reports what was used. */
export interface ShotRequest {
  url: string; width: number; height: number; out: string; fullHeight?: boolean; timeoutMs?: number; scale?: number
  /** Capture only this element (a CSS selector) instead of the viewport - the poster generator's
   *  way of shooting a video's first frame at the clip's own size. Excludes fullHeight. */
  clip?: string
}
export type ShotResult =
  | { ok: true; width: number; height: number; scale: number; truncated?: boolean; unsettled?: boolean; note?: string; recaptures: number; ms?: number }
  | { ok: false; error: string; ms?: number; recaptures?: number }

const slug = (frameId: string) => frameId.replace(/\//g, '--')
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** How to size a frame's shot, matching the SETTLED canvas (store.ts measureNode): a frame
 *  with contentWidth is a content frame and ALWAYS auto-fits its height; a valid meta.viewport
 *  overrides only the WIDTH. Non-content frames use their viewport (or mobile), fixed height. */
export interface FrameSizing { width: number; initialHeight: number; fullHeight: boolean }
/** Optional canvas-node size - the copy-as-image contract: the frame at the NODE'S WIDTH.
 *  Slides ignore it (the artwork is the slide at its stage), content frames take the width
 *  only (the whole document is captured, never the node's scroll window), fixed frames take
 *  both (clamped to the canvas node range 120..3840 × 80..2160). */
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
  const fallback = viewports.mobile ?? { width: 390, height: 844 }
  // a slide is shot at its stage (the declared viewport, else 1280×720) whatever its canvas
  // node's size - the slide as it plays is the artwork, ready to paste anywhere
  const sl = slideSize(frame, viewports)
  if (sl) return { width: sl.width, initialHeight: sl.height, fullHeight: false }
  if (cw) {
    const width = clamp(ow ?? vpObj?.width ?? cw, 320, 1600)                 // node > vpw > contentWidth
    return { width, initialHeight: Math.round(width * 0.75), fullHeight: true }
  }
  const vp = vpObj ?? fallback
  if (ow || oh) return { width: clamp(ow ?? vp.width, 120, 3840), initialHeight: clamp(oh ?? vp.height, 80, 2160), fullHeight: false }
  return { width: vp.width, initialHeight: vp.height, fullHeight: false }
}

/** A shot's timing line (spec 27a Part D): its frame, scale, time, retakes - kept on a failure too - and an outcome code. */
export function shotEvent(frameId: string, askedScale: number, result: ShotResult): Record<string, unknown> {
  return { kind: 'shot', frame: frameId, scale: result.ok ? result.scale : askedScale, ms: result.ms, recaptures: result.recaptures ?? 0,
    outcome: result.ok ? (/not checked for a stale surface/.test(result.note ?? '') ? 'unchecked' : 'ok') : result.error === STALE ? 'stale' : /timed out/.test(result.error) ? 'timeout' : 'error' }
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
  browser?: Browser       // a batch's browser: the frame renders in it instead of starting its own
}): Promise<FrameShot> {
  const { root, viewports, frameId, theme, origin, scale = 2, size, browser } = opts
  if (!/^[a-z0-9-]+$/i.test(theme)) return { ok: false, error: 'invalid theme' }
  if (!Number.isInteger(scale) || scale < 1 || scale > 4) return { ok: false, error: 'invalid scale' }
  const frame = manifestFrame(root, frameId)
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
  const req: ShotRequest = { url: frameUrl(origin, frame, theme), width: plan.width, height: plan.initialHeight, out: tmp, fullHeight: plan.fullHeight, scale }
  const result = browser ? await captureIn(req, browser) : await capture(req)
  // its timing, as a code and numbers (spec 27a Part D)
  logJam(root, shotEvent(frameId, scale, result))
  if (!result.ok) { rmSync(tmp, { force: true }); return { ok: false, error: result.error } }
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
  return { ok: true, path: rel, width: result.width, height: result.height, scale: result.scale, ...(result.truncated ? { truncated: true } : {}), ...(result.unsettled ? { unsettled: true } : {}), ...(result.note ? { note: result.note } : {}), recaptures: result.recaptures }
}

/** A frame as design/manifest.json lists it, or null. */
export type ManifestFrame = { id: string; file: string; kind: string; viewport?: string; contentWidth?: number; slide?: boolean }
export function manifestFrame(root: string, frameId: string): ManifestFrame | null {
  let manifest: { frames?: ManifestFrame[] } = {}
  try { manifest = JSON.parse(readFileSync(join(root, 'design', 'manifest.json'), 'utf8')) } catch { /* no manifest yet */ }
  return (manifest.frames ?? []).find((f) => f.id === frameId) ?? null
}

/** The URL a frame renders at on its own: an HTML frame is its file, a TSX frame the frame host. */
export const frameUrl = (origin: string, frame: ManifestFrame, theme: string) => frame.kind === 'html'
  ? `${origin}/${frame.file}?theme=${encodeURIComponent(theme)}`
  : `${origin}${ROUTE}/frame/?id=${encodeURIComponent(frame.id)}&theme=${encodeURIComponent(theme)}`

/** True once the frame has mounted: #root (or the body, for an HTML frame) has children. */
export const MOUNTED = `(() => { const el = document.getElementById('root') ?? document.body; return !!el && el.childElementCount > 0 && document.readyState !== 'loading' })()`

export type FrameShot =
  | { ok: true; path: string; width: number; height: number; scale: number; truncated?: boolean; unsettled?: boolean; note?: string; recaptures: number }
  | { ok: false; error: string }

/** What a batch asks for: explicit ids, one scene, or everything the manifest lists. */
export type FrameSelector = { frames: unknown } | { scene: unknown } | { all: unknown }
export const BATCH_MAX = 200

/** Turn a selector into the ordered list of frame ids to shoot, or an error with the HTTP
 *  status it deserves. Ids the manifest does not know are kept (each fails its own entry);
 *  duplicates, an empty or oversize list, and a scene nobody belongs to are refused whole. */
export function resolveFrames(root: string, sel: Record<string, unknown>): { ok: true; frames: string[] } | { ok: false; status: number; error: string } {
  const keys = ['frames', 'scene', 'all'].filter((k) => sel[k] !== undefined)
  if (keys.length !== 1) return { ok: false, status: 400, error: 'name exactly one of frames (an array of ids), scene (a name) or all (true)' }
  let manifest: { frames?: { id: string; scene: string }[] } = {}
  try { manifest = JSON.parse(readFileSync(join(root, 'design', 'manifest.json'), 'utf8')) } catch { /* no manifest yet */ }
  const entries = manifest.frames ?? []   // manifest order: sorted by id, as the sidebar lists them
  const listed = entries.map((f) => f.id)
  let frames: string[]
  if (keys[0] === 'frames') {
    if (!Array.isArray(sel.frames) || !sel.frames.every((f) => typeof f === 'string' && f)) return { ok: false, status: 400, error: 'frames must be an array of frame ids' }
    frames = sel.frames as string[]
    if (new Set(frames).size !== frames.length) return { ok: false, status: 400, error: 'frames lists the same id twice' }
  } else if (keys[0] === 'scene') {
    if (typeof sel.scene !== 'string' || !sel.scene) return { ok: false, status: 400, error: 'scene must be a scene name' }
    frames = entries.filter((f) => f.scene === sel.scene).map((f) => f.id)   // the scene the manifest names, not an id prefix
    if (!frames.length) return { ok: false, status: 404, error: `no frames in scene "${sel.scene}" - scenes are in design/manifest.json` }
  } else {
    if (sel.all !== true) return { ok: false, status: 400, error: 'all must be true' }
    frames = listed
  }
  if (!frames.length) return { ok: false, status: 400, error: 'nothing to shoot' }
  if (frames.length > BATCH_MAX) return { ok: false, status: 400, error: `${frames.length} frames - a batch takes ${BATCH_MAX} at most` }
  return { ok: true, frames }
}

export type BatchEntry = { frame: string } & FrameShot

/** Shoot many frames as ONE operation: one browser, `shotConcurrency()` frames at a time
 *  inside it, results in the order asked. Every entry answers for itself - an unknown id or a
 *  frame that throws fails alone; only a browser that could not start fails the whole batch
 *  (the thrown error, for the caller to turn into a 503). Once work has begun a browser that
 *  dies fails the remaining entries individually. */
export async function shootBatch(opts: {
  root: string
  viewports: Record<string, { width: number; height: number }>
  frames: string[]
  theme: string
  origin: string
  scale?: number
}): Promise<BatchEntry[]> {
  const { root, viewports, frames, theme, origin, scale } = opts
  return withBrowser('shot', (b) => pool(shotConcurrency(), frames, async (frameId) => {
    const r = await shootFrame({ root, viewports, frameId, theme, origin, scale, browser: b }).catch((e) => ({ ok: false as const, error: (e as Error).message }))
    return { frame: frameId, ...r }
  }))
}

/** Kill the headless browsers earlier versions left behind (they outlived their server, and
 *  on macOS such a ghost of the user's own Chrome can swallow every link the machine opens),
 *  then remove the profile directories nothing references. Runs once at `dev()` start,
 *  best-effort, never throws. Orphaned is the rule: a live browser of ANY running marver
 *  server has that server as its parent, and ours die with it - so a headless Chrome on one
 *  of our profiles whose parent is 1 can only be a leak. darwin and linux (`ps -o`); anywhere
 *  else this is a no-op. */
const BROWSER_NAMES = new Set(['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser', 'chrome', 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'msedge', 'brave', 'brave-browser'])
export async function sweepGhosts(log: (line: string) => void = () => {}): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return
  const tmp = tmpdir()
  const bins = new Set([...CHROMES, ...(process.env.MARVER_CHROME ? [process.env.MARVER_CHROME] : [])])
  const profileOf = (cmd: string): string | null => {
    const m = /(?:^|\s)--user-data-dir=(\S+)/.exec(cmd)
    if (!m) return null
    const dir = m[1]
    return PROFILE_PREFIXES.some((pre) => dir.startsWith(join(tmp, pre))) ? dir : null
  }
  // the browser binary as `ps` shows it: a path we know, or (a Linux launcher script having
  // exec'd the real binary under another path) a known browser name, with a script (`node`,
  // `sh`) never matching
  const isBrowser = (cmd: string): boolean => {
    const exe = cmd.split(' --')[0]
    if ([...bins].some((b) => exe === b || exe.startsWith(`${b} `))) return true
    return BROWSER_NAMES.has(exe.slice(exe.lastIndexOf('/') + 1))
  }
  type Row = { pid: number; ppid: number; cmd: string }
  const ps = (args: string[]): Row[] | null => {
    try {
      return execFileSync('ps', args, { encoding: 'utf8' }).split('\n').map((l) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)
        return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] } : null
      }).filter((r): r is Row => !!r)
    } catch { return null }   // a ps without -o (busybox): nothing we can do safely
  }
  const rows = ps(['-axo', 'pid=,ppid=,command='])
  if (!rows) return
  const isGhost = (r: Row) => r.ppid === 1 && r.cmd.includes('--headless') && !!profileOf(r.cmd) && isBrowser(r.cmd)
  const referenced = new Set<string>()
  for (const r of rows) { const dir = profileOf(r.cmd); if (dir) referenced.add(dir) }
  for (const g of rows.filter(isGhost)) {
    // the snapshot is stale by now: a pid can be reused - re-read THIS pid and require the same
    // command line and parent before signalling
    const now = ps(['-o', 'pid=,ppid=,command=', '-p', String(g.pid)])?.[0]
    if (!now || now.cmd !== g.cmd || now.ppid !== g.ppid) continue
    try { process.kill(g.pid, 'SIGKILL') } catch { continue }   // not ours, or gone
    const by = Date.now() + 2000
    while (Date.now() < by) { try { process.kill(g.pid, 0); await new Promise((r) => setTimeout(r, 50)) } catch { break } }
    log(`shot: removed a headless browser left by an earlier version (pid ${g.pid})`)
    referenced.delete(profileOf(g.cmd)!)
  }
  // profiles nothing references and that have sat for a while - a browser that is starting
  // right now has a fresh directory
  let names: string[] = []
  try { names = readdirSync(tmp).filter((n) => PROFILE_PREFIXES.some((pre) => n.startsWith(pre))) } catch { return }
  for (const n of names) {
    const dir = join(tmp, n)
    if (referenced.has(dir)) continue
    try { if (Date.now() - statSync(dir).mtimeMs < 10 * 60_000) continue } catch { continue }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* someone else's, on a shared /tmp */ }
  }
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

/** One OPERATION at a time PER LANE, and one browser per operation. An operation is a shot,
 *  a batch or a poster: it starts its browser, runs its frames through it (a batch runs N at
 *  once inside), and closes it in the finally - no browser is ever shared between operations
 *  or left idle. Operations on a lane queue as shots always did, so two operations never
 *  write the same output at the same time. Posters have their own lane - a frame being shot
 *  may ask for its poster mid-render, and on the shot's lane that request would wait for the
 *  very shot that is waiting for it - and so do anchor checks, which have a deadline of their
 *  own and must not wait out a batch of shots. */
const chains = new Map<string, Promise<unknown>>()

export function withBrowser<T>(lane: 'shot' | 'poster' | 'check', fn: (b: Browser) => Promise<T>, o: { skip?: () => boolean; skipped?: T } = {}): Promise<T> {
  const run = async () => {
    // asked once the lane is free: an operation nobody waits for any more (a perf run that ended) starts no browser
    if (o.skip?.()) return o.skipped as T
    const b = await Browser.launch()
    try { return await fn(b) } finally { await b.close() }
  }
  const prev = chains.get(lane) ?? Promise.resolve()
  const next = prev.then(run, run)
  chains.set(lane, next)
  return next
}

/** One frame as its own operation (a poster, the shell's copy-as-image, a single `shot`). */
export function capture(req: ShotRequest, lane: 'shot' | 'poster' = 'shot'): Promise<ShotResult> {
  return withBrowser(lane, (b) => captureIn(req, b)).catch((e) => ({ ok: false as const, error: (e as Error).message }))
}

/** How many frames a batch renders at once inside its browser. Six at most by default, fewer
 *  on a small machine: the settle and grow passes are wall-clock budgets, and past a few
 *  concurrent renderers a frame starts spending its budget waiting for CPU instead of for its
 *  own content (measured 2026-09-04: 31 frames, no unsettled capture up to 8 on 18 cores). */
export function shotConcurrency(): number {
  const n = Number(process.env.MARVER_SHOT_CONCURRENCY)
  if (Number.isInteger(n) && n >= 1 && n <= 16) return n
  return Math.max(2, Math.min(6, availableParallelism() - 2))
}

/** Run `fn` over `items` with at most `n` in flight; results in input order. */
export async function pool<T, R>(n: number, items: T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => { for (;;) { const i = next++; if (i >= items.length) return; results[i] = await fn(items[i], i) } }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return results
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

/** The windows live captures hold, per browser, until their tab is closed - and how many live captures have a window
 *  nobody could name. A capture sizes its window only when it is surely its own: no other live capture in it, and no
 *  live capture whose window is unknown. */
const live = new WeakMap<Browser, { windows: Map<number, number>; unknown: number }>()
const liveFor = (b: Browser) => { let l = live.get(b); if (!l) { l = { windows: new Map(), unknown: 0 }; live.set(b, l) } return l }
/** Test seams - never set outside tests: what an attempt returns (to inject Chrome's stale surface), whether a capture
 *  gets its own window and may size it, each sizing seen, and a shorter watchdog. */
export const shotSeams: {
  capture?: (png: Buffer, at: { attempt: number; view: { w: number; h: number } | null; windowId?: number }) => Buffer
  newWindow?: boolean
  resize?: boolean
  onResize?: (windowId: number) => void
  watchdogMs?: number
  /** the time left a retake needs (RETRY_LEFT): the boundary moved, to test both sides of it */
  retryLeftMs?: number
  /** the window lookup fails, as on a Chrome that cannot name a tab's window */
  noWindow?: boolean
} = {}
/** A retake, or the 1x attempt, starts only with this much of the shot's deadline left. */
const RETRY_LEFT = 3000
const STALE = 'Chrome returned a stale surface (the picture came back tiled) - shoot it again'

/** One capture in a browser it may share; the result carries the capture's own time (`ms` - not its wait for a
 *  browser slot), which `shootFrame` logs and never passes on. */
export async function captureIn(req: ShotRequest, b: Browser): Promise<ShotResult> {
  const t0 = performance.now()
  const r = await captureOnce(req, b)
  return { ...r, ms: Math.round(performance.now() - t0) }
}

async function captureOnce({ url, width, height, out, fullHeight = false, timeoutMs = 30_000, scale: wantScale = 2, clip }: ShotRequest, b: Browser): Promise<ShotResult> {
  // retakes so far - kept on a failure too, a retake that threw included
  let recaptures = 0
  // fixed-size frames: step the scale down until the bitmap fits the budget (never up)
  let scale = Math.min(4, Math.max(1, Math.round(wantScale)))
  while (scale > 1 && !fits(width, height, scale)) scale--

  // This shot's identity inside a browser it may share with other frames of a batch: its
  // sends carry it, so the watchdog can settle THIS shot's calls and nothing else's.
  const me = {}
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let targetId: string | undefined
  let sessionId: string | undefined
  let windowId: number | undefined
  let registered: 'window' | 'unknown' | null = null
  let off = () => {}
  try {
    let lastException = ''
    const send = (method: string, params: Record<string, unknown> = {}, sid?: string) => b.send(method, params, sid, me)
    // Per-call deadline: the outer watchdog only fires at timeoutMs+15s, so a single hung CDP
    // call (a wedged measure, a stuck setDeviceMetricsOverride/captureScreenshot) would hold the
    // SERIALIZED shot queue for that whole window. Bound each call in the full-height settle path.
    const sendD = (method: string, params: Record<string, unknown>, ms = 1500) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      return Promise.race([
        send(method, params, sessionId),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${method} timed out`)), ms) }),
      ]).finally(() => clearTimeout(timer))
    }

    // Overall watchdog: kill Chrome past a hard deadline, which closes the socket and rejects
    // any pending send. Covers the CDP calls that have no timeout of their own (setup, the
    // final captureScreenshot) - the readiness loop below bounds itself, these do not.
    const watchMs = shotSeams.watchdogMs ?? timeoutMs + 15_000
    const hardBy = Date.now() + watchMs
    watchdog = setTimeout(() => b.abort(me, 'the shot timed out'), watchMs)
    const left = () => hardBy - Date.now()
    // a call that may not answer (window bounds, a probe): it answers, or null within `ms`
    const bounded = <T,>(p: Promise<T>, ms: number): Promise<T | null> => {
      let t: ReturnType<typeof setTimeout> | undefined
      return Promise.race([p.catch(() => null), new Promise<null>((r) => { t = setTimeout(() => r(null), Math.max(1, ms)) })]).finally(() => clearTimeout(t))
    }
    // Everything discretionary (settles, grow passes) is budgeted against the watchdog with this
    // reserve kept back for the REQUIRED final resize (<=5s) and capture (<=15s), so a frame that
    // took most of `timeoutMs` to mount can never push the capture into the kill.
    const RESERVE = 21_000
    const discretionary = () => hardBy - RESERVE - Date.now()

    // its own window (#14): Chrome resizes the tab's native view to the capture at screenshot time and, when the copy
    // wins that race, tiles the view's old surface - a window sized to the capture beforehand leaves nothing to resize
    targetId = (await send('Target.createTarget', { url: 'about:blank', newWindow: shotSeams.newWindow ?? true })).targetId as string
    sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId as string
    // its window, registered on its own (held until its tab is closed); one nobody can name stops every sizing meanwhile
    const lv = liveFor(b)
    const win = shotSeams.noWindow ? null : await bounded(send('Browser.getWindowForTarget', { targetId }), 1000)
    if (typeof win?.windowId === 'number') { windowId = win.windowId as number; lv.windows.set(windowId, (lv.windows.get(windowId) ?? 0) + 1); registered = 'window' }
    else { lv.unknown++; registered = 'unknown' }
    // the native view, measured before any emulation: its CSS size, its DPR and the window's decoration around it -
    // each attempt's view (what a stale surface would be) is read from the window's bounds through these
    let view: { dpr: number; decoW: number; decoH: number } | null = null
    const v0 = (await bounded(send('Runtime.evaluate', { expression: '[innerWidth, innerHeight, devicePixelRatio]', returnByValue: true }, sessionId), 1000))?.result?.value as number[] | undefined
    if (windowId !== undefined && Array.isArray(v0) && v0.length === 3 && v0.every((x) => typeof x === 'number' && x > 0) && typeof win?.bounds?.width === 'number' && typeof win?.bounds?.height === 'number')
      view = { dpr: v0[2], decoW: win.bounds.width - v0[0], decoH: win.bounds.height - v0[1] }
    const viewNow = async (): Promise<{ w: number; h: number } | null> => {
      if (!view || windowId === undefined) return null
      const r = await bounded(send('Browser.getWindowBounds', { windowId }), Math.min(1000, left()))
      const bw = r?.bounds?.width, bh = r?.bounds?.height
      return typeof bw === 'number' && typeof bh === 'number' ? { w: Math.round((bw - view.decoW) * view.dpr), h: Math.round((bh - view.decoH) * view.dpr) } : null
    }
    // a fixed frame or a slide: its window sized to the capture, if the window is surely its own (full-height frames
    // and clips keep the guard below only). Bounded: the platform may clamp, refuse or stall it - the guard decides then
    if (!fullHeight && !clip && view && windowId !== undefined && shotSeams.resize !== false && lv.windows.get(windowId) === 1 && lv.unknown === 0) {
      const cw = Math.round((width * scale) / view.dpr), ch = Math.round((height * scale) / view.dpr)
      shotSeams.onResize?.(windowId)
      const ok = (await bounded(send('Browser.setWindowBounds', { windowId, bounds: { width: cw + view.decoW, height: ch + view.decoH } }).then(() => true), 1000)) === true
      for (const by = Date.now() + 500; ok && Date.now() < by;) {
        const r = await bounded(send('Runtime.evaluate', { expression: '[innerWidth, innerHeight]', returnByValue: true }, sessionId), by - Date.now())
        const v = r?.result?.value as number[] | undefined
        if (v && v[0] === cw && v[1] === ch) break
        await new Promise((r2) => setTimeout(r2, 20))
      }
    }
    // A throw in THIS frame, keyed by its session - a batch shares the browser, so an
    // unkeyed listener would report frame A's exception on frame B.
    off = b.on((m) => {
      if (m.sessionId === sessionId && m.method === 'Runtime.exceptionThrown') {
        const d = m.params?.exceptionDetails
        lastException = String(d?.exception?.description ?? d?.text ?? '').split('\n')[0]
      }
    })
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
        expression: MOUNTED,
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
    // For a fixed frame this IS the final settle; a content frame settles again in its
    // capture viewport below and that verdict replaces this one.
    let settled = await settle(3000)

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
      settled = await settle(Math.max(1200, settleDeadline - Date.now()))
      // a late load in the final viewport (a below-fold image without reserved size) can still
      // grow the document: remeasure once and, within the cap, take the taller box
      const m2 = await measureH()
      if (m2 > capH) {
        if (m2 <= cap) capH = m2
        else { capH = cap; truncated = true; note = `frame is ${m2}px tall; captured the top ${cap}px - split it or reduce its height` }
        await sendD('Emulation.setDeviceMetricsOverride', { width: capW, height: capH, deviceScaleFactor: scale, mobile: false }, 5000)
        settled = await settle(600)   // the capture viewport's own verdict replaces the earlier one
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
    // each attempt measures the view just before it is taken, and is judged against that measurement
    let attempt = 0
    const take = async (): Promise<{ png: Buffer; view: { w: number; h: number } | null }> => {
      const v = await viewNow()
      const shot = await sendD('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: capX, y: capY, width: capW, height: capH, scale: 1 } }, Math.max(1000, Math.min(15000, left() - 500)))
      let png: Buffer = Buffer.from(String(shot.data), 'base64')
      if (shotSeams.capture) png = shotSeams.capture(png, { attempt, view: v, windowId })
      attempt++
      return { png, view: v }
    }
    // the guard (#14, #24): a picture that is the view's old surface tiled is taken again - twice at most, each only with
    // RETRY_LEFT of the deadline left - and never shipped as the frame
    const twoFrames = () => sendD('Runtime.evaluate', { expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))', awaitPromise: true, returnByValue: true }, Math.max(1, Math.min(1000, left() - RETRY_LEFT))).catch(() => null)
    const judge = (a: { png: Buffer; view: { w: number; h: number } | null }) => (a.view ? staleSurface(a.png, a.view.w, a.view.h, hardBy - 1000) : Promise.resolve('unknown' as const))
    let shotNow = await take()
    let verdict = await judge(shotNow)
    const retryLeft = shotSeams.retryLeftMs ?? RETRY_LEFT
    while (verdict === 'stale' && recaptures < 2 && left() > retryLeft) {
      recaptures++
      await twoFrames()
      shotNow = await take()
      verdict = await judge(shotNow)
    }
    if (verdict === 'stale' && fullHeight && scale > 1 && left() > retryLeft) {
      // a full-height frame at 1x: the same CSS box, a smaller surface - guarded too
      const was = scale
      await sendD('Emulation.setDeviceMetricsOverride', { width: capW, height: capH, deviceScaleFactor: 1, mobile: false }, Math.max(1, Math.min(5000, left() - 1000)))
      await twoFrames()
      recaptures++
      shotNow = await take()
      verdict = await judge(shotNow)
      if (verdict !== 'stale') { scale = 1; note = `${note ? note + '; ' : ''}came back tiled at ${was}x - captured at 1x` }
    }
    if (verdict === 'stale') return { ok: false, error: STALE, recaptures }
    if (verdict === 'unknown') note = `${note ? note + '; ' : ''}not checked for a stale surface`
    writeFileSync(out, shotNow.png)
    // Out of settle budget (under a wide batch, a slow image, a heavy chart): the capture still
    // ships, but it SAYS so - an agent reading the JSON must not take a half-drawn frame as final.
    const unsettled = !settled
    if (unsettled) note = `${note ? note + '; ' : ''}captured before the frame settled - images, charts or diagrams may be missing; shoot it alone or lower MARVER_SHOT_CONCURRENCY`
    return { ok: true, width: capW, height: capH, scale, ...(truncated ? { truncated: true } : {}), ...(unsettled ? { unsettled: true } : {}), ...(note ? { note } : {}), recaptures }
  } catch (err) {
    return { ok: false, error: (err as Error).message, ...(recaptures ? { recaptures } : {}) }
  } finally {
    if (watchdog) clearTimeout(watchdog)
    off()

    // Close THIS shot's tab; the browser belongs to the operation and closes with it. Bounded,
    // best-effort: a wedged target must not hold the batch, and the browser's own close is the
    // backstop for a Chrome that stopped answering. Then settle whatever this shot still has
    // in flight (a timed-out call, the close itself) - nothing of it outlives the shot.
    if (targetId && !b.dead) {
      let t: ReturnType<typeof setTimeout> | undefined
      await Promise.race([b.send('Target.closeTarget', { targetId }, undefined, me).catch(() => {}), new Promise((r) => { t = setTimeout(r, 2000) })])
      clearTimeout(t)
    }
    // its window is let go once its tab is closed (or the close gave up)
    const lv = liveFor(b)
    if (registered === 'window' && windowId !== undefined) { const n = (lv.windows.get(windowId) ?? 1) - 1; if (n > 0) lv.windows.set(windowId, n); else lv.windows.delete(windowId) }
    else if (registered === 'unknown') lv.unknown = Math.max(0, lv.unknown - 1)
    b.abort(me, 'the shot finished')
  }
}
