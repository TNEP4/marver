/**
 * The capture matrix (spec 28 A2.10 (A3), A3.8 #34-#37): transitions of the real app, each watched at every refresh
 * by ScreenCaptureKit (test/native/capture.swift, a window stream, the window kept on top) and judged against main's
 * journal (both clocks mach_continuous_time in ns: the control case checks they line up). The app runs with its
 * production switches in test mode (its control socket drives it), on the real trust and bridge, with ground-mode
 * fake canvases (test/harness/fake-canvas.ts): A and B offer the inset, C does not.
 *
 * What is read: the strip's empty part (from the strip itself: between its last tab and its pill), with two narrow
 * regions where a document's tags sit - its document tag at the centre and its size tag at innerWidth - 260. Each
 * sample is classified against colours calibrated as the capture shows them (the cover's ground and dots, read with
 * Home shown; the tags read where they show), never as hex. A frame is good when nothing under the tabs is a page
 * pixel the case does not allow.
 *
 * Two layouts, found from main's own view journal:
 * - **opaque** (app 0.1, and 0.2 until the one ground lands): every view below the strip, the cover always shown -
 *   every case is exact: nothing but ground and dots under the tabs, ever;
 * - **one ground** (0.2): a full-height view under a see-through strip - after an uncover the active document's own
 *   tags are allowed, anything else (an earlier document's or size's tag, another tab's, white) is a bad frame;
 *   covering cases count from main's decision. Per case, the p95 of bad refreshes at most 2 and every bad interval at
 *   most 100 ms (A3.8 #36); exact cases count zero.
 * A transition is inconclusive on a gap, a blank sample or a short bad tail with no good frame after it; it is run
 * again, three times at most; three inconclusive runs fail the case. Built here: reload, navigation, programmatic
 * resize, a switch to a see-through tab, to a covered tab and to Home, a canvas killed, rapid switches with the strip
 * stalled, a stalled canvas. Not built here (each needs what the one ground or another stream brings): steady panning
 * on a real shell, the live resize (a CGEvent drag: Accessibility), a failed proof and an instance mismatch from full
 * height, an error page to a trusted page, a tab page's lift, HTML fullscreen, a late reply of an earlier epoch, and
 * the four under load.
 *
 *   node app/test/capture/matrix.ts [--n 40] [--cases reload,switch-covered,...] [--out <dir>]
 * Exit 77 when blind (not run, never passed): Screen Recording not granted to the process running it, the screen
 * locked or the display asleep (checked first, and again by the heartbeat's own second: only idle frames is blind).
 * Else 0 when every built case passed, 1 when one failed, 3 when one is inconclusive or broke.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CaptureBlind, Palette, blindLine, captureAccess, judgeCase, judgeTransition, startCapture, type CaptureFrame, type CaseVerdict, type TransitionVerdict } from '../harness/capture.ts'
import { DOC_TAGS, SIZE_TAG, SIZE_TAG_X, startFakeCanvas, type FakeCanvas } from '../harness/fake-canvas.ts'
import { launch, sleep, world, type Launch } from '../budgets/launcher.ts'

const argv = process.argv.slice(2)
const val = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const N = Number(val('--n') ?? 40)
const OUT = resolve(val('--out') ?? '.')
const ONLY = val('--cases')?.split(',')
const W = 1280, H = 820

interface Tab { id: string; fake: FakeCanvas }
interface State { active: string; tabs: { id: string; reg: { instance: string; state: string } | null; doc: { lifted?: boolean; trusted: boolean; commits: number } | null }[] }
interface LogLine { topic: string; t: string; data: Record<string, unknown> }

const access = await captureAccess()
if (access !== true) {
  process.stdout.write(`capture matrix: BLIND - not run. ${blindLine(access)}\n`)
  process.exit(77)
}

const w = await world()
const fakes: FakeCanvas[] = []
let L: Launch | undefined
const report: { at: string; layout?: string; refreshHz?: number; clockSkewMs?: number; heartbeat?: { frames: number; complete: number; gaps: number[] }; blind?: string; cases: Record<string, CaseVerdict & { exact: boolean; detail: TransitionVerdict[] } | { kind: 'not-built' | 'error'; why: string }> } = { at: new Date().toISOString(), cases: {} }
try {
  for (const [slot, name, inset] of [[1, 'Alpha', true], [2, 'Beta', true], [3, 'Gamma', false]] as const) {
    const f = await startFakeCanvas({ home: w.home, slotBase: w.slotBase, slot, name, ground: true, features: inset ? ['bridge', 'inset'] : ['bridge'], root: join(w.dir, `repo-${slot}`) })
    await f.ready
    fakes.push(f)
  }
  // forty crashes in a minute would latch the tab (A2.11): the matrix shortens the latch window, nothing else
  L = await launch(w, { drive: true, env: { MARVER_APP_TIMINGS: JSON.stringify({ crashWindowMs: 200 }) } })
  const call = <T = unknown>(n: string, a?: unknown) => L!.call<T>(n, a)
  await call('resize', { width: W, height: H })
  await call('onTop', { on: true })
  const state = () => call<State>('state')
  const until = async (f: (s: State) => boolean, ms: number, what: string) => {
    const end = Date.now() + ms
    for (;;) { const s = await state(); if (f(s)) return s; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(50) }
  }
  const s0 = await until((s) => fakes.every((f) => s.tabs.some((t) => t.reg?.instance === f.instance && t.reg.state === 'ready')), 15_000, 'the three tabs')
  const tabs: Tab[] = fakes.map((f) => ({ fake: f, id: s0.tabs.find((t) => t.reg?.instance === f.instance)!.id }))
  const [A, B, C] = tabs as [Tab, Tab, Tab]
  const lifted = (id: string) => until((s) => { const t = s.tabs.find((x) => x.id === id); return !!t?.doc?.lifted && !!t.doc.trusted }, 15_000, `${id} lifted`)
  for (const t of [C, B, A]) { await call('activate', { id: t.id }); await lifted(t.id) }
  await sleep(500)
  // the layout, from Electron's own bounds: a full-height canvas view is the one ground
  const views = await call<{ key: string; bounds: { y: number } }[]>('views')
  const layout = views.find((v) => v.key === `${A.id}:view`)?.bounds.y === 0 ? 'one-ground' : 'opaque'
  report.layout = layout
  // the strip's empty part, from the strip
  const span = await call<{ l: number; r: number }>('exec', { target: 'strip', js: `(() => { const t = [...document.querySelectorAll('#tabs > *')].pop(); const p = document.getElementById('pill'); return { l: Math.round(t ? t.getBoundingClientRect().right + 8 : 120), r: Math.round(p && !p.hidden ? p.getBoundingClientRect().left - 8 : innerWidth - 20) } })()` })
  const regions = {
    strip: { x: span.l, y: 6, w: Math.max(10, span.r - span.l), h: 32 },
    doc: { x: W / 2 - 24, y: 16, w: 48, h: 12 },
    size: { x: W - SIZE_TAG_X + 2, y: 16, w: 8, h: 12 },
  }
  // the heartbeat (A3.8 #29, #37): a 1 px compositor animation in the strip's corner, so every refresh has a frame and
  // a gap is a missed one - it keeps going while the strip's main thread is stalled. Main inserts it in test builds
  // once the one ground is built; until then the runner puts it there, outside the regions it reads
  const HEARTBEAT = `(() => { if (document.getElementById('mv-hb')) return 1; const st = document.createElement('style'); st.textContent = '@keyframes mvhb { from { opacity: .1 } to { opacity: .9 } }'; document.head.appendChild(st);
    const d = document.createElement('div'); d.id = 'mv-hb'; d.style.cssText = 'position:fixed;right:2px;bottom:2px;width:1px;height:1px;background:#000;pointer-events:none;z-index:2147483647;animation:mvhb 1s linear infinite alternate'; document.body.appendChild(d); return 1 })()`
  const heartbeat = async () => { for (let i = 0; i < 40; i++) { if (await call('exec', { target: 'strip', js: HEARTBEAT }).catch(() => 0)) return; await sleep(100) } }
  await heartbeat()
  const winId = await call<number | null>('window:id')
  if (!winId) throw new Error('no window id')
  const cap = await startCapture({ mode: 'window', windowId: winId, regions, grid: [12, 2] })
  report.refreshHz = cap.ready.refreshHz
  report.clockSkewMs = Math.round(Number(process.hrtime.bigint() - BigInt(cap.ready.hostNs)) / 1e5) / 10
  if (Math.abs(report.clockSkewMs) > 5) throw new Error(`the clocks do not line up: ${report.clockSkewMs} ms`)
  // the heartbeat's own second: every refresh a frame, and complete ones among them. Only idle frames is a screen
  // that composites nothing (locked, or the display asleep, after the check): blind, never a pass
  {
    const h0 = cap.frames.length
    await sleep(1000)
    const hb = cap.frames.slice(h0)
    report.heartbeat = { frames: hb.length, complete: hb.filter((f) => f.status === 'complete').length, gaps: hb.filter((f) => f.gap).map((f) => f.gap!) }
    if (!report.heartbeat.complete) throw new CaptureBlind('the screen unlocked and the display awake', 'locked')
  }
  const samples = (since: bigint) => cap.frames.filter((f) => BigInt(f.hostNs) >= since && f.status === 'complete' && f.regions).flatMap((f) => Object.values(f.regions!).flat())
  // calibration: Home shows the cover's ground and dots under the strip (and its own page, at full height, in 0.2)
  await call('activate', { id: 'home' })
  await sleep(400)
  const g0 = process.hrtime.bigint()
  await sleep(300)
  const pal = new Palette(22).add('ground', samples(g0)).between('ground', '#e7e9ef', '#c9cbd5')
  // the tags, as hex with a wider tolerance until a see-through frame shows them (then calibrated)
  const tagPal = new Palette(40)
  for (const t of DOC_TAGS) tagPal.add(`tag:${t}`, [t])
  tagPal.add('size', [SIZE_TAG])
  const classify = (hex: string) => { const c = pal.classify(hex); return c === 'ground' ? 'ground' : tagPal.classify(hex) }

  const journalSince = async (n: number) => (await call<LogLine[]>('log', { since: n }))
  const logLen = async () => (await call<LogLine[]>('log')).length
  /** main's decision: the first compose the action made, its journal time (ns) */
  async function act(f: () => Promise<unknown>): Promise<bigint> {
    const n = await logLen()
    const before = process.hrtime.bigint()
    await f()
    for (let i = 0; i < 40; i++) {
      const c = (await journalSince(n)).find((l) => l.topic === 'compose')
      if (c) return BigInt(c.t)
      await sleep(25)
    }
    return before
  }
  /** a frame's verdict when only ground (and, in one ground, `allow`'s tags) may show under the tabs */
  const verdictFor = (allow: () => Set<string>) => (f: CaptureFrame) => {
    const ok = allow()
    // a sample outside a window resized smaller reads nothing ('') and says nothing
    for (const s of Object.values(f.regions ?? {}).flat()) { if (!s) continue; const c = classify(s); if (c !== 'ground' && !ok.has(c)) return 'bad' as const }
    return 'good' as const
  }
  const tagOf = (t: Tab) => `tag:${t.fake.tags.at(-1)?.tag}`

  /** setup once, run + each per transition, teardown once */
  type Case = { name: string; exact: boolean; setup?: () => Promise<void>; run: () => Promise<{ t0: bigint; allow: () => Set<string>; settleMs?: number }>; each?: () => Promise<void>; teardown?: () => Promise<void> }
  const exactAll = layout === 'opaque'
  const seeThrough = (t: Tab) => () => layout === 'one-ground' ? new Set([tagOf(t), 'size']) : new Set<string>()
  const none = () => new Set<string>()
  let flip = false
  const cases: Case[] = [
    { name: 'reload', exact: exactAll, setup: async () => { await call('activate', { id: A.id }); await lifted(A.id) },
      run: async () => ({ t0: await act(() => call('reloadPage', { target: A.id })), allow: seeThrough(A), settleMs: 900 }) },
    { name: 'navigation', exact: exactAll, setup: async () => { await call('activate', { id: A.id }); await lifted(A.id) },
      run: async () => { const next = DOC_TAGS[(A.fake.tags.length + 3) % DOC_TAGS.length]; return { t0: await act(() => call('exec', { target: A.id, js: `location.href = '/?mvtag=${next}'; 1` })), allow: seeThrough(A), settleMs: 900 } } },
    { name: 'resize', exact: exactAll, setup: async () => { await call('activate', { id: A.id }); await lifted(A.id) },
      run: async () => { flip = !flip; return { t0: await act(() => call('resize', flip ? { width: W - 120, height: H - 60 } : { width: W, height: H })), allow: seeThrough(A), settleMs: 700 } },
      teardown: async () => { await call('resize', { width: W, height: H }); await sleep(300) } },
    { name: 'switch-see-through', exact: exactAll,
      run: async () => { flip = !flip; const t = flip ? B : A; return { t0: await act(() => call('activate', { id: t.id })), allow: seeThrough(t), settleMs: 600 } } },
    { name: 'switch-covered', exact: exactAll,
      run: async () => { flip = !flip; const t = flip ? C : A; return { t0: await act(() => call('activate', { id: t.id })), allow: t === C ? none : seeThrough(A), settleMs: 600 } } },
    { name: 'switch-home', exact: exactAll,
      run: async () => { flip = !flip; return { t0: await act(() => call('activate', { id: flip ? 'home' : A.id })), allow: flip ? none : seeThrough(A), settleMs: 600 } } },
    { name: 'canvas-killed', exact: exactAll, setup: async () => { await call('activate', { id: B.id }); await lifted(B.id) },
      run: async () => ({ t0: await act(() => call('crash', { target: B.id })), allow: none, settleMs: 500 }),
      each: async () => { await sleep(300); await lifted(B.id).catch(() => {}) } },
    { name: 'switches-strip-stalled', exact: exactAll, setup: async () => { await call('exec', { target: 'strip', js: 'setTimeout(() => { const e = Date.now() + 120000; while (Date.now() < e) {} }, 0); 1' }) },
      run: async () => { flip = !flip; const t = flip ? C : A; return { t0: await act(() => call('activate', { id: t.id })), allow: t === C ? none : seeThrough(A), settleMs: 350 } },
      teardown: async () => { await call('crash', { target: 'strip' }); await sleep(1500); await heartbeat() } },
    { name: 'canvas-stalled', exact: true, setup: async () => { await call('activate', { id: 'home' }); await sleep(300) },
      // a hidden tab stalled, resized, then shown: nothing of it under the tabs before its answer (exact)
      run: async () => {
        await call('exec', { target: B.id, js: 'setTimeout(() => { const e = Date.now() + 1500; while (Date.now() < e) {} }, 0); 1' })
        await call('resize', { width: W - 80, height: H })
        return { t0: await act(() => call('activate', { id: B.id })), allow: none, settleMs: 1300 }
      },
      each: async () => { await call('resize', { width: W, height: H }); await call('activate', { id: 'home' }); await sleep(900) } },
  ]

  for (const c of cases) {
    if (ONLY && !ONLY.includes(c.name)) continue
    process.stdout.write(`capture matrix: ${c.name}...\n`)
    try {
      await c.setup?.()
      const detail: TransitionVerdict[] = []
      for (let i = 0; i < N; i++) {
        let v: TransitionVerdict = { kind: 'inconclusive', why: 'not run' }
        for (let tries = 0; tries < 3 && v.kind === 'inconclusive'; tries++) {
          const r = await c.run()
          await sleep(r.settleMs ?? 600)
          const t1 = process.hrtime.bigint() - 50_000_000n
          v = judgeTransition(cap.frames, { t0: r.t0, t1, refreshHz: cap.ready.refreshHz, verdict: verdictFor(r.allow), ...(c.exact ? { maxN: 0 } : {}) })
          await c.each?.()
        }
        detail.push(v)
      }
      await c.teardown?.()
      const j = judgeCase(detail, { exact: c.exact })
      report.cases[c.name] = { ...j, exact: c.exact, detail }
      process.stdout.write(`  ${j.kind.toUpperCase()} ${c.exact ? 'exact' : 'threshold'}: p95 n ${j.p95n}, max ${j.maxMs} ms, ${j.inconclusive} inconclusive of ${j.transitions}\n`)
      if (j.kind !== 'pass') await cap.png(join(OUT, `matrix-${c.name}.png`))
    } catch (e) {
      report.cases[c.name] = { kind: 'error', why: (e as Error).message }
      process.stdout.write(`  ERROR ${(e as Error).message}\n`)
    }
  }
  for (const n of ['steady-pan (a real shell)', 'live-resize (CGEvent drag: Accessibility)', 'failed-proof and instance-mismatch from full height', 'error-page to trusted', 'tab-page lift', 'html-fullscreen', 'late-reply of an earlier epoch', 'under load (a second window)'])
    report.cases[n] = { kind: 'not-built', why: 'needs the one ground (or another stream) before it can be staged here' }
  await cap.stop()
} catch (e) {
  if (!(e instanceof CaptureBlind)) throw e
  report.blind = e.message
} finally {
  await L?.stop()
  for (const f of fakes) await f.close()
  w.release()
}
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'matrix.json'), JSON.stringify(report, null, 2))
if (report.blind) { process.stdout.write(`capture matrix: BLIND - not run. ${report.blind}\nreport: ${join(OUT, 'matrix.json')}\n`); process.exit(77) }
const built = Object.values(report.cases).filter((c) => c.kind !== 'not-built')
const hb = report.heartbeat
process.stdout.write(`capture matrix (${report.layout} layout, ${report.refreshHz} Hz, clocks ${report.clockSkewMs} ms, heartbeat ${hb?.complete}/${hb?.frames} complete in 1 s, ${hb?.gaps.length} gaps): report ${join(OUT, 'matrix.json')}\n`)
// 0 every built case passed, 1 one failed, 3 none failed but one is inconclusive or broke (never a pass)
process.exit(built.some((c) => c.kind === 'fail') ? 1 : built.every((c) => c.kind === 'pass') ? 0 : 3)
