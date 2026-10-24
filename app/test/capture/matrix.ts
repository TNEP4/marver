/**
 * The capture matrix (spec 28 A2.10 (A3), A3.8 #34-#37): transitions of the real app, each watched at every refresh
 * by ScreenCaptureKit (test/native/capture.swift, a window stream, the window kept on top) and judged against main's
 * journal. The app runs with its production switches in test mode (its control socket drives it), on the real trust
 * and bridge, with ground-mode fake canvases (test/harness/fake-canvas.ts): A and B offer the inset, C does not.
 *
 * **It proves nothing until the one ground lands.** In the opaque layout (app 0.1, and 0.2 until the one ground
 * builds its cover) every canvas view sits at y >= 44, so the strip's empty part can only ever show the strip or the
 * cover: every case would pass by construction. So the opaque layout reports each case NOT APPLICABLE and exits 3,
 * never 0, after the clock control (which needs no full-height view).
 *
 * In the one ground (a full-height view under a see-through strip) it reads the strip's empty part (from the strip
 * itself: between its last tab and its pill), the document tag's place at the centre, and a narrow region where each
 * width the run uses draws the size tag (`innerWidth - 260`). Before a transition's decision, what showed before it
 * may show; from main's decision (the first compose that makes the target active, read from the journal by time),
 * only ground and dots; from each `present uncover` of the target, that document's own tag, its band, and its size
 * tag only where a view of the uncovered width draws it - a frame of an older width, an earlier document's tag,
 * another tab's, white: a bad frame (matrix-judge.ts). Each transition runs until the journal says the state settled
 * (quiet 150 ms with the target active, and for a see-through target its uncover), then 100 ms and 4 refreshes more
 * (A3.8 #35); one that never settles, or in which main composed nothing, is inconclusive, never judged. A
 * transition's tail is evidence too (judgeTransition: the first frame after its window must have arrived).
 *
 * Calibration (A3.8 #34), never as hex: the ground and its dots from a known source - a test-mode marker view painted
 * the ground of the app's look, then its dot colour - and Home's samples must sit on that ground-dot line, else the
 * run refuses to judge; each document tag, the size tag and the fixture's band as a see-through frame shows them
 * (A navigated to each tag); two classes within the tolerance refuse the run.
 *
 * The clock control (A3.8 #36): main shows and hides a marker (the `clock:marker` hook) and journals each change; its
 * first frame must be displayed 0 to 3 refreshes later, else the run is inconclusive.
 *
 * An inconclusive transition is run again; three inconclusive runs fail the case (`retried`, A3.8 #37). A failing
 * transition writes the frames around its first bad one (the helper's ring of the strip, two seconds deep).
 *
 * Built here: reload, navigation, programmatic resize, a switch to a see-through tab, to a covered tab and to Home, a
 * canvas killed, rapid switches with the strip stalled, a stalled canvas. Not built (8 of 15; each needs the one
 * ground, Accessibility or another stream): steady panning on a real shell, the live resize (a CGEvent drag), a failed
 * proof and an instance mismatch from full height, an error page to a trusted page, a tab page's lift, HTML
 * fullscreen, a late reply of an earlier epoch, and the four under load.
 *
 *   node app/test/capture/matrix.ts [--n 40] [--cases reload,switch-covered,...] [--control] [--dump] [--out <dir>]
 * `--control`: only the heartbeat's second and the clock control, in whatever layout - the harness checking itself,
 * no case judged: exit 0 when the clock control holds, else 3. Exit 77 when blind (not run, never passed): Screen
 * Recording not granted to the process running it, the screen locked or the display asleep. Else 0 when every built
 * case passed in the one ground, 1 when one failed, 3 when one is inconclusive or broke, the calibration or the clock
 * control failed, or the layout is opaque (not applicable).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CaptureBlind, Palette, TRIES, blindLine, captureAccess, clockControl, judgeCase, judgeTransition, retried, startCapture, type CaptureFrame, type CaptureSession, type CaseVerdict, type ClockControl, type TransitionVerdict } from '../harness/capture.ts'
import { DOC_TAGS, SIZE_TAG_X, startFakeCanvas, type FakeCanvas } from '../harness/fake-canvas.ts'
import { launch, sleep, world, type Launch } from '../budgets/launcher.ts'
import { clash, decisionOf, docTagRect, frameVerdict, mode, samplePoint, settleOf, shownAt, sizeTagRect, type Classify, type LogLine, type Rect, type Segment, type Shown } from './matrix-judge.ts'

const argv = process.argv.slice(2)
const val = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const N = Number(val('--n') ?? 40)
const OUT = resolve(val('--out') ?? '.')
const ONLY = val('--cases')?.split(',')
const CONTROL_ONLY = argv.includes('--control')
const DUMP = argv.includes('--dump')
const W = 1280, H = 820
/** the widths the run uses: each has a size-tag region where a view of that width draws it */
const WIDTHS = [W, W - 120, W - 80]
const GRID = [12, 2] as const
const MS = 1_000_000n
/** the ground and its dots, per look (src/client/shell/styles.css, app/src/main/plan.ts) */
const LOOK: Record<string, { ground: string; dot: string }> = { light: { ground: 'e7e9ef', dot: 'c9cbd5' }, dark: { ground: '1b1c23', dot: '35363f' } }

interface Tab { id: string; fake: FakeCanvas }
interface State { active: string; tabs: { id: string; reg: { instance: string; state: string } | null; doc: { lifted?: boolean; trusted: boolean; commits: number } | null }[] }
type CaseReport = (CaseVerdict & { exact: boolean; detail: (TransitionVerdict & { evidence?: string[] })[] }) | { kind: 'not-built' | 'not-applicable' | 'error'; why: string }

/** The run ends early on purpose (`--control`, or the opaque layout): its report is written, nothing judged. */
class Done extends Error {}
/** The calibration cannot tell the classes apart, or its source is not what it should be: no case is judged. */
class CalibrationRefused extends Error {}

const access = await captureAccess()
if (access !== true) {
  process.stdout.write(`capture matrix: BLIND - not run. ${blindLine(access)}\n`)
  process.exit(77)
}

const w = await world()
const fakes: FakeCanvas[] = []
let L: Launch | undefined
let cap: CaptureSession | undefined
const report: {
  at: string; layout?: string; refreshHz?: number; clockSkewMs?: number; clock?: ClockControl; heartbeat?: { frames: number; complete: number; gaps: number[] }
  calibration?: { ok: boolean; why?: string; colours?: Record<string, string> }; blind?: string; cases: Record<string, CaseReport>
} = { at: new Date().toISOString(), cases: {} }
const NOT_BUILT = ['steady-pan (a real shell)', 'live-resize (CGEvent drag: Accessibility)', 'failed-proof and instance-mismatch from full height', 'error-page to trusted', 'tab-page lift', 'html-fullscreen', 'late-reply of an earlier epoch', 'under load (a second window)']
const BUILT = ['reload', 'navigation', 'resize', 'switch-see-through', 'switch-covered', 'switch-home', 'canvas-killed', 'switches-strip-stalled', 'canvas-stalled']
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
  const marker = await call<{ rect: { x: number; y: number; width: number; height: number } }>('clock:marker', { on: false })
  const regions: Record<string, Rect> = {
    strip: { x: span.l, y: 6, w: Math.max(10, span.r - span.l), h: 32 },
    doc: { x: W / 2 - 24, y: 16, w: 48, h: 12 },
    ...Object.fromEntries(WIDTHS.map((x) => [`size@${x}`, { x: x - SIZE_TAG_X + 2, y: 16, w: 8, h: 12 }])),
    marker: { x: marker.rect.x + 4, y: marker.rect.y + 4, w: marker.rect.width - 8, h: marker.rect.height - 8 },
  }
  const judged = Object.fromEntries(Object.entries(regions).filter(([n]) => n !== 'marker'))
  // the heartbeat (A3.8 #29, #37): so every refresh has a frame and a gap is a missed one. On this Mac (24 Oct) a 1 px
  // CSS opacity animation in the strip - the compositor's, the design's, and main's in the one-ground stream - did not
  // keep a window stream at the refresh rate (30-60 frames a second, stalls up to a second); a 2 px block whose
  // colour the strip's page changes at every animation frame did (about 110 a second at 120 Hz). It stops while the
  // strip's main thread is stalled, so that case's transitions can be inconclusive on gaps: never passed
  const HEARTBEAT = `(() => { if (document.getElementById('mv-hb')) return 1;
    const d = document.createElement('div'); d.id = 'mv-hb'; d.style.cssText = 'position:fixed;right:2px;bottom:2px;width:2px;height:2px;pointer-events:none;z-index:2147483647';
    document.body.appendChild(d); let k = 0; const f = () => { k ^= 1; d.style.background = k ? '#000' : '#333'; requestAnimationFrame(f) }; requestAnimationFrame(f); return 1 })()`
  const heartbeat = async () => { for (let i = 0; i < 40; i++) { if (await call('exec', { target: 'strip', js: HEARTBEAT }).catch(() => 0)) return; await sleep(100) } }
  await heartbeat()
  const winId = await call<number | null>('window:id')
  if (!winId) throw new Error('no window id')
  cap = await startCapture({ mode: 'window', windowId: winId, regions, grid: [...GRID], ring: { x: 0, y: 0, w: W, h: 44 }, ringFrames: 240 })
  const c = cap
  const R = 1e9 / c.ready.refreshHz
  report.refreshHz = c.ready.refreshHz
  report.clockSkewMs = Math.round(Number(process.hrtime.bigint() - BigInt(c.ready.hostNs)) / 1e5) / 10
  if (Math.abs(report.clockSkewMs) > 5) throw new Error(`the clocks do not line up: ${report.clockSkewMs} ms`)
  // the heartbeat's own second: every refresh a frame, and complete ones among them. Only idle frames is a screen
  // that composites nothing (locked, or the display asleep, after the check): blind, never a pass
  {
    const h0 = c.frames.length
    await sleep(1000)
    const hb = c.frames.slice(h0)
    report.heartbeat = { frames: hb.length, complete: hb.filter((f) => f.status === 'complete').length, gaps: hb.filter((f) => f.gap).map((f) => f.gap!) }
    if (!report.heartbeat.complete) throw new CaptureBlind('the screen unlocked and the display awake', 'locked')
  }
  const log = (o: { afterT: bigint }) => call<LogLine[]>('log', { afterT: String(o.afterT) })

  // the clock control: the marker shown and hidden four times, each change journaled by main right after it made it
  {
    const from = process.hrtime.bigint()
    for (let i = 0; i < 8; i++) { await call('clock:marker', { on: i % 2 === 0 }); await sleep(150) }
    await sleep(150)
    const marks = (await log({ afterT: from })).filter((l) => l.topic === 'clock').map((l) => ({ ns: BigInt(l.t), on: !!l.data.marker }))
    const red = new Palette(60).add('on', ['ff0000'])
    report.clock = clockControl(c.frames, marks, c.ready.refreshHz, (f) => { const xs = f.regions?.marker?.filter(Boolean) ?? []; return xs.length ? xs.every((x) => red.classify(x) === 'on') : null })
  }
  if (CONTROL_ONLY || layout === 'opaque') {
    if (layout === 'opaque') for (const n of BUILT) report.cases[n] = { kind: 'not-applicable', why: 'the opaque layout: every canvas view sits at y >= 44, so the strip\'s empty part only ever shows the strip or the cover - a case would pass by construction. The matrix proves nothing until the one ground lands' }
    throw new Done()
  }
  if (!report.clock.ok) throw new Error(`the clock control ${report.clock.inconclusive ? 'is inconclusive' : 'failed'}: ${report.clock.why}`)
  const samples = (since: bigint, name: string) => c.frames.filter((f) => BigInt(f.hostNs) >= since && f.status === 'complete' && f.regions?.[name]).flatMap((f) => f.regions![name]!)

  // ---- calibration (A3.8 #34): the ground and its dots from a known source, Home checked against them, each tag as a
  // see-through frame shows it
  const look = (await log({ afterT: 0n })).filter((l) => l.topic === 'compose').at(-1)?.data.cover as { color?: string } | undefined
  const dark = (look?.color ?? '').toLowerCase().replace('#', '') === LOOK.dark!.ground
  const hexes = dark ? LOOK.dark! : LOOK.light!
  const markerSample = async (hex: string) => {
    await call('clock:marker', { on: true, color: hex })
    await sleep(150)
    const from = process.hrtime.bigint()
    await sleep(200)
    return mode(samples(from, 'marker'))
  }
  const groundCal = await markerSample(hexes.ground)
  const dotCal = await markerSample(hexes.dot)
  await call('clock:marker', { on: false })
  if (!groundCal || !dotCal) throw new CalibrationRefused('the marker showed no colour to calibrate the ground from')
  const groundPal = new Palette(22).add('ground', [groundCal, dotCal]).between('ground', `#${groundCal}`, `#${dotCal}`)
  await call('activate', { id: 'home' })
  await sleep(400)
  {
    const from = process.hrtime.bigint()
    await sleep(300)
    const off = Object.keys(judged).flatMap((n) => samples(from, n)).filter((x) => x && groundPal.classify(x) !== 'ground')
    if (off.length) throw new CalibrationRefused(`Home shows, under the strip, colours that are not its ground or dots (${[...new Set(off)].slice(0, 6).join(', ')}): Home is no calibration source`)
  }
  const tagCal = new Map<string, string>()
  let sizeCal: string | null = null
  let bandCal: string | null = null
  await call('activate', { id: A.id })
  await lifted(A.id)
  for (const tag of DOC_TAGS) {
    const before = process.hrtime.bigint()
    const t0 = Date.now()
    await call('exec', { target: A.id, js: `location.href = '/?mvtag=${tag}'; 1` })
    const end = Date.now() + 8000
    let un: LogLine | undefined
    while (!un && Date.now() < end) { await sleep(50); un = (await log({ afterT: before })).find((l) => l.topic === 'present' && l.data.op === 'uncover' && l.data.tab === A.id) }
    if (!un || A.fake.tags.at(-1)?.tag !== tag || A.fake.tags.at(-1)!.t < t0) throw new CalibrationRefused(`the document tagged ${tag} was never uncovered`)
    await sleep(150)
    const from = BigInt(un.t) + 100n * MS
    await sleep(200)
    tagCal.set(tag, mode(samples(from, 'doc')) ?? '')
    sizeCal ??= mode(samples(from, `size@${W}`))
    if (!bandCal) {
      // the band: the strip region's samples clear of both tags
      const strip = regions.strip!
      const band = c.frames.filter((f) => BigInt(f.hostNs) >= from && f.status === 'complete').flatMap((f) => (f.regions?.strip ?? []).filter((_, k) => {
        const p = samplePoint(strip, k, GRID)
        const inR = (r: { x0: number; x1: number; y0: number; y1: number }) => p.x >= r.x0 - 2 && p.x <= r.x1 + 2
        return !inR(sizeTagRect(W)) && !inR(docTagRect(W))
      }))
      bandCal = mode(band)
    }
  }
  if ([...tagCal.values()].some((x) => !x) || !sizeCal || !bandCal) throw new CalibrationRefused('a tag never showed in a see-through frame')
  const bandIsGround = groundPal.classify(bandCal) === 'ground'
  const named = [{ name: 'ground', hex: groundCal }, { name: 'ground', hex: dotCal }, { name: 'size', hex: sizeCal }, ...(bandIsGround ? [] : [{ name: 'band', hex: bandCal }]), ...[...tagCal].map(([t, h]) => ({ name: `tag:${t}`, hex: h }))]
  const TOL = 30
  const clashed = clash(named, TOL)
  if (clashed) throw new CalibrationRefused(`two classes the run must tell apart look alike: ${clashed}`)
  report.calibration = { ok: true, colours: Object.fromEntries(named.map((x, i) => [`${x.name}${x.name === 'ground' ? (i ? '-dot' : '') : ''}`, x.hex])) }
  const tagPal = new Palette(TOL).add('size', [sizeCal])
  if (!bandIsGround) tagPal.add('band', [bandCal])
  for (const [t, h] of tagCal) tagPal.add(`tag:${t}`, [h])
  const classify: Classify = (hex) => groundPal.classify(hex) === 'ground' ? 'ground' : tagPal.classify(hex) as ReturnType<Classify>

  // ---- the transitions
  /** what showed under the tabs at the end of the last transition: the start of the next one's timeline */
  let prev: Shown | null = null
  /** each tab's document shown now: its latest load (since `since` for a reload or a navigation) */
  const tagOf = (t: Tab, since?: number) => (at: bigint) => {
    void at
    const last = t.fake.tags.at(-1)
    return last && (since === undefined || last.t >= since) ? last.tag : null
  }
  const evidenceDir = join(OUT, 'matrix-evidence')
  rmSync(evidenceDir, { recursive: true, force: true })

  /** What shows under the tabs now, from the journal's last compose: the active canvas's document when uncovered. */
  async function nowShown(): Promise<Shown | null> {
    const last = (await log({ afterT: process.hrtime.bigint() - 60_000n * MS })).filter((l) => l.topic === 'compose').at(-1)
    if (!last || (last.data.cover as { visible?: boolean } | undefined)?.visible !== false) return null
    const t = tabs.find((x) => x.id === last.data.active)
    const tag = t?.fake.tags.at(-1)?.tag
    return t && tag ? { tag, width: Number(last.data.w) } : null
  }

  type Step = { target: Tab | 'home'; seeThrough: boolean; act: () => Promise<unknown>; fresh?: boolean }
  type Case = { name: string; exact: boolean; setup?: () => Promise<void>; step: () => Step; each?: () => Promise<void>; teardown?: () => Promise<void> }

  /** One run of a transition: act, main's decision, the settle, the window, the judgement. */
  async function once(cs: Case, k: number, attempt: number): Promise<TransitionVerdict & { evidence?: string[] }> {
    prev = await nowShown()
    const st = cs.step()
    const target = st.target === 'home' ? 'home' : st.target.id
    const before = process.hrtime.bigint()
    const wall = Date.now()
    await st.act()
    let t0: bigint | null = null
    for (let i = 0; i < 40 && t0 === null; i++) { t0 = decisionOf(await log({ afterT: before - 1n }), before, target); if (t0 === null) await sleep(25) }
    if (t0 === null) return { kind: 'inconclusive', why: 'main composed nothing for the action within 1 s: no decision to count from' }
    let settled: ReturnType<typeof settleOf> = null
    const end = Date.now() + 6000
    while (!settled && Date.now() < end) {
      await sleep(50)
      const tag = st.target === 'home' ? () => null : tagOf(st.target, st.fresh ? wall : undefined)
      settled = settleOf(await log({ afterT: t0 - 1n }), { t0, target, seeThrough: st.seeThrough, now: process.hrtime.bigint(), quietNs: 150n * MS, tagAt: tag })
    }
    if (!settled) return { kind: 'inconclusive', why: `the state never settled within 6 s${st.seeThrough ? ' (no uncover of the target)' : ''}` }
    const t1 = settled.at + 100n * MS + BigInt(Math.round(4 * R))
    // the window's tail must have arrived before it is judged
    const tailEnd = Date.now() + 2000
    while (!c.frames.some((f) => BigInt(f.hostNs) >= t1) && Date.now() < tailEnd) await sleep(20)
    const segs: Segment[] = [{ from: 0n, shown: prev }, ...settled.segments]
    const verdict = (f: CaptureFrame) => frameVerdict(f, { regions: judged, grid: GRID, classify, shown: shownAt(segs, BigInt(f.hostNs)) })
    const v = judgeTransition(c.frames, { t0, t1, refreshHz: c.ready.refreshHz, verdict, ...(cs.exact ? { maxN: 0 } : {}) })
    prev = shownAt(segs, t1)
    let evidence: string[] | undefined
    if (v.kind === 'fail') {
      // the frames around the first bad one, from the helper's ring
      const inWin = c.frames.filter((f) => BigInt(f.hostNs) >= t0 && BigInt(f.hostNs) < t1 && f.status === 'complete')
      const i = inWin.findIndex((f) => verdict(f) === 'bad')
      if (i >= 0) {
        mkdirSync(evidenceDir, { recursive: true })
        evidence = []
        for (const [d, f] of [[-1, inWin[i - 1]], [0, inWin[i]], [1, inWin[i + 1]]] as const) {
          if (!f) continue
          const p = join(evidenceDir, `${cs.name}-${k}-${attempt}-${d < 0 ? 'before' : d ? 'after' : 'first-bad'}-${f.hostNs}.png`)
          if (await c.pngAt(f.hostNs, p)) evidence.push(p)
        }
      }
    }
    c.forget(t0 - 2_000n * MS)
    return { ...v, ...(evidence ? { evidence } : {}) }
  }

  let flip = false
  const toA = (): Step => ({ target: A, seeThrough: true, act: () => call('activate', { id: A.id }) })
  const cases: Case[] = [
    { name: 'reload', exact: false, setup: async () => { await call('activate', { id: A.id }); await lifted(A.id) },
      step: () => ({ target: A, seeThrough: true, fresh: true, act: () => call('reloadPage', { target: A.id }) }) },
    { name: 'navigation', exact: false, setup: async () => { await call('activate', { id: A.id }); await lifted(A.id) },
      step: () => { const next = DOC_TAGS[(A.fake.tags.length + 3) % DOC_TAGS.length]; return { target: A, seeThrough: true, fresh: true, act: () => call('exec', { target: A.id, js: `location.href = '/?mvtag=${next}'; 1` }) } } },
    { name: 'resize', exact: false, setup: async () => { await call('activate', { id: A.id }); await lifted(A.id) },
      step: () => { flip = !flip; const size = flip ? { width: W - 120, height: H - 60 } : { width: W, height: H }; return { target: A, seeThrough: true, act: () => call('resize', size) } },
      teardown: async () => { await call('resize', { width: W, height: H }); await sleep(300) } },
    { name: 'switch-see-through', exact: false,
      step: () => { flip = !flip; const t = flip ? B : A; return { target: t, seeThrough: true, act: () => call('activate', { id: t.id }) } } },
    { name: 'switch-covered', exact: false,
      step: () => { flip = !flip; return flip ? { target: C, seeThrough: false, act: () => call('activate', { id: C.id }) } : toA() } },
    { name: 'switch-home', exact: false,
      step: () => { flip = !flip; return flip ? { target: 'home', seeThrough: false, act: () => call('activate', { id: 'home' }) } : toA() } },
    { name: 'canvas-killed', exact: false, setup: async () => { await call('activate', { id: B.id }); await lifted(B.id) },
      // covered by the decision; the automatic reload that follows uncovers B's next document, which may then show
      step: () => ({ target: B, seeThrough: false, act: () => call('crash', { target: B.id }) }),
      each: async () => { await sleep(300); await lifted(B.id).catch(() => {}); await sleep(300) } },
    { name: 'switches-strip-stalled', exact: false, setup: async () => { await call('exec', { target: 'strip', js: 'setTimeout(() => { const e = Date.now() + 120000; while (Date.now() < e) {} }, 0); 1' }) },
      step: () => { flip = !flip; return flip ? { target: C, seeThrough: false, act: () => call('activate', { id: C.id }) } : toA() },
      teardown: async () => { await call('crash', { target: 'strip' }); await sleep(1500); await heartbeat() } },
    { name: 'canvas-stalled', exact: true, setup: async () => { await call('activate', { id: 'home' }); await sleep(300) },
      // a hidden tab stalled, resized, then shown: nothing of it under the tabs before its answer (exact)
      step: () => ({ target: B, seeThrough: true, act: async () => {
        await call('exec', { target: B.id, js: 'setTimeout(() => { const e = Date.now() + 1500; while (Date.now() < e) {} }, 0); 1' })
        await call('resize', { width: W - 80, height: H })
        return call('activate', { id: B.id })
      } }),
      each: async () => { await call('resize', { width: W, height: H }); await call('activate', { id: 'home' }); await sleep(900) } },
  ]

  for (const cs of cases) {
    if (ONLY && !ONLY.includes(cs.name)) continue
    process.stdout.write(`capture matrix: ${cs.name}...\n`)
    try {
      await cs.setup?.()
      await sleep(300)
      const detail: (TransitionVerdict & { evidence?: string[] })[] = []
      for (let k = 0; k < N; k++) {
        const tries: (TransitionVerdict & { evidence?: string[] })[] = []
        do { tries.push(await once(cs, k, tries.length)); await cs.each?.() } while (tries.at(-1)!.kind === 'inconclusive' && tries.length < TRIES)
        const v = retried(tries)
        detail.push(v)
      }
      await cs.teardown?.()
      const j = judgeCase(detail, { exact: cs.exact })
      report.cases[cs.name] = { ...j, exact: cs.exact, detail }
      process.stdout.write(`  ${j.kind.toUpperCase()} ${cs.exact ? 'exact' : 'threshold'}: p95 n ${j.p95n}, max ${j.maxMs} ms, ${j.inconclusive} inconclusive and ${j.unresolved} unresolved of ${j.transitions}\n`)
    } catch (e) {
      report.cases[cs.name] = { kind: 'error', why: (e as Error).message }
      process.stdout.write(`  ERROR ${(e as Error).message}\n`)
    }
  }
} catch (e) {
  if (e instanceof CaptureBlind) report.blind = e.message
  else if (e instanceof CalibrationRefused) report.calibration = { ok: false, why: e.message }
  else if (!(e instanceof Done)) throw e
} finally {
  for (const n of NOT_BUILT) report.cases[n] ??= { kind: 'not-built', why: 'needs the one ground, Accessibility or another stream before it can be staged here' }
  await cap?.stop()
  if (DUMP && cap) { mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, 'matrix-frames.jsonl'), cap.frames.map((f) => JSON.stringify(f)).join('\n')) }
  await L?.stop()
  for (const f of fakes) await f.close()
  w.release()
}
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'matrix.json'), JSON.stringify(report, null, 2))
if (report.blind) { process.stdout.write(`capture matrix: BLIND - not run. ${report.blind}\nreport: ${join(OUT, 'matrix.json')}\n`); process.exit(77) }
const hb = report.heartbeat
const clock = report.clock ? (report.clock.ok ? `clock control ok (lags ${report.clock.lags.join(', ')} refreshes)` : `clock control ${report.clock.inconclusive ? 'INCONCLUSIVE' : 'FAILED'}: ${report.clock.why}`) : 'clock control not run'
process.stdout.write(`capture matrix (${report.layout} layout, ${report.refreshHz} Hz, clocks ${report.clockSkewMs} ms, ${clock}, heartbeat ${hb?.complete}/${hb?.frames} complete in 1 s, ${hb?.gaps.length} gaps): report ${join(OUT, 'matrix.json')}\n`)
if (report.calibration && !report.calibration.ok) process.stdout.write(`capture matrix: CALIBRATION REFUSED - ${report.calibration.why}; no case judged\n`)
if (report.layout === 'opaque') process.stdout.write('capture matrix: NOT APPLICABLE - the opaque layout: no canvas pixel can reach the strip\'s empty part, so every case would pass by construction; the matrix proves nothing until the one ground lands\n')
const built = Object.values(report.cases).filter((x) => x.kind !== 'not-built')
// --control: 0 when the clock control holds (a check of the harness, never an acceptance). Else 0 only when every
// built case passed in the one ground with the clock control and the calibration good; 1 one failed; 3 anything
// else - inconclusive, broke, refused or not applicable
if (CONTROL_ONLY) process.exit(report.clock?.ok ? 0 : 3)
const ok = report.layout === 'one-ground' && report.clock?.ok && report.calibration?.ok && built.length > 0 && built.every((x) => x.kind === 'pass')
process.exit(built.some((x) => x.kind === 'fail') ? 1 : ok ? 0 : 3)

