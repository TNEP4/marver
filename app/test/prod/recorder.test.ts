/**
 * The recorder on the real binary (spec 28 A3.7, A3.8 #4-#12), with the production switches and the trust stream's
 * real bridge and canvas preload: a fake canvas that says hello with its page. Marver Dev writes app-dev.jsonl. The
 * sampler's tick and the minute on disk are shortened (MARVER_APP_TIMINGS: the rules, not the durations, are under
 * test here; the 5 s and 60 s run in the release).
 *
 * - retention at launch: a home seeded with a 20-day-old line, 51 pictures and 11 completed Crashpad reports is
 *   pruned before the first sample line (which must exist);
 * - the start line names the machine profile, whose file has every field filled or 'unknown', collected in under
 *   50 ms of main-thread work - every step of the launch's collection counted, the spawns' too; the start line was
 *   written within the launch's first second, held, and stamped with that hash when its file existed (the hold
 *   ended by the hash: `recorder:flush` never ends it);
 * - samples: each `(pid, born)` once; RSS as Electron said it - the sample a tick published against what that tick's
 *   own getAppMetrics() returned (KB / 1024), and the minute on disk against the last tick it folded; the canvas
 *   renderer named for its tab, the app pages by role, the GPU process apart; the visible tab's preload answers its
 *   memory, whose `private` is within 10 % of `footprint -p` read from outside within a second of it (A3.8 #5);
 * - a tab switch writes `shown` with its time;
 * - a killed renderer writes `gone` with `tab`, `ws`, `commit` and the page its hello sent, not ours;
 * - `recorder: false` set live: no sample line, getAppMetrics no longer called by anything (every call is counted
 *   through one wrapper); memory.ts wanting it: called again, still nothing on disk;
 * - the GPU process killed: `child-gone { type: 'GPU', reason: 'killed' }`, then a sample with a new GPU process.
 * Needs the trust stream's bridge and preload built in (on a branch without them the cases that need a document
 * are skipped and say so).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'
import { startFakeCanvas, type FakeCanvas } from '../harness/fake-canvas.ts'
import { parseAppLine, type AppRecord, type Sample } from '../../../src/shared/app-perf.ts'
import type { RawMetric } from '../../src/main/recorder.ts'

const DAY = 86_400_000
const TIMINGS = { sampleMs: 500, sampleDiskMs: 3000, writeBatchMs: 250, agxMs: 1500, memServesMs: 3000, retentionDelayMs: 200 }
const PAGE1 = 'rec0page0001', PAGE2 = 'rec0page0002'
const HELLO = (page: string) => `var ma = window.marverApp; if (ma) { ma.hello({ version: '0.27.2', board: 'main', page: '${page}' }); ma.busy({ busy: false, unsaved: false, why: [] }) } say('script');`

let w: WindowRun
let real = false
const fakes: FakeCanvas[] = []
let seededAt = 0

beforeAll(async () => {
  w = await launchWindow('prod', {
    extraEnv: { MARVER_APP_FAKE_TRUST: '0', MARVER_APP_TIMINGS: JSON.stringify(TIMINGS) },
    prepare: async (env) => {
      // retention's fixtures, before the first launch (A3.8 #12)
      const perf = join(env.home, 'perf')
      for (const d of ['flashes', 'crashpad/completed', 'machine']) mkdirSync(join(perf, d), { recursive: true })
      seededAt = Date.now()
      const old = JSON.stringify({ v: 1, ts: seededAt - 20 * DAY, kind: 'dropped', app: 'aaaaaaaaaaaa', seq: 0, flavour: 'dev', machine: null, n: 1 })
      writeFileSync(join(perf, 'app-dev.jsonl'), old + '\n', { mode: 0o600 })
      const age = (p: string, ms: number) => { const t = new Date(seededAt - ms); utimesSync(p, t, t) }
      for (let i = 0; i < 51; i++) { const p = join(perf, 'flashes', `seed-${String(i).padStart(2, '0')}.png`); writeFileSync(p, 'x'); age(p, (60 - i) * 60_000) }
      for (let i = 0; i < 11; i++) { const p = join(perf, 'crashpad', 'completed', `${String(i).padStart(8, '0')}-1111-2222-3333-444444444444.dmp`); writeFileSync(p, 'x'); age(p, (20 - i) * 3600_000) }
      return {}
    },
  })
  real = (await w.run.call<string[]>('hooks')).includes('trust:admit-delay')
  if (!real) process.stdout.write('recorder: INCONCLUSIVE - the trust stream\'s bridge and preload are not built in; the document cases are skipped\n')
}, 60_000)
afterAll(async () => {
  for (const f of fakes) await f.close().catch(() => {})
  await w?.close()
})

const file = () => join(w.env.home, 'perf', 'app-dev.jsonl')
const lines = async (): Promise<AppRecord[]> => {
  await w.run.call('recorder:flush')
  return existsSync(file()) ? readFileSync(file(), 'utf8').split('\n').filter(Boolean).map((l) => parseAppLine(l)).filter((r): r is AppRecord => !!r) : []
}
const of = async <K extends AppRecord['kind']>(kind: K) => (await lines()).filter((r) => r.kind === kind) as Extract<AppRecord, { kind: K }>[]
async function until<T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}
type Ring = { samples: Sample[]; last: Sample | null; stats: { metricsCalls: number; metrics: Record<string, number>; ticks: number; need: boolean; recorder: boolean } }
const ring = () => w.run.call<Ring>('recorder:samples')

async function canvas(slot: number, page: string): Promise<string> {
  const fake = await startFakeCanvas({ home: w.env.home, slotBase: w.slotBase, slot, name: `Recorder ${slot}`, script: HELLO(page) })
  fakes.push(fake)
  await fake.ready
  const s = await w.until((x) => x.tabs.some((t) => t.reg?.instance === fake.instance && t.reg.state === 'ready'), 10_000, 'the canvas from the registry')
  return s.tabs.find((t) => t.reg?.instance === fake.instance)!.id
}
const lifted = (id: string) => w.until((x) => { const t = x.tabs.find((q) => q.id === id)!; return !!t.doc?.lifted && t.doc.trusted }, 15_000, `tab ${id} lifted`)

describe('the recorder on the real binary (A3.7)', () => {
  it('retention at launch, before the first sample: the old line, the 51st picture, the 11th dump', async () => {
    const perf = join(w.env.home, 'perf')
    await until('the pictures pruned', async () => readdirSync(join(perf, 'flashes')).length === 50)
    const recs = await lines()
    expect(recs.some((r) => r.ts < seededAt - 10 * DAY)).toBe(false)
    expect(readdirSync(join(perf, 'flashes'))).not.toContain('seed-00.png')
    expect(readdirSync(join(perf, 'crashpad', 'completed')).filter((n) => n.endsWith('.dmp') && n.includes('-1111-'))).toHaveLength(10)
    expect(statMode(join(perf, 'flashes'))).toBe(0o700)
    // the journal: the prune ended before the first sample line was written - which must exist to say so
    const firstSample = await until('the first sample line', async () => (await w.log('recorder')).find((l) => l.data.kind === 'sample'), 15_000)
    const log = await w.log('perflog')
    const pruned = log.findIndex((l) => 'pruned' in l.data)
    expect(pruned).toBeGreaterThanOrEqual(0)
    expect(BigInt(log[pruned]!.t) < BigInt(firstSample.t)).toBe(true)
  })

  it('the start line names a machine profile whose every field is filled or unknown, collected in under 50 ms', async () => {
    const start = await until('the start line', async () => (await of('start'))[0])
    expect(start).toMatchObject({ flavour: 'dev', recorder: true, pid: w.run.pid })
    expect(start.machine).toMatch(/^[0-9a-f]{16}$/)
    const m = await w.run.call<{ collectMs: number; launchMs: number | null; maxMs: number; parts: Record<string, number>; hash: string; file: string }>('recorder:machine')
    // every main-thread step of the launch's collection: the host's floor, the spawns' starts and answers, the GPU asks, the build
    expect(m.launchMs).not.toBe(null)
    expect(m.launchMs!).toBeLessThan(50)
    expect(m.maxMs).toBeLessThan(50)
    process.stdout.write(`recorder: the launch's profile collection ${m.launchMs!.toFixed(2)} ms of main-thread work (the last: ${JSON.stringify(Object.fromEntries(Object.entries(m.parts).map(([k, v]) => [k, Math.round(v * 100) / 100])))})\n`)
    // the hold at launch (A3.8 #11): the start line, written in the launch's first second before any profile existed,
    // waited and was stamped with the hash once its file was written - the hold ended by the hash, never forced
    const hold = (await w.log('perflog')).find((l) => 'hold' in l.data)?.data.hold as { by: string; machine: string | null; lines: number; startedAt: number; waitedMs: number } | undefined
    expect(hold).toMatchObject({ by: 'hash', machine: start.machine })
    expect(hold!.lines).toBeGreaterThanOrEqual(1)
    expect(start.ts - hold!.startedAt).toBeLessThan(1000)
    process.stdout.write(`recorder: the hold at launch ended by the hash after ${hold!.waitedMs} ms, ${hold!.lines} line(s) held\n`)
    const profile = JSON.parse(readFileSync(join(w.env.home, 'perf', 'machine', `${start.machine}.json`), 'utf8'))
    expect(profile).toMatchObject({ v: 1, kind: 'app', electron: '45.0.0', hostHash: expect.stringMatching(/^[0-9a-f]{16}$/) })
    const walk = (v: unknown, path: string): void => {
      if (v === undefined || v === null || (typeof v === 'string' && !v)) throw new Error(`${path} is missing`)
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`)
    }
    walk(profile, 'profile')
    expect(profile.host.chip).not.toBe('unknown')
    expect(profile.host.cores.p).toBeGreaterThan(0)
    expect(profile.displays.length).toBeGreaterThan(0)
    expect(statMode(join(w.env.home, 'perf', 'machine', `${start.machine}.json`))).toBe(0o600)
  })

  it('samples: each process once, RSS as Electron says it, the canvas renderer for its tab, the app pages by role; the visible tab\'s memory from its preload', async (ctx) => {
    if (!real) { ctx.skip(); return }
    const id = await canvas(1, PAGE1)
    await w.run.call('activate', { id })
    await lifted(id)
    const tab = await w.tab(id)
    const s = await until('a sample with the canvas and its memory', async () => {
      const l = (await ring()).last
      return l?.procs.some((p) => p.role === 'canvas' && p.tabs.includes(id)) && l.visible?.tab === id ? l : null
    }, 15_000)
    const keys = s.procs.map((p) => `${p.pid}:${p.born}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(s.procs.filter((p) => p.type === 'browser')).toHaveLength(1)
    expect(s.gpu).not.toBe(null)
    expect(s.procs.find((p) => p.role === 'strip')).toBeDefined()
    // RSS is Electron's working set in KB / 1024, once per process: the sample a tick published against what that
    // tick's own getAppMetrics() returned (kept by the counted wrapper, before the sampler's wiring read it)
    const key = (x: { pid: number; born: number }) => `${x.pid}:${x.born}`
    const t = await w.run.call<{ sample: Sample; metrics: RawMetric[] | null } | null>('recorder:tick')
    expect(t?.metrics).toBeTruthy()
    expect(t!.sample.procs.map(key).sort()).toEqual(t!.metrics!.map(key).sort())
    for (const p of t!.sample.procs) expect(p.rssMB).toBeCloseTo(t!.metrics!.find((m) => key(m) === key(p))!.workingSetKB / 1024, 6)
    const gpuRaw = t!.metrics!.find((m) => m.type === 'GPU')!
    expect(t!.sample.gpu).toMatchObject({ pid: gpuRaw.pid, born: gpuRaw.born })
    expect(t!.sample.gpu!.gpuProcessRssMB).toBeCloseTo(gpuRaw.workingSetKB / 1024, 6)
    // the minute on disk: each process's last RSS is the last tick's figure for that (pid, born)
    type Folded = { body: { procs: { pid: number; born: number; rssMB: { last: number | null } }[] } | null; lastTs: number; lastRaw: RawMetric[] | null }
    const fold = await until('a minute folded', async () => { const f = (await w.run.call<{ minute: Folded | null }>('recorder:flush', { minute: true })).minute; return f?.body && f.lastRaw ? f : null })
    const minuteLine = await until('that minute on disk', async () => (await of('sample')).find((x) => JSON.stringify(x.procs) === JSON.stringify(fold.body!.procs)))
    let met = 0
    for (const p of minuteLine.procs) {
      const m = fold.lastRaw!.find((x) => key(x) === key(p))
      if (!m) continue   // a process gone before the minute's last tick
      met++
      expect(p.rssMB.last).toBeCloseTo(m.workingSetKB / 1024, 3)
    }
    expect(met).toBe(fold.lastRaw!.length)
    expect(s.visible).toMatchObject({ tab: id, page: PAGE1, commit: tab.doc!.commits })
    expect(s.visible!.ws).toMatch(/^[0-9a-f]{16}$/)
    expect(s.visible!.privateMB).toBeGreaterThan(0)
    expect(s.visible!.heapMB).toBeGreaterThan(0)
    const canvasProc = s.procs.find((p) => p.role === 'canvas' && p.tabs.includes(id))!
    // A3.8 #5's first-build check: the preload's `private` against macOS's footprint, read from outside within a second
    // of the answer, within 10 % (if not, canvas memory falls back to RSS, labelled: a design change, so this fails)
    const fresh = await until('a mem answer under a second old', async () => { const v = (await ring()).last?.visible; return v?.tab === id && Date.now() - v.at < 1000 ? v : null })
    const fp = footprintMB(canvasProc.pid)
    process.stdout.write(`recorder: canvas renderer ${canvasProc.pid}: preload private ${fresh.privateMB} MB, footprint -p ${fp.mb === null ? fp.why : `${fp.mb.toFixed(1)} MB`}, RSS ${canvasProc.rssMB.toFixed(1)} MB\n`)
    expect(fp.mb, `footprint -p not read: ${fp.why}`).not.toBe(null)
    expect(Math.abs(fresh.privateMB - fp.mb!) / fp.mb!, `preload private ${fresh.privateMB} MB against footprint ${fp.mb!.toFixed(1)} MB`).toBeLessThan(0.1)
    // the minute on disk names the same processes
    const minute = await until('a sample line naming the canvas', async () => (await of('sample')).find((x) => x.procs.some((p) => p.role === 'canvas' && p.tabs.includes(id))), 10_000)
    expect(minute.n).toBeGreaterThan(1)
    expect(minute.procs.find((p) => p.type === 'browser')!.cpu.mean).not.toBe(null)
  })

  it('a tab switch writes shown with its time; a killed renderer writes gone with its identity, not ours', async (ctx) => {
    if (!real) { ctx.skip(); return }
    const id = (await w.state()).tabs.find((t) => t.name === 'Recorder 1')!.id
    const id2 = await canvas(2, PAGE2)
    await w.run.call('activate', { id: id2 })
    await lifted(id2)
    await w.run.call('activate', { id })
    const shown = await until('a shown line', async () => (await of('shown')).find((x) => x.tab === id))
    expect(shown.ms).toBeGreaterThan(0)
    expect(shown.ms).toBeLessThan(1000)
    expect(shown.page).toBe(PAGE1)
    const tab = await w.tab(id)
    const at = Date.now()
    await w.run.call('crash', { target: id })
    const gone = await until('the gone line', async () => (await of('gone')).find((x) => x.tab === id), 3000)
    expect(gone.ts - at).toBeLessThan(1000)
    expect(gone).toMatchObject({ tab: id, commit: tab.doc!.commits, page: PAGE1, role: 'canvas', ours: false })
    expect(gone.ws).toMatch(/^[0-9a-f]{16}$/)
    expect(['killed', 'crashed']).toContain(gone.reason)
    expect(gone.pid).toBeGreaterThan(0)
    // tab lines follow each document change: the crash, then the reload's commit
    await lifted(id)
    const tabs = (await of('tab')).filter((x) => x.tab === id)
    expect(new Set(tabs.map((x) => x.commit)).size).toBeGreaterThan(1)
  })

  it('recorder: false set live: no sample line and no getAppMetrics; memory.ts wanting it samples again, still nothing on disk', async () => {
    writeFileSync(join(w.env.home, 'config.json'), JSON.stringify({ recorder: false }))
    await w.run.call('files.reread')
    await until('the recorder off', async () => !(await ring()).stats.recorder)
    await sleep(TIMINGS.sampleMs * 2)
    const n = (await of('sample')).length
    const before = (await ring()).stats
    await sleep(TIMINGS.sampleDiskMs * 2)
    expect((await of('sample')).length).toBe(n)
    // no getAppMetrics() at all, from anything in the app (the tick's, a mark's, an identity read's: one counted wrapper)
    const after = (await ring()).stats
    expect(after.metrics).toEqual(before.metrics)
    expect(after.metricsCalls).toBe(before.metricsCalls)
    await w.run.call('recorder:need', { on: true })
    await sleep(TIMINGS.sampleMs * 4)
    expect((await ring()).stats.metrics.tick).toBeGreaterThan(after.metrics.tick!)
    await sleep(TIMINGS.sampleDiskMs)
    expect((await of('sample')).length).toBe(n)
    await w.run.call('recorder:need', { on: false })
    writeFileSync(join(w.env.home, 'config.json'), JSON.stringify({ recorder: true }))
    await w.run.call('files.reread')
  })

  it('the GPU process killed: child-gone, then a sample with a new GPU process', async () => {
    await until('the recorder on', async () => (await ring()).stats.recorder)
    const before = await until('a sample with the GPU process', async () => (await ring()).last?.gpu ?? null)
    process.kill(before.pid, 'SIGKILL')
    const cg = await until('child-gone', async () => (await of('child-gone')).find((x) => x.type === 'GPU'), 5000)
    expect(cg).toMatchObject({ reason: 'killed', ours: false, machineWide: false })
    const after = await until('a new GPU process', async () => { const g = (await ring()).last?.gpu; return g && g.pid !== before.pid ? g : null }, 15_000)
    expect(after.born).toBeGreaterThan(0)
    // a crash says it: no gpu-restart for it
    await sleep(2500)
    expect((await of('gpu-restart')).filter((x) => x.pid === after.pid)).toHaveLength(0)
  })
})

/** A process's physical footprint from outside (`footprint -p <pid> -f bytes`), in MB (MiB, as the preload's KB / 1024). */
function footprintMB(pid: number): { mb: number | null; why: string } {
  try {
    const out = execFileSync('/usr/bin/footprint', ['-p', String(pid), '-f', 'bytes', '--noCategories'], { encoding: 'utf8', timeout: 10_000 })
    const m = /Footprint:\s*(\d+)\s*B\b/.exec(out)
    return m ? { mb: Number(m[1]) / 2 ** 20, why: '' } : { mb: null, why: `no footprint in: ${out.slice(0, 200)}` }
  } catch (err) { return { mb: null, why: (err as Error).message.split('\n')[0]! } }
}

function statMode(p: string): number {
  return Number.parseInt(execFileSync('/usr/bin/stat', ['-f', '%Lp', p], { encoding: 'utf8' }).trim(), 8)
}
