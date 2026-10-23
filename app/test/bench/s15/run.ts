/**
 * Spike S15 (spec 28 A3.8 #3): the four covers, in order, on bench.cjs, each watched with the ScreenCaptureKit
 * helper (A3.8 #37) and held to A2.2's threshold (A3.8 #36: the p95 of the bad refreshes at most 2, every bad
 * interval at most 100 ms). A cover passes when
 *   (a) it covers whenever it is shown - never the pattern under the tabs, through a steady hold and every toggle;
 *   (b) it reaches the screen within the threshold over 50 toggles made with a view switch (canvas A <-> B and the
 *       cover shown in one turn, as compose() does), counted from main's decision until the first verified covered frame;
 *   (c) it keeps covering with the strip's renderer stalled (and, for 3, its own).
 * The first that passes is the one used; the run stops there unless `--all`. Windows appear on the screen for the
 * run (about 30 s a variant), kept on top and shown inactive; no port is bound; each launch has a temporary profile.
 *
 *   node app/test/bench/s15/run.ts [--all] [--variants 1,2,3,4] [--toggles 50] [--out <dir>]
 *
 * Exit 0 with a report (`<out>/s15.json`, and a summary on stdout); exit 77 when Screen Recording is not granted to
 * the process running it - the spike then did not run (blind), and the report says which app needs the permission.
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
 * So, as A3.8 #3 says for variant 3: "one plain View (no web contents)" becomes "one cover view whose ground is its
 * native background", `pages/cover/` draws its still dots, and its renderer counts in the app's own memory (#48).
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { CaptureBlind, Palette, captureAccess, judgeCase, judgeTransition, startCapture, type CaptureFrame, type CaseVerdict, type TransitionVerdict } from '../../harness/capture.ts'

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
const NAMES: Record<number, string> = { 1: 'a plain View, the ground its background', 2: 'an ImageView of still dots', 3: 'a WebContentsView (dots page), the ground its native background', 4: 'no view: the strip\'s own background' }

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

interface Result {
  variant: number
  name: string
  refreshHz: number
  clockSkewMs: number
  steady: { frames: number; bad: number }
  toggles: CaseVerdict & { detail: TransitionVerdict[] }
  stalledStrip: CaseVerdict & { detail: TransitionVerdict[] }
  stalledCover?: CaseVerdict & { detail: TransitionVerdict[] }
  uncoverStalledStrip?: { uncovered: number; of: number }
  passes: boolean
  why: string[]
}

async function runVariant(v: number): Promise<Result> {
  const ud = mkdtempSync(join(tmpdir(), 's15-ud-'))
  const b = bench(ud)
  try {
    await b.next('ready')
    const win = await b.cmd({ op: 'setup', variant: v }, 'window')
    await sleep(400)
    const regions = { empty: { x: 300, y: 6, w: 700, h: 32 } }
    const cap = await startCapture({ mode: 'window', windowId: Number(win.id), regions, grid: [10, 2] })
    const skew = Number(process.hrtime.bigint() - BigInt(cap.ready.hostNs)) / 1e6
    const hz = cap.ready.refreshHz
    const samplesSince = (t: bigint) => cap.frames.filter((f) => BigInt(f.hostNs) >= t && f.status === 'complete' && f.regions).flatMap((f) => f.regions!.empty!)
    // calibration: the ground and its dots, A's and B's patterns, each as the capture shows them
    await b.cmd({ op: 'state', canvas: 'a', cover: false }, 'state')
    const cal = await b.cmd({ op: 'calib', on: true }, 'calib')
    await sleep(350)
    const groundSamples = samplesSince(BigInt(cal.ns) + 100_000_000n)
    await b.cmd({ op: 'calib', on: false }, 'calib')
    const sa = await b.cmd({ op: 'state', canvas: 'a' }, 'state'); await sleep(300)
    const aSamples = samplesSince(BigInt(sa.ns) + 100_000_000n)
    const sb = await b.cmd({ op: 'state', canvas: 'b' }, 'state'); await sleep(300)
    const bSamples = samplesSince(BigInt(sb.ns) + 100_000_000n)
    const pal = new Palette(20).add('ground', groundSamples).add('a', aSamples).add('b', bSamples).between('ground', '#e7e9ef', '#c9cbd5')
    const verdict = (f: CaptureFrame) => (f.regions?.empty ?? []).every((s) => pal.classify(s) === 'ground') ? 'good' as const : 'bad' as const

    // (a) steady: covered over A for 600 ms, judged from 150 ms after the decision
    const st = await b.cmd({ op: 'state', canvas: 'a', cover: true }, 'state')
    await sleep(600)
    const hold = cap.frames.filter((f) => BigInt(f.hostNs) >= BigInt(st.ns) + 150_000_000n && f.status === 'complete')
    const steady = { frames: hold.length, bad: hold.filter((f) => verdict(f) === 'bad').length }
    await b.cmd({ op: 'state', cover: false }, 'state')
    await sleep(200)

    const toggles = async (n: number) => {
      const out: TransitionVerdict[] = []
      let on: 'a' | 'b' = 'a'
      for (let i = 0; i < n; i++) {
        on = on === 'a' ? 'b' : 'a'
        const t0 = BigInt((await b.cmd({ op: 'state', canvas: on, cover: true }, 'state')).ns)
        await sleep(220)
        const t1 = BigInt((await b.cmd({ op: 'state', cover: false }, 'state')).ns)
        await sleep(140)
        out.push(judgeTransition(cap.frames, { t0, t1, refreshHz: hz, verdict }))
      }
      // an inconclusive transition is run again, at most three times in all (A3.8 #37)
      for (let k = 0; k < out.length; k++) {
        for (let tries = 1; out[k]!.kind === 'inconclusive' && tries < 3; tries++) {
          on = on === 'a' ? 'b' : 'a'
          const t0 = BigInt((await b.cmd({ op: 'state', canvas: on, cover: true }, 'state')).ns)
          await sleep(220)
          const t1 = BigInt((await b.cmd({ op: 'state', cover: false }, 'state')).ns)
          await sleep(140)
          out[k] = judgeTransition(cap.frames, { t0, t1, refreshHz: hz, verdict })
        }
      }
      return { ...judgeCase(out), detail: out }
    }
    const t = await toggles(TOGGLES)
    await b.cmd({ op: 'stall', target: 'strip' }, 'stalled')
    await sleep(150)
    const ss = await toggles(STALLED)
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
    if (v === 3) {
      await b.cmd({ op: 'stall', target: 'cover' }, 'stalled')
      await sleep(150)
      sc = await toggles(STALLED)
      await b.cmd({ op: 'unstall', target: 'cover' }, 'unstalled')
    }
    await cap.png(join(OUT, `s15-v${v}-last.png`))
    await cap.stop()
    if (flag('--dump')) writeFileSync(join(OUT, `s15-v${v}-frames.jsonl`), cap.frames.map((f) => JSON.stringify(f)).join('\n'))
    const why: string[] = []
    if (!steady.frames) why.push('(a) no frame seen while covered')
    else if (steady.bad) why.push(`(a) ${steady.bad} of ${steady.frames} frames showed the pattern while covered`)
    if (t.kind !== 'pass') why.push(`(b) toggles ${t.kind}: p95 n ${t.p95n}, max ${t.maxMs} ms, ${t.inconclusive} inconclusive`)
    if (ss.kind !== 'pass') why.push(`(c) strip stalled ${ss.kind}: p95 n ${ss.p95n}, max ${ss.maxMs} ms, ${ss.inconclusive} inconclusive`)
    if (sc && sc.kind !== 'pass') why.push(`(c) cover stalled ${sc.kind}: p95 n ${sc.p95n}, max ${sc.maxMs} ms`)
    if (Math.abs(skew) > 100) why.push(`the clocks do not line up: ${skew.toFixed(1)} ms between the helper's ready and this process`)
    return {
      variant: v, name: NAMES[v]!, refreshHz: hz, clockSkewMs: Math.round(skew * 10) / 10, steady,
      toggles: t, stalledStrip: ss, ...(sc ? { stalledCover: sc } : {}), ...(uncover ? { uncoverStalledStrip: uncover } : {}),
      passes: why.length === 0, why,
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

const access = await captureAccess()
if (access !== true) {
  const r = { spike: 'S15', ran: false, blind: true, needs: access.needs }
  writeFileSync(join(OUT, 's15.json'), JSON.stringify(r, null, 2))
  process.stdout.write(`S15: BLIND - not run. Screen Recording must be granted to ${access.needs} (System Settings > Privacy & Security > Screen & System Audio Recording)\n`)
  process.exit(77)
}
const results: Result[] = []
let chosen: number | null = null
for (const v of VARIANTS) {
  process.stdout.write(`S15: variant ${v} (${NAMES[v]})...\n`)
  try {
    const r = await runVariant(v)
    results.push(r)
    process.stdout.write(`  ${r.passes ? 'PASS' : 'FAIL'}  steady ${r.steady.bad}/${r.steady.frames} bad; toggles p95 n ${r.toggles.p95n}, max ${r.toggles.maxMs} ms (${r.toggles.inconclusive} inconclusive); strip stalled p95 n ${r.stalledStrip.p95n}, max ${r.stalledStrip.maxMs} ms${r.stalledCover ? `; cover stalled p95 n ${r.stalledCover.p95n}, max ${r.stalledCover.maxMs} ms` : ''}${r.uncoverStalledStrip ? `; uncovered with the strip stalled ${r.uncoverStalledStrip.uncovered}/${r.uncoverStalledStrip.of}` : ''}; ${r.refreshHz} Hz, clocks ${r.clockSkewMs} ms\n`)
    for (const w of r.why) process.stdout.write(`    ${w}\n`)
    if (r.passes && chosen === null) { chosen = v; if (!ALL) break }
  } catch (e) {
    if (e instanceof CaptureBlind) { process.stdout.write(`S15: BLIND - ${e.message}\n`); process.exit(77) }
    process.stdout.write(`  ERROR ${(e as Error).message}\n`)
    results.push({ variant: v, name: NAMES[v]!, passes: false, why: [`error: ${(e as Error).message}`] } as Result)
  }
}
const report = { spike: 'S15', ran: true, at: new Date().toISOString(), electron: '45.0.0', chosen, results }
writeFileSync(join(OUT, 's15.json'), JSON.stringify(report, null, 2))
process.stdout.write(`S15: ${chosen === null ? 'NO cover passed - the opaque strip stays (A2.2\'s fallback); the numbers go to Nic' : `variant ${chosen} (${NAMES[chosen]}) is the first that passes`}\nreport: ${join(OUT, 's15.json')}\n`)
