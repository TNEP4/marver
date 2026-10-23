/**
 * The capture harness (spec 28 A3.8 #34-#38, #50): what WindowServer composited for the app's window at each
 * refresh, read by `test/native/capture.swift` (ScreenCaptureKit, a window or a display stream) and judged here
 * against main's journal (testing/index.ts `JournalTopics`: both clocks are mach_absolute_time; a control case
 * checks that they line up). Owner: the flash and native acceptance stream; the one-ground stream reads its matrix.
 *
 * **Screen Recording is the runner's** (A3.8 #37): the helper checks `CGPreflightScreenCaptureAccess()` and exits 77
 * when it is not granted - reported as **blind**, not run, never passed, naming the app that needs the permission
 * (the terminal or agent running the suite). The app itself never asks for Screen Recording (A2.12).
 *
 * The helper's stdout, one JSON line each (FROZEN, A3.8 #53): first `{ ready: { hostNs, refreshHz, scale } }`, then
 * per frame `{ hostNs, status: 'complete' | 'idle' | 'blank' | 'suspended' | 'started' | 'stopped', gap?, detect? }`.
 * Added by the native stream (optional, so the frozen reader is unchanged): `ready.window` (the stream's size in
 * points), a frame's `regions` (the samples of each named region, `--regions`) and its first `info`. A run is
 * conclusive only if every sample is `complete` or `idle` and display times stay within 1.5 refreshes; an
 * inconclusive transition is run again, and three fail the case.
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

/** Raised by startCapture when the helper exits 77: report the case as blind, never as a pass. */
export class CaptureBlind extends Error {
  readonly needs: string
  constructor(needs: string) { super(`blind: Screen Recording is not granted to ${needs}`); this.needs = needs }
}

/** Whether the helper may record the screen here: true, or the app that needs the permission. */
export async function captureAccess(): Promise<true | { needs: string }> {
  const bin = nativeTool('capture')
  try { await promisify(execFile)(bin, ['check'], { timeout: 10_000 }); return true } catch (e) {
    if ((e as { code?: number }).code === CAPTURE_BLIND) return { needs: responsibleApp() }
    throw e
  }
}

export interface CaptureSession {
  /** the helper's first line */
  ready: CaptureReady
  /** every line after it, as it comes (frames and the helper's own) */
  lines: AsyncIterable<CaptureLine>
  /** every frame so far, in arrival order */
  frames: CaptureFrame[]
  /** write the last complete frame as a PNG (a failing case's evidence) */
  png(path: string): Promise<void>
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
}): Promise<CaptureSession> {
  const bin = nativeTool('capture')
  const args: string[] = [o.mode]
  if (o.windowId !== undefined) args.push('--window-id', String(o.windowId))
  if (o.detect) args.push('--detect', `${o.detect.hex.replace(/^#/, '')}:${o.detect.minPx}:${o.detect.belowY}`)
  if (o.regions) args.push('--regions', Object.entries(o.regions).map(([n, r]) => `${n}:${r.x},${r.y},${r.w},${r.h}`).join(';'))
  if (o.grid) args.push('--grid', `${o.grid[0]}x${o.grid[1]}`)
  if (o.fps) args.push('--fps', String(o.fps))
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  let err = ''
  child.stderr.on('data', (c) => { err += c })
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))
  const frames: CaptureFrame[] = []
  const waiting: ((l: CaptureLine | null) => void)[] = []
  const queue: (CaptureLine | null)[] = []
  let ready: CaptureReady | undefined
  let onReady: ((r: CaptureReady) => void) | undefined
  let pngDone: (() => void) | undefined
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (l) => {
    let x: unknown
    try { x = JSON.parse(l) } catch { return }
    const line = x as CaptureLine & { png?: string }
    if (line.png) { pngDone?.(); return }
    if ('ready' in line) { ready = line.ready; onReady?.(line.ready); return }
    frames.push(line)
    const w = waiting.shift()
    if (w) w(line); else queue.push(line)
  })
  rl.on('close', () => { const w = waiting.shift(); if (w) w(null); else queue.push(null) })
  const first = await Promise.race([
    new Promise<CaptureReady>((r) => { onReady = r }),
    exited.then((code) => code),
  ])
  if (typeof first !== 'object' || first === null) {
    if (first === CAPTURE_BLIND) throw new CaptureBlind(responsibleApp())
    throw new Error(`capture.swift exited ${first}: ${err.trim()}`)
  }
  const lines: AsyncIterable<CaptureLine> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const q = queue.shift()
        if (q !== undefined) return Promise.resolve(q ? { value: q, done: false } : { value: undefined, done: true })
        return new Promise((r) => waiting.push((l) => r(l ? { value: l, done: false } : { value: undefined, done: true })))
      },
    }),
  }
  return {
    ready: ready!, lines, frames,
    png: (path) => new Promise<void>((r) => { pngDone = r; child.stdin.write(`png ${path}\n`); setTimeout(r, 3000) }),
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
 * pass: a sample neither complete nor idle, display times more than 1.5 refreshes apart (the frame before `t0`
 * included), no frame at all, or a bad interval with no verified good frame after it.
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
  let i = frames.findIndex((f) => ns(f) >= o.t0)
  if (i < 0) return { kind: 'inconclusive', why: 'no frame after the decision' }
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
    if (prevNs !== null && Number(ns(f) - prevNs) > refreshNs * 1.5) return { kind: 'inconclusive', why: `display times ${(Number(ns(f) - prevNs) / 1e6).toFixed(1)} ms apart` }
    prevNs = ns(f)
    seen++
    const v = f.status === 'complete' ? o.verdict(f) : carried
    if (v === null) return { kind: 'inconclusive', why: 'an idle sample with no frame before it' }
    carried = v
    if (v === 'bad') { n++; if (firstBad === null) firstBad = ns(f); goodAfterBad = null }
    else if (f.status === 'complete' && firstBad !== null && goodAfterBad === null) goodAfterBad = ns(f)
  }
  if (!seen) return { kind: 'inconclusive', why: 'no frame inside the transition' }
  if (prevNs !== null && Number(o.t1 - prevNs) > refreshNs * 1.5 && i >= frames.length) return { kind: 'inconclusive', why: 'the stream ended inside the transition' }
  if (n === 0) return { kind: 'pass', n: 0, ms: 0 }
  if (goodAfterBad === null) {
    // still bad at the window's end, seen without a gap: more bad refreshes than allowed is a fail on what was seen
    // (ms then a lower bound); fewer is missing evidence, never a pass
    if (n > (o.maxN ?? 2)) return { kind: 'fail', n, ms: Math.round(Number(prevNs! - firstBad!) / 1e5) / 10 }
    return { kind: 'inconclusive', why: 'no verified good frame after the bad interval' }
  }
  const ms = Number(goodAfterBad - firstBad!) / 1e6
  const ok = n <= (o.maxN ?? 2) && ms <= (o.maxMs ?? 100)
  return { kind: ok ? 'pass' : 'fail', n, ms: Math.round(ms * 10) / 10 }
}

export interface CaseVerdict {
  kind: 'pass' | 'fail' | 'inconclusive'
  transitions: number
  inconclusive: number
  /** p95 of n over the conclusive transitions, and the largest ms */
  p95n: number
  maxMs: number
  /** every n, pooled */
  ns: number[]
}

/**
 * A case over its transitions (A3.8 #36): the p95 of `n` at most 2 and every `ms` at most 100 (exact: every n 0).
 * Any inconclusive transition leaves the case inconclusive unless the caller re-ran it (three fail the case).
 */
export function judgeCase(vs: readonly TransitionVerdict[], o: { exact?: boolean } = {}): CaseVerdict {
  const done = vs.filter((v): v is { kind: 'pass' | 'fail'; n: number; ms: number } => v.kind === 'pass' || v.kind === 'fail')
  const ns = done.map((v) => v.n).sort((a, b) => a - b)
  const p95n = ns.length ? ns[Math.min(ns.length - 1, Math.ceil(ns.length * 0.95) - 1)]! : 0
  const maxMs = done.reduce((m, v) => Math.max(m, v.ms), 0)
  const inconclusive = vs.length - done.length
  const ok = o.exact ? ns.every((x) => x === 0) : p95n <= 2 && maxMs <= 100
  return { kind: inconclusive || !done.length ? 'inconclusive' : ok ? 'pass' : 'fail', transitions: vs.length, inconclusive, p95n, maxMs, ns }
}
