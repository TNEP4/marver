#!/usr/bin/env node
/**
 * Launch to the first canvas tab painted (spec 28 A3.8 #50; the Budgets): pixels, not A2's frame-callback proxy. No
 * test hook. A fake canvas paints its body a sentinel colour unlike its view's ground; one first launch makes the
 * profile (its time reported, not gated); then, for each warm launch, the capture helper's display stream starts (a
 * window stream cannot exist before the window) with its heartbeat, looking for a 64 x 64 block of the sentinel, and
 * the binary is spawned directly. The time is from spawn to the display time of the first frame showing the block.
 *
 * **Where the sentinel counts** (review of a3-native, major #8): only inside an on-screen window of the spawned
 * process, at least 44 pt below its top (#50: the canvas below the strip), the window's frame read again from the
 * window server at the detection (capture.swift `detect-pid`). A block of the colour anywhere else on the display -
 * another app, a notification, a web page - is not the app's first paint.
 *
 * **The clocks**: once per run, before the first launch, a clock control on display times - the helper paints its own
 * marker red and grey twelve times, stamps each change once committed, and each change's first frame must be
 * displayed 0 to 3 refreshes later (clockControl, as S15 and the matrix do with main's marker); a change whose frames
 * have a hole is skipped, and six measured on contiguous frames are needed - else the run is inconclusive. The
 * ready line's comparison (the helper's "now" against this process's, within 5 ms) is kept as a sanity check only.
 *
 * A launch is conclusive only if no frame before the spawn already shows the sentinel, the frame before the
 * detection is the refresh before it (within 1.5 refreshes: no gap, as #50 says), and the page had focus at its
 * first frame (`document.hasFocus()`). `--gap-refreshes 3` allows the frame before the detection up to three
 * refreshes earlier (a display stream on this Mac skips one now and then even with a heartbeat): a narrowing of #50
 * the report states, for Nic to take into #50 or not - never the default. Gate: five conclusive warm launches with the median under 1 s,
 * every launch reported, and **any launch whose evidence shows more than 1.5 s fails the gate, conclusive or not**
 * (review of a3-native, major #7): a complete frame displayed more than 1.5 s after the spawn that does not show the
 * sentinel, before its first frame that does - a launch that never painted within 5 s with frames arriving is one.
 * A launch whose stream delivered nothing past the spawn is a setup error, reported, never retried into silence.
 * Inconclusive launches are run again, eight launches at most. A2's proxy (spawn to the page's first animation-frame
 * request) is recorded beside each.
 *
 * Every launch uses Chromium's mock keychain (launcher.ts says why): the warm launches do not do the real Safe
 * Storage read, a narrowing of #50 stated in the report. `--real-keychain` drops it, for a Mac set up for acceptance
 * only: on a Mac with the person's own Marver it would read that app's keychain item.
 *
 *   node app/test/budgets/launch-painted.mjs [--app <Marver.app>] [--real-keychain] [--out <dir>]
 *
 * Each launch takes the focus for about a second (the page must have it): the windows appear on the screen. Exit 77
 * when Screen Recording is not granted to the process running it (blind: not run).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, sleep, world } from './launcher.ts'
import { startFakeCanvas } from '../harness/fake-canvas.ts'
import { Palette, blindLine, captureAccess, clockControl, startCapture } from '../harness/capture.ts'

const argv = process.argv.slice(2)
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const APP = val('--app') ? resolve(val('--app')) : undefined
const OUT = resolve(val('--out') ?? '.')
const REAL_KEYCHAIN = argv.includes('--real-keychain')
/** the frame before a detection may be this many refreshes earlier (1: no gap, #50 as written) */
const GAP_REFRESHES = Number(val('--gap-refreshes') ?? 1)
const GATE_MS = 1500
const SENTINEL = '00c853'
const SAY = "if (window.marverApp) { marverApp.hello({ version: '0.27.1', board: null, page: 'painted-' + Math.random().toString(36).slice(2, 10) }); marverApp.busy({ busy: false, unsaved: false, why: [] }) }\n"
  + "requestAnimationFrame(function () { navigator.sendBeacon('/__mv/test/focus-' + document.hasFocus()) });"

const access = await captureAccess()
if (access !== true) {
  process.stdout.write(`launch-painted: BLIND - not run. ${blindLine(access)}\n`)
  process.exit(77)
}

const w = await world()
const fake = await startFakeCanvas({ home: w.home, slotBase: w.slotBase, slot: 1, name: 'Painted', sentinel: SENTINEL, script: SAY, root: join(w.dir, 'repo') })
await fake.ready
// Marver Dev keeps its state in state-dev/ (A2.14 #23)
const STATE = join(w.home, APP ? 'state' : 'state-dev')
mkdirSync(STATE, { recursive: true, mode: 0o700 })
writeFileSync(join(STATE, 'launched'), '')
writeFileSync(join(STATE, 'tabs.json'), JSON.stringify({ v: 1, active: { kind: 'canvas', ws: fake.ws, origin: fake.origin },
  canvases: [{ ws: fake.ws, origin: fake.origin, path: '/', shownAt: Date.now() }], settings: false, closed: [] }))

/** The clock control on display times (A3.8 #36), once a run: the helper's marker shown and hidden four times. */
async function displayClock() {
  const cap = await startCapture({ mode: 'display', heartbeat: true, marker: true })
  try {
    await sleep(300)
    const marks = []
    for (let i = 0; i < 12; i++) { const on = i % 2 === 0; marks.push({ ns: await cap.mark(on), on }); await sleep(150) }
    await sleep(150)
    const red = new Palette(60).add('on', ['ff0000'])
    // a display stream skips a refresh now and then: a change on a hole is skipped, six measured cleanly are needed
    return clockControl(cap.frames, marks, cap.ready.refreshHz, (f) => { const xs = f.regions?.marker?.filter(Boolean) ?? []; return xs.length ? xs.every((x) => red.classify(x) === 'on') : null }, { minMeasured: 6 })
  } finally { await cap.stop() }
}

/** One launch watched by a display stream: spawn to the first sentinel frame, and what makes it conclusive. */
async function painted(label) {
  const cap = await startCapture({ mode: 'display', detect: { hex: SENTINEL, minPx: 64, belowY: 0 }, heartbeat: true })
  const skewMs = Number(process.hrtime.bigint() - BigInt(cap.ready.hostNs)) / 1e6
  const refreshNs = 1e9 / cap.ready.refreshHz
  await sleep(300)
  const since = fake.requests.length
  const L = await launch(w, { app: APP, realKeychain: REAL_KEYCHAIN })
  // from now on the sentinel counts only inside the spawned process's window, below its top 44 pt
  cap.detectPid(L.pid)
  const inApp = (f) => f.detect?.found && f.detect.pid === L.pid && !f.untimed
  let hit = null
  const end = Date.now() + 5000
  while (!hit && Date.now() < end) {
    hit = cap.frames.find((f) => inApp(f) && BigInt(f.hostNs) >= L.spawnNs) ?? null
    if (!hit) await sleep(20)
  }
  // the gate's evidence, conclusive or not: a complete frame past spawn + 1.5 s with no sentinel, before the first
  // that has it, says this launch took more than 1.5 s
  const gateNs = L.spawnNs + BigInt(GATE_MS) * 1_000_000n
  const late = cap.frames.find((f) => f.status === 'complete' && !f.untimed && BigInt(f.hostNs) > gateNs && !inApp(f) && (!hit || BigInt(f.hostNs) < BigInt(hit.hostNs)))
  const delivered = cap.frames.some((f) => f.status === 'complete' && BigInt(f.hostNs) > L.spawnNs)
  await sleep(400)
  const reqs = fake.requests.slice(since)
  const raf = reqs.find((r) => r.path.startsWith('/__mv/test/focus-'))
  await L.stop()
  await cap.stop()
  const why = []
  if (Math.abs(skewMs) > 5) why.push(`the helper's clock and this process's are ${skewMs.toFixed(1)} ms apart`)
  if (cap.frames.some((f) => f.detect?.found && BigInt(f.hostNs) < L.spawnNs)) why.push('the sentinel was on the screen before the spawn')
  let gapMs = null
  if (!hit) why.push('no frame showed the sentinel within 5 s')
  else {
    const i = cap.frames.indexOf(hit)
    const prev = cap.frames[i - 1]
    gapMs = prev ? Number(BigInt(hit.hostNs) - BigInt(prev.hostNs)) / 1e6 : null
    if (gapMs === null || gapMs > (refreshNs * (GAP_REFRESHES === 1 ? 1.5 : GAP_REFRESHES)) / 1e6 + 0.5) why.push(`the frame before the detection is ${gapMs?.toFixed(1)} ms earlier (${GAP_REFRESHES === 1 ? 'a gap: #50 asks for none' : `more than ${GAP_REFRESHES} refreshes`})`)
  }
  if (!raf) why.push('the page never reported its first frame')
  else if (raf.path !== '/__mv/test/focus-true') why.push('the page did not have focus')
  const ms = hit ? Number(BigInt(hit.hostNs) - L.spawnNs) / 1e6 : null
  const proxyMs = raf ? raf.t - L.t0 : null
  // over the gate: the evidence above, or a detection itself past 1.5 s; no frame at all past the spawn: setup
  const overMs = late ? Math.round(Number(BigInt(late.hostNs) - L.spawnNs) / 1e6) : ms !== null && ms > GATE_MS ? Math.round(ms) : null
  return {
    label, ms: ms === null ? null : Math.round(ms), proxyMs, window: hit?.detect?.window ?? null, skewMs: Math.round(skewMs * 10) / 10, gapMs: gapMs === null ? null : Math.round(gapMs * 10) / 10, refreshHz: cap.ready.refreshHz,
    conclusive: !why.length, why, over: overMs !== null ? { atLeastMs: overMs, painted: !!hit } : null, setup: !delivered ? 'the display stream delivered no frame after the spawn' : null,
  }
}

const report = {
  budget: 'launch-painted', at: new Date().toISOString(), build: APP ?? 'dev (app/dist, production switches, no test hook)',
  keychain: REAL_KEYCHAIN ? 'real' : 'mock: no real Safe Storage read (a narrowing of A3.8 #50, stated)',
  gapRule: GAP_REFRESHES === 1 ? 'no gap before the detection (#50 as written)' : `the frame before the detection within ${GAP_REFRESHES} refreshes (a narrowing of #50, stated)`,
  clock: null, first: null, warm: [],
}
try {
  report.clock = await displayClock()
  if (!report.clock.ok) throw Object.assign(new Error(`the clock control on display times ${report.clock.inconclusive ? 'is inconclusive' : 'failed'}: ${report.clock.why}`), { setup: true })
  report.first = await painted('first')
  // a first launch that shows nothing is a broken setup: no warm launch is worth the screen time
  if (report.first.ms === null) throw Object.assign(new Error('the first launch never painted the sentinel'), { setup: true })
  await sleep(500)
  let tries = 0
  while (report.warm.filter((r) => r.conclusive).length < 5 && tries < 8) {
    tries++
    const r = await painted(`warm-${tries}`)
    report.warm.push(r)
    // a launch over the gate fails it whatever else: no more screen time
    if (r.over) break
    await sleep(500)
  }
} catch (e) { if (!e.setup) throw e; report.setup = e.message } finally { await fake.close(); w.release() }

const ok = report.warm.filter((r) => r.conclusive)
const sorted = ok.map((r) => r.ms).sort((a, b) => a - b)
report.medianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
report.over = report.warm.filter((r) => r.over).map((r) => ({ label: r.label, ...r.over, conclusive: r.conclusive }))
report.setupErrors = report.warm.filter((r) => r.setup).map((r) => ({ label: r.label, why: r.setup }))
// any warm launch over 1.5 s fails the gate, conclusive or not; else five conclusive ones with the median under 1 s
report.kind = report.over.length && report.clock?.ok ? 'fail' : report.setup || report.setupErrors.length || ok.length < 5 ? 'inconclusive' : report.medianMs < 1000 && sorted.every((x) => x <= GATE_MS) ? 'pass' : 'fail'
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'launch-painted.json'), JSON.stringify(report, null, 2))
const line = (r) => `${r.label}: ${r.ms ?? '-'} ms painted (A2's proxy ${r.proxyMs ?? '-'} ms), clocks ${r.skewMs} ms, frame before ${r.gapMs ?? '-'} ms at ${r.refreshHz} Hz${r.over ? ` - OVER 1.5 s: not painted ${r.over.atLeastMs} ms after the spawn` : ''}${r.setup ? ` - SETUP: ${r.setup}` : ''}${r.conclusive ? '' : ` - inconclusive: ${r.why.join('; ')}`}`
process.stdout.write([`clock control on display times: ${report.clock ? (report.clock.ok ? `ok (lags ${report.clock.lags.join(', ')} refreshes)` : `NOT OK - ${report.clock.why}`) : 'not run'}`,
  ...(report.first ? [line(report.first) + ' (first launch: reported, not gated)'] : []), ...report.warm.map(line), ...(report.setup ? [`SETUP: ${report.setup}`] : []),
  `launch-painted: ${report.kind.toUpperCase()} - median of ${ok.length} conclusive warm launches ${report.medianMs ?? '-'} ms (under 1000), ${report.over.length} over 1.5 s (any fails), keychain ${REAL_KEYCHAIN ? 'real' : 'mock (narrowed)'}`, `report: ${join(OUT, 'launch-painted.json')}`].join('\n') + '\n')
process.exit(report.kind === 'pass' ? 0 : report.kind === 'fail' ? 1 : 3)
