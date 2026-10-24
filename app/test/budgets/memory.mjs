#!/usr/bin/env node
/**
 * The app's own memory, two gates (spec 28 A3.8 #2, #48; the Budgets; Nic, 23 Oct): macOS's footprint (Activity
 * Monitor's Memory, `/usr/bin/footprint`), read from outside the app, never by the app about itself. RSS is reported
 * beside it and decides nothing.
 *
 * - **No canvas open**: three fake canvases registered, Home active, none ever shown (no document request reaches
 *   them), 30 s: 10 s to settle, then the mean of three reads 10 s apart. Counted: the browser, the GPU process,
 *   every utility process, the app pages' renderers (the strip and Home, and the cover's once S15's variant 3 is
 *   built) and Crashpad's handler. Under 200 MB.
 * - **Canvases open**: the three loaded, one shown and two hidden, idle 60 s, then three reads 10 s apart. Counted:
 *   the browser, utility, app-page processes and the handler - not the GPU process, whose footprint, its growth over
 *   the no-canvas run and the RSS sums are reported beside. Under 200 MB.
 * A footprint that cannot be read, renderers that change between reads, a canvas shown in the no-canvas run, or a
 * canvas renderer not told apart makes a run inconclusive, never a pass on RSS. A gate that fails gives its numbers
 * to Nic; the limit stays.
 *
 * **The cover's renderer must be there** (review of a3-native, minor #15): once S15's variant 3 is built its renderer
 * (25-35 MB) counts in the no-canvas gate, so a cover made lazily - on the first canvas - would pass that gate without
 * it. The no-canvas run is inconclusive unless a process with the role `cover` is running: the dev build knows a cover
 * was chosen from its journal (the one ground's `cover` line, `chosen`) and names its renderer with `procs:roles`; the
 * signed build reads the role from the recorder's `sample` lines, and expects it unless `--no-cover` says the build
 * has no S15 cover.
 *
 *   node app/test/budgets/memory.mjs [--app <Marver.app>] [--no-cover] [--out <dir>]
 *
 * The dev build (default) runs under the production switches in test mode (its control socket switches tabs and
 * names the canvas renderers; its window shows inactive, so a run never takes the person's focus). The signed build
 * (`--app`) has no hook: its tabs are switched with keypost (Accessibility) and its canvas renderers named by the
 * recorder's own `sample` lines in perf/app.jsonl; without either the canvas-open gate is inconclusive.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, mb, sleep, world } from './launcher.ts'
import { startFakeCanvas } from '../harness/fake-canvas.ts'
import { appProcesses, footprintMB, rssMB } from '../harness/outside.ts'
import { nativeTool, responsibleApp } from '../harness/capture.ts'

const argv = process.argv.slice(2)
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const APP = val('--app') ? resolve(val('--app')) : undefined
const OUT = resolve(val('--out') ?? '.')
const NO_COVER = argv.includes('--no-cover')
const BUDGET = 200
const SAY = "if (window.marverApp) { marverApp.hello({ version: '0.27.1', board: null, page: 'budget-' + Math.random().toString(36).slice(2, 10) }); marverApp.busy({ busy: false, unsaved: false, why: [] }) }"

/** Three fake canvases registered in a world, each logging its requests. */
async function fakes(w) {
  const out = []
  for (const slot of [1, 2, 3]) {
    const f = await startFakeCanvas({ home: w.home, slotBase: w.slotBase, slot, name: `Budget ${slot}`, script: SAY, root: join(w.dir, `repo-${slot}`) })
    await f.ready
    out.push(f)
  }
  return out
}

/** The canvas renderers' pids: the dev build's hook, else the recorder's last sample line naming roles. */
async function canvasPids(L, w) {
  if (L.control) return new Set((await L.call('procs:roles')).canvas)
  const f = join(w.home, 'perf', 'app.jsonl')
  if (!existsSync(f)) return null
  const last = readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"kind":"sample"')).at(-1)
  if (!last) return null
  return new Set(JSON.parse(last).procs.filter((p) => p.role === 'canvas').map((p) => p.pid))
}

/**
 * Whether the no-canvas run holds the cover's renderer when the build has one: null when it does (or the build has no
 * S15 cover), else why the gate cannot be read. `cover` names the pids, for the report.
 */
async function coverHeld(L, w) {
  if (L.control) {
    const chosen = (await L.call('log', { afterSeq: 0 })).some((l) => l.topic === 'cover' && l.data?.chosen === true)
    if (!chosen) return { why: null, cover: [], note: 'no S15 cover in this build (the journal\'s cover line has chosen false, or there is none)' }
    const pids = (await L.call('procs:roles')).cover ?? []
    return pids.length ? { why: null, cover: pids } : { why: 'S15\'s cover is built but its renderer is not running in the no-canvas run: the gate would leave out what #48 counts', cover: [] }
  }
  if (NO_COVER) return { why: null, cover: [], note: '--no-cover: a build without S15\'s cover' }
  const f = join(w.home, 'perf', 'app.jsonl')
  const last = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"kind":"sample"')).at(-1) : undefined
  if (!last) return { why: 'the cover\'s renderer could not be told apart: no recorder sample line (pass --no-cover for a build without S15\'s cover)', cover: [] }
  const pids = JSON.parse(last).procs.filter((p) => p.role === 'cover').map((p) => p.pid)
  return pids.length ? { why: null, cover: pids } : { why: 'no process with the role cover in the recorder\'s last sample: the cover\'s renderer is not running in the no-canvas run', cover: [] }
}

/** One gate: `settleMs`, then three reads 10 s apart; the mean of the counted footprints. */
async function gate(name, L, w, { countGpu, canvas, settleMs, check }) {
  await sleep(settleMs)
  const reads = []
  for (let i = 0; i < 3; i++) {
    if (i) await sleep(10_000)
    let r = null
    for (let tries = 0; tries < 2 && !r; tries++) {
      const procs = await appProcesses(L.pid, { bundle: APP, database: join(w.home, 'perf', 'crashpad') })
      const pids = procs.map((p) => p.pid)
      const fp = await footprintMB(pids)
      const rss = await rssMB(pids)
      if (procs.length && pids.every((p) => fp.has(p))) r = procs.map((p) => ({ ...p, command: undefined, fpMB: fp.get(p.pid), rssMB: rss.get(p.pid) ?? 0, canvas: canvas.has(p.pid) }))
    }
    reads.push(r)
  }
  const why = !L.alive() ? 'the app went'
    : reads.some((x) => !x) ? 'a footprint could not be read (/usr/bin/footprint)'
      : new Set(reads.map((x) => x.filter((p) => p.role === 'renderer').map((p) => p.pid).sort().join(','))).size > 1 ? 'the renderers changed between reads'
        : !reads[0].some((p) => p.role === 'crashpad') ? 'Crashpad\'s handler was not found'
          : await check?.()
  if (why) return { name, kind: 'inconclusive', why }
  const mean = (f) => reads.reduce((a, x) => a + x.filter(f).reduce((b, p) => b + p.fpMB, 0), 0) / reads.length
  const meanRss = (f) => reads.reduce((a, x) => a + x.filter(f).reduce((b, p) => b + p.rssMB, 0), 0) / reads.length
  const counted = (p) => !p.canvas && (countGpu || p.role !== 'gpu')
  const total = mean(counted)
  const parts = {
    browser: mb(mean((p) => p.role === 'browser')), gpu: mb(mean((p) => p.role === 'gpu')), utility: mb(mean((p) => p.role === 'utility')),
    appPages: mb(mean((p) => p.role === 'renderer' && !p.canvas)), crashpad: mb(mean((p) => p.role === 'crashpad')), other: mb(mean((p) => p.role === 'other')),
    canvases: mb(mean((p) => p.canvas)), appPageRenderers: reads[0].filter((p) => p.role === 'renderer' && !p.canvas).length, canvasRenderers: reads[0].filter((p) => p.canvas).length,
  }
  return {
    name, kind: total < BUDGET ? 'pass' : 'fail', totalMB: mb(total), budgetMB: BUDGET, countGpu, parts,
    rssCountedMB: mb(meanRss(counted)), rssAllMB: mb(meanRss(() => true)), reads,
  }
}

const report = { budget: 'memory', at: new Date().toISOString(), build: APP ?? 'dev (app/dist, production switches, test mode)', gates: [] }
const drive = !APP

// 1. no canvas open
{
  const w = await world()
  const fs = await fakes(w)
  const L = await launch(w, { app: APP, drive })
  try {
    let held = null
    const r = await gate('memory-no-canvas', L, w, {
      countGpu: true, canvas: new Set(), settleMs: 10_000,
      check: async () => {
        if (fs.some((f) => f.requests.some((q) => q.path === '/' && q.method === 'GET'))) return 'a canvas was shown in the no-canvas run'
        held = await coverHeld(L, w)
        return held.why
      },
    })
    report.gates.push({ ...r, cover: held ? { pids: held.cover, ...(held.note ? { note: held.note } : {}) } : null })
  } finally { await L.stop(); for (const f of fs) await f.close(); w.release() }
}

// 2. canvases open: the three loaded, one shown and two hidden
{
  const w = await world()
  const fs = await fakes(w)
  const L = await launch(w, { app: APP, drive })
  try {
    let why = null
    if (drive) {
      const st = async () => L.call('state')
      const end = Date.now() + 15_000
      let s = await st()
      while (s.tabs.filter((t) => t.kind === 'local').length < 3 && Date.now() < end) { await sleep(100); s = await st() }
      const ids = s.tabs.filter((t) => t.kind === 'local').map((t) => t.id)
      for (const id of ids) {
        await L.call('activate', { id })
        const end2 = Date.now() + 15_000
        while (!(await st()).tabs.find((t) => t.id === id)?.doc?.lifted) { if (Date.now() > end2) { why = `the canvas ${id} never lifted`; break } await sleep(100) }
      }
    } else {
      // the signed build: ⌘1, ⌘2, ⌘3 with keypost (Accessibility)
      const kp = nativeTool('keypost')
      if (!/access: true/.test(execFileSync(kp, ['check'], { encoding: 'utf8' }))) why = `blind: ${responsibleApp()} may not post key events (Accessibility)`
      else for (const code of [18, 19, 20]) { execFileSync(kp, [String(L.pid), String(code), 'cmd']); await sleep(2000) }
    }
    const canvas = why ? new Set() : await canvasPids(L, w)
    if (!why && (!canvas || !canvas.size)) why = 'the canvas renderers could not be told apart (no hook, no recorder sample line)'
    const r = why ? { name: 'memory-canvas-open', kind: 'inconclusive', why }
      : await gate('memory-canvas-open', L, w, {
        countGpu: false, canvas, settleMs: 60_000,
        check: async () => fs.some((f) => !f.requests.some((q) => q.path === '/' && q.method === 'GET')) ? 'a canvas was never loaded' : null,
      })
    report.gates.push(r)
  } finally { await L.stop(); for (const f of fs) await f.close(); w.release() }
}

const noCanvas = report.gates[0]
const open = report.gates[1]
if (noCanvas.parts && open.parts) open.gpuGrowthMB = mb(open.parts.gpu - noCanvas.parts.gpu)
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'memory.json'), JSON.stringify(report, null, 2))
for (const g of report.gates) {
  if (g.kind === 'inconclusive') { process.stdout.write(`${g.name}: INCONCLUSIVE - ${g.why}\n`); continue }
  const p = g.parts
  process.stdout.write(`${g.name}: ${g.kind.toUpperCase()} ${g.totalMB} MB footprint (budget ${BUDGET}): browser ${p.browser}, utility ${p.utility}, app pages ${p.appPages} (${p.appPageRenderers}), crashpad ${p.crashpad}${p.other ? `, other ${p.other}` : ''}, GPU ${p.gpu} ${g.countGpu ? 'counted' : `reported, not counted${g.gpuGrowthMB !== undefined ? ` (${g.gpuGrowthMB >= 0 ? '+' : ''}${g.gpuGrowthMB} over the no-canvas run)` : ''}`}${p.canvasRenderers ? `; canvases ${p.canvases} (${p.canvasRenderers} renderers) not counted` : ''}; RSS ${g.rssCountedMB} counted, ${g.rssAllMB} all\n`)
}
process.stdout.write(`report: ${join(OUT, 'memory.json')}\n`)
process.exit(report.gates.every((g) => g.kind === 'pass') ? 0 : report.gates.some((g) => g.kind === 'fail') ? 1 : 3)
