/**
 * Mark a Flash as a transaction (spec 28 A3.3, A3.7, A3.8 #13, r1 #6), through fake ports and a fake clock: the
 * order (capture, written, pill, record), the record's two deadlines, the debounce from the last mark, a quit
 * mid-picture, a failed picture, the recorder off; and the pictures' folder.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgxReading, AppBody, RingEvent, Sample } from '../../../src/shared/app-perf.ts'
import { AGX_UNKNOWN, FLASH_WIDTH, flashId, flashTime, markFlash, pendingFlashes, pictureWriter, prunePictures, quitFlashes, resetFlashes, type FlashPorts } from '../../src/main/flashes.ts'
import { PictureRefused, type AppPicture } from '../../src/main/window.ts'

vi.mock('electron', () => ({ BaseWindow: class {}, View: class {}, WebContentsView: class {}, nativeImage: {}, nativeTheme: { shouldUseDarkColors: false, on() {} }, screen: {}, app: {} }))

const sample = (ts: number): Sample => ({ ts, mono: ts, dt: 5, procs: [], gpu: { pid: 9, born: 1, cpu: 0.01, gpuProcessRssMB: 80 }, pressure: null, thermal: 'nominal', sys: null, visible: null })
const AGX: AgxReading = { gpuSystemMemoryMB: 1121.8, allocMB: 7231.8, utilPct: 17, rendererPct: 10, tilerPct: 3, recoveryCount: 0, machineWide: true }
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

interface Rig {
  p: FlashPorts
  calls: string[]
  records: AppBody<'flash'>[]
  pills: { at: number; recorder: boolean; picture: string | null }[]
  events: RingEvent[]
  writes: string[]
  capture: { resolve(p: AppPicture): void; reject(e: unknown): void } | null
  agx: { resolve(a: AgxReading): void } | null
  recorder: boolean
  /** each writePicture's signal, and how to end a write held with writeMs 'never' */
  signals: (AbortSignal | undefined)[]
  finishWrite: (() => void) | null
}

function rig(o: { captureMs?: number | 'never' | 'fail'; agxMs?: number; writeFails?: boolean; writeMs?: 'never'; recorder?: boolean } = {}): Rig {
  const r: Rig = { calls: [], records: [], pills: [], events: [], writes: [], capture: null, agx: null, recorder: o.recorder ?? true, signals: [], finishWrite: null } as unknown as Rig
  r.p = {
    now: () => Date.now(),
    flavour: 'release',
    recorderOn: () => r.recorder,
    identity: () => ({ tab: 't1', ws: 'ab'.repeat(8), commit: 3, page: 'page-0001' }),
    ring: () => ({ samples: [sample(Date.now() - 5000)], events: [] }),
    stateNow: () => sample(Date.now()),
    gpuEvents: (from, to) => r.events.filter((e) => e.ts >= from && e.ts <= to),
    thermal: () => 'nominal',
    pressure: () => ({ level: 1, availablePct: 60, at: Date.now() }),
    featureStatus: () => ({ gpu_compositing: 'enabled' }),
    readAgx: () => new Promise((res) => {
      r.calls.push('agx:start')
      const done = (a: AgxReading) => { r.calls.push('agx:end'); res(a) }
      if (o.agxMs === undefined) { r.agx = { resolve: done }; setTimeout(() => done(AGX), 300) } else setTimeout(() => done(AGX), o.agxMs)
    }),
    capture: ({ width }) => new Promise((res, rej) => {
      r.calls.push(`capture:${width}`)
      const pic: AppPicture = { png: PNG, width, height: 300, scale: 0.375, layers: [] }
      r.capture = { resolve: res, reject: rej }
      if (o.captureMs === 'fail') setTimeout(() => rej(new PictureRefused('window hidden')), 50)
      else if (o.captureMs !== 'never') setTimeout(() => { r.calls.push('captured'); res(pic) }, o.captureMs ?? 100)
    }),
    writePicture: async (name, _png, signal) => {
      r.calls.push('write')
      r.writes.push(name)
      r.signals.push(signal)
      if (o.writeMs === 'never') await new Promise<void>((res) => { r.finishWrite = res })
      return o.writeFails ? { why: 'write failed' } : { path: `flashes/${name}` }
    },
    confirm: (c) => { r.calls.push('pill'); r.pills.push(c) },
    append: (b) => { r.calls.push('record'); r.records.push(b) },
  }
  return r
}

const T0 = Date.UTC(2026, 9, 23, 20, 51, 3, 412)
beforeEach(() => { vi.useFakeTimers({ now: T0 }); resetFlashes() })
afterEach(() => { quitFlashes(); vi.useRealTimers() })

describe('the transaction, in its order (A3.8 #13)', () => {
  it('capture, then the picture written, then the pill; the record once the picture, the AGX read and the +1 s window have ended', async () => {
    const r = rig()
    const done = markFlash('key', r.p)
    await vi.advanceTimersByTimeAsync(150)
    expect(r.calls).toEqual(['agx:start', `capture:${FLASH_WIDTH}`, 'captured', 'write', 'pill'])
    expect(r.records).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(800)   // +950 ms: the GPU window still open
    expect(r.records).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(100)
    await done
    expect(r.calls.at(-1)).toBe('record')
    const rec = r.records[0]!
    expect(rec).toMatchObject({ tab: 't1', commit: 3, page: 'page-0001', via: 'key', recorder: true, agx: AGX, thermal: 'nominal', featureStatus: { gpu_compositing: 'enabled' } })
    expect(rec.picture).toBe(`flashes/${flashId(T0, 'release', rec.id.split('-')[3])}.png`)
    expect(rec.pictureWhy).toBeUndefined()
    expect(rec.ring?.samples).toHaveLength(1)
    expect(rec.now.gpu?.gpuProcessRssMB).toBe(80)
    expect(r.pills[0]).toEqual({ at: T0, recorder: true, picture: rec.picture })
  })

  it('a 1.8 s picture: the pill after it, the record after it too (past mark + 1 s)', async () => {
    const r = rig({ captureMs: 1800 })
    const done = markFlash('menu', r.p)
    await vi.advanceTimersByTimeAsync(1200)
    expect(r.pills).toHaveLength(0)
    expect(r.records).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(700)
    await done
    expect(r.calls).toEqual(['agx:start', `capture:${FLASH_WIDTH}`, 'agx:end', 'captured', 'write', 'pill', 'record'])
    expect(r.records[0]!.picture).toMatch(/^flashes\/.+\.png$/)
  })

  it('the record waits for a slow AGX read (2 s at most), whatever the picture did', async () => {
    const r = rig({ agxMs: 1900 })
    const done = markFlash('key', r.p)
    await vi.advanceTimersByTimeAsync(1500)
    expect(r.pills).toHaveLength(1)
    expect(r.records).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(500)
    await done
    expect(r.records[0]!.agx).toEqual(AGX)
  })

  it('the GPU events from 1 s before the mark to 1 s after it, whenever the record is written', async () => {
    const r = rig()
    r.events.push({ kind: 'child-gone', ts: T0 - 500 }, { kind: 'child-gone', ts: T0 - 1500 })
    const done = markFlash('key', r.p)
    await vi.advanceTimersByTimeAsync(600)
    r.events.push({ kind: 'gpu-restart', ts: Date.now() })
    await vi.advanceTimersByTimeAsync(800)
    r.events.push({ kind: 'gpu', ts: Date.now() })   // +1.4 s: after the window
    await done
    expect(r.records[0]!.gpuEvents.map((e) => e.ts - T0)).toEqual([-500, 600])
  })
})

describe('the debounce, from the last mark (A3.8 #13.1)', () => {
  it('a press at +1.5 s does nothing - no capture, no record, no pill; one at +2.1 s marks', async () => {
    const r = rig()
    void markFlash('key', r.p)
    await vi.advanceTimersByTimeAsync(1500)
    const before = r.calls.length
    await markFlash('key', r.p)
    expect(r.calls.slice(before)).toEqual([])
    expect(r.pills).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(600)   // +2.1 s
    void markFlash('key', r.p)
    await vi.advanceTimersByTimeAsync(1100)
    expect(r.pills).toHaveLength(2)
    expect(r.records).toHaveLength(2)
    expect(r.records[0]!.id).not.toBe(r.records[1]!.id)
  })

  it('on the monotonic clock: a wall clock stepped back an hour after a mark never blocks the next one (minor #14)', async () => {
    const r = rig()
    // the wall clock: an hour back after the first mark; the monotonic one runs on
    let back = 0
    r.p = { ...r.p, now: () => Date.now() - back, mono: () => Date.now() }
    void markFlash('key', r.p)
    await vi.advanceTimersByTimeAsync(1200)
    back = 3_600_000
    await vi.advanceTimersByTimeAsync(1000)   // +2.2 s on the monotonic clock, -59 min on the wall
    void markFlash('key', r.p)
    await vi.advanceTimersByTimeAsync(1100)
    expect(r.pills).toHaveLength(2)
    expect(r.records).toHaveLength(2)
    // and the record waited its 1 s on the monotonic clock, not until the wall clock caught up
    expect(pendingFlashes()).toBe(0)
  })

  it('the mark\'s time is in its id (the envelope\'s ts is when the record was written)', () => {
    expect(flashTime(flashId(T0, 'release', 'ab12'))).toBe(T0)
    expect(flashTime(flashId(T0, 'dev', 'ab12'))).toBe(T0)
    expect(flashTime('not-an-id')).toBeNull()
  })

  it('counted from the last mark, not the last press: presses every second mark every other one', async () => {
    const r = rig()
    for (let i = 0; i < 6; i++) { void markFlash('key', r.p); await vi.advanceTimersByTimeAsync(1000) }
    await vi.advanceTimersByTimeAsync(2000)
    expect(r.records).toHaveLength(3)
  })
})

describe('a quit, a failed picture, the recorder off', () => {
  it('a quit mid-picture writes the record at once, naming no picture (pictureWhy quit), and the picture is never written later', async () => {
    const r = rig({ captureMs: 'never', agxMs: 5000 })
    const done = markFlash('key', r.p)
    await vi.advanceTimersByTimeAsync(300)
    expect(pendingFlashes()).toBe(1)
    quitFlashes()
    expect(r.records).toHaveLength(1)
    expect(r.records[0]).toMatchObject({ picture: null, pictureWhy: 'quit', agx: AGX_UNKNOWN })
    r.capture!.resolve({ png: PNG, width: 480, height: 300, scale: 1, layers: [] })
    await vi.advanceTimersByTimeAsync(5000)
    await done
    expect(r.writes).toEqual([])
    expect(r.pills).toHaveLength(0)
    expect(r.records).toHaveLength(1)
  })

  it('a quit while the picture is written cancels its publication: the writer\'s signal aborted, the record naming no picture, no pill (code review r1 #5)', async () => {
    const r = rig({ writeMs: 'never', agxMs: 5000 })
    const done = markFlash('key', r.p)
    await vi.advanceTimersByTimeAsync(150)   // captured at 100 ms: the write under way
    expect(r.calls).toContain('write')
    expect(r.signals[0]).toBeInstanceOf(AbortSignal)
    expect(r.signals[0]!.aborted).toBe(false)
    quitFlashes()
    expect(r.signals[0]!.aborted).toBe(true)
    expect(r.records).toHaveLength(1)
    expect(r.records[0]).toMatchObject({ picture: null, pictureWhy: 'quit' })
    r.finishWrite!()   // the writer answers late: nothing more
    await vi.advanceTimersByTimeAsync(5000)
    await done
    expect(r.pills).toHaveLength(0)
    expect(r.records).toHaveLength(1)
  })

  it('a mark that ends without a quit never aborts its writer', async () => {
    const r = rig()
    const done = markFlash('key', r.p)
    await vi.advanceTimersByTimeAsync(1100)
    await done
    quitFlashes()
    expect(r.signals[0]!.aborted).toBe(false)
  })

  it('a quit after the picture keeps it, with the GPU events so far', async () => {
    const r = rig({ agxMs: 5000 })
    const done = markFlash('key', r.p)
    await vi.advanceTimersByTimeAsync(400)
    r.events.push({ kind: 'child-gone', ts: Date.now() })
    quitFlashes()
    await done
    expect(r.records).toHaveLength(1)
    expect(r.records[0]!.picture).toMatch(/^flashes\//)
    expect(r.records[0]!.pictureWhy).toBeUndefined()
    expect(r.records[0]!.agx).toEqual(AGX_UNKNOWN)
    expect(r.records[0]!.gpuEvents).toHaveLength(1)
  })

  it('a failed capture still leaves a mark, and a pill with no button (no picture)', async () => {
    const r = rig({ captureMs: 'fail' })
    const done = markFlash('key', r.p)
    await vi.advanceTimersByTimeAsync(1100)
    await done
    expect(r.pills).toEqual([{ at: T0, recorder: true, picture: null }])
    expect(r.records[0]).toMatchObject({ picture: null, pictureWhy: 'window hidden' })
    expect(r.writes).toEqual([])
  })

  it('a picture past 2 s is a timeout, never written; a write that fails is `write failed`', async () => {
    const r = rig({ captureMs: 'never' })
    const done = markFlash('key', r.p)
    await vi.advanceTimersByTimeAsync(2001)
    await done
    expect(r.records[0]).toMatchObject({ picture: null, pictureWhy: 'timeout' })
    expect(r.pills[0]!.picture).toBeNull()
    r.capture!.resolve({ png: PNG, width: 480, height: 300, scale: 1, layers: [] })
    await vi.advanceTimersByTimeAsync(10)
    expect(r.writes).toEqual([])

    await vi.advanceTimersByTimeAsync(2000)
    const w = rig({ writeFails: true })
    const d2 = markFlash('key', w.p)
    await vi.advanceTimersByTimeAsync(1100)
    await d2
    expect(w.records[0]).toMatchObject({ picture: null, pictureWhy: 'write failed' })
    expect(w.pills[0]!.picture).toBeNull()
  })

  it('with the recorder off: no history (ring null), the state at the mark, and the pill says so', async () => {
    const r = rig({ recorder: false })
    const done = markFlash('key', r.p)
    await vi.advanceTimersByTimeAsync(1100)
    await done
    expect(r.records[0]!.ring).toBeNull()
    expect(r.records[0]!.recorder).toBe(false)
    expect(r.records[0]!.now.ts).toBe(T0)
    expect(r.pills[0]!.recorder).toBe(false)
  })
})

describe('the ids and the pictures\' folder', () => {
  it('an id sorts by time, has no colon, and says -dev in Marver Dev', () => {
    expect(flashId(T0, 'release', 'ab12')).toBe('20261023-205103-412-ab12')
    expect(flashId(T0, 'dev', 'ab12')).toBe('20261023-205103-412-ab12-dev')
  })

  it('pictureWriter writes whole under perf/flashes (700, files 600) and keeps the newest 50', async () => {
    vi.useRealTimers()
    const perf = mkdtempSync(join(tmpdir(), 'mvflash-'))
    const write = pictureWriter(perf)
    const res = await write('20261023-205103-412-ab12.png', PNG)
    expect(res).toEqual({ path: 'flashes/20261023-205103-412-ab12.png' })
    expect(statSync(join(perf, 'flashes')).mode & 0o777).toBe(0o700)
    expect(statSync(join(perf, 'flashes', '20261023-205103-412-ab12.png')).mode & 0o777).toBe(0o600)
    expect(await write('../evil.png', PNG)).toEqual({ why: 'write failed' })
    // the home not writable (the recorder's guard, minor #4): nothing written
    const ro = mkdtempSync(join(tmpdir(), 'mvflash-ro-'))
    expect(await pictureWriter(ro, () => false)('20261023-205103-412-cd34.png', PNG)).toEqual({ why: 'write failed' })
    expect(readdirSync(ro)).toEqual([])
    const dir = join(perf, 'flashes')
    for (let i = 0; i < 55; i++) {
      const f = join(dir, `old-${String(i).padStart(2, '0')}.png`)
      writeFileSync(f, PNG)
      const t = new Date(Date.now() - (100 - i) * 1000)
      utimesSync(f, t, t)
    }
    const gone = prunePictures(dir, '20261023-205103-412-ab12.png')
    expect(readdirSync(dir)).toHaveLength(50)
    expect(gone).toHaveLength(6)
    expect(readdirSync(dir)).toContain('20261023-205103-412-ab12.png')
    expect(gone).toContain('old-00.png')
  })

  it('pictureWriter: a quit while the file is written publishes nothing and leaves no temporary file (code review r1 #5)', async () => {
    vi.useRealTimers()
    const perf = mkdtempSync(join(tmpdir(), 'mvflash-quit-'))
    const ac = new AbortController()
    const big = Buffer.alloc(64 << 20, 7)   // long enough to be caught writing
    const w = pictureWriter(perf)('20261023-205103-412-ab12.png', big, ac.signal)
    const dir = join(perf, 'flashes')
    const until = Date.now() + 5000
    while (!(existsSync(dir) && readdirSync(dir).some((n) => n.endsWith('.tmp'))) && Date.now() < until) await new Promise((r) => setImmediate(r))
    expect(readdirSync(dir).some((n) => n.endsWith('.tmp'))).toBe(true)   // writing
    ac.abort()
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])   // removed in the quit's own turn
    expect(await w).toEqual({ why: 'quit' })
    expect(readdirSync(dir)).toEqual([])
    // aborted before it began: nothing made at all
    const ac2 = new AbortController(); ac2.abort()
    expect(await pictureWriter(perf)('20261023-205103-412-cd34.png', PNG, ac2.signal)).toEqual({ why: 'quit' })
    expect(readdirSync(dir)).toEqual([])
  })

  it('retention removes a temporary picture abandoned over a minute ago (a quit that ended the process mid-write), never a fresh one (code review r1 #5)', () => {
    vi.useRealTimers()
    const dir = join(mkdtempSync(join(tmpdir(), 'mvflash-tmp-')), 'flashes')
    mkdirSync(dir)
    const stale = '20261023-205103-412-ab12.png.0123456789ab.tmp'
    const fresh = '20261023-205104-412-cd34.png.abcdefabcdef.tmp'
    writeFileSync(join(dir, stale), PNG)
    writeFileSync(join(dir, fresh), PNG)
    writeFileSync(join(dir, 'notes.tmp'), 'not ours')
    const t = new Date(Date.now() - 120_000)
    utimesSync(join(dir, stale), t, t)
    utimesSync(join(dir, 'notes.tmp'), t, t)
    const gone = prunePictures(dir)
    expect(gone).toContain(stale)
    expect(readdirSync(dir).sort()).toEqual([fresh, 'notes.tmp'].sort())
  })
})
