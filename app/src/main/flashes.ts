/**
 * Mark a Flash (spec 28 A3.3, A3.8 #13, #14): ⌃⌥F on any view, or Help > Mark a Flash. Owner: the flash stream; the
 * recorder stream supplies its ports. A transaction, in this order:
 * 1. the 2 s debounce is reserved at once, counted from the last mark: a press inside it does nothing (no new pill
 *    `rev`);
 * 2. in the same turn: the mark's id, the active tab's identity, the ring (only with the recorder on), the state now
 *    (one `getAppMetrics()`), the GPU events of the second before, thermal state, pressure and feature status; the
 *    AGX read starts now, beside the picture;
 * 3. the picture - a reconstructed app-content picture, 480 px wide (`captureApp`), 2 s at most - then written
 *    (mode 600) to `perf/flashes/<id>.png` (at most 50 kept);
 * 4. only then the pill "Flash marked", its Show bound to that picture (`showItemInFolder`); no picture, no button;
 * 5. the record, once the picture settled, the AGX read ended and the GPU-event window closed at mark + 1 s. At a
 *    quit an unfinished mark is written at once with what it has (`pictureWhy: 'quit'`, AGX 'unknown').
 * With the recorder off the mark carries no history, and the pill adds "no samples before it: the recorder is off".
 *
 * FROZEN (A3.8 #53): `FlashPorts`, `markFlash`, `quitFlashes`. Where each port comes from: `capture` is window.ts's
 * `captureApp`, `writePicture` this file's `pictureWriter(perfDir)`, `confirm` pill.ts's `flashMarked`; the rest are
 * the recorder's (its ring and its sampler, `recorder.gpuEvents`, pressure.ts, machine.ts's `readAgx`, perflog.ts's
 * `append`). Pure but for node:fs in `pictureWriter`: unit-tested through fake ports.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { AgxReading, AppBody, Flavour, PictureWhy, PressureReading, RingEvent, Sample, TabIdent, ThermalState } from '../../../src/shared/app-perf.ts'
import { writeWhole } from './fsx.ts'
import { AGX_UNKNOWN } from './machine.ts'
import { T } from './timings.ts'
import type { AppPicture } from './window.ts'

/** The picture's width, px, and how many pictures are kept (both flavours). */
export const FLASH_WIDTH = 480
export const FLASH_PICTURES_KEPT = 50

/** What a mark needs of the recorder and the window (the recorder stream builds these). */
export interface FlashPorts {
  now(): number
  flavour: Flavour
  recorderOn(): boolean
  /** the active local tab's identity, in this turn; null on Home, Settings or with no canvas */
  identity(): TabIdent | null
  /** the ring (A3.8 #7): the last 12 samples and 60 s of events; null with the recorder off */
  ring(): { samples: Sample[]; events: RingEvent[] } | null
  /** one getAppMetrics() now, on the sampler's baselines (the GPU process's gpuProcessRssMB in it) */
  stateNow(): Sample
  /** GPU process events of the ring between two times (gone, child-gone, gpu-restart, gpu), also those still to come */
  gpuEvents(from: number, to: number): RingEvent[]
  thermal(): ThermalState
  pressure(): PressureReading | null
  featureStatus(): Record<string, string>
  readAgx(timeoutMs: number): Promise<AgxReading>
  /** window.ts captureApp */
  capture(o: { width: number }): Promise<AppPicture>
  /** written whole, mode 600, under perf/flashes: the path relative to perf/, or why not */
  writePicture(name: string, png: Buffer): Promise<{ path: string } | { why: PictureWhy }>
  /** the strip's pill (pill.ts confirm 'flash'), with Show only for a picture */
  confirm(c: { at: number; recorder: boolean; picture: string | null }): void
  /** perflog.ts append */
  append(body: AppBody<'flash'>): void
}

/** AGX figures nobody read (the read failed, timed out, or the quit came first): machine.ts's. */
export { AGX_UNKNOWN }

const WHYS = new Set<PictureWhy>(['window hidden', 'timeout', 'empty', 'write failed', 'quit', 'no window'])
/** A capture's refusal as a PictureWhy (captureApp throws an Error carrying `why`); anything else is 'empty'. */
export const whyOf = (e: unknown): PictureWhy => {
  const w = (e as { why?: unknown } | null)?.why
  return typeof w === 'string' && WHYS.has(w as PictureWhy) ? w as PictureWhy : 'empty'
}

/** `20261023-205103-412-ab12` (`-dev` in Marver Dev): sortable, no colon, unique enough for a person's marks. */
export function flashId(now: number, flavour: Flavour, rand = randomBytes(2).toString('hex')): string {
  const d = new Date(now)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}`
  return `${stamp}-${rand}${flavour === 'dev' ? '-dev' : ''}`
}

/** One mark in flight: what it took in its turn, what it has so far, and how to end it now. */
interface Mark {
  done: boolean
  /** resolves the mark's waits at a quit */
  quit: () => void
  write: (o: { quit: boolean }) => void
}
const marks = new Set<Mark>()
/** the last mark's time: the debounce counts from it, never from a press that marked nothing */
let lastMark: number | null = null

/** Test seam. */
export function resetFlashes(): void { lastMark = null; marks.clear() }

/** runCommand('mark-flash'), through the recorder's port. Resolves once the record is written (or the quit wrote it). */
export async function markFlash(via: 'key' | 'menu', p: FlashPorts): Promise<void> {
  // 1. the debounce, reserved at once
  const at = p.now()
  if (lastMark !== null && at - lastMark < T.flashDebounceMs) return
  lastMark = at

  // 2. everything of the moment, in this turn
  const id = flashId(at, p.flavour)
  const ident = p.identity()
  const recorder = p.recorderOn()
  const ring = recorder ? p.ring() : null
  let now: Sample
  try { now = p.stateNow() } catch { now = emptySample(at) }
  const thermal = safe(() => p.thermal(), 'unknown' as ThermalState)
  const pressure = safe(() => p.pressure(), null)
  const featureStatus = safe(() => p.featureStatus(), {} as Record<string, string>)
  let agx: AgxReading | null = null
  let agxRead: Promise<void>
  try { agxRead = p.readAgx(T.spawnTimeoutMs).then((a) => { agx = a }, () => { agx = AGX_UNKNOWN }) } catch { agx = AGX_UNKNOWN; agxRead = Promise.resolve() }
  let picture: string | null = null
  let pictureWhy: PictureWhy | undefined
  let pictureSettled = false

  let quitNow!: () => void
  const quitting = new Promise<'quit'>((r) => { quitNow = () => r('quit') })
  const m: Mark = {
    done: false,
    quit: () => quitNow(),
    write(o) {
      if (m.done) return
      m.done = true
      marks.delete(m)
      if (o.quit && !pictureSettled) { picture = null; pictureWhy = 'quit' }
      p.append({
        ...(ident ?? {}), id, via, recorder, ring, now,
        gpuEvents: safe(() => p.gpuEvents(at - T.flashGpuWindowMs, at + T.flashGpuWindowMs), [] as RingEvent[]),
        thermal, pressure, featureStatus, agx: agx ?? AGX_UNKNOWN, picture,
        ...(pictureWhy ? { pictureWhy } : {}),
      })
    },
  }
  marks.add(m)

  // 3. the picture, 2 s at most, then its file - before anything of the confirmation exists
  const shot = await Promise.race([
    Promise.resolve().then(() => p.capture({ width: FLASH_WIDTH })).then((pic) => ({ pic }), (e: unknown) => ({ why: whyOf(e) })),
    wait(T.flashPictureMs).then(() => ({ why: 'timeout' as const })),
    quitting,
  ])
  if (shot === 'quit' || m.done) { m.write({ quit: true }); return }
  if ('why' in shot) pictureWhy = shot.why
  else if (!shot.pic.png?.length) pictureWhy = 'empty'
  else {
    const wrote = await Promise.race([Promise.resolve().then(() => p.writePicture(`${id}.png`, shot.pic.png)).catch((): { why: PictureWhy } => ({ why: 'write failed' })), quitting])
    // a quit while the file was written: the record names no picture (a file that landed is pruned later)
    if (wrote === 'quit' || m.done) { m.write({ quit: true }); return }
    if ('path' in wrote) picture = wrote.path
    else pictureWhy = wrote.why
  }
  pictureSettled = true

  // 4. the pill, now that the picture is on disk (or is not, and says nothing of a picture)
  try { p.confirm({ at, recorder, picture }) } catch { /* the strip is going: the record still lands */ }

  // 5. the record: the AGX read ended and the GPU-event window closed at mark + 1 s
  const left = at + T.flashGpuWindowMs - p.now()
  await Promise.race([Promise.all([agxRead, left > 0 ? wait(left) : Promise.resolve()]), quitting])
  m.write({ quit: false })
}

/** `will-quit`, before the writer's flush: every unfinished mark written now with what it has. */
export function quitFlashes(): void {
  for (const m of [...marks]) { m.write({ quit: true }); m.quit() }
}

/** The marks not yet written (tests). */
export const pendingFlashes = (): number => marks.size

const wait = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, Math.max(0, ms)); (t as { unref?: () => void }).unref?.() })
function safe<V>(f: () => V, fallback: V): V { try { return f() } catch { return fallback } }
function emptySample(at: number): Sample {
  return { ts: at, mono: 0, dt: null, procs: [], gpu: null, pressure: null, thermal: 'unknown', sys: null, visible: null }
}

// ---------------------------------------------------------------------------------------------------------------
// The pictures' folder: perf/flashes, 700; each picture written whole, 600; the newest 50 kept (both flavours)

/** The `writePicture` port over `<perfDir>/flashes`. Never throws: a failure is `write failed`. */
export function pictureWriter(perfDir: string): FlashPorts['writePicture'] {
  return async (name, png) => {
    if (!/^[0-9a-z-]+\.png$/.test(name)) return { why: 'write failed' }
    const dir = join(perfDir, 'flashes')
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      chmodSync(dir, 0o700)
      await writeWhole(join(dir, name), png, 0o600)
    } catch { return { why: 'write failed' } }
    prunePictures(dir, name)
    return { path: `flashes/${name}` }
  }
}

/** Keep the newest FLASH_PICTURES_KEPT pictures, never the one just written; a file already gone is no error. */
export function prunePictures(dir: string, keep?: string, max = FLASH_PICTURES_KEPT): string[] {
  let files: { name: string; t: number }[]
  try {
    files = readdirSync(dir).filter((n) => n.endsWith('.png')).map((name) => {
      try { return { name, t: statSync(join(dir, name)).mtimeMs } } catch { return { name, t: -1 } }
    }).filter((f) => f.t >= 0)
  } catch { return [] }
  files.sort((a, b) => b.t - a.t || (a.name < b.name ? 1 : -1))
  const gone: string[] = []
  for (const f of files.slice(max)) {
    if (f.name === keep) continue
    try { unlinkSync(join(dir, f.name)); gone.push(f.name) } catch { /* gone already */ }
  }
  return gone
}
