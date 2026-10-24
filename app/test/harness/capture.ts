/**
 * The capture harness (spec 28 A3.8 #34-#38, #50): what WindowServer composited for the app's window at each
 * refresh, read by `test/native/capture.swift` (ScreenCaptureKit, a window or a display stream) and judged here
 * against main's journal (testing/index.ts `JournalTopics`: both on mach_continuous_time, the helper converting SCK's; a control case
 * checks that they line up). Owner: the flash and native acceptance stream; the one-ground stream reads its matrix.
 *
 * **Screen Recording is the runner's** (A3.8 #37): the helper checks `CGPreflightScreenCaptureAccess()` and exits 77
 * when it is not granted - reported as **blind**, not run, never passed, naming the app that needs the permission
 * (the terminal or agent running the suite). The app itself never asks for Screen Recording (A2.12).
 *
 * The helper's stdout, one JSON line each (FROZEN, A3.8 #53): first `{ ready: { hostNs, refreshHz, scale } }`, then
 * per frame `{ hostNs, status: 'complete' | 'idle' | 'blank' | 'suspended' | 'started' | 'stopped', gap?, detect? }`
 * - and `CaptureSession.lines` yields exactly that, `{ ready }` first. Added by the native stream (optional, so the
 * frozen reader is unchanged): `ready.window` (the stream's size in points), a frame's `regions` (the samples of each
 * named region, `--regions`) and its first `info`; the helper's own `{ png }` answers are not lines. A run is
 * conclusive only if every sample is `complete` or `idle` and display times stay within 1.5 refreshes, at both ends of
 * each transition; an inconclusive transition is run again, and three fail the case (`retried`).
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

/** capture.swift's exit code when Screen Recording is not granted to the process running it. */
export const CAPTURE_BLIND = 77

export interface CaptureReady { hostNs: string; refreshHz: number; scale: number; window?: { w: number; h: number } }
export interface CaptureFrame {
  hostNs: string
  status: 'complete' | 'idle' | 'blank' | 'suspended' | 'started' | 'stopped'
  /** frames the stream missed before this one: the transition is inconclusive */
  gap?: number
  /** `--detect <hex>:<minPx>`: a solid block of that colour found, and where */
  detect?: { found: boolean; rect?: { x: number; y: number; w: number; h: number } }
  /** `--regions`: each region's samples, "rrggbb" in sRGB, row by row (native stream, additive) */
  regions?: Record<string, string[]>
}
export type CaptureLine = { ready: CaptureReady } | CaptureFrame

/** A transition's verdict (A3.8 #36): `n` bad refreshes, `ms` from the first bad frame to the first verified good one. */
export type TransitionVerdict = { kind: 'pass' | 'fail'; n: number; ms: number } | { kind: 'inconclusive'; why: string } | { kind: 'blind'; needs: string }
  /** three runs of one transition, each inconclusive: it fails its case (A3.8 #37; `retried`) */
  | { kind: 'unresolved'; why: string }

// ---- the helpers, compiled once per source ---------------------------------------------------------------------

const NATIVE = resolve(import.meta.dirname, '..', 'native')

/** A Swift helper of test/native, compiled with `swiftc -O` into a temp folder keyed by its source's hash. */
export function nativeTool(name: 'capture' | 'clickpost' | 'procusage' | 'keypost'): string {
  const src = join(NATIVE, `${name}.swift`)
  const hash = createHash('sha256').update(readFileSync(src)).digest('hex').slice(0, 12)
  const dir = join(tmpdir(), `mv-native-${hash}`)
  const bin = join(dir, name)
  if (existsSync(bin)) return bin
  mkdirSync(dir, { recursive: true })
  const tmp = `${bin}.${process.pid}.tmp`
  execFileSync('/usr/bin/swiftc', ['-O', src, '-o', tmp], { stdio: 'pipe', timeout: 300_000 })
  renameSync(tmp, bin)
  return bin
}

/** The app macOS asks about for Screen Recording or Accessibility: the first `.app` up this process's ancestry. */
export function responsibleApp(): string {
  let pid = process.pid
  for (let i = 0; i < 20 && pid > 1; i++) {
    try {
      const [ppid, ...cmd] = execFileSync('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/)
      const m = /^(.*?\.app)\//.exec(cmd.join(' '))
      if (m) return m[1]!
      pid = Number(ppid)
    } catch { break }
  }
  return 'the terminal or agent host running this suite'
}

/**
 * Why a capture is blind: Screen Recording not granted to the runner (`needs` names the app), or nothing composited
 * at all - the screen locked or the display asleep (a stream then sends only `idle` frames).
 */
export type BlindWhy = 'permission' | 'locked' | 'asleep'
export interface Blind { needs: string; why: BlindWhy }
const blindSays = (b: Blind) => b.why === 'permission' ? `Screen Recording is not granted to ${b.needs}` : `the ${b.why === 'locked' ? 'screen is locked' : 'display is asleep'}: nothing is composited (needs ${b.needs})`

/** Raised by startCapture when the helper exits 77: report the case as blind, never as a pass. */
export class CaptureBlind extends Error {
  readonly needs: string
  readonly why: BlindWhy
  constructor(needs: string, why: BlindWhy = 'permission') { super(`blind: ${blindSays({ needs, why })}`); this.needs = needs; this.why = why }
}

/** The helper's check line read into a verdict (pure: `capture check`'s stdout). */
export function blindOf(stdout: string): Blind | null {
  let c: { access?: boolean; locked?: boolean; asleep?: boolean } = {}
  try { c = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') } catch { /* an unreadable line is the permission's */ }
  if (c.access === false || c.access === undefined) return { needs: responsibleApp(), why: 'permission' }
  if (c.locked) return { needs: 'the screen unlocked, the app window on it', why: 'locked' }
  if (c.asleep) return { needs: 'the display awake', why: 'asleep' }
  return null
}

/** Whether the helper can watch the screen here: true, or why it is blind (and what would make it see). */
export async function captureAccess(): Promise<true | Blind> {
  const bin = nativeTool('capture')
  try { await promisify(execFile)(bin, ['check'], { timeout: 10_000 }); return true } catch (e) {
    const x = e as { code?: number; stdout?: string }
    if (x.code === CAPTURE_BLIND) return blindOf(x.stdout ?? '') ?? { needs: responsibleApp(), why: 'permission' }
    throw e
  }
}

/** Whether anything is composited now (a run that needs frames drawn but not captured: no permission asked). */
export async function screenState(): Promise<{ locked: boolean; asleep: boolean }> {
  const read = (out: string) => { try { const c = JSON.parse(out.trim().split('\n').pop() ?? '{}') as { locked?: boolean; asleep?: boolean }; return { locked: !!c.locked, asleep: !!c.asleep } } catch { return { locked: false, asleep: false } } }
  try { return read((await promisify(execFile)(nativeTool('capture'), ['check'], { timeout: 10_000 })).stdout) } catch (e) { return read((e as { stdout?: string }).stdout ?? '') }
}

/** A blind verdict's words, for a report line. */
export const blindLine = (b: Blind) => blindSays(b)

export interface CaptureSession {
  /** the helper's first line */
  ready: CaptureReady
  /**
   * FROZEN: first `{ ready }`, then every frame line from the session's start, as it comes. It reads `frames` (an
   * index into it), so nothing is queued a second time, and an iterator made late still starts at the session's first
   * frame kept (frames `forget` dropped are skipped).
   */
  lines: AsyncIterable<CaptureLine>
  /** the frames kept, in arrival order (`forget` drops older ones) */
  frames: CaptureFrame[]
  /** called with every frame as it arrives; returns its unsubscribe */
  onFrame(fn: (f: CaptureFrame) => void): () => void
  /** drop the frames before `ns`, keeping the last complete one before it (a transition carries it) */
  forget(ns: bigint): void
  /** write the last complete frame as a PNG */
  png(path: string): Promise<void>
  /**
   * write the frame displayed at `hostNs` as a PNG - the strip of the window that holds the regions, from the helper's
   * ring of the last 60 complete frames (window mode with regions only): false when it has left the ring
   */
  pngAt(hostNs: string, path: string): Promise<boolean>
  stop(): Promise<void>
}

/** One capture session of the app's window (or the display, for the painted launch). */
export async function startCapture(o: {
  mode: 'window' | 'display'
  windowId?: number
  detect?: { hex: string; minPx: number; belowY: number }
  /** window points from its top-left, sampled on a `grid` of cell centres (default 4 x 4) */
  regions?: Record<string, { x: number; y: number; w: number; h: number }>
  grid?: [number, number]
  fps?: number
  /** display mode: the helper's 2 px heartbeat window, so every refresh is captured and a gap is a missed frame */
  heartbeat?: boolean
  /** window points kept for each of the last 60 complete frames, for `pngAt` (a failing transition's evidence) */
  ring?: { x: number; y: number; w: number; h: number }
}): Promise<CaptureSession> {
  const bin = nativeTool('capture')
  const args: string[] = [o.mode]
  if (o.windowId !== undefined) args.push('--window-id', String(o.windowId))
  if (o.detect) args.push('--detect', `${o.detect.hex.replace(/^#/, '')}:${o.detect.minPx}:${o.detect.belowY}`)
  if (o.regions) args.push('--regions', Object.entries(o.regions).map(([n, r]) => `${n}:${r.x},${r.y},${r.w},${r.h}`).join(';'))
  if (o.grid) args.push('--grid', `${o.grid[0]}x${o.grid[1]}`)
  if (o.fps) args.push('--fps', String(o.fps))
  if (o.heartbeat) args.push('--heartbeat')
  if (o.ring) args.push('--ring', `${o.ring.x},${o.ring.y},${o.ring.w},${o.ring.h}`)
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  let err = ''
  child.stderr.on('data', (c) => { err += c })
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))
  const frames: CaptureFrame[] = []
  /** frames forget() dropped: an iterator's index is absolute */
  let dropped = 0
  let ended = false
  const wake: (() => void)[] = []
  const listeners = new Set<(f: CaptureFrame) => void>()
  let ready: CaptureReady | undefined
  let onReady: ((r: CaptureReady) => void) | undefined
  const pngWaits = new Map<string, (ok: boolean) => void>()
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (l) => {
    let x: unknown
    try { x = JSON.parse(l) } catch { return }
    const line = x as CaptureLine & { png?: string; id?: string }
    if (line.png) { const w = pngWaits.get(line.id ?? 'last'); pngWaits.delete(line.id ?? 'last'); w?.(line.png === 'done'); return }
    if ('ready' in line) { ready = line.ready; onReady?.(line.ready); return }
    frames.push(line)
    for (const f of listeners) { try { f(line) } catch { /* a listener's own error */ } }
    for (const w of wake.splice(0)) w()
  })
  rl.on('close', () => { ended = true; for (const w of wake.splice(0)) w(); for (const [, w] of pngWaits) w(false); pngWaits.clear() })
  const first = await Promise.race([
    new Promise<CaptureReady>((r) => { onReady = r }),
    exited.then((code) => code),
  ])
  if (typeof first !== 'object' || first === null) {
    if (first === CAPTURE_BLIND) throw new CaptureBlind(/locked|asleep/.test(err) ? 'the screen unlocked and the display awake' : responsibleApp(), /locked|asleep/.test(err) ? 'locked' : 'permission')
    throw new Error(`capture.swift exited ${first}: ${err.trim()}`)
  }
  const readyLine = first
  const lines: AsyncIterable<CaptureLine> = {
    [Symbol.asyncIterator]: () => {
      let gaveReady = false
      let at = dropped
      return {
        next: async (): Promise<IteratorResult<CaptureLine>> => {
          if (!gaveReady) { gaveReady = true; return { value: { ready: readyLine }, done: false } }
          for (;;) {
            if (at < dropped) at = dropped
            const f = frames[at - dropped]
            if (f) { at++; return { value: f, done: false } }
            if (ended) return { value: undefined, done: true }
            await new Promise<void>((r) => wake.push(r))
          }
        },
      }
    },
  }
  let seq = 0
  const ask = (id: string, cmd: string) => new Promise<boolean>((r) => {
    const t = setTimeout(() => { pngWaits.delete(id); r(false) }, 3000)
    pngWaits.set(id, (ok) => { clearTimeout(t); r(ok) })
    try { child.stdin.write(cmd + '\n') } catch { pngWaits.delete(id); clearTimeout(t); r(false) }
  })
  return {
    ready: readyLine, lines, frames,
    onFrame(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
    forget(ns) {
      let k = frames.findIndex((f) => BigInt(f.hostNs) >= ns)
      if (k < 0) k = frames.length
      // keep the last complete frame before ns, and everything after it
      let keepFrom = k
      for (let j = k - 1; j >= 0; j--) if (frames[j]!.status === 'complete') { keepFrom = j; break }
      if (keepFrom > 0) { frames.splice(0, keepFrom); dropped += keepFrom }
    },
    png: async (path) => { await ask('last', `png ${path}`) },
    pngAt: (hostNs, path) => { const id = `p${++seq}`; return ask(id, `png-at ${id} ${hostNs} ${path}`) },
    async stop() {
      child.stdin.end()
      const code = await Promise.race([exited, new Promise<'late'>((r) => setTimeout(() => r('late'), 3000))])
      if (code === 'late') child.kill('SIGKILL')
    },
  }
}

// ---- colours, as the capture sees them ---------------------------------------------------------------------------

export type RGB = [number, number, number]
export const rgb = (hex: string): RGB => { const v = parseInt(hex.replace(/^#/, ''), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255] }
const dist = (a: RGB, b: RGB) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))

/**
 * The calibrated colours of a run (A3.8 #34): each source sampled as the capture shows it - never its hex - and a
 * sample classified by the nearest within `tolerance`. A pair `[ground, dot]` also takes every colour near the line
 * between them (antialiased dot edges count as ground or dots).
 */
export class Palette {
  private named: { name: string; c: RGB }[] = []
  private lines: { name: string; a: RGB; b: RGB }[] = []
  readonly tolerance: number
  constructor(tolerance = 18) { this.tolerance = tolerance }
  add(name: string, samples: readonly string[]): this {
    const seen = new Set<string>()
    for (const s of samples) if (s && !seen.has(s)) { seen.add(s); this.named.push({ name, c: rgb(s) }) }
    return this
  }
  /** colours along a to b (a dot's antialiased edge on the ground) are `name` */
  between(name: string, a: string, b: string): this { this.lines.push({ name, a: rgb(a), b: rgb(b) }); return this }
  classify(hex: string): string {
    if (!hex) return 'none'
    const p = rgb(hex)
    let best = 'other', d = this.tolerance + 1
    for (const n of this.named) { const x = dist(p, n.c); if (x < d) { d = x; best = n.name } }
    for (const l of this.lines) {
      // the point's projection on the segment, then its distance
      const ab = [l.b[0] - l.a[0], l.b[1] - l.a[1], l.b[2] - l.a[2]]
      const len = ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2 || 1
      const t = Math.max(0, Math.min(1, ((p[0] - l.a[0]) * ab[0]! + (p[1] - l.a[1]) * ab[1]! + (p[2] - l.a[2]) * ab[2]!) / len))
      const q: RGB = [l.a[0] + ab[0]! * t, l.a[1] + ab[1]! * t, l.a[2] + ab[2]! * t]
      const x = dist(p, q)
      if (x < d) { d = x; best = l.name }
    }
    return best
  }
}

// ---- judging a transition (A3.8 #36, #37) ------------------------------------------------------------------------

/** A frame's verdict: every sample of what the case reads is good, or something in it is bad. */
export type FrameVerdict = 'good' | 'bad'

/**
 * One transition, from main's decision `t0` to `t1` (the window's end): `n` the refreshes showing a bad frame (an
 * `idle` sample repeats the frame before it), `ms` from the first bad frame's display time to that of the first
 * verified good frame after the last bad one (a `complete` sample that passes, A3.8 r1 #10). Inconclusive, never a
 * pass: a sample neither complete nor idle, display times more than 1.5 refreshes apart, no frame at all, or a bad
 * interval with no verified good frame after it. **Both ends are covered** (A3.8 #36, #37: missing evidence is never
 * a pass): the frame before `t0` (else the first frame inside) must be within 1.5 refreshes of the first one inside,
 * and the first frame at or after `t1` must exist, carry no `gap` and be within 1.5 refreshes of the last frame
 * inside - so a stream that skipped the window's tail, or has not delivered it yet, is inconclusive. That frame
 * closes a bad interval when it is a complete good one; it is never counted as bad.
 */
export function judgeTransition(frames: readonly CaptureFrame[], o: {
  t0: bigint
  t1: bigint
  refreshHz: number
  verdict(f: CaptureFrame): FrameVerdict
  /** the case's own threshold for this one transition (default A2.2's: 2 refreshes, 100 ms; exact: 0) */
  maxN?: number
  maxMs?: number
}): TransitionVerdict {
  const refreshNs = 1e9 / o.refreshHz
  const ns = (f: CaptureFrame) => BigInt(f.hostNs)
  const apart = (a: bigint, b: bigint) => Number(b - a) > refreshNs * 1.5
  const msOf = (d: bigint) => (Number(d) / 1e6).toFixed(1)
  let i = frames.findIndex((f) => ns(f) >= o.t0)
  if (i < 0) return { kind: 'inconclusive', why: 'no frame after the decision' }
  // the head: with no frame before t0, the first one inside must itself be within 1.5 refreshes of the decision
  if (i === 0 && apart(o.t0, ns(frames[0]!))) return { kind: 'inconclusive', why: `no frame before the decision, the first ${msOf(ns(frames[0]!) - o.t0)} ms after it` }
  // the frame on screen at t0: the last complete one before it, carried by idle samples
  let carried: FrameVerdict | null = null
  for (let k = i - 1; k >= 0; k--) if (frames[k]!.status === 'complete') { carried = o.verdict(frames[k]!); break }
  let prevNs = i > 0 ? ns(frames[i - 1]!) : null
  let n = 0
  let firstBad: bigint | null = null
  let goodAfterBad: bigint | null = null
  let seen = 0
  for (; i < frames.length && ns(frames[i]!) < o.t1; i++) {
    const f = frames[i]!
    if (f.status !== 'complete' && f.status !== 'idle') return { kind: 'inconclusive', why: `a ${f.status} sample` }
    if (f.gap) return { kind: 'inconclusive', why: `a gap of ${f.gap} refreshes` }
    if (prevNs !== null && apart(prevNs, ns(f))) return { kind: 'inconclusive', why: `display times ${msOf(ns(f) - prevNs)} ms apart` }
    prevNs = ns(f)
    seen++
    const v = f.status === 'complete' ? o.verdict(f) : carried
    if (v === null) return { kind: 'inconclusive', why: 'an idle sample with no frame before it' }
    carried = v
    if (v === 'bad') { n++; if (firstBad === null) firstBad = ns(f); goodAfterBad = null }
    else if (f.status === 'complete' && firstBad !== null && goodAfterBad === null) goodAfterBad = ns(f)
  }
  if (!seen || prevNs === null) return { kind: 'inconclusive', why: 'no frame inside the transition' }
  const maxN = o.maxN ?? 2, maxMs = o.maxMs ?? 100
  const round = (d: bigint) => Math.round(Number(d) / 1e5) / 10
  // past the threshold on what was seen, contiguous from the decision: a fail whatever the tail (an interval still
  // open at the last frame seen gives ms as a lower bound, to that frame)
  if (n > maxN) return { kind: 'fail', n, ms: round((goodAfterBad ?? prevNs) - firstBad!) }
  if (goodAfterBad !== null && Number(goodAfterBad - firstBad!) / 1e6 > maxMs) return { kind: 'fail', n, ms: round(goodAfterBad - firstBad!) }
  // the tail: the first frame at or after t1 proves that no refresh between the last frame inside and t1 was missed
  const after = i < frames.length ? frames[i]! : null
  if (!after) return { kind: 'inconclusive', why: `no frame at or after the window's end (the last ${msOf(o.t1 - prevNs)} ms before it unseen)` }
  if (after.gap) return { kind: 'inconclusive', why: `a gap of ${after.gap} refreshes at the window's end` }
  if (apart(prevNs, ns(after))) return { kind: 'inconclusive', why: `display times ${msOf(ns(after) - prevNs)} ms apart at the window's end` }
  // a bad interval still open at t1 is closed by that frame only when it is a complete good one
  if (firstBad !== null && goodAfterBad === null && after.status === 'complete' && o.verdict(after) === 'good') goodAfterBad = ns(after)
  if (n === 0) return { kind: 'pass', n: 0, ms: 0 }
  if (goodAfterBad === null) return { kind: 'inconclusive', why: 'no verified good frame after the bad interval' }
  return { kind: Number(goodAfterBad - firstBad!) / 1e6 <= maxMs ? 'pass' : 'fail', n, ms: round(goodAfterBad - firstBad!) }
}

export interface CaseVerdict {
  kind: 'pass' | 'fail' | 'inconclusive'
  transitions: number
  /** transitions left inconclusive (fewer than three runs), and those three runs left inconclusive (they fail the case) */
  inconclusive: number
  unresolved: number
  /** p95 of n over the conclusive transitions, and the largest ms */
  p95n: number
  maxMs: number
  /** every n, pooled */
  ns: number[]
}

/** How many runs one transition gets before its inconclusive verdict fails the case (A3.8 #37). */
export const TRIES = 3

/**
 * One transition's verdict over its runs (A3.8 #37): the first conclusive one; three inconclusive ones are
 * `unresolved`, which fails the case - a retry never turns missing evidence into a pass. Fewer than three, all
 * inconclusive: still inconclusive (the caller runs it again).
 */
export function retried(tries: readonly TransitionVerdict[]): TransitionVerdict {
  const done = tries.find((v) => v.kind !== 'inconclusive')
  if (done) return done
  if (tries.length >= TRIES) return { kind: 'unresolved', why: `${tries.length} inconclusive runs: ${tries.map((v) => (v as { why: string }).why).join('; ')}` }
  return tries.at(-1) ?? { kind: 'inconclusive', why: 'not run' }
}

/**
 * A case over its transitions (A3.8 #36, #37): the p95 of `n` at most 2 and every `ms` at most 100 (exact: every n
 * 0). An `unresolved` transition (three inconclusive runs) fails the case; any transition still inconclusive (not
 * yet run three times) leaves it inconclusive; a blind one too.
 */
export function judgeCase(vs: readonly TransitionVerdict[], o: { exact?: boolean } = {}): CaseVerdict {
  const done = vs.filter((v): v is { kind: 'pass' | 'fail'; n: number; ms: number } => v.kind === 'pass' || v.kind === 'fail')
  const ns = done.map((v) => v.n).sort((a, b) => a - b)
  const p95n = ns.length ? ns[Math.min(ns.length - 1, Math.ceil(ns.length * 0.95) - 1)]! : 0
  const maxMs = done.reduce((m, v) => Math.max(m, v.ms), 0)
  const unresolved = vs.filter((v) => v.kind === 'unresolved').length
  const inconclusive = vs.length - done.length - unresolved
  const ok = o.exact ? ns.every((x) => x === 0) : p95n <= 2 && maxMs <= 100
  const kind = unresolved ? 'fail' : inconclusive || !done.length ? 'inconclusive' : ok ? 'pass' : 'fail'
  return { kind, transitions: vs.length, inconclusive, unresolved, p95n, maxMs, ns }
}
