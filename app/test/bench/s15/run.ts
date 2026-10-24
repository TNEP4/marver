/**
 * Spike S15 (spec 28 A3.8 #3): the four covers, in order, on bench.cjs, each watched with the ScreenCaptureKit
 * helper (A3.8 #37) and held to A2.2's threshold (A3.8 #36: the p95 of the bad refreshes at most 2, every bad
 * interval at most 100 ms). A cover passes when
 *   (a) it covers whenever it is shown - never the pattern under the tabs, through a steady hold and every toggle;
 *   (b) it reaches the screen within the threshold over 50 toggles made with a view switch (canvas A <-> B and the
 *       cover shown in one turn, as compose() does), counted from main's decision until the first verified covered frame;
 *   (c) it keeps covering with the strip's renderer stalled (and, for 3, its own).
 * Beyond the gate, for 3: the same toggles with its renderer crashed (not reloaded) and as a cover that has never
 * painted - whether covering waits on a renderer at all, which A3.8 #3's amendment for 3 says it never does. Reported
 * apart (`beyond`), never part of the pass: they are facts cover.ts must design for, not the gate Nic set.
 * The first that passes is the one used; the run stops there unless `--all`. Windows appear on the screen for the
 * run (about 30 s a variant), kept on top and shown inactive; no port is bound; each launch has a temporary profile.
 * Every transition is judged by judgeTransition (both ends of its window seen, A3.8 #36) and run again while
 * inconclusive, three runs at most: three inconclusive ones fail the case (`retried`, A3.8 #37).
 *
 * The clock control (A3.8 #36): main shows and hides a red marker view, stamped right after each change; the first
 * frame showing the change must be displayed 0 to 3 refreshes after the stamp, else the variant's run is inconclusive.
 * It checks the helper's display times against main's own clock, which the ready line's comparison (the helper's
 * "now" against this process's) cannot.
 *
 *   node app/test/bench/s15/run.ts [--all] [--variants 1,2,3,4] [--toggles 50] [--cover-from scheme|data] [--dump] [--out <dir>]
 *   node app/test/bench/s15/run.ts --rejudge <out>/s15-v3-run.json    the dump's transitions judged again, no window
 *
 * Exit 0 with a report (`<out>/s15.json`, and a summary on stdout); exit 77 when Screen Recording is not granted to
 * the process running it - the spike then did not run (blind), and the report says which app needs the permission.
 * `--dump` writes each variant's frames (`s15-v<n>-frames.jsonl`) and what judging them needs - the calibration
 * samples, every transition's t0 and t1 (`s15-v<n>-run.json`) - so `--rejudge` can judge them again offline.
 *
 * **S15's result** (23 Oct 2026, Electron 45.0.0, Nic's MacBook Pro, the built-in display at 120 Hz, a window
 * stream at 2x; the helper's clock and this process's 0.1-0.3 ms apart): **variant 3 is the first that passes.**
 *   1 View: never covers. Every steady frame (50 of 50) showed the canvas's pattern under the strip, and every toggle
 *     the newly shown view's (n 24-25: the whole 220 ms hold). AppKit draws it beneath the web views' NSViews,
 *     whatever the child order says.
 *   2 ImageView: the same - never covers (50 of 50; n 24-25).
 *   3 WebContentsView, the ground its native background: covers in every steady frame (0 of 49 bad); 50 toggles
 *     n 0 (26) or 1 (24), the bad interval at most 11.3 ms; the strip's renderer stalled, n 0 or 1, at most 10.4 ms;
 *     its own renderer stalled, n 0 or 1, at most 12 ms. PASS.
 *   4 not run: the first that passes is used.
 * **Run again on 24 Oct** with the judge that sees both ends of each window, the clock control and the cover served
 * as cover.ts will serve it (`mvbench://cover/` on a persist: partition), `--variants 3,4 --all --dump`: the marker's
 * changes reached the screen 0.6-2.0 refreshes after main made them (the clocks agree); no transition inconclusive.
 *   3: steady 0 of 50 bad; 50 toggles p95 n 1 (one n 2), at most 17.3 ms; strip stalled p95 n 1, at most 9.7 ms;
 *     its own renderer stalled p95 n 1, at most 16.8 ms. PASS - A3.8 #3's gate holds. **Beyond the gate**: with its
 *     renderer crashed (not reloaded) it never covers (20 toggles, n 24-25: the whole hold), and a cover whose page
 *     has not painted yet never covers either (n 24-25). A WebContentsView's native background is drawn as the base
 *     of its renderer's frame, not by the browser: so covering waits on the cover's renderer having presented a frame
 *     and being alive (a stalled one keeps its last frame). The marker, a WebContentsView with nothing loaded, never
 *     reached the screen at all. #3's amendment "covering never waits on a renderer" is wrong as written.
 *   4: steady 0 of 50; 50 toggles p95 n 1, at most 16.8 ms; with the strip's renderer stalled it never covers (n 24-25)
 *     - its background is the strip renderer's too. FAIL.
 * So variant 3 stays the choice, and cover.ts must keep every canvas below the strip (0.1's opaque layout) while the
 * cover's renderer has not presented, or has gone, until it presents again.
 * **Run again on 24 Oct at 10:38** (the review's, `--dump`, variants 1-3; clocks 0.1 ms apart, the marker's changes
 * 0.4-2.1 refreshes after main made them; no transition inconclusive): 1 FAIL (steady 50 of 50 bad; toggles p95 n 26,
 * at most 220.1 ms; strip stalled p95 n 25); 2 FAIL (50 of 50; p95 n 25, at most 218.2 ms); 3 PASS (steady 0 of 49;
 * toggles p95 n 1, at most 15.9 ms; strip stalled p95 n 1, at most 16.5 ms; its own stalled p95 n 1, at most 9.3 ms)
 * and beyond the gate again never covering with its renderer crashed (p95 n 25, 220.9 ms) or before its first paint
 * (p95 n 26, 219.7 ms). Both 24 Oct dumps judged again (`--rejudge`) with the judge that reads an idle frame at its
 * own time and refuses a frame without its samples: the same verdicts.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { CaptureBlind, Palette, TRIES, blindLine, captureAccess, clockControl, judgeCase, judgeTransition, retried, startCapture, type CaptureFrame, type CaseVerdict, type ClockControl, type FrameVerdict, type TransitionVerdict } from '../../harness/capture.ts'

const APP = resolve(import.meta.dirname, '..', '..', '..')
const ELECTRON = createRequire(join(APP, 'package.json'))('electron') as unknown as string
const argv = process.argv.slice(2)
const flag = (n: string) => argv.includes(n)
const val = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const ALL = flag('--all')
const VARIANTS = (val('--variants') ?? '1,2,3,4').split(',').map(Number)
const TOGGLES = Number(val('--toggles') ?? 50)
const STALLED = Math.max(10, Math.round(TOGGLES * 0.4))
const OUT = resolve(val('--out') ?? mkdtempSync(join(tmpdir(), 's15-')))
mkdirSync(OUT, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const COVER_FROM = val('--cover-from') === 'data' ? 'data' : 'scheme'
const NAMES: Record<number, string> = { 1: 'a plain View, the ground its background', 2: 'an ImageView of still dots', 3: `a WebContentsView (dots page${COVER_FROM === 'data' ? ', a data: URL' : ', mvbench://cover/ on a persist: partition'}), the ground its native background`, 4: 'no view: the strip\'s own background' }
const GROUND = '#e7e9ef', DOT = '#c9cbd5'

/** What judging a variant's frames needs, kept beside its dump (`--rejudge`). */
interface RunDump {
  variant: number
  refreshHz: number
  calibration: { ground: string[]; a: string[]; b: string[] }
  /** every transition run, each try: its set (toggles, strip, cover, crashed, fresh), t0 and t1 */
  transitions: { set: string; k: number; t0: string; t1: string }[]
}
const paletteOf = (c: RunDump['calibration']) => new Palette(20).add('ground', c.ground).add('a', c.a).add('b', c.b).between('ground', GROUND, DOT)
/** the strip's empty part all ground; `unread` when the frame carries none of its samples (never good: `[].every()` is true) */
const verdictOf = (pal: Palette) => (f: CaptureFrame): FrameVerdict => {
  const xs = (f.regions?.empty ?? []).filter(Boolean)
  return !xs.length ? 'unread' : xs.every((s) => pal.classify(s) === 'ground') ? 'good' : 'bad'
}

interface Ev { ns: string; ev: string; [k: string]: unknown }

function bench(userData: string) {
  const child = spawn(ELECTRON, [join(import.meta.dirname, 'bench.cjs')], { env: { ...process.env, S15_USER_DATA: userData }, stdio: ['pipe', 'pipe', 'pipe'] })
  let err = ''
  child.stderr.on('data', (c) => { err += c })
  const waiters: { ev: string; r: (e: Ev) => void }[] = []
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (l) => {
    let e: Ev
    try { e = JSON.parse(l) as Ev } catch { return }
    if (e.ev === 'error') process.stderr.write(`bench: ${JSON.stringify(e)}\n`)
    const i = waiters.findIndex((w) => w.ev === e.ev)
    if (i >= 0) waiters.splice(i, 1)[0]!.r(e)
  })
  const next = (ev: string, ms = 20_000) => new Promise<Ev>((r, j) => {
    const t = setTimeout(() => j(new Error(`bench: no ${ev} in ${ms} ms: ${err.slice(-400)}`)), ms)
    waiters.push({ ev, r: (e) => { clearTimeout(t); r(e) } })
  })
  const cmd = async (o: Record<string, unknown>, ev: string) => { const p = next(ev); child.stdin.write(JSON.stringify(o) + '\n'); return p }
  return { child, next, cmd, err: () => err }
}

/** the Electron the bench reported in its ready event (never a hard-coded version) */
let electronSeen: string | null = null

interface Result {
  variant: number
  name: string
  refreshHz: number
  clockSkewMs: number
  clock: ClockControl
  steady: { frames: number; bad: number; unread: number }
  toggles: CaseVerdict & { detail: TransitionVerdict[] }
  stalledStrip: CaseVerdict & { detail: TransitionVerdict[] }
  stalledCover?: CaseVerdict & { detail: TransitionVerdict[] }
  crashedCover?: CaseVerdict & { detail: TransitionVerdict[]; reason?: unknown }
  freshCover?: CaseVerdict & { detail: TransitionVerdict[] }
  uncoverStalledStrip?: { uncovered: number; of: number }
  passes: boolean
  why: string[]
  /** beyond the gate (variant 3): facts cover.ts must design for, never part of the pass */
  beyond?: string[]
}

async function runVariant(v: number): Promise<Result> {
  const ud = mkdtempSync(join(tmpdir(), 's15-ud-'))
  const b = bench(ud)
  try {
    const ready = await b.next('ready')
    if (typeof ready.electron === 'string') electronSeen = ready.electron
    const win = await b.cmd({ op: 'setup', variant: v, coverFrom: COVER_FROM }, 'window')
    await sleep(400)
    const H = Number(win.h)
    const regions = { empty: { x: 300, y: 6, w: 700, h: 32 }, marker: { x: 28, y: H - 24, w: 16, h: 16 } }
    const cap = await startCapture({ mode: 'window', windowId: Number(win.id), regions, grid: [10, 2] })
    const skew = Number(process.hrtime.bigint() - BigInt(cap.ready.hostNs)) / 1e6
    const hz = cap.ready.refreshHz
    const samplesSince = (t: bigint) => cap.frames.filter((f) => BigInt(f.hostNs) >= t && f.status === 'complete' && f.regions).flatMap((f) => f.regions!.empty!)
    const dump: RunDump = { variant: v, refreshHz: hz, calibration: { ground: [], a: [], b: [] }, transitions: [] }

    // the clock control: the marker shown and hidden four times, 150 ms apart, against the bench's grey
    const marks: { ns: bigint; on: boolean }[] = []
    for (let i = 0; i < 8; i++) { const m = await b.cmd({ op: 'marker', on: i % 2 === 0 }, 'marker'); marks.push({ ns: BigInt(m.ns), on: i % 2 === 0 }); await sleep(150) }
    await sleep(100)
    const red = new Palette(60).add('on', ['ff0000'])
    const isOn = (f: CaptureFrame) => { const xs = f.regions?.marker?.filter(Boolean) ?? []; return xs.length ? xs.every((x) => red.classify(x) === 'on') : null }
    const clock = clockControl(cap.frames, marks, hz, isOn)

    // calibration: the ground and its dots, A's and B's patterns, each as the capture shows them
    await b.cmd({ op: 'state', canvas: 'a', cover: false }, 'state')
    const cal = await b.cmd({ op: 'calib', on: true }, 'calib')
    await sleep(350)
    dump.calibration.ground = samplesSince(BigInt(cal.ns) + 100_000_000n)
    await b.cmd({ op: 'calib', on: false }, 'calib')
    const sa = await b.cmd({ op: 'state', canvas: 'a' }, 'state'); await sleep(300)
    dump.calibration.a = samplesSince(BigInt(sa.ns) + 100_000_000n)
    const sb = await b.cmd({ op: 'state', canvas: 'b' }, 'state'); await sleep(300)
    dump.calibration.b = samplesSince(BigInt(sb.ns) + 100_000_000n)
    const verdict = verdictOf(paletteOf(dump.calibration))

    // (a) steady: covered over A for 600 ms, judged from 150 ms after the decision
    const st = await b.cmd({ op: 'state', canvas: 'a', cover: true }, 'state')
    await sleep(600)
    const hold = cap.frames.filter((f) => BigInt(f.hostNs) >= BigInt(st.ns) + 150_000_000n && f.status === 'complete')
    const steady = { frames: hold.length, bad: hold.filter((f) => verdict(f) === 'bad').length, unread: hold.filter((f) => verdict(f) === 'unread').length }
    await b.cmd({ op: 'state', cover: false }, 'state')
    await sleep(200)

    // one toggle: canvas switched and the cover shown in one turn, held, then uncovered; judged once its window's
    // tail has arrived (the next frame after t1)
    let on: 'a' | 'b' = 'a'
    const toggle = async (set: string, k: number): Promise<TransitionVerdict> => {
      on = on === 'a' ? 'b' : 'a'
      const t0 = BigInt((await b.cmd({ op: 'state', canvas: on, cover: true }, 'state')).ns)
      await sleep(220)
      const t1 = BigInt((await b.cmd({ op: 'state', cover: false }, 'state')).ns)
      await sleep(140)
      dump.transitions.push({ set, k, t0: String(t0), t1: String(t1) })
      return judgeTransition(cap.frames, { t0, t1, refreshHz: hz, verdict })
    }
    const toggles = async (set: string, n: number) => {
      const out: TransitionVerdict[] = []
      for (let k = 0; k < n; k++) {
        const tries: TransitionVerdict[] = []
        do tries.push(await toggle(set, k)); while (tries.at(-1)!.kind === 'inconclusive' && tries.length < TRIES)
        out.push(retried(tries))
      }
      return { ...judgeCase(out), detail: out }
    }
    const t = await toggles('toggles', TOGGLES)
    await b.cmd({ op: 'stall', target: 'strip' }, 'stalled')
    await sleep(150)
    const ss = await toggles('strip', STALLED)
    // with the strip stalled, does uncovering happen at all (variant 4: it waits for the strip's renderer)
    let uncover: Result['uncoverStalledStrip']
    if (v === 4) {
      let up = 0
      for (let i = 0; i < 5; i++) {
        await b.cmd({ op: 'state', cover: true }, 'state'); await sleep(200)
        const u = await b.cmd({ op: 'state', cover: false }, 'state'); await sleep(250)
        const after = cap.frames.filter((f) => BigInt(f.hostNs) >= BigInt(u.ns) + 150_000_000n && f.status === 'complete')
        if (after.some((f) => verdict(f) === 'bad')) up++
      }
      uncover = { uncovered: up, of: 5 }
    }
    await b.cmd({ op: 'unstall', target: 'strip' }, 'unstalled')
    await sleep(300)
    let sc: Result['stalledCover']
    let cc: Result['crashedCover']
    let fc: Result['freshCover']
    if (v === 3) {
      await b.cmd({ op: 'stall', target: 'cover' }, 'stalled')
      await sleep(150)
      sc = await toggles('cover', STALLED)
      // its renderer gone (not reloaded), then a cover that has never painted: covering must not wait on either
      const crash = await b.cmd({ op: 'crash-cover' }, 'crashed')
      await sleep(300)
      cc = { ...(await toggles('crashed', STALLED)), reason: crash.reason }
      await b.cmd({ op: 'fresh-cover' }, 'fresh')
      fc = await toggles('fresh', STALLED)
    }
    await cap.png(join(OUT, `s15-v${v}-last.png`))
    await cap.stop()
    if (flag('--dump')) {
      writeFileSync(join(OUT, `s15-v${v}-frames.jsonl`), cap.frames.map((f) => JSON.stringify(f)).join('\n'))
      writeFileSync(join(OUT, `s15-v${v}-run.json`), JSON.stringify(dump, null, 2))
    }
    const why: string[] = []
    if (!clock.ok) why.push(`the clock control: ${clock.why} - the run is inconclusive`)
    if (!steady.frames) why.push('(a) no frame seen while covered')
    else if (steady.unread) why.push(`(a) ${steady.unread} of ${steady.frames} frames carried none of the strip's samples - inconclusive`)
    else if (steady.bad) why.push(`(a) ${steady.bad} of ${steady.frames} frames showed the pattern while covered`)
    const say = (what: string, c: CaseVerdict) => `${what} ${c.kind}: p95 n ${c.p95n}, max ${c.maxMs} ms, ${c.inconclusive} inconclusive, ${c.unresolved} unresolved`
    if (t.kind !== 'pass') why.push(`(b) ${say('toggles', t)}`)
    if (ss.kind !== 'pass') why.push(`(c) ${say('strip stalled', ss)}`)
    if (sc && sc.kind !== 'pass') why.push(`(c) ${say('cover stalled', sc)}`)
    const beyond: string[] = []
    if (cc && cc.kind !== 'pass') beyond.push(`${say('its renderer crashed', cc)} - covering waits on the cover's renderer being alive`)
    if (fc && fc.kind !== 'pass') beyond.push(`${say('a cover that never painted', fc)} - covering waits on its first frame`)
    if (Math.abs(skew) > 100) why.push(`the clocks do not line up: ${skew.toFixed(1)} ms between the helper's ready and this process`)
    return {
      variant: v, name: NAMES[v]!, refreshHz: hz, clockSkewMs: Math.round(skew * 10) / 10, clock, steady,
      toggles: t, stalledStrip: ss, ...(sc ? { stalledCover: sc } : {}), ...(cc ? { crashedCover: cc } : {}), ...(fc ? { freshCover: fc } : {}),
      ...(uncover ? { uncoverStalledStrip: uncover } : {}),
      passes: why.length === 0, why, beyond,
    }
  } finally {
    const exited = new Promise<void>((r) => { if (b.child.exitCode !== null) r(); else b.child.once('exit', () => r()) })
    try { b.child.stdin.write(JSON.stringify({ op: 'quit' }) + '\n') } catch { /* gone */ }
    const late = setTimeout(() => b.child.kill('SIGKILL'), 3000)
    await exited
    clearTimeout(late)
    rmSync(ud, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/** `--rejudge <run.json>`: a dump's transitions judged again with today's judge (its frames beside it), no window. */
if (val('--rejudge')) {
  const runFile = resolve(val('--rejudge')!)
  const dump = JSON.parse(readFileSync(runFile, 'utf8')) as RunDump
  const frames = readFileSync(runFile.replace(/-run\.json$/, '-frames.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as CaptureFrame)
  const verdict = verdictOf(paletteOf(dump.calibration))
  const sets = new Map<string, Map<number, TransitionVerdict[]>>()
  for (const x of dump.transitions) {
    const v = judgeTransition(frames, { t0: BigInt(x.t0), t1: BigInt(x.t1), refreshHz: dump.refreshHz, verdict })
    const m = sets.get(x.set) ?? new Map<number, TransitionVerdict[]>()
    m.set(x.k, [...(m.get(x.k) ?? []), v])
    sets.set(x.set, m)
  }
  for (const [set, m] of sets) {
    const c = judgeCase([...m.values()].map(retried))
    process.stdout.write(`S15 v${dump.variant} rejudged, ${set}: ${c.kind.toUpperCase()} - p95 n ${c.p95n}, max ${c.maxMs} ms, ${c.inconclusive} inconclusive, ${c.unresolved} unresolved of ${c.transitions}; n ${JSON.stringify(c.ns)}\n`)
  }
  process.exit(0)
}

const access = await captureAccess()
if (access !== true) {
  const r = { spike: 'S15', ran: false, blind: true, why: access.why, needs: access.needs }
  writeFileSync(join(OUT, 's15.json'), JSON.stringify(r, null, 2))
  process.stdout.write(`S15: BLIND - not run. ${blindLine(access)}${access.why === 'permission' ? ' (System Settings > Privacy & Security > Screen & System Audio Recording)' : ''}\n`)
  process.exit(77)
}
const results: Result[] = []
let chosen: number | null = null
for (const v of VARIANTS) {
  process.stdout.write(`S15: variant ${v} (${NAMES[v]})...\n`)
  try {
    const r = await runVariant(v)
    results.push(r)
    const c = (x: CaseVerdict | undefined, what: string) => x ? `; ${what} p95 n ${x.p95n}, max ${x.maxMs} ms` : ''
    process.stdout.write(`  ${r.passes ? 'PASS' : 'FAIL'}  steady ${r.steady.bad}/${r.steady.frames} bad; toggles p95 n ${r.toggles.p95n}, max ${r.toggles.maxMs} ms (${r.toggles.inconclusive} inconclusive, ${r.toggles.unresolved} unresolved)${c(r.stalledStrip, 'strip stalled')}${c(r.stalledCover, 'cover stalled')}${c(r.crashedCover, 'cover crashed')}${c(r.freshCover, 'cover never painted')}${r.uncoverStalledStrip ? `; uncovered with the strip stalled ${r.uncoverStalledStrip.uncovered}/${r.uncoverStalledStrip.of}` : ''}; ${r.refreshHz} Hz, clocks ${r.clockSkewMs} ms, marker lags ${JSON.stringify(r.clock.lags)} refreshes\n`)
    for (const w of r.why) process.stdout.write(`    ${w}\n`)
    for (const w of r.beyond ?? []) process.stdout.write(`    beyond the gate: ${w}\n`)
    if (r.passes && chosen === null) { chosen = v; if (!ALL) break }
  } catch (e) {
    if (e instanceof CaptureBlind) { process.stdout.write(`S15: BLIND - ${e.message}\n`); process.exit(77) }
    process.stdout.write(`  ERROR ${(e as Error).message}\n`)
    results.push({ variant: v, name: NAMES[v]!, passes: false, why: [`error: ${(e as Error).message}`] } as Result)
  }
}
const report = { spike: 'S15', ran: true, at: new Date().toISOString(), electron: electronSeen, coverFrom: COVER_FROM, chosen, results }
writeFileSync(join(OUT, 's15.json'), JSON.stringify(report, null, 2))
process.stdout.write(`S15: ${chosen === null ? 'NO cover passed - the opaque strip stays (A2.2\'s fallback); the numbers go to Nic' : `variant ${chosen} (${NAMES[chosen]}) is the first that passes`}\nreport: ${join(OUT, 's15.json')}\n`)
