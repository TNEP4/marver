import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceId } from '../src/server/workspace.ts'
import { NOW, writeFixture } from './fixtures/perf-029/make.ts'

/**
 * Spec 30 R14 #56: 0.30's `marver perf`, in every view, over 0.29-era data (test/fixtures/perf-029, synthetic and shaped
 * like the 4 Nov lines) gives what 0.29 gave - held to golden/, which 0.29's own code printed: set MV_R30_GOLDEN_FROM to
 * a checkout of it (`git archive 1be9ae99 src`, with node_modules beside) and this file writes
 * them again instead of comparing. Then 0.30 lines through the same views: change-id grouping, parts, `(page, seq)`.
 */

const FROM = process.env.MV_R30_GOLDEN_FROM
const GOLDEN = join(import.meta.dirname, 'fixtures', 'perf-029', 'golden')
const VIEWS: [string, Record<string, unknown>][] = [
  ['default', { minutes: 120 }], ['default-wide', { minutes: 600 }], ['loads', { loads: true, minutes: 120 }],
  ['jam', { jam: true }], ['runs', { runs: true }], ['runs-against', { runs: true, against: 'aaaaaaaaaaaaaaa1' }],
  ['crashes', { crashes: true }], ['flashes', { flashes: true }], ['flashes-all', { flashes: true, all: true }], ['machine', { machine: true }],
]

let base = '', root = '', home = ''
const wasHome = process.env.MARVER_HOME
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'mv-r30-readers-'))
  root = join(base, 'repo'); home = join(base, 'home')
  mkdirSync(root, { recursive: true })
  writeFixture(root, home)
})
afterAll(() => { rmSync(base, { recursive: true, force: true }); process.env.MARVER_HOME = wasHome })
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); process.env.MARVER_HOME = home })
afterEach(() => vi.useRealTimers())

/** What differs from machine to machine: where the fixture lies, the clock's words. */
const normal = (text: string) => text
  .replaceAll(root, 'ROOT').replaceAll(home, 'HOME').replaceAll(workspaceId(root), 'ROOTWS')
  .replace(/\d{1,2}:\d{2}:\d{2}(\s?[AP]M)?/g, 'T')
  .replace(/[A-Z][a-z]{2} \d{1,2}, /g, 'D ')
  .replace(/\d{1,2}\/\d{1,2}\/\d{4},? /g, 'D ')

async function printed(perfCommand: (root: string, o: never) => unknown, o: Record<string, unknown>): Promise<string> {
  const out: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')) })
  try { await perfCommand(root, o as never) } finally { log.mockRestore() }
  return normal(out.join('\n')) + '\n'
}

describe('0.29-era data, every view (#56)', () => {
  for (const [name, o] of VIEWS) {
    for (const json of [false, true]) {
      const file = `${name}${json ? '.json' : ''}.txt`
      it(`${name}${json ? ' --json' : ''} prints what 0.29 printed`, async () => {
        const { perfCommand } = await import(FROM ? join(FROM, 'src/cli/perf.ts') : '../src/cli/perf.ts')
        const text = await printed(perfCommand, { ...o, json })
        if (FROM) { mkdirSync(GOLDEN, { recursive: true }); writeFileSync(join(GOLDEN, file), text); return }
        expect(text).toBe(readFileSync(join(GOLDEN, file), 'utf8'))
      })
    }
  }

  it('the fixture covers what it claims: nothing is a view of nothing', () => {
    if (FROM) return
    const g = (f: string) => readFileSync(join(GOLDEN, `${f}.txt`), 'utf8')
    expect(g('default')).toContain('fixtures.ts  2x  reached 301 frames, 1 updated in place')
    expect(g('default')).toContain('after: update')
    expect(g('loads')).toContain('The Main Board')
    expect(g('loads')).toContain('4 records never reached this log')
    expect(g('jam')).toContain('runs by outcome')
    expect(g('runs')).toContain('after a change')
    expect(g('crashes')).toContain('the minute before')
    expect(g('crashes')).toContain('not responding: 1')
    expect(g('flashes')).toContain('white at 2 samples')
    expect(g('flashes-all')).toContain('a canvas of another repo')
    expect(g('machine')).toContain('host abcdefabcdefabcd')
    for (const [name] of VIEWS) expect(existsSync(join(GOLDEN, `${name}.json.txt`)), name).toBe(true)
  })
})

describe('0.30 lines through the same views (#7, #10, #56)', () => {
  const MIN = 60_000
  const WS = '163cf821d349d94a', PG = '90879e227f04', LOAD = 'a51d669160cf'
  let r = ''
  const perf = () => join(r, 'design', '.local', 'perf')
  const write = (name: string, lines: unknown[]) => writeFileSync(join(perf(), name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const run = async (o: Record<string, unknown>) => {
    const { perfCommand } = await import('../src/cli/perf.ts')
    const out: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')) })
    try { await perfCommand(r, { json: true, ...o } as never) } finally { log.mockRestore() }
    return JSON.parse(out.join('\n'))
  }
  const text = async (o: Record<string, unknown>) => {
    const { perfCommand } = await import('../src/cli/perf.ts')
    const out: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')) })
    try { await perfCommand(r, o as never) } finally { log.mockRestore() }
    return out.join('\n')
  }
  beforeEach(() => { r = mkdtempSync(join(tmpdir(), 'mv-r30-readers30-')); mkdirSync(perf(), { recursive: true }) })
  afterEach(() => rmSync(r, { recursive: true, force: true }))

  it('an edit is its change id: two update lines of one change are one edit, its frames the union of its update and update-ids lines', async () => {
    write('reloads.jsonl', [
      { ts: NOW - 5 * MIN, kind: 'update', cause: 'update', file: 'a.tsx', change: 'deadbeef:1', reload: ['x/1', 'x/2'], inPlace: [], reloadN: 3, inPlaceN: 1, parts: 2 },
      { ts: NOW - 5 * MIN, kind: 'update-ids', change: 'deadbeef:1', part: 1, parts: 2, reload: ['x/3'], inPlace: ['x/4'] },
      { ts: NOW - 5 * MIN + 1, kind: 'update', cause: 'update', file: 'a.tsx', change: 'deadbeef:1', reload: ['x/2'], inPlace: [] },
      { ts: NOW - 4 * MIN, kind: 'update', cause: 'update', file: 'a.tsx', change: 'deadbeef:2', reload: ['x/1'], inPlace: [] },
      // 0.29's shape beside it, and a refused refresh, never attributed: each its own edit
      { ts: NOW - 3 * MIN, kind: 'update', cause: 'update', file: 'a.tsx', reload: ['x/5'], inPlace: [] },
      { ts: NOW - 2 * MIN, kind: 'update', cause: 'invalidate', file: 'b.tsx', change: 'unknown', graphTs: 5, candidates: { ids: ['deadbeef:1'], n: 1 }, reload: ['y/1'], inPlace: [] },
      { ts: NOW - 2 * MIN + 1, kind: 'update', cause: 'invalidate', file: 'b.tsx', change: 'unknown', graphTs: 6, candidates: { ids: ['deadbeef:2'], n: 1 }, reload: ['y/2'], inPlace: [] },
      // a part whose update is past the window has no file to join: it makes no row
      { ts: NOW - MIN, kind: 'update-ids', change: 'deadbeef:9', part: 1, parts: 2, reload: ['z/1'] },
    ])
    const j = await run({})
    expect(j.files['a.tsx']).toEqual({ edits: 3, reached: ['x/1', 'x/2', 'x/5', 'x/3'], inPlace: ['x/4'] })
    expect(j.files['b.tsx']).toEqual({ edits: 2, reached: ['y/1', 'y/2'], inPlace: [] })
    expect(Object.keys(j.files)).toEqual(['a.tsx', 'b.tsx'])
  })

  it('a shell line written twice past the server\'s window counts once by (page, seq); server lines, which name none, each count', async () => {
    const ready = { ts: NOW - MIN, kind: 'ready', tab: 's1', page: PG, seq: 7, node: 'n', frame: 'x/1', cause: 'job', ms: 100 }
    write('reloads.jsonl', [
      ready, ready,
      { ts: NOW - MIN, kind: 'shell-boot', tab: 's1', page: PG, seq: 3 }, { ts: NOW - MIN, kind: 'shell-boot', tab: 's1', page: PG, seq: 3 },
      { ts: NOW - 2 * MIN, kind: 'full-reload', passed: true, triggeredBy: null, path: null, by: 'unknown', candidates: { ids: [], n: 0 } },
      { ts: NOW - 2 * MIN, kind: 'full-reload', passed: true, triggeredBy: null, path: null, by: 'ambiguous', candidates: { ids: ['deadbeef:1', 'deadbeef:2'], n: 2 } },
    ])
    const j = await run({})
    expect(j.documents.afterEdit).toBe(1)
    expect(j.boots).toHaveLength(1)
    expect(j.reloads).toHaveLength(2)
    const t = await text({})
    expect(t).toContain('2 candidates')
    expect(t).toContain('no file\'s hooks were running')
  })

  it('every reader of a retried page record counts it once; the safety cap\'s lines, which name no page, each count', async () => {
    const load = { v: 1, ws: WS, page: PG, load: LOAD, seq: 1, ts: NOW - MIN, kind: 'load', board: 'main', cause: 'boot', request: LOAD, sinceNav: 3 }
    const cap = { v: 1, ts: NOW - MIN, kind: 'dropped', n: 100, reason: 'retention-cap' }
    write('page.jsonl', [load, load, cap, { ...cap, ts: NOW - MIN + 1, n: 50 }])
    const j = await run({ loads: true })
    expect(j.loads).toHaveLength(1)
    expect(j.retentionCap).toBe(150)
    expect(j.dropped).toBe(0)
    expect(await text({ loads: true })).toContain('150 records deleted by the safety cap')
  })

  it('new kinds between the lines leave "what came just before a page load" saying why', async () => {
    write('reloads.jsonl', [
      { ts: NOW - 5 * MIN, kind: 'update', cause: 'update', file: 'a.tsx', change: 'deadbeef:1', reload: ['x/1'], inPlace: [] },
      { ts: NOW - 5 * MIN + 1, kind: 'change', change: 'deadbeef:1', file: 'a.tsx', event: 'update', flightMs: 40 },
      { ts: NOW - 5 * MIN + 2, kind: 'invalidate', revision: 'r1', frames: 1, changes: ['deadbeef:1'] },
      { ts: NOW - 5 * MIN + 3, kind: 'invalidated', tab: 's', page: PG, seq: 1, revision: 'r1', asked: 1, offBoard: 0, onBoard: 1, awake: 1, asleep: 0, held: {} },
      { ts: NOW - 5 * MIN + 4, kind: 'shell-boot', tab: 's', page: PG, seq: 2 },
    ])
    expect((await run({})).boots[0].before.map((b: { kind: string }) => b.kind)).toEqual(['update'])
  })

  it('a segment and a live file read as one log, in every view', async () => {
    const seg = (ago: number) => ({ ts: NOW - ago, kind: 'update', cause: 'update', file: 'a.tsx', reload: [`x/${ago}`], inPlace: [] })
    writeFileSync(join(perf(), `reloads.${NOW - 3 * MIN}-${NOW - 2 * MIN}.jsonl`), JSON.stringify(seg(3 * MIN)) + '\n')
    write('reloads.jsonl', [seg(MIN)])
    expect((await run({})).files['a.tsx'].edits).toBe(2)
  })
})
