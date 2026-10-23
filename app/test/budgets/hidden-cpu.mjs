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
 * Which processes are canvases: on the signed build, only the release's own `app.jsonl` (r4 #1) - the measured
 * launch's lines from the last `sample` before the window to the first after it (waited for, 70 s at most), whole:
 * `seq` contiguous, no `dropped` line, both bounding samples present; a canvas tab's `gone`, `unload` or `tab` line
 * with a new commit inside makes the run inconclusive. Then the recorder's own figure for the processes alive
 * through the window must agree with the outside one within 0.001 cores or 20 %, else the harness fails as its own
 * error. The dev build (default; test mode over its control socket, production switches) names the canvases with
 * its procs:roles hook when the recorder has written no sample line - labelled, since a test hook is not the
 * release's evidence.
 *
 * Reported, not gated: helpers seen to start or end at the 5 s reads, each canvas renderer's CPU, the probes'
 * spawn time, and (with --scene) Home active with every canvas hidden, or the window minimised.
 *
 *   node app/test/budgets/hidden-cpu.mjs [--app <Marver.app>] [--minutes 5] [--settle 60] [--scene hidden|home|minimised] [--out <dir>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, sleep, world } from './launcher.ts'
import { startFakeCanvas } from '../harness/fake-canvas.ts'
import { appProcesses, cpuPass, cpuWindow, crashpadOf } from '../harness/outside.ts'
import { nativeTool, responsibleApp } from '../harness/capture.ts'
import { parseAppLine } from '../../../src/shared/app-perf.ts'

const argv = process.argv.slice(2)
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const APP = val('--app') ? resolve(val('--app')) : undefined
const OUT = resolve(val('--out') ?? '.')
const MINUTES = Number(val('--minutes') ?? 5)
const SETTLE = Number(val('--settle') ?? 60)
const SCENE = val('--scene') ?? 'hidden'
const BUDGET = 0.01
const SAY = "if (window.marverApp) { marverApp.hello({ version: '0.27.1', board: null, page: 'cpu-' + Math.random().toString(36).slice(2, 10) }); marverApp.busy({ busy: false, unsaved: false, why: [] }) }"

/** The measured launch's lines of app.jsonl (or app-dev.jsonl), parsed; null when there is no file. */
function appLines(home) {
  const f = join(home, 'perf', APP ? 'app.jsonl' : 'app-dev.jsonl')
  if (!existsSync(f)) return null
  return readFileSync(f, 'utf8').split('\n').map(parseAppLine).filter(Boolean)
}

/**
 * The release log's evidence for a window (r4 #1): the lines from the last sample before `from` to the first after
 * `to`, whole, and the canvas pids they name. null with a reason when it cannot prove the roles.
 */
function evidence(lines, from, to) {
  const start = lines.find((l) => l.kind === 'start')
  if (!start) return { why: 'no start line' }
  const mine = lines.filter((l) => l.app === start.app && l.flavour === (APP ? 'release' : 'dev'))
  const samples = mine.filter((l) => l.kind === 'sample')
  const before = samples.filter((l) => l.ts <= from).at(-1)
  const after = samples.find((l) => l.ts >= to)
  if (!before || !after) return { why: `no sample line ${!before ? 'before the window' : 'after it'}` }
  const span = mine.filter((l) => l.seq >= before.seq && l.seq <= after.seq)
  for (let i = 1; i < span.length; i++) if (span[i].seq !== span[i - 1].seq + 1) return { why: `a seq gap at ${span[i - 1].seq}` }
  if (span.some((l) => l.kind === 'dropped')) return { why: 'a dropped line' }
  const canvasTabs = new Set(span.filter((l) => l.kind === 'sample').flatMap((l) => l.procs.filter((p) => p.role === 'canvas').flatMap((p) => p.tabs)))
  const commits = new Map()
  for (const l of span) {
    if ((l.kind === 'gone' || l.kind === 'unload') && canvasTabs.has(l.tab)) return { why: `a canvas tab's ${l.kind} line inside the window` }
    if (l.kind === 'tab' && canvasTabs.has(l.tab)) {
      if (commits.has(l.tab) && commits.get(l.tab) !== l.commit) return { why: 'a canvas tab committed a new document inside the window' }
      commits.set(l.tab, l.commit)
    }
  }
  const canvas = span.filter((l) => l.kind === 'sample').flatMap((l) => l.procs.filter((p) => p.role === 'canvas').map((p) => ({ pid: p.pid, born: p.born })))
  // the recorder's own figure: its minute lines' CPU over the processes it does not call canvas
  const minutes = span.filter((l) => l.kind === 'sample' && l.ts > from && l.ts <= to + 60_000)
  const secs = minutes.reduce((s, l) => s + l.procs.filter((p) => p.role !== 'canvas').reduce((a, p) => a + (p.cpu.mean ?? 0) * l.span / 1000, 0) + (l.gpu?.cpu.mean ?? 0) * l.span / 1000, 0)
  const spanS = minutes.reduce((s, l) => s + l.span / 1000, 0)
  return { canvas, recorderCores: spanS ? secs / spanS : null, spawnMs: minutes.reduce((s, l) => s + (l.spawnMs ?? 0), 0), lines: span.length }
}

async function once(attempt) {
  const w = await world()
  const fs = []
  for (const slot of [1, 2, 3]) { const f = await startFakeCanvas({ home: w.home, slotBase: w.slotBase, slot, name: `Idle ${slot}`, script: SAY, root: join(w.dir, `repo-${slot}`) }); await f.ready; fs.push(f) }
  const drive = !APP
  const L = await launch(w, { app: APP, drive, env: { MARVER_APP_HEARTBEAT: '0' } })
  const res = { attempt, scene: SCENE, build: APP ?? 'dev (app/dist, production switches, test mode)' }
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
    const handler = await crashpadOf({ bundle: APP, database: join(w.home, 'perf', 'crashpad') })
    const rolesA = drive ? await L.call('procs:roles') : null
    const a = await cpuPass(L.pid, handler, 'start')
    // the 5 s reads: helpers seen to start or end (an idle app should have none)
    const seen = [new Set((await appProcesses(L.pid, { bundle: APP, database: join(w.home, 'perf', 'crashpad') })).map((p) => p.pid))]
    const end = Date.now() + MINUTES * 60_000
    while (Date.now() < end) { await sleep(Math.min(5000, end - Date.now())); seen.push(new Set((await appProcesses(L.pid, { bundle: APP, database: join(w.home, 'perf', 'crashpad') })).map((p) => p.pid))) }
    const b = await cpuPass(L.pid, handler, 'end')
    const rolesB = drive ? await L.call('procs:roles') : null
    // the canvases: the release log, else (dev only) the hook, labelled
    let lines = appLines(w.home)
    let ev = null
    if (lines?.some((l) => l.kind === 'sample')) {
      const waitEnd = Date.now() + 70_000
      while (!(ev = evidence(lines, a.at, b.at)).canvas && /after it/.test(ev.why ?? '') && Date.now() < waitEnd) { await sleep(2000); lines = appLines(w.home) }
    }
    let canvasOf
    let rolesFrom
    if (ev?.canvas) { canvasOf = (pid, startedAt) => ev.canvas.some((c) => c.pid === pid && Math.abs(c.born - startedAt) <= 1000); rolesFrom = 'app.jsonl' }
    else if (APP) return { ...res, kind: 'inconclusive', why: `the release's log does not prove the roles: ${ev?.why ?? 'no sample line (the recorder wrote none)'}` }
    else { const c = new Set([...rolesA.canvas, ...rolesB.canvas]); canvasOf = (pid) => c.has(pid); rolesFrom = `the dev build's procs:roles hook (no recorder sample line${ev?.why ? `: ${ev.why}` : ''})` }
    const win = cpuWindow(a, b, canvasOf)
    const started = [...seen.at(-1)].filter((p) => !seen[0].has(p))
    const ended = [...seen[0]].filter((p) => !seen.at(-1).has(p))
    const base = { ...res, rolesFrom, minutes: MINUTES, cores: Math.round(win.cores * 1e5) / 1e5, seconds: Math.round(win.seconds * 1000) / 1000, canvases: win.canvases, helpersStarted: started, helpersEnded: ended, passes: { start: a, end: b }, spawnMs: ev?.spawnMs ?? null }
    if (win.kind === 'inconclusive') return { ...base, kind: 'inconclusive', why: win.why }
    if (ev?.recorderCores != null) {
      const diff = Math.abs(ev.recorderCores - win.cores)
      base.recorderCores = Math.round(ev.recorderCores * 1e5) / 1e5
      if (diff > Math.max(0.001, 0.2 * win.cores)) return { ...base, kind: 'harness-error', why: `the recorder's figure ${ev.recorderCores.toFixed(5)} and the outside one ${win.cores.toFixed(5)} disagree: the recorder is broken (it cannot pass itself)` }
    } else base.recorderCores = 'not checked: no recorder sample lines'
    return { ...base, kind: win.cores < BUDGET ? 'pass' : 'fail' }
  } finally { await L.stop(); for (const f of fs) await f.close(); w.release() }
}

let r
for (let attempt = 1; attempt <= 3; attempt++) {
  r = await once(attempt)
  if (r.kind !== 'inconclusive' || /blind/.test(r.why ?? '')) break
  process.stdout.write(`hidden-cpu: attempt ${attempt} inconclusive (${r.why}); again\n`)
}
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, `hidden-cpu-${SCENE}.json`), JSON.stringify(r, null, 2))
process.stdout.write(r.kind === 'inconclusive' || r.kind === 'harness-error' ? `hidden-cpu (${SCENE}): ${r.kind.toUpperCase()} - ${r.why}\n`
  : `hidden-cpu (${SCENE}): ${SCENE === 'hidden' ? r.kind.toUpperCase() : `REPORTED (${r.kind} against the gate)`} - the app's own CPU ${r.cores} cores over ${r.minutes} min (budget ${BUDGET}; ${r.seconds} s); canvases taken out: ${r.canvases.map((c) => `${c.pid} ${c.seconds.toFixed(3)} s`).join(', ') || 'none'}; helpers started ${r.helpersStarted.length}, ended ${r.helpersEnded.length}; roles from ${r.rolesFrom}; the recorder's figure ${r.recorderCores}\n`)
process.stdout.write(`report: ${join(OUT, `hidden-cpu-${SCENE}.json`)}\n`)
process.exit(r.kind === 'pass' ? 0 : r.kind === 'fail' || r.kind === 'harness-error' ? 1 : 3)
