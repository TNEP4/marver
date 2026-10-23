import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { dirname, join } from 'node:path'
import { CLI, fixtureRoot, startDev, type Dev } from './dev-server.ts'
import { findChrome } from '../src/server/cdp.ts'
import { parsePower, spawnOut } from '../src/server/machine-host.ts'
import type { RunLine, RunStreamLine } from '../src/shared/perf-run.ts'

/**
 * Headless perf runs (spec 28 A3.4, A3.7, A3.8 #17-#22), end to end: a real `marver dev` on a fixture repo, its own
 * headless Chrome driving script 1, and the lines in design/.local/perf/runs.jsonl. A run is read-only (nothing of the
 * repo changes, no write reaches the server), repeatable on an idle Mac on power, its inputs fingerprinted and watched,
 * its bakes its own (a video missing its poster runs without one; a cancel leaves no poster, and a normal tab's poster
 * still works), and concurrent runs keep their own counts. A second canvas holds each compile 5 s with a 3 s warm-up,
 * for the cold and the cancelled runs. Skips, never fails, without Chrome.
 */

const CHROME = !!findChrome()
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')

const GLASS = (label: string) => `import { Card } from '../../components/Card'
import { tone } from '../../../src/generated/tone'
export default () => (
  <main style={{ position: 'relative', minHeight: '100vh', margin: 0, background: 'linear-gradient(135deg, #ff7a59, #7b61ff 45%, ' + tone + ')', font: '600 18px system-ui' }}>
    <Card title=${JSON.stringify(label)} left={40} top={40} />
    <Card title="Lane first" left={40} top={160} />
  </main>
)
`
const CARD = (pad: number) => `export const Card = ({ title, left, top }: { title: string; left: number; top: number }) => (
  <div style={{ position: 'absolute', left, top, width: 300, padding: ${pad}, borderRadius: 16, color: '#123', background: 'rgba(255,255,255,.35)', border: '1px solid rgba(255,255,255,.5)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>{title}</div>
)
`
const PLAIN = (n: number) => `export default () => <main style={{ margin: 0, padding: 24, font: '16px system-ui' }}><h1 style={{ margin: 0 }}>Plain ${n}</h1><p>no glass here</p></main>\n`
const DOC = (paras: number) => `import { Doc, Md } from '@marver-design/marver/content'
export default () => (
  <Doc>
${Array.from({ length: paras }, (_, i) => `    <Md>{${JSON.stringify(`## Section ${i + 1}\n\nA paragraph long enough to wrap across a couple of lines in a document-width frame, so the height is real.`)}}</Md>`).join('\n')}
  </Doc>
)
`
const VIDEO = (title: string) => `import { Doc, Md, Video } from '@marver-design/marver/content'
export default () => (
  <Doc>
    <Md>{${JSON.stringify(`## ${title}`)}}</Md>
    <Video src="clip.webm" />
  </Doc>
)
`
const HTML = (n: number) => `<!doctype html><html><body style="margin:0;font:16px system-ui"><h1>page ${n}</h1><img src="/design/assets/dot.png" width="32" height="32"></body></html>\n`

/** The fixture board: 12 frames - 2 hi-fi with glass (an imported component, a git-ignored import), 4 plain hi-fi,
 *  4 Docs (one height saved), 2 HTML. */
const MAIN = [
  { key: 'g1', frame: 'app/glass1', x: 0, y: 0, w: 800, h: 500 },
  { key: 'g2', frame: 'app/glass2', x: 900, y: 0, w: 800, h: 500 },
  ...[1, 2, 3, 4].map((n, i) => ({ key: `p${n}`, frame: `app/plain${n}`, x: i * 500, y: 600, w: 400, h: 300 })),
  ...['a', 'b', 'c', 'd'].map((d, i) => ({ key: `d${d}`, frame: `docs/${d}`, x: i * 850, y: 1000 })),
  { key: 'h1', frame: 'pages/p1', x: 0, y: 2200, w: 600, h: 400 },
  { key: 'h2', frame: 'pages/p2', x: 700, y: 2200, w: 600, h: 400 },
]

interface Canvas { root: string; dev: Dev }
let A: Canvas | null = null   // the canvas most cases run on
let B: Canvas | null = null   // each compile held 5 s, a 3 s warm-up: cold bakes and the cancel
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sha = (p: string) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex') } catch { return 'absent' } }
const put = (root: string, rel: string, body: string | Buffer) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }
const token = (c: Canvas) => JSON.parse(readFileSync(join(c.root, 'design', '.local', 'dev.json'), 'utf8')).token as string
const runsLog = (c: Canvas): RunLine[] => { try { return readFileSync(join(c.root, 'design', '.local', 'perf', 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
const pageLog = (c: Canvas): Record<string, any>[] => { try { return readFileSync(join(c.root, 'design', '.local', 'perf', 'page.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }

/** One `POST /api/perf/run`, read to its end: its stream's lines and the run lines in it. `onLine` sees each line as
 *  it comes; `signal` cancels by closing the request. */
async function run(c: Canvas, board: string, o: { slow?: boolean; repeat?: number; signal?: AbortSignal; onLine?: (l: RunStreamLine) => void } = {}): Promise<{ stream: RunStreamLine[]; lines: RunLine[] }> {
  const res = await fetch(`${c.dev.origin}/__mv/api/perf/run`, { method: 'POST', signal: o.signal, headers: { 'x-mv-work': token(c), 'content-type': 'application/json' }, body: JSON.stringify({ board, slow: o.slow, repeat: o.repeat }) })
  if (!res.ok) throw new Error(`perf/run answered ${res.status}: ${await res.text()}`)
  const stream: RunStreamLine[] = []
  let buf = ''
  const dec = new TextDecoder()
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true })
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const l = JSON.parse(buf.slice(0, nl)) as RunStreamLine
        buf = buf.slice(nl + 1)
        stream.push(l)
        o.onLine?.(l)
      }
    }
  } catch (e) { if (!o.signal?.aborted) throw e }
  return { stream, lines: stream.flatMap((l) => ('line' in l ? [l.line] : [])) }
}
const inputsNow = async (c: Canvas) => (await (await fetch(`${c.dev.origin}/__mv/api/perf/inputs`, { headers: { 'x-mv-work': token(c) } })).json()).inputs as { hash: string; files: number } | null
/** A run's line in runs.jsonl, once it is there. */
async function lineOf(c: Canvas, id: string, ms = 120_000): Promise<RunLine> {
  for (const by = Date.now() + ms; Date.now() < by; await wait(200)) { const l = runsLog(c).find((x) => x.run === id); if (l) return l }
  throw new Error(`no line for run ${id}`)
}
const runIdOf = (stream: RunStreamLine[]) => stream.find((l): l is { phase: 'warm'; run: string } => 'phase' in l)?.run
/** The files a run must leave as they were. */
const untouched = (c: Canvas) => ({
  sizes: sha(join(c.root, 'design', 'boards', '_sizes.json')),
  board: sha(join(c.root, 'design', 'boards', 'main.json')),
  video: sha(join(c.root, 'design', 'boards', 'video.json')),
  seen: sha(join(c.root, 'design', '.local', 'seen.json')),
  comments: existsSync(join(c.root, 'design', 'comments')) ? readdirSync(join(c.root, 'design', 'comments')).map((f) => `${f}:${sha(join(c.root, 'design', 'comments', f))}`).sort().join(',') : 'none',
  poster: existsSync(join(c.root, 'design', 'assets', 'clip.webm.poster.png')),
})
/** The canvas's request cookie and its echo: what a normal tab sends with an owner-gated POST. */
async function owner(c: Canvas): Promise<Record<string, string>> {
  const r = await fetch(`${c.dev.origin}/__mv/api/policy`)
  const v = /mv_c=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1] ?? ''
  return { cookie: `mv_c=${v}`, 'x-mv-c': v, origin: c.dev.origin }
}
/** Every compiled frame in the shared cache: `<gen>/<key>`. */
const bakeDirs = (c: Canvas) => { const base = join(c.root, 'design', '.local', 'bakes'); try { return readdirSync(base).flatMap((g) => { try { return readdirSync(join(base, g)).filter((k) => k !== 'owner' && !k.includes('.tmp-')).map((k) => `${g}/${k}`) } catch { return [] } }) } catch { return [] } }

function fixture(prefix: string): string {
  const root = fixtureRoot(prefix)
  const p = (rel: string, body: string | Buffer) => put(root, rel, body)
  p('.gitignore', 'src/generated/\n')
  p('design/config.ts', 'export default { jam: false }\n')
  p('design/components/Card.tsx', CARD(18))
  p('src/generated/tone.ts', `export const tone = '#19c2a0'\n`)
  p('design/scenes/app/glass1.tsx', GLASS('Past due'))
  p('design/scenes/app/glass2.tsx', GLASS('Chase dispatch'))
  for (const n of [1, 2, 3, 4]) p(`design/scenes/app/plain${n}.tsx`, PLAIN(n))
  for (const [d, n] of [['a', 6], ['b', 3], ['c', 4], ['d', 2]] as const) p(`design/scenes/docs/${d}.tsx`, DOC(n))
  p('design/scenes/pages/p1.html', HTML(1))
  p('design/scenes/pages/p2.html', HTML(2))
  p('design/scenes/media/clip.tsx', VIDEO('A clip'))
  p('design/scenes/media/again.tsx', VIDEO('The clip again'))
  p('design/assets/dot.png', PNG)
  copyFileSync(join(import.meta.dirname, 'fixtures', 'clip.webm'), join(root, 'design', 'assets', 'clip.webm'))
  const board = (name: string, order: number, nodes: object[]) => p(`design/boards/${name}.json`, JSON.stringify({ version: 1, name, order, auto: false, nodes }, null, 2) + '\n')
  board('main', 0, MAIN)
  board('video', 1, [{ key: 'v1', frame: 'media/clip', x: 0, y: 0 }])
  board('videos', 2, [{ key: 'v1', frame: 'media/clip', x: 0, y: 0 }, { key: 'v2', frame: 'media/again', x: 900, y: 0 }])
  board('broken', 3, [{ key: 'ok', frame: 'app/plain1', x: 0, y: 0, w: 400, h: 300 }, { key: 'gone', frame: 'app/nope', x: 500, y: 0, w: 400, h: 300 }])
  p('design/boards/_sizes.json', JSON.stringify({ about: 'fixture', heights: { 'docs/a@760': 900 } }, null, 2) + '\n')
  return root
}

beforeAll(async () => {
  if (!CHROME) return
  const ra = fixture('mv-perfrun-a-'), rb = fixture('mv-perfrun-b-')
  const [da, db] = await Promise.all([
    startDev(ra),
    startDev(rb, { env: { MV_BAKE_HOLD_MS: '5000', MV_PERF_RUN_T: JSON.stringify({ warmMs: 3000 }), MARVER_SHOT_CONCURRENCY: '1' } }),
  ])
  A = { root: ra, dev: da }
  B = { root: rb, dev: db }
}, 120_000)

afterAll(async () => {
  await Promise.all([A?.dev.stop(), B?.dev.stop()])
  for (const c of [A, B]) if (c) rmSync(c.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

const need = (ctx: { skip: () => void }, c: Canvas | null): Canvas => { if (!c) ctx.skip(); return c! }
/** An idle Mac on power, or the repeatability case is inconclusive - never passed (A3.8 #22). */
async function idleOnPower(): Promise<string | null> {
  const power = process.platform === 'darwin' ? parsePower(await spawnOut('/usr/bin/pmset', ['-g', 'ps'])) : 'unknown'
  if (power !== 'ac') return `on ${power} power`
  const load = loadavg()[0], cores = cpus().length
  return load < cores / 2 ? null : `the Mac is busy (load ${load.toFixed(1)} on ${cores} cores)`
}

let first: RunLine | null = null

describe('a headless run', () => {
  it('runs script 1 to its line: valid, read-only, its records stamped and its writes refused in the page', async (ctx) => {
    const c = need(ctx, A)
    const before = untouched(c)
    const { stream, lines } = await run(c, 'main')
    expect(stream.filter((l) => 'phase' in l).map((l) => (l as { phase: string }).phase)).toEqual(['warm', 'measured', 'closing'])
    expect(stream.at(-1)).toEqual({ done: true })
    expect(lines).toHaveLength(1)
    const l = first = lines[0]
    expect(l, JSON.stringify(l)).toMatchObject({ v: 1, script: 1, where: 'headless', board: 'main', valid: true, forbidden: 0, frames: 12, gestures: 3, slow: false, overlapped: false, bakes: 'warm', errors: 0 })
    expect(l.run).toMatch(/^[0-9a-f]{16}$/)
    expect(l.loadToSettledMs).toBeGreaterThan(0)
    expect(l.settledMs).toBeLessThanOrEqual(l.loadToSettledMs!)
    expect(l.saved).toEqual({ measuring: 4, savedHeights: 1 })
    expect(l.p95).toBeGreaterThan(0)
    expect(l.heapPeakMB).toBeGreaterThan(0)
    expect(l.inputs?.hash).toBe(l.inputsEnd)
    expect(l.inputs!.files).toBeGreaterThan(15)
    expect(l.host.memGB).toBeGreaterThan(0)
    expect(l.machine).toMatch(/^[0-9a-f]{16}$/)
    expect(runsLog(c).map((x) => x.run)).toContain(l.run)
    // the page's records went to page.jsonl, stamped by the server; the warm-up posted none
    const mine = pageLog(c).filter((r) => r.run === l.run)
    expect(mine.some((r) => r.kind === 'settled')).toBe(true)
    expect(new Set(mine.map((r) => r.page)).size, 'one page: the measured one').toBe(1)
    // nothing of the repo changed, and the page refused its own writes before sending them (marks/seen, heights)
    expect(untouched(c)).toEqual(before)
    expect(l.refusedInPage).toBeGreaterThan(0)
    // its bakes were allowed: the glass compiled
    expect(c.dev.out()).toMatch(/bake: app\/glass1/)
    // the headless host profile, beside the app's
    const machine = join(process.env.MARVER_HOME!, 'perf', 'machine', `${l.machine}.json`)
    expect(JSON.parse(readFileSync(machine, 'utf8'))).toMatchObject({ v: 1, kind: 'headless', power: l.power, host: l.host })
  }, 240_000)

  it('two runs of the fixture board agree within 10 % on load to settled and p95 (an idle Mac on power)', async (ctx) => {
    const c = need(ctx, A)
    const busy = await idleOnPower()
    if (busy) { console.log(`repeatability: inconclusive, not run - ${busy}`); return ctx.skip() }
    // only an invalid run is run again, twice at most; two valid runs that disagree fail
    const valid: RunLine[] = first?.valid ? [first] : []
    for (let tries = 0; valid.length < 2 && tries < 3; tries++) { const { lines } = await run(c, 'main'); if (lines[0]?.valid) valid.push(lines[0]) }
    expect(valid, 'two valid runs').toHaveLength(2)
    const [a, b] = valid
    expect(b.inputs?.hash).toBe(a.inputs?.hash)
    const near = (x: number | null, y: number | null) => { expect(x).not.toBeNull(); expect(Math.abs(y! - x!), `${x} -> ${y}`).toBeLessThanOrEqual(Math.max(x!, 1) * 0.1) }
    near(a.loadToSettledMs, b.loadToSettledMs)
    near(a.p95, b.p95)
  }, 240_000)

  it('a video missing its poster runs without one: no poster written, nothing of it in the shared cache', async (ctx) => {
    const c = need(ctx, A)
    const before = bakeDirs(c)
    const { lines } = await run(c, 'video')
    expect(lines[0], JSON.stringify(lines[0])).toMatchObject({ valid: true, postersMissing: 1 })
    expect(existsSync(join(c.root, 'design', 'assets', 'clip.webm.poster.png'))).toBe(false)
    expect(c.dev.out()).toMatch(/bake: media\/clip/)   // compiled - for the run alone
    expect(bakeDirs(c).filter((d) => !before.includes(d))).toEqual([])
  }, 240_000)

  it('an edit to a component a frame imports, between two runs, changes the inputs; so do the layout, the heights and an ignored import', async (ctx) => {
    const c = need(ctx, A)
    const base = first?.inputs?.hash ?? (await inputsNow(c))!.hash
    put(c.root, 'design/components/Card.tsx', CARD(20))
    await wait(1500)   // the watcher's event lands before the next run registers
    const { lines } = await run(c, 'main')
    expect(lines[0].inputs?.hash).not.toBe(base)
    expect(lines[0].valid, JSON.stringify(lines[0])).toBe(true)
    // the fingerprint alone, as an agent reads it: a board's layout, a saved height, a git-ignored file a frame imports
    let last = (await inputsNow(c))!.hash
    expect(last).toBe(lines[0].inputs?.hash)
    const step = async (what: string, change: () => void) => {
      change(); await wait(50)
      const now = (await inputsNow(c))!.hash
      expect(now, what).not.toBe(last)
      last = now
    }
    await step('the layout', () => put(c.root, 'design/boards/main.json', JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: MAIN.map((n) => (n.key === 'p1' ? { ...n, x: n.x + 10 } : n)) }, null, 2) + '\n'))
    await step('the saved heights', () => put(c.root, 'design/boards/_sizes.json', JSON.stringify({ about: 'fixture', heights: { 'docs/a@760': 910 } }, null, 2) + '\n'))
    await step('an ignored import', () => put(c.root, 'src/generated/tone.ts', `export const tone = '#19c2a1'\n`))
    await wait(1500)
  }, 240_000)

  it('an edit made and undone during the run makes it invalid (inputs)', async (ctx) => {
    const c = need(ctx, A)
    const file = join(c.root, 'design', 'scenes', 'app', 'plain3.tsx')
    const was = readFileSync(file, 'utf8')
    const { lines } = await run(c, 'main', { onLine: (l) => { if ('phase' in l && l.phase === 'measured') { writeFileSync(file, PLAIN(33)); setTimeout(() => writeFileSync(file, was), 300) } } })
    expect(lines[0], JSON.stringify(lines[0])).toMatchObject({ valid: false, invalidReason: 'inputs' })
    expect(readFileSync(file, 'utf8')).toBe(was)
    await wait(1500)
  }, 240_000)

  it('a board with a frame that is gone is invalid (frames)', async (ctx) => {
    const c = need(ctx, A)
    const { lines } = await run(c, 'broken')
    expect(lines[0], JSON.stringify(lines[0])).toMatchObject({ valid: false, invalidReason: 'frames' })
  }, 240_000)

  it('two concurrent runs keep their own counts: a write in one run\'s name is refused and counted for it alone', async (ctx) => {
    const c = need(ctx, A)
    const sizes = sha(join(c.root, 'design', 'boards', '_sizes.json'))
    let injected: Promise<number> | null = null
    const a = run(c, 'main', { onLine: (l) => {
      if (!('phase' in l) || l.phase !== 'warm' || injected) return
      injected = owner(c).then((h) => fetch(`${c.dev.origin}/__mv/api/sizes`, { method: 'POST', headers: { ...h, 'content-type': 'application/json', 'x-mv-perfrun': l.run }, body: JSON.stringify({ heights: { 'docs/a@760': 999 } }) })).then((r) => r.status)
    } })
    await wait(300)
    const b = run(c, 'main')
    const [ra, rb] = await Promise.all([a, b])
    expect(await injected).toBe(403)
    expect(ra.lines[0], JSON.stringify(ra.lines[0])).toMatchObject({ forbidden: 1, valid: false, invalidReason: 'writes', overlapped: true })
    expect(rb.lines[0], JSON.stringify(rb.lines[0])).toMatchObject({ forbidden: 0, overlapped: true })
    expect(sha(join(c.root, 'design', 'boards', '_sizes.json'))).toBe(sizes)
  }, 240_000)

  it('--slow says so', async (ctx) => {
    const c = need(ctx, A)
    const { lines } = await run(c, 'video', { slow: true })
    expect(lines[0], JSON.stringify(lines[0])).toMatchObject({ slow: true, valid: true })
  }, 240_000)

  it('`marver perf --runs --json` reads them: cohorts, the comparisons, the invalid and the overlapped apart', async (ctx) => {
    const c = need(ctx, A)
    const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, [CLI, 'perf', '--runs', '--json', '--root', c.root], { timeout: 30_000 }, (e, so) => (e ? reject(e) : resolve(so))))
    const j = JSON.parse(out)
    expect(j.days).toBe(14)
    expect(j.runs.length).toBe(runsLog(c).length)
    const main = j.boards.find((b: any) => b.board === 'main' && !b.cohort.slow)
    expect(main.cohort).toMatchObject({ script: 1, board: 'main', slow: false, bakes: 'warm' })
    expect(main.afterChange ?? main.sameInputs).toBeTruthy()
    expect(j.invalid.map((r: RunLine) => r.invalidReason)).toEqual(expect.arrayContaining(['inputs', 'frames', 'writes']))
    expect(j.boards.some((b: any) => b.board === 'video' && b.cohort.slow === true)).toBe(true)
    // the text report, and --loads keeps run loads out of a person's view
    const text = await new Promise<string>((resolve, reject) => execFile(process.execPath, [CLI, 'perf', '--loads', '--root', c.root], { timeout: 30_000 }, (e, so) => (e ? reject(e) : resolve(so))))
    expect(text).toMatch(/headless run loads? not shown: npx marver perf --runs/)
  }, 60_000)
})

describe('a run\'s bakes, compiled slowly', () => {
  it('a bake still compiling when the warm-up\'s deadline passes gives bakes: cold; the measured load waits for it', async (ctx) => {
    const c = need(ctx, B)
    const { lines } = await run(c, 'main')
    expect(lines[0], JSON.stringify(lines[0])).toMatchObject({ bakes: 'cold', gestures: 3 })
  }, 240_000)

  it('a run cancelled while a video board\'s bakes are queued leaves no poster; its line says cancelled; a normal tab\'s poster still works', async (ctx) => {
    const c = need(ctx, B)
    const logBefore = c.dev.out().length
    const ac = new AbortController()
    let id = '', cancelledAt = 0
    // cancelled 3.5 s in: the warm-up's page has asked for both frames' bakes, one compile at a time, each held 5 s
    const done = run(c, 'videos', { signal: ac.signal, onLine: (l) => { if ('phase' in l && l.phase === 'warm') { id = l.run; setTimeout(() => { cancelledAt = Date.now(); ac.abort() }, 3500) } } })
    await done
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    // the line comes once the run's compiles have ended: the one rendering finished, the one queued never started
    const line = await lineOf(c, id)
    const lineAfter = Date.now() - cancelledAt
    expect(line).toMatchObject({ valid: false, invalidReason: 'cancelled' })
    const compiled = c.dev.out().slice(logBefore).split('\n').filter((x) => /bake: media\//.test(x))
    expect(compiled.length, compiled.join('\n')).toBe(1)
    expect(lineAfter, 'the line waited for the compile under way').toBeGreaterThan(1500)
    expect(existsSync(join(c.root, 'design', 'assets', 'clip.webm.poster.png'))).toBe(false)
    await wait(2000)
    expect(existsSync(join(c.root, 'design', 'assets', 'clip.webm.poster.png'))).toBe(false)
    // a normal tab's poster: the same request without a run
    const r = await fetch(`${c.dev.origin}/__mv/api/poster`, { method: 'POST', headers: { ...(await owner(c)), 'content-type': 'application/json' }, body: JSON.stringify({ src: 'clip.webm' }) })
    expect(r.status, await r.clone().text()).toBe(200)
    expect(await r.json()).toMatchObject({ generated: true })
    expect(existsSync(join(c.root, 'design', 'assets', 'clip.webm.poster.png'))).toBe(true)
  }, 240_000)
})
