#!/usr/bin/env node
/**
 * All tabs hidden: the app's own CPU under 1 % of one core (spec 28 A3.8 #49, r1 #11, r2 #1, r3 #2, r4 #1; the
 * Budgets). "All tabs hidden" is the window hidden (⇧⌘W), since Home is a tab. Three idle canvases, each loaded once,
 * the recorder on (its shipped default: its own cost is part of what is measured), the heartbeat off; 60 s to
 * settle, then the window (5 minutes; 10 for acceptance).
 *
 * Counted from outside, exits included: procusage.swift reads each process's own CPU and its reaped children's, for
 * the browser, every live child of it and Crashpad's handler (outside.ts cpuPass, in the order that errs against the
 * app); over the window the end's sum minus the start's (cpuWindow). Canvas renderers are taken out: each alive at
 * both ends is subtracted, and one that starts or ends inside the window makes the run inconclusive - run again, up
 * to three times, never passed. Anything else unattributed stays the app's: it can fail a run, never pass one.
 *
 * Which processes are canvases: on the signed build, only the release's own `app.jsonl` (r4 #1; evidence.ts) - the
 * measured launch's lines from the last `sample` before the window to the first after it (waited for, 70 s at most),
 * whole: `seq` contiguous, no `dropped` line, both bounding samples present; a canvas tab's `gone` or `unload`, or a
 * `tab` line whose commit or main frame differs from the tab's last line before the window (a reload, a navigation,
 * a cross-process navigation), makes the run inconclusive. Then the recorder's own figure must agree with the outside
 * one within 0.001 cores or 20 %, else the harness fails as its own error - compared like with like (evidence.ts
 * `crossCheck`): the processes alive at both outside passes, joined by pid and start time, each one's own CPU (no
 * reaped children, no Crashpad handler), against the recorder's minute lines that lie inside the window, the GPU
 * process counted once. The dev build (default; test mode over its control socket, production switches) is held to
 * the same: its recorder's own log (app-dev.jsonl), whole, and the agreement - no test hook names its canvases for
 * the gate (code review r1 #3). Evidence missing or not whole, or a cross-check not made (`unchecked`), is
 * inconclusive, never a pass (evidence.ts `cpuGate`).
 *
 * Reported, not gated: helpers seen to start or end between any two of the 5 s reads, each canvas renderer's CPU,
 * the probes' spawn time, and (with --scene) Home active with every canvas hidden, or the window minimised.
 * `--ballast`: the first canvas burns a third of a core while hidden (the fake's cpuBallast, A3.8 r3): the app's own
 * figure must stay under the gate and that renderer's CPU be reported apart - the check that canvases are taken out.
 *
 *   node app/test/budgets/hidden-cpu.mjs [--app <Marver.app>] [--minutes 5] [--settle 60] [--scene hidden|home|minimised] [--ballast] [--out <dir>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, sleep, world } from './launcher.ts'
import { startFakeCanvas } from '../harness/fake-canvas.ts'
import { appProcesses, cpuPass, cpuWindow, crashpadOf } from '../harness/outside.ts'
import { churn, cpuGate, crossCheck, releaseEvidence } from './evidence.ts'
import { nativeTool, responsibleApp } from '../harness/capture.ts'
import { parseAppLine } from '../../../src/shared/app-perf.ts'

const argv = process.argv.slice(2)
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const APP = val('--app') ? resolve(val('--app')) : undefined
const OUT = resolve(val('--out') ?? '.')
const MINUTES = Number(val('--minutes') ?? 5)
const SETTLE = Number(val('--settle') ?? 60)
const SCENE = val('--scene') ?? 'hidden'
const BALLAST = argv.includes('--ballast')
const BUDGET = 0.01
const SAY = "if (window.marverApp) { marverApp.hello({ version: '0.27.1', board: null, page: 'cpu-' + Math.random().toString(36).slice(2, 10) }); marverApp.busy({ busy: false, unsaved: false, why: [] }) }"

/** The measured launch's lines of app.jsonl (or app-dev.jsonl), parsed; null when there is no file. */
function appLines(home) {
  const f = join(home, 'perf', APP ? 'app.jsonl' : 'app-dev.jsonl')
  if (!existsSync(f)) return null
  return readFileSync(f, 'utf8').split('\n').map(parseAppLine).filter(Boolean)
}

/** The release log's evidence for a window (r4 #1): evidence.ts's, for the flavour measured. */
const evidence = (lines, from, to) => releaseEvidence(lines, from, to, APP ? 'release' : 'dev')

async function once(attempt) {
  const w = await world()
  const fs = []
  for (const slot of [1, 2, 3]) { const f = await startFakeCanvas({ home: w.home, slotBase: w.slotBase, slot, name: `Idle ${slot}`, script: SAY, root: join(w.dir, `repo-${slot}`), cpuBallast: BALLAST && slot === 1 }); await f.ready; fs.push(f) }
  const drive = !APP
  const L = await launch(w, { app: APP, drive })
  const res = { attempt, scene: SCENE, build: APP ?? 'dev (app/dist, production switches, test mode)', ...(BALLAST ? { ballast: 'the first canvas burns a third of a core while hidden' } : {}) }
  try {
    // each canvas loaded once, then every tab hidden
    if (drive) {
      let s = await L.call('state')
      const end = Date.now() + 15_000
      while (s.tabs.filter((t) => t.kind === 'local').length < 3 && Date.now() < end) { await sleep(100); s = await L.call('state') }
      for (const t of s.tabs.filter((x) => x.kind === 'local')) {
        await L.call('activate', { id: t.id })
        const e2 = Date.now() + 15_000
        while (!(await L.call('state')).tabs.find((x) => x.id === t.id)?.doc?.lifted && Date.now() < e2) await sleep(100)
      }
      if (SCENE === 'home') await L.call('activate', { id: 'home' })
      else if (SCENE === 'minimised') await L.call('command', { cmd: 'minimize' })
      else await L.call('command', { cmd: 'close-window' })
    } else {
      const kp = nativeTool('keypost')
      if (!/access: true/.test(execFileSync(kp, ['check'], { encoding: 'utf8' }))) return { ...res, kind: 'inconclusive', why: `blind: ${responsibleApp()} may not post key events (Accessibility)` }
      for (const code of [18, 19, 20]) { execFileSync(kp, [String(L.pid), String(code), 'cmd']); await sleep(2500) }
      if (SCENE === 'home') execFileSync(kp, [String(L.pid), '17', 'cmd'])        // ⌘T: Home
      else if (SCENE === 'minimised') execFileSync(kp, [String(L.pid), '46', 'cmd'])   // ⌘M
      else execFileSync(kp, [String(L.pid), '13', 'cmd,shift'])                   // ⇧⌘W
    }
    if (fs.some((f) => !f.requests.some((q) => q.path === '/' && q.method === 'GET'))) return { ...res, kind: 'inconclusive', why: 'a canvas was never loaded' }
    await sleep(SETTLE * 1000)
    const handler = await crashpadOf({ database: join(w.home, 'perf', 'crashpad') })
    const a = await cpuPass(L.pid, handler, 'start')
    // the 5 s reads: helpers seen to start or end (an idle app should have none)
    const seen = [new Set((await appProcesses(L.pid, { database: join(w.home, 'perf', 'crashpad') })).map((p) => p.pid))]
    const end = Date.now() + MINUTES * 60_000
    while (Date.now() < end) { await sleep(Math.min(5000, end - Date.now())); seen.push(new Set((await appProcesses(L.pid, { database: join(w.home, 'perf', 'crashpad') })).map((p) => p.pid))) }
    const b = await cpuPass(L.pid, handler, 'end')
    // the canvases: the recorder's own log only, in either flavour (code review r1 #3) - its sample after the window
    // waited for, 70 s at most
    let ev = evidence(appLines(w.home) ?? [], a.at, b.at)
    const waitEnd = Date.now() + 70_000
    while (ev.why !== undefined && /after it|no start line/.test(ev.why) && Date.now() < waitEnd) { await sleep(2000); ev = evidence(appLines(w.home) ?? [], a.at, b.at) }
    if (ev.why !== undefined) return { ...res, ...cpuGate({ ev, budget: BUDGET }) }
    const canvasOf = (pid, startedAt) => ev.canvas.some((c) => c.pid === pid && Math.abs(c.born - startedAt) <= 1000)
    const rolesFrom = APP ? 'app.jsonl' : 'app-dev.jsonl'
    const win = cpuWindow(a, b, canvasOf)
    const { started, ended } = churn(seen)
    const base = { ...res, rolesFrom, minutes: MINUTES, cores: Math.round(win.cores * 1e5) / 1e5, seconds: Math.round(win.seconds * 1000) / 1000, canvases: win.canvases, helpersStarted: started, helpersEnded: ended, passes: { start: a, end: b }, spawnMs: ev.spawnMs }
    if (win.kind === 'inconclusive') return { ...base, ...cpuGate({ ev, win, budget: BUDGET }) }
    if (BALLAST) {
      // the burning canvas must be one of those taken out, and burning: else the check checked nothing
      const burned = Math.max(0, ...win.canvases.map((c) => c.seconds))
      base.ballastSeconds = Math.round(burned * 1000) / 1000
      if (burned < 0.1 * MINUTES * 60) return { ...base, kind: 'inconclusive', why: `the ballast canvas burned ${burned.toFixed(2)} s, not a third of a core: it was not taken out, or did not burn` }
    }
    // the recorder against the outside reads, like with like: the processes alive through the window, own CPU only;
    // the gate is decided only once they agree
    const x = crossCheck(a, b, ev.recorder, canvasOf)
    const r5 = (v) => Math.round(v * 1e5) / 1e5
    base.recorderCheck = { ...x, outsideCores: r5(x.outsideCores), recorderCores: r5(x.recorderCores), minutes: ev.minutes }
    const g = cpuGate({ ev, win, cross: x, budget: BUDGET })
    return { ...base, kind: g.kind, ...(g.why ? { why: g.why } : {}) }
  } finally { await L.stop(); for (const f of fs) await f.close(); w.release() }
}

let r
for (let attempt = 1; attempt <= 3; attempt++) {
  r = await once(attempt)
  if (r.kind !== 'inconclusive' || /blind/.test(r.why ?? '')) break
  process.stdout.write(`hidden-cpu: attempt ${attempt} inconclusive (${r.why}); again\n`)
}
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, `hidden-cpu-${SCENE}${BALLAST ? '-ballast' : ''}.json`), JSON.stringify(r, null, 2))
process.stdout.write(r.kind === 'inconclusive' || r.kind === 'harness-error' ? `hidden-cpu (${SCENE}${BALLAST ? ', ballast' : ''}): ${r.kind.toUpperCase()} - ${r.why}\n`
  : `hidden-cpu (${SCENE}${BALLAST ? ', ballast' : ''}): ${SCENE === 'hidden' ? r.kind.toUpperCase() : `REPORTED (${r.kind} against the gate)`} - the app's own CPU ${r.cores} cores over ${r.minutes} min (budget ${BUDGET}; ${r.seconds} s); canvases taken out: ${r.canvases.map((c) => `${c.pid} ${c.seconds.toFixed(3)} s`).join(', ') || 'none'}; helpers started ${r.helpersStarted.length}, ended ${r.helpersEnded.length}; roles from ${r.rolesFrom}; the recorder ${r.recorderCheck?.kind}${r.recorderCheck?.kind === 'unchecked' ? ` (${r.recorderCheck.why})` : ` (${r.recorderCheck?.recorderCores} against ${r.recorderCheck?.outsideCores} cores over ${r.recorderCheck?.joined} processes)`}\n`)
process.stdout.write(`report: ${join(OUT, `hidden-cpu-${SCENE}${BALLAST ? '-ballast' : ''}.json`)}\n`)
process.exit(r.kind === 'pass' ? 0 : r.kind === 'fail' || r.kind === 'harness-error' ? 1 : 3)
