import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'
import { runsSummary } from '../src/cli/perf-app.ts'
import { perfRunCommand } from '../src/cli/perf.ts'
import { readRuns } from '../src/server/perf.ts'
import { PAGE_KINDS } from '../src/shared/perf-records.ts'
import type { RunLine } from '../src/shared/perf-run.ts'

/**
 * Spec 30 R15 #57, #58, the cost: `marver perf run <board> --recorder core|full --repeat 3` for the load and the gesture,
 * then the listed operations in a real page at each level - 20 theme switches, 20 mode toggles, 100 commands, 200
 * console errors spread over 30 frames - and every budget checked: the median load-to-settled within 5 %, gesture p95
 * within 0.5 ms, each operation's own duration within 5 %. A test-only switch (`?mvslowhook=console`, recorder-level.ts)
 * adds a 5 ms busy wait to the console's way through the shell and to `hooked('console', ...)`: with it the same check
 * must fail, proof that it measures the hooks. A budget is measured on a Mac doing other things, so a miss is measured
 * again (3 times at most, the best of each cohort kept): noise passes, a real cost does not.
 *
 * Skips without Chrome. Slow (minutes): it runs real headless runs.
 */

const FRAME = (i: number) => `export const meta = { title: 'F${i}', viewport: 'mobile' }\nexport default () => <main style={{ padding: 24 }}><h1>Frame ${i}</h1></main>\n`
const N = 30
const files: Record<string, string> = {
  'design/config.ts': 'export default { jam: false }\n',
  'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: Array.from({ length: N }, (_, i) => ({ key: `n-${i}`, frame: `demo/f${i}`, x: (i % 6) * 420, y: Math.floor(i / 6) * 900, w: 390, h: 844 })) }),
}
for (let i = 0; i < N; i++) files[`design/scenes/demo/f${i}.tsx`] = FRAME(i)

let root = ''
let dev: Dev | null = null
let browser: Browser | null = null

beforeAll(async () => {
  browser = await Browser.launch()
  if (!browser) return
  root = fixtureRoot('mv-r30-cost-', files)
  dev = await startDev(root)
}, 120_000)
afterAll(async () => {
  browser?.close()
  await dev?.stop()
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

/** The operations, in the page: each a total in ms, input to its effects' last turn. */
const OPS = `(async () => {
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const key = (k) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); document.body.dispatchEvent(e) }
  const timed = async (fn) => { const t = performance.now(); await fn(); return performance.now() - t }
  const out = {}
  out.theme = await timed(async () => { for (let i = 0; i < 20; i++) { key('d'); await frames() } })
  out.mode = await timed(async () => { for (let i = 0; i < 20; i++) { key('l'); await frames() } })
  out.commands = await timed(async () => { for (let i = 0; i < 100; i++) { key('h'); await new Promise((r) => requestAnimationFrame(r)) } })
  const docs = [...document.querySelectorAll('iframe')].map((f) => f.contentWindow).filter(Boolean)
  out.console = await timed(async () => {
    for (let i = 0; i < 200; i++) {
      // spread over the frames, one in six in the shell itself
      if (i % 6 === 0 || !docs.length) console.error('cost ' + i)
      else docs[i % docs.length].console.error('cost ' + i)
    }
    // what they posted, handled: past the shell's queue, then a frame
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
    await frames()
  })
  return out
})()`

interface Ops { theme: number; mode: number; commands: number; console: number }

/** One page at a level: its board settled, then the operations, the kinds it recorded. */
async function opsAt(query: string): Promise<{ ops: Ops; kinds: string[] }> {
  const s = await browser!.tab({ width: 1440, height: 900 })
  try {
    await browser!.go(s, `${dev!.origin}/${query}#/b/main`)
    await browser!.send('Page.bringToFront', {}, s)
    await browser!.until(s, `window.__mvRecorder && window.__mvRecorder.state().owner && window.__mvRecorder.state().owner.done === 'settled'`, 120_000)
    const ops = await browser!.eval(s, OPS) as Ops
    await browser!.eval(s, `window.__mvRecorder.send()`)
    await browser!.until(s, `window.__mvRecorder.state().queued === 0 && !window.__mvRecorder.state().sending`, 15_000)
    const page = await browser!.eval(s, `window.__mvRecorder.page`) as string
    const lines = readFileSync(join(root, 'design', '.local', 'perf', 'page.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { page: string; kind: string })
    return { ops, kinds: [...new Set(lines.filter((l) => l.page === page).map((l) => l.kind))] }
  } finally { await browser!.closeTab(s).catch(() => {}) }
}

/** `marver perf run main --recorder <level> --repeat 3 --json`. */
async function runs(level: 'core' | 'full'): Promise<RunLine[]> {
  const out: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')) })
  try {
    await perfRunCommand(root, 'main', { recorder: level, repeat: 3, json: true })
  } finally { log.mockRestore() }
  return (JSON.parse(out.join('\n')) as { runs: RunLine[] }).runs
}

/** The figures a cohort's budget reads, the best of each so far (a miss is measured again). */
interface Figures { loadToSettled: number; gestureP95: number; ops: Ops }
const OP_NAMES = ['theme', 'mode', 'commands', 'console'] as const
function best(a: Figures | null, b: Figures): Figures {
  if (!a) return b
  return { loadToSettled: Math.min(a.loadToSettled, b.loadToSettled), gestureP95: Math.min(a.gestureP95, b.gestureP95), ops: Object.fromEntries(OP_NAMES.map((k) => [k, Math.min(a.ops[k], b.ops[k])])) as unknown as Ops }
}
/** #57's budgets: what is past them, in words. */
function pastBudget(full: Pick<Figures, 'ops'> & Partial<Figures>, core: Pick<Figures, 'ops'> & Partial<Figures>): string[] {
  const out: string[] = []
  if (full.loadToSettled !== undefined && full.loadToSettled > core.loadToSettled! * 1.05) out.push(`load to settled ${full.loadToSettled} ms against ${core.loadToSettled} ms`)
  if (full.gestureP95 !== undefined && full.gestureP95 > core.gestureP95! + 0.5) out.push(`gesture p95 ${full.gestureP95} ms against ${core.gestureP95} ms`)
  for (const k of OP_NAMES) if (full.ops[k] > core.ops[k] * 1.05) out.push(`${k} ${full.ops[k].toFixed(1)} ms against ${core.ops[k].toFixed(1)} ms`)
  return out
}
async function opsMedian(query: string, n = 3): Promise<{ ops: Ops; kinds: string[] }> {
  const all = []
  for (let i = 0; i < n; i++) all.push(await opsAt(query))
  return { ops: Object.fromEntries(OP_NAMES.map((k) => [k, median(all.map((a) => a.ops[k]))])) as unknown as Ops, kinds: [...new Set(all.flatMap((a) => a.kinds))] }
}

describe('the recorder\'s own cost (#57, #58)', () => {
  let coreBase: { ops: Ops } | null = null

  it('--recorder core|full, three runs each, then the operations: every budget holds', async (ctx) => {
    if (!dev) return ctx.skip()
    let fullBest: Figures | null = null, coreBest: Figures | null = null
    let missed: string[] = []
    for (let attempt = 0; attempt < 3; attempt++) {
      const [c, f] = [await runs('core'), await runs('full')]
      if (attempt === 0) {
        // the level reaches the page, and the line says it; the two never compare as one
        expect(c.map((l) => l.recorder)).toEqual(['core', 'core', 'core'])
        expect(f.map((l) => l.recorder)).toEqual(['full', 'full', 'full'])
        for (const l of [...c, ...f]) expect(l.valid, `${l.run}: ${l.invalidReason ?? ''} ${l.cut ?? ''}`).toBe(true)
        expect(c[0]!.inputs!.hash).not.toBe(f[0]!.inputs!.hash)
        const cohorts = runsSummary(readRuns(root) as RunLine[]).boards.filter((b) => b.board === 'main')
        expect(new Set(cohorts.map((b) => b.cohort.recorder))).toEqual(new Set(['core', 'full']))
      }
      const co = await opsMedian('?mvrecorder=core')
      const fu = await opsMedian('')
      if (attempt === 0) {
        // `core` records 0.29's kinds and nothing this spec adds
        const added = PAGE_KINDS.slice(PAGE_KINDS.indexOf('renders'))
        expect(co.kinds.filter((k) => (added as readonly string[]).includes(k))).toEqual([])
      }
      coreBest = best(coreBest, { loadToSettled: median(c.map((l) => l.loadToSettledMs!)), gestureP95: median(c.map((l) => l.p95!)), ops: co.ops })
      fullBest = best(fullBest, { loadToSettled: median(f.map((l) => l.loadToSettledMs!)), gestureP95: median(f.map((l) => l.p95!)), ops: fu.ops })
      missed = pastBudget(fullBest, coreBest)
      process.stdout.write(`recorder cost, attempt ${attempt + 1}: core ${JSON.stringify(coreBest)}, full ${JSON.stringify(fullBest)}${missed.length ? ` - past budget: ${missed.join('; ')}` : ''}\n`)
      if (!missed.length) break
    }
    coreBase = coreBest
    expect(missed).toEqual([])
  }, 900_000)

  it('a 5 ms busy wait on the console hook must fail it: the check measures the hooks', async (ctx) => {
    if (!dev) return ctx.skip()
    const core = coreBase ?? await opsMedian('?mvrecorder=core')
    const slow = await opsMedian('?mvslowhook=console')
    const missed = pastBudget(slow, core)
    process.stdout.write(`recorder cost, the slow hook: ${JSON.stringify(slow.ops)} against ${JSON.stringify(core.ops)} - ${missed.join('; ')}\n`)
    expect(missed.join('; ')).toMatch(/console/)
    // and without the switch the wait is not there: only the console's figure moved by what it holds
    expect(slow.ops.console - core.ops.console).toBeGreaterThan(5 * (200 / 6) * 0.8)
  }, 180_000)

  it('the switch reaches `hooked()` too, by name, and never another hook', async (ctx) => {
    if (!dev) return ctx.skip()
    const seams = `/@fs${join(import.meta.dirname, '..', 'src', 'client', 'shell', 'recorder-seams.ts')}`
    const s = await browser!.tab({ width: 1000, height: 700 })
    try {
      await browser!.go(s, `${dev!.origin}/?mvslowhook=console#/b/main`)
      await browser!.until(s, `window.__mvRecorder && window.__mvRecorder.state().owner`, 60_000)
      const took = await browser!.eval(s, `import(${JSON.stringify(seams)}).then((m) => {
        const time = (h) => { const f = m.hooked(h, () => {}); const t = performance.now(); for (let i = 0; i < 20; i++) f(); return performance.now() - t }
        return { console: time('console'), theme: time('theme') }
      })`) as { console: number; theme: number }
      expect(took.console).toBeGreaterThanOrEqual(90)         // 20 x 5 ms
      expect(took.theme).toBeLessThan(20)
    } finally { await browser!.closeTab(s).catch(() => {}) }
  }, 120_000)
})
