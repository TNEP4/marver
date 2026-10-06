import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apiMiddleware } from '../src/server/api.ts'
import { ROUTE } from '../src/cli/name.ts'
import { hash, scanFrames } from '../src/server/manifest.ts'
import { annotateBoards, planNames, planWithStage, readContextFacts } from '../src/server/board-status.ts'
import { addFolders } from '../src/server/boards.ts'
import { assertProjected, publishedManifest, resolvePolicy, withoutEvidence } from '../src/server/build.ts'
import { availableLevels, capabilityTable, frontMatter, globRe, parseMap, shippedRows, tables, type Audience, type Level } from '../src/shared/context.ts'
import { resolveType, readType } from '../src/shared/board-types.ts'
import { NO_CONTEXT, phaseOf, publishableStatus, resolveStatus, type ContextFacts } from '../src/shared/status.ts'
import { parseFolders, toWire, fromWire, validateWire, buildTree } from '../src/shared/board-tree.ts'
import { contextCheck, contextIndex, contextInit } from '../src/cli/context.ts'
import { boardsNew, foldersAdd } from '../src/cli/boards.ts'
import { init } from '../src/cli/init.ts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatusIcon, TypeIcon } from '../src/client/shell/board-icons.tsx'

let root = ''
const put = (rel: string, body: string | object) => {
  const f = join(root, rel)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
}
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const commitAll = (msg: string) => { git('add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg); return git('rev-parse', 'HEAD').trim() }

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mv-context-')) })
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

// ---------------------------------------------------------------------------------------------
describe('shared/context: the parsers', () => {
  it('front matter: flow maps, block lists, a managed marker line before it, an unclosed block', () => {
    const fm = frontMatter('---\nstate: current\nreviewed: { revision: abc, scope: "a, b" }\ndepends_on:\n  - x.yml\n  - "y z"\n---\n# Body\n')
    expect(fm.data).toEqual({ state: 'current', reviewed: { revision: 'abc', scope: 'a, b' }, depends_on: ['x.yml', 'y z'] })
    expect(fm.offset).toBe(7)
    const managed = frontMatter('<!-- marver:managed 0123 - edit freely -->\n---\nname: release\n---\nbody\n')
    expect(managed.data).toEqual({ name: 'release' })
    expect(managed.offset).toBe(4)
    expect(frontMatter('---\nstate: current\n# no close\n').error).toMatch(/never closes/)
    expect(frontMatter('# plain\n').data).toBeNull()
  })

  it('tables: pipes inside backticks stay in their cell; code fences are not tables', () => {
    const t = tables('| A | B |\n|---|---|\n| `a|b` | c |\n\n```\n| x | y |\n```\n')
    expect(t).toHaveLength(1)
    expect(t[0].rows[0].cells).toEqual(['`a|b`', 'c'])
  })

  it('shipped rows: capability tables with an Available column, levels read per row', () => {
    const rows = shippedRows([
      '| Service | Evidence |', '|---|---|', '| app | `confirmed` - run 1234567 |', '',
      '| Capability | Implemented | Available |', '|---|---|---|',
      '| `checkout` - pay | `src/c.ts` | production - `confirmed` by run 1234567 |',
      '| `quote` | `src/q.ts` | production - `reported`, `CHANGELOG.md:3` |',
    ].join('\n'))
    expect(rows.map((r) => [r.capability, r.levels])).toEqual([['checkout', ['confirmed']], ['quote', ['reported']]])
  })

  it('globs: **, *, {a,b}, and literal dots and dollars', () => {
    expect(globRe('apps/{desk,run}/app/routes/api.$id.ts*').test('apps/run/app/routes/api.$id.tsx')).toBe(true)
    expect(globRe('apps/**').test('apps/a/b/c.ts')).toBe(true)
    expect(globRe('src/*.ts').test('src/a/b.ts')).toBe(false)
    expect(globRe('packages/db/drizzle/{0017_m3-run,0018_x}.sql').test('packages/db/drizzle/0018_x.sql')).toBe(true)
  })

  it('the map and its generated index table', () => {
    const m = parseMap(JSON.stringify({ capabilities: { a: { contract: 'context/product/a.md', paths: ['src/a/**'] }, b: { paths: [] } } }))
    expect(typeof m).toBe('object')
    expect(capabilityTable(m as Exclude<typeof m, string>)).toBe('| Capability | Contract |\n|---|---|\n| `a` | [`product/a.md`](product/a.md) |\n| `b` | none yet - see the map |')
    expect(parseMap('{"capabilities": {"a": {}}}')).toMatch(/paths must be a list of paths/)
    const withSummary = parseMap(JSON.stringify({ capabilities: { pay: { summary: 'taking money | refunds', contract: 'context/product/pay.md', paths: [] } } }))
    expect(capabilityTable(withSummary as Exclude<typeof withSummary, string>)).toMatch(/^\| `pay` - taking money \/ refunds \| \[`product\/pay.md`\]\(product\/pay.md\) \|$/m)
  })
})

// ---------------------------------------------------------------------------------------------
describe('board types (spec 20)', () => {
  it('own type, else the folder, else its parent, else plain; an unknown own type reads plain', () => {
    expect(resolveType('deck', 'feature')).toBe('deck')
    expect(resolveType(undefined, 'feature', 'project')).toBe('feature')
    expect(resolveType(undefined, undefined, 'project')).toBe('project')
    expect(resolveType(undefined, 'brand-new-kind', 'project')).toBe('project')
    expect(resolveType('brand-new-kind', 'feature')).toBe('plain')
    expect(resolveType(undefined)).toBe('plain')
    expect(readType('Not A Type')).toBeUndefined()
  })

  it('a folder type survives the registry, the tree and the wire - an unknown word included', () => {
    const rows = parseFolders({ version: 1, folders: [{ name: 'features', type: 'feature' }, { name: 'brand', type: 'brand-kit' }, { name: 'x', type: 'NOPE' }] })
    expect(rows).toEqual([{ name: 'features', type: 'feature' }, { name: 'brand', type: 'brand-kit' }, { name: 'x' }])
    const tree = buildTree([{ name: 'a', folder: 'features' }], rows as never)
    const wire = toWire(tree)
    expect(wire).toContainEqual({ folder: 'features', items: ['a'], type: 'feature' })
    expect(validateWire(wire)).toBeNull()
    expect(validateWire([{ folder: 'f', items: [], type: 'Bad Type' }])).toMatch(/invalid folder type/)
    expect(fromWire(wire as never).find((f) => f.name === 'brand')).toMatchObject({ type: 'brand-kit' })
  })
})

// ---------------------------------------------------------------------------------------------
const lv = (levels: Level[], audience: Audience = 'team') => ({ levels, where: 'context/shipped.md:9', audience })
const ct = (state: string, audience: Audience = 'team') => ({ state, where: 'context/product/c.md', audience })
const pl = (where: string, audience: Audience = 'team') => [{ where, audience }]

describe('status: the nine rows (spec 20)', () => {
  const ctx = (over: Partial<ContextFacts> = {}): ContextFacts => ({ present: true, unreadable: new Map(), shipped: new Map(), contracts: new Map(), plans: new Map(), ...over })
  const board = (over = {}) => ({ name: 'checkout', type: 'feature' as const, scenes: [], ...over })

  it('only feature and project boards wear one', () => {
    expect(resolveStatus({ ...board(), type: 'deck' }, ctx())).toBeNull()
    expect(resolveStatus({ ...board(), type: 'project' }, ctx())?.status).toBe('backlog')
  })
  it('rows 1-3: the board decides, a blocked board says why', () => {
    expect(resolveStatus(board({ status: 'archived' }), ctx())).toMatchObject({ status: 'archived', row: 1 })
    expect(resolveStatus(board({ status: 'paused' }), ctx())).toMatchObject({ status: 'paused', row: 2 })
    expect(resolveStatus(board({ status: 'blocked', reason: 'the provider' }), ctx())).toMatchObject({ status: 'blocked', row: 3, reason: 'the provider' })
  })
  it('row 4: unreadable evidence is Unknown - never a stale Done', () => {
    const shipped = new Map([['checkout', lv(['confirmed'])]])
    expect(resolveStatus(board(), ctx({ shipped, unreadable: new Map([['*', 'context/shipped.md: broken']]) }))).toMatchObject({ status: 'unknown', row: 4 })
    expect(resolveStatus(board(), ctx({ unreadable: new Map([['checkout', 'bad contract']]) }))?.status).toBe('unknown')
    expect(resolveStatus(board({ name: 'other' }), ctx({ unreadable: new Map([['checkout', 'bad']]) }))?.status).toBe('backlog')
  })
  it('row 5 wins over a shipped record: version two is being built', () => {
    const r = resolveStatus(board({ scenes: [{ name: 'checkout-specs' }, { name: 'checkout-lofi' }] }), ctx({
      plans: new Map([['checkout', pl('context/plans/v2.md')]]),
      shipped: new Map([['checkout', lv(['confirmed'])]]),
    }))
    expect(r).toMatchObject({ status: 'in-progress', row: 5, fill: 2 })
  })
  it('rows 6-9: confirmed, reported, an accepted contract, else Backlog', () => {
    expect(resolveStatus(board(), ctx({ shipped: new Map([['checkout', lv(['reported', 'confirmed'])]]) }))?.status).toBe('done')
    expect(resolveStatus(board(), ctx({ shipped: new Map([['checkout', lv(['reported'])]]) }))?.status).toBe('done-reported')
    expect(resolveStatus(board(), ctx({ shipped: new Map([['checkout', lv(['unknown'])]]) }))?.status).toBe('backlog')
    expect(resolveStatus(board(), ctx({ contracts: new Map([['checkout', ct('current')]]) }))?.status).toBe('todo')
    expect(resolveStatus(board(), ctx({ contracts: new Map([['checkout', ct('proposed')]]) }))?.status).toBe('backlog')
  })
  it('a board names its capability, or is it', () => {
    const shipped = new Map([['pay', lv(['confirmed'])]])
    expect(resolveStatus(board({ capability: 'pay' }), ctx({ shipped }))?.status).toBe('done')
  })
  it('row 5: a plan whose code is underway (`stage: build`) is Building - the design agreed, no fill', () => {
    const plans = new Map([['checkout', [{ where: 'context/plans/a.md', audience: 'team' as Audience }, { where: 'context/plans/b.md', audience: 'publishable' as Audience, stage: 'build' as const }]]])
    const r = resolveStatus(board({ scenes: [{ name: 'checkout' }] }), ctx({ plans }))
    expect(r).toMatchObject({ status: 'building', row: 5, evidence: ['context/plans/b.md: stage build'], audience: 'publishable' })
    expect(r?.fill).toBeUndefined()
    // version two of a shipped capability, being built
    const v2 = resolveStatus(board(), ctx({ plans, shipped: new Map([['checkout', lv(['confirmed'])]]) }))
    expect(v2?.status).toBe('building')
    expect(v2?.evidence[1]).toMatch(/this is the next version/)
    expect(publishableStatus({ status: 'building', row: 5, audience: 'publishable' })).toEqual({ status: 'building' })
  })
  it('without context/: by hand for To do, Backlog, In progress and Building - never Done', () => {
    expect(resolveStatus(board({ status: 'todo' }), NO_CONTEXT)?.status).toBe('todo')
    expect(resolveStatus(board({ status: 'in-progress' }), NO_CONTEXT)?.status).toBe('in-progress')
    expect(resolveStatus(board({ status: 'building' }), NO_CONTEXT)).toMatchObject({ status: 'building', row: 5 })
    expect(resolveStatus(board({ status: 'building' }), ctx())?.status).toBe('backlog')   // with context/ the plan says it, not the board
    expect(resolveStatus(board({ status: 'done' }), NO_CONTEXT)?.status).toBe('backlog')
    expect(resolveStatus(board({ status: 'done' }), ctx())?.status).toBe('backlog')
  })
  it('phases come from scene names or a brief, never geometry', () => {
    expect(phaseOf('c', [{ name: 'c-specs' }])).toBe(1)
    expect(phaseOf('c', [{ name: 'c-specs' }, { name: 'c' }])).toBe(3)
    expect(phaseOf('c', [{ name: 'anything', phase: 'lofi' }])).toBe(2)
    expect(phaseOf('c', [{ name: 'other' }])).toBeUndefined()
  })
  it('what a published canvas may show: rows 5-9, from publishable evidence only, no reason', () => {
    expect(publishableStatus({ status: 'blocked', row: 3, audience: 'publishable' })).toBeNull()
    expect(publishableStatus({ status: 'in-progress', row: 5, fill: 2, audience: 'team' })).toBeNull()
    expect(publishableStatus({ status: 'in-progress', row: 5, fill: 2, audience: 'publishable' })).toEqual({ status: 'in-progress', fill: 2 })
  })
  it('a status takes the strictest audience of its evidence', () => {
    expect(resolveStatus(board(), ctx({ shipped: new Map([['checkout', lv(['confirmed'], 'publishable')]]) }))?.audience).toBe('publishable')
    expect(resolveStatus(board(), ctx({ contracts: new Map([['checkout', ct('current', 'restricted')]]) }))?.audience).toBe('restricted')
    expect(resolveStatus(board(), ctx())?.audience).toBe('publishable')
  })
  it('work on a shipped capability says it is the next version', () => {
    const r = resolveStatus(board(), ctx({ plans: new Map([['checkout', pl('context/plans/v2.md')]]), shipped: new Map([['checkout', lv(['confirmed'])]]) }))
    expect(r?.evidence[1]).toMatch(/this is the next version/)
  })
  it('status glyphs follow one rule: open is an outline, settled is filled - done green, archived a solid brown box', () => {
    const svg = (status: Parameters<typeof StatusIcon>[0]['status']) => renderToStaticMarkup(createElement(StatusIcon, { status }))
    // the first shape is the silhouette: an open status draws it as a ring, a settled one fills it
    const silhouette = (s: string) => /<(circle|rect|path)\b[^>]*>/.exec(s.replace(/<mask[\s\S]*?<\/mask>/g, ''))![0]
    for (const s of ['backlog', 'todo', 'in-progress', 'building', 'blocked', 'unknown', 'paused', 'done-reported'] as const)
      expect(silhouette(svg(s))).toMatch(/<circle[^>]*fill="none"/)
    expect(svg('building')).toMatch(/stroke="var\(--status-building, #0088ff\)"[\s\S]*M5.6 4.9 L3.8 7 L5.6 9.1/)   // the code, in Marver's blue
    expect(silhouette(svg('done'))).toMatch(/<circle[^>]*fill="var\(--status-done, #34c759\)"/)
    expect(svg('done-reported')).toMatch(/stroke="var\(--status-done/)          // the same green, outlined: not yet confirmed
    // Done's check is cut out of the disc - the row behind shows through it, in either theme
    expect(svg('done')).toMatch(/<mask id="(mv-st-[\w-]+)">[\s\S]*stroke="#000"[\s\S]*<\/mask><circle[^>]*mask="url\(#\1\)"/)
    expect(svg('done')).not.toMatch(/stroke="#fff"/)
    const archived = svg('archived')
    expect(archived).not.toMatch(/<circle|fill="none"/)                       // no ring: out of the flow, and solid
    expect(archived.match(/fill="var\(--status-archived, #956d51\)"/g)).toHaveLength(2)   // the lid and the body, in brown
    expect(renderToStaticMarkup(createElement(TypeIcon, { type: 'archive' }))).toMatch(/fill="none"/)   // the type icon stays an outline
  })
})

// ---------------------------------------------------------------------------------------------
describe('reading context/ off disk', () => {
  it('the record, contracts and open plans; a broken contract is Unknown for its capability', () => {
    put('context/shipped.md', '| Capability | Available |\n|---|---|\n| `a` | production - `confirmed` by run 1234567 |\n')
    put('context/product/b.md', '---\nstate: current\ncapability: b\n---\n')
    put('context/product/c.md', '---\nstate: current\n')
    put('context/plans/p.md', '---\nstate: proposed\ncapabilities: [d, e]\n---\n')
    put('context/plans/old.md', '---\nstate: historical\ncapability: f\n---\n')
    const f = readContextFacts(root)
    expect([...f.shipped.keys()]).toEqual(['a'])
    expect(f.contracts.get('b')?.state).toBe('current')
    expect(f.unreadable.get('c')).toMatch(/never closes/)
    expect([...f.plans.keys()].sort()).toEqual(['d', 'e'])
    expect(f.plans.get('d')?.[0].stage).toBeUndefined()
    put('context/plans/q.md', '---\nstate: proposed\ncapability: g\nstage: Building\n---\n')
    put('context/plans/r.md', '---\nstate: proposed\ncapability: h\nstage: design\n---\n')
    const g = readContextFacts(root)
    expect(g.plans.get('g')?.[0].stage).toBe('build')                        // build or building, any case
    expect(g.plans.get('h')?.[0].stage).toBeUndefined()
  })

  it('planWithStage moves only the stage line - inserted, replaced, removed - every other byte kept; refuses what it cannot edit as one line', () => {
    const ok = (raw: string, st: 'build' | null) => { const r = planWithStage(raw, st); if ('error' in r) throw new Error(r.error); return r.text }
    expect(ok('---\nstate: proposed\n---\nbody\n', 'build')).toBe('---\nstate: proposed\nstage: build\n---\nbody\n')
    expect(ok('---\nstage: design\nstate: proposed\n---\n', 'build')).toBe('---\nstage: build\nstate: proposed\n---\n')
    expect(ok('---\nstate: proposed\nstage: build\n---\nstage: build in the body stays\n', null)).toBe('---\nstate: proposed\n---\nstage: build in the body stays\n')
    expect(ok('---\nstate: proposed\n---\n', null)).toBe('---\nstate: proposed\n---\n')
    expect(ok('---\nstage: build\n  # implementation underway\nstate: proposed\n---\n', null)).toBe('---\n  # implementation underway\nstate: proposed\n---\n')   // an indented comment is no value
    // CRLF front matter over an LF body: only the inserted line is new - the body keeps its endings
    expect(ok('<!-- marver:managed v1 -->\r\n---\r\nstate: proposed\r\n---\r\n# Body\nline\n', 'build')).toBe('<!-- marver:managed v1 -->\r\n---\r\nstate: proposed\r\nstage: build\r\n---\r\n# Body\nline\n')
    for (const [raw, why] of [
      ['# no front matter\n', /no front matter/],
      ['---\nstate: proposed\n', /never closes/],
      ['---\ncapability: pay\nstage:\n  - build\n---\n', /not one word/],     // removing the header would hand its list to `capability`
      ['---\nstage: [build]\n---\n', /not one word/],
      ['---\nstage: build\nstage: design\n---\n', /twice/],
      // a list behind a comment: the reader would hand `- build` to capability once the header goes
      ['---\ncapability: pay\nstage: # list follows\n# a comment\n  - build\n---\n', /not one word|cannot edit as one line/],
      ['---\nstage: # list follows\n# a comment\n  - build\ncapability: pay\n---\n', /not one word/],   // first field: the reader drops the orphaned list
      ['---\ncapability: pay\nstage: |-\n  build\n---\n', /not one word/],                     // a block: \`pay build\` once the header goes
      ['---\ncapability: pay\nstage: >\n  build\n---\n', /not one word/],
      ['---\ncapability: pay\nstage: build\n  more\n---\n', /not one word/],                   // a plain scalar continued on an indented line
    ] as const) expect((planWithStage(raw, null) as { error: string }).error).toMatch(why)
  })

  it('planNames: the plan a write reads must still be open and still name the capability', () => {
    expect(planNames('---\nstate: proposed\ncapability: pay\n---\n', 'pay')).toBe(true)
    expect(planNames('---\nstate: proposed\ncapabilities: [a, pay]\n---\n', 'pay')).toBe(true)
    expect(planNames('---\nstate: historical\ncapability: pay\n---\n', 'pay')).toBe(false)   // closed meanwhile
    expect(planNames('---\nstate: proposed\ncapability: refunds\n---\n', 'pay')).toBe(false)  // moved to another
    expect(planNames('# no front matter\n', 'pay')).toBe(false)
  })

  it('POST boards/status writes the plans and the board together: an odd stage writes nothing, a failed write puts the plans back', async () => {
    put('context/INDEX.md', '# The index\n')
    put('design/boards/pay.json', { version: 1, type: 'feature', status: 'paused', nodes: [] })
    put('context/plans/a.md', '---\nstate: proposed\ncapability: pay\n---\n')
    put('context/plans/b.md', '---\nstate: proposed\ncapability: pay\nstage:\n  - build\n---\n')
    let r = await drive('POST', 'boards/status', { name: 'pay', status: 'building' })
    expect(r.status).toBe(422)
    expect(r.json.error).toMatch(/context\/plans\/b.md has a `stage` that is not one word/)
    expect(read('context/plans/a.md')).not.toMatch(/stage/)                               // nothing written
    expect(JSON.parse(read('design/boards/pay.json')).status).toBe('paused')
    put('context/plans/b.md', '---\nstate: proposed\ncapability: pay\n---\n')
    // the board cannot be written: the plans written before it go back
    const dir = join(root, 'design', 'boards')
    chmodSync(dir, 0o555)
    try {
      r = await drive('POST', 'boards/status', { name: 'pay', status: 'building' })
    } finally { chmodSync(dir, 0o755) }
    expect(r.status).toBe(500)
    expect(r.json.error).toMatch(/nothing changed/)
    expect(read('context/plans/a.md')).not.toMatch(/stage/)
    expect(read('context/plans/b.md')).not.toMatch(/stage/)
    expect(JSON.parse(read('design/boards/pay.json')).status).toBe('paused')
  })

  it('a board inherits its folder type; a phase counts once its scene holds a frame', () => {
    put('design/scenes/x-lofi/_brief.md', '---\nphase: lofi\n---\n')
    put('context/plans/p.md', '---\nstate: proposed\ncapability: x\n---\n')
    const boards = [{ name: 'x', json: { folder: 'features', layout: { rows: [['x-lofi']] } } }]
    const folders = [{ name: 'features', type: 'feature' }]
    let a = annotateBoards(root, boards, folders, () => 'features')
    expect(a.get('x')).toMatchObject({ type: 'feature', status: { status: 'in-progress' } })
    expect(a.get('x')?.status?.fill).toBeUndefined()
    put('design/scenes/x-lofi/one.tsx', 'export default () => null\n')
    a = annotateBoards(root, boards, folders, () => 'features')
    expect(a.get('x')?.status?.fill).toBe(2)
  })

  it('the manifest carries types and compact statuses - never the evidence', () => {
    put('design/boards/_folders.json', { version: 1, folders: [{ name: 'features', type: 'feature' }] })
    put('design/boards/pay.json', { version: 1, folder: 'features', nodes: [] })
    put('design/boards/plain.json', { version: 1, nodes: [] })
    put('context/shipped.md', '| Capability | Available |\n|---|---|\n| `pay` | production - `confirmed` by run 1234567 |\n')
    const m = scanFrames(root)
    expect(m.folders).toEqual([{ name: 'features', type: 'feature' }])
    expect(m.boards?.find((b) => b.name === 'pay')).toMatchObject({ type: 'feature', status: { status: 'done' } })
    expect(JSON.stringify(m.boards)).not.toMatch(/evidence|run 1234567/)
    expect(m.boards?.find((b) => b.name === 'plain')).toEqual({ name: 'plain' })
  })
})

// ---------------------------------------------------------------------------------------------
// the dev API: types and statuses out, spec 20's fields kept through every write
function drive(method: string, path: string, body?: unknown) {
  const mw = apiMiddleware(root)
  const req: any = {
    method, url: `${ROUTE}/api/${path}`,
    headers: { host: 'localhost:5200', cookie: 'mv_c=tok', 'x-mv-c': 'tok', origin: 'http://localhost:5200' },
    _cbs: {} as Record<string, (arg?: unknown) => void>,
    on(ev: string, cb: (arg?: unknown) => void) { this._cbs[ev] = cb; return this },
    destroy() {},
  }
  const res: any = { statusCode: 0, body: '', setHeader() {}, end(s?: string) { this.body = s ?? ''; this._done?.() } }
  const done = new Promise<{ status: number; json: any }>((resolve) => {
    res._done = () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(res.body) } catch { return null } })() })
    void mw(req, res, () => resolve({ status: 404, json: null }))
  })
  if (method === 'POST' || method === 'PUT') {
    const raw = Buffer.from(JSON.stringify(body ?? {}))
    queueMicrotask(() => { req._cbs.data?.(raw); req._cbs.end?.() })
  }
  return done
}

describe('the dev API (spec 20)', () => {
  it('lists each board with its resolved type and its status with evidence', async () => {
    put('design/boards/_folders.json', { version: 1, folders: [{ name: 'features', type: 'feature' }] })
    put('design/boards/pay.json', { version: 1, folder: 'features', nodes: [] })
    put('context/product/pay.md', '---\nstate: current\ncapability: pay\n---\n')
    const r = await drive('GET', 'boards')
    expect(r.json[0]).toMatchObject({ name: 'pay', type: 'feature', status: { status: 'todo', row: 8, evidence: [expect.stringMatching(/context\/product\/pay.md/)] } })
    const f = await drive('GET', 'folders')
    expect(f.json.folders).toEqual([{ name: 'features', type: 'feature' }])
  })

  it('an autosave keeps type, capability, status and reason from disk', async () => {
    put('design/boards/pay.json', { version: 1, type: 'feature', capability: 'payments', status: 'blocked', reason: 'the provider', nodes: [] })
    const sha = hash(read('design/boards/pay.json'))
    const r = await drive('PUT', 'boards/pay', { board: { version: 1, nodes: [{ frame: 'a/b' }] }, baseHash: sha, mustExist: true })
    expect(r.status).toBe(200)
    expect(JSON.parse(read('design/boards/pay.json'))).toMatchObject({ type: 'feature', capability: 'payments', status: 'blocked', reason: 'the provider', nodes: [{ frame: 'a/b' }] })
  })

  it('a tree write keeps a folder type', async () => {
    put('design/boards/_folders.json', { version: 1, folders: [{ name: 'features', type: 'feature' }] })
    put('design/boards/pay.json', { version: 1, nodes: [] })
    const b = await drive('GET', 'boards'), f = await drive('GET', 'folders')
    const r = await drive('POST', 'boards/reorder', {
      protocol: 2, tree: [{ folder: 'features', items: ['pay'], type: 'feature' }],
      base: { boards: { pay: b.json[0].sha256 }, folders: f.json.sha256 },
    })
    expect(r.status).toBe(200)
    expect(JSON.parse(read('design/boards/_folders.json')).folders).toEqual([{ name: 'features', order: 0, type: 'feature' }])
    expect(JSON.parse(read('design/boards/pay.json')).folder).toBe('features')
  })

  it('settable: the three decisions with context/ (plus In progress and Building where an open plan names it), the by-hand words as well without it - only on boards that carry a status', async () => {
    put('design/boards/pay.json', { version: 1, type: 'feature', nodes: [] })
    put('design/boards/pitch.json', { version: 1, type: 'deck', nodes: [] })
    const of = async (n: string) => (await drive('GET', 'boards')).json.find((b: any) => b.name === n)
    expect((await of('pay')).settable).toEqual(['backlog', 'todo', 'in-progress', 'building', 'blocked', 'paused', 'archived'])
    expect((await of('pitch')).settable).toBeUndefined()
    put('context/INDEX.md', '# The index\n')
    expect((await of('pay')).settable).toEqual(['blocked', 'paused', 'archived'])
    put('context/plans/pay-v1.md', '---\nstate: proposed\ncapability: pay\n---\n')
    expect((await of('pay')).settable).toEqual(['in-progress', 'building', 'blocked', 'paused', 'archived'])
  })

  it('POST boards/status Building with context/: the open plan says `stage: build`, the board\'s decision gives way; In progress takes it off', async () => {
    put('context/INDEX.md', '# The index\n')
    put('design/boards/pay.json', { version: 1, type: 'feature', capability: 'payments', status: 'paused', nodes: [] })
    // no open plan: Building has nothing to be read from
    let r = await drive('POST', 'boards/status', { name: 'pay', status: 'building' })
    expect(r.status).toBe(422)
    expect(r.json.error).toMatch(/Building needs an open plan naming payments/)
    put('context/plans/v2.md', '<!-- marver:managed v1 -->\r\n---\r\nstate: proposed\r\ncapability: payments\r\n---\r\n# Payments v2\r\n')
    put('context/plans/old.md', '---\nstate: historical\ncapability: payments\n---\n')             // closed: never touched
    r = await drive('POST', 'boards/status', { name: 'pay', status: 'building' })
    expect(r.status).toBe(200)
    expect(read('context/plans/v2.md')).toBe('<!-- marver:managed v1 -->\r\n---\r\nstate: proposed\r\ncapability: payments\r\nstage: build\r\n---\r\n# Payments v2\r\n')
    expect(read('context/plans/old.md')).not.toMatch(/stage/)
    expect(JSON.parse(read('design/boards/pay.json')).status).toBeUndefined()   // no longer paused
    expect((await drive('GET', 'boards')).json.find((b: any) => b.name === 'pay').status).toMatchObject({ status: 'building', row: 5, evidence: ['context/plans/v2.md: stage build'] })
    r = await drive('POST', 'boards/status', { name: 'pay', status: 'in-progress' })
    expect(r.status).toBe(200)
    expect(read('context/plans/v2.md')).not.toMatch(/stage/)
    expect((await drive('GET', 'boards')).json.find((b: any) => b.name === 'pay').status.status).toBe('in-progress')
    // a plan naming the capability twice is one file, written once
    put('context/plans/twice.md', '---\nstate: proposed\ncapabilities: [payments, payments]\ncapability: payments\n---\n')
    r = await drive('POST', 'boards/status', { name: 'pay', status: 'building' })
    expect(r.status).toBe(200)
    expect(read('context/plans/twice.md').match(/stage: build/g)).toHaveLength(1)
  })

  it('POST boards/status: a decision into the file, every other field kept; blocked says why; null clears both', async () => {
    put('context/INDEX.md', '# The index\n')
    put('design/boards/pay.json', { version: 1, type: 'feature', title: 'Payments', capability: 'payments', nodes: [{ frame: 'a/b' }] })
    const sha = () => hash(read('design/boards/pay.json'))
    let r = await drive('POST', 'boards/status', { name: 'pay', status: 'paused', baseHash: sha() })
    expect(r.status).toBe(200)
    expect(r.json.sha256).toBe(sha())
    expect(JSON.parse(read('design/boards/pay.json'))).toEqual({ version: 1, type: 'feature', title: 'Payments', capability: 'payments', nodes: [{ frame: 'a/b' }], status: 'paused' })
    expect((await drive('POST', 'boards/status', { name: 'pay', status: 'blocked' })).status).toBe(400)          // no reason
    r = await drive('POST', 'boards/status', { name: 'pay', status: 'blocked', reason: '  waiting on   the bank ', baseHash: sha() })
    expect(r.status).toBe(200)
    expect(JSON.parse(read('design/boards/pay.json'))).toMatchObject({ status: 'blocked', reason: 'waiting on the bank' })
    r = await drive('POST', 'boards/status', { name: 'pay', status: 'archived' })
    expect(JSON.parse(read('design/boards/pay.json')).reason).toBeUndefined()                                    // a reason is a blocked board's alone
    r = await drive('POST', 'boards/status', { name: 'pay', status: null, baseHash: sha() })
    expect(r.status).toBe(200)
    const after = JSON.parse(read('design/boards/pay.json'))
    expect(after.status).toBeUndefined()
    expect(after).toMatchObject({ title: 'Payments', capability: 'payments' })
  })

  it('POST boards/status refuses Done, the evidence\'s words where context/ decides them, a board with no status, a stale hash', async () => {
    put('design/boards/_folders.json', { version: 1, folders: [{ name: 'features', type: 'feature' }, { name: 'decks', type: 'deck' }] })
    put('design/boards/pay.json', { version: 1, folder: 'features', nodes: [] })                                // a feature by its folder
    put('design/boards/pitch.json', { version: 1, folder: 'decks', nodes: [] })
    expect((await drive('POST', 'boards/status', { name: 'pay', status: 'todo' })).status).toBe(200)          // no context/: by hand
    put('context/INDEX.md', '# The index\n')
    for (const status of ['todo', 'backlog', 'in-progress', 'building', 'done']) {
      const r = await drive('POST', 'boards/status', { name: 'pay', status })
      expect(r.status).toBe(422)
      expect(r.json.error).toMatch(status === 'done' ? /never set by hand/ : status === 'in-progress' || status === 'building' ? /needs an open plan/ : /read from the evidence/)
    }
    expect((await drive('POST', 'boards/status', { name: 'pay', status: 'done-reported' })).status).toBe(400)
    expect((await drive('POST', 'boards/status', { name: 'pitch', status: 'paused' })).json.error).toMatch(/deck board carries no status/)
    expect((await drive('POST', 'boards/status', { name: 'nope', status: 'paused' })).status).toBe(404)
    const r = await drive('POST', 'boards/status', { name: 'pay', status: 'paused', baseHash: 'stale' })
    expect(r.status).toBe(409)
    expect(JSON.parse(read('design/boards/pay.json')).status).toBe('todo')                                     // nothing written
  })
})

// ---------------------------------------------------------------------------------------------
describe('publishing (spec 20): the projection', () => {
  it('an existing row keeps presenting as it always has - a board type only suggests, never changes it', () => {
    put('design/publish.json', { boards: { deck: 'read', pay: { max: 'comment' }, own: { max: 'read', type: 'design' } } })
    const p = resolvePolicy(root, { deck: {}, pay: {}, own: {} })
    expect(p.boards.deck).toEqual({ max: 'read', type: 'mix' })
    expect(p.boards.pay).toEqual({ max: 'comment', type: 'mix' })
    expect(p.boards.own).toEqual({ max: 'read', type: 'design' })
  })

  it('showStatus is a boolean', () => {
    put('design/publish.json', { boards: { pay: { max: 'read', showStatus: 'yes' } } })
    expect(() => resolvePolicy(root, { pay: {} })).toThrow(/showStatus/)
  })

  it('boards ship without their evidence fields; a status only where opted in, rows 5-9, no reason', () => {
    expect(withoutEvidence({ nodes: [], status: 'blocked', reason: 'r', capability: 'c', type: 'feature' })).toEqual({ nodes: [], type: 'feature' })
    const manifest = {
      frames: [], scenes: [],
      boards: [
        { name: 'a', type: 'feature', status: { status: 'done' as const } },
        { name: 'b', type: 'feature', status: { status: 'blocked' as const, reason: 'secret' } },
        { name: 'c', type: 'feature', status: { status: 'in-progress' as const, fill: 2 as const, audience: 'publishable' as const } },
      ],
    }
    const pub = publishedManifest(manifest, [], ['a', 'b', 'c'], true, new Set(['b', 'c']))
    expect(pub.boards).toEqual([{ name: 'a', type: 'feature' }, { name: 'b', type: 'feature' }, { name: 'c', type: 'feature', status: { status: 'in-progress', fill: 2 } }])
  })

  it('a status ships only from publishable evidence', () => {
    const manifest = { frames: [], scenes: [], boards: [
      { name: 'a', status: { status: 'todo' as const, audience: 'restricted' as const } },
      { name: 'b', status: { status: 'done' as const, audience: 'publishable' as const } },
    ] }
    const pub = publishedManifest(manifest, [], ['a', 'b'], true, new Set(['a', 'b']))
    expect(pub.boards).toEqual([{ name: 'a' }, { name: 'b', status: { status: 'done' } }])
  })

  it('the build fails when a stripped field survives', () => {
    const base = { manifest: { frames: [], scenes: [] }, boards: { a: { nodes: [] } } }
    expect(() => assertProjected(base as never, new Set())).not.toThrow()
    expect(() => assertProjected({ ...base, boards: { a: { status: 'blocked' } } } as never, new Set())).toThrow(/would ship its "status"/)
    expect(() => assertProjected({ ...base, manifest: { frames: [], scenes: [], boards: [{ name: 'a', status: { status: 'done' } }] } } as never, new Set())).toThrow(/did not allow/)
    expect(() => assertProjected({ ...base, manifest: { frames: [], scenes: [], boards: [{ name: 'a', status: { status: 'blocked' } }] } } as never, new Set(['a']))).toThrow(/did not allow/)
    expect(() => assertProjected({ ...base, meta: { a: { status: { status: 'done', reason: 'x' } } } } as never, new Set(['a']))).toThrow(/did not allow/)
    expect(() => assertProjected({ ...base, meta: { a: { type: 'feature', capability: 'x' } } } as never, new Set(['a']))).toThrow(/beyond its type and status/)
    expect(() => assertProjected({ ...base, meta: { a: { type: 'feature', status: { status: 'done', fill: 2 } } } } as never, new Set(['a']))).not.toThrow()
  })
})

// ---------------------------------------------------------------------------------------------
describe('init --kind, folders add, boards new', () => {
  it('a fresh canvas gets its kind\'s typed folders; a re-run never rearranges', () => {
    init(root, { mode: 'studio', demo: false, kind: 'knowledge' })
    const reg = () => JSON.parse(read('design/boards/_folders.json')).folders
    expect(reg().map((f: { name: string }) => f.name)).toEqual(['start-here', 'projects', 'feedback', 'context', 'archive'])
    expect(reg()[0]).toMatchObject({ title: 'Start here', type: 'start' })
    put('design/boards/_folders.json', { version: 1, folders: [{ name: 'context', order: 0, type: 'context' }, { name: 'mine', order: 1 }] })
    init(root, { mode: 'studio', demo: false })
    expect(reg().map((f: { name: string }) => f.name)).toEqual(['context', 'mine'])
    init(root, { mode: 'studio', demo: false, kind: 'knowledge' })
    expect(reg().map((f: { name: string }) => f.name)).toEqual(['context', 'mine', 'start-here', 'projects', 'feedback', 'archive'])
    expect(reg()[0]).toEqual({ name: 'context', order: 0, type: 'context' })
  })

  it('init says how to start context/ while there is none - in the words to give the agent - and stops once it exists', () => {
    const said = () => { const log = vi.spyOn(console, 'log').mockImplementation(() => {}); try { init(root, { mode: 'studio', demo: false }); return log.mock.calls.flat().join('\n') } finally { log.mockRestore() } }
    expect(said()).toMatch(/no context\/ yet - feature and project boards read Backlog[\s\S]*"Set up our context\."/)
    contextInit(root)
    expect(said()).not.toMatch(/no context\/ yet/)
  })

  it('the contract and boards.md put the context offer before feature work in a project without one', () => {
    init(root, { mode: 'studio', demo: false })
    expect(read('design/AGENTS.md')).toMatch(/## Before the method: a project with no `context\/`[\s\S]*ends with this line[\s\S]*Want me to set it up\?[\s\S]*## The method/)
    expect(read('design/instructions/boards.md')).toMatch(/No `context\/`\? Your reply ends with the context line/)
  })

  it('folders add appends a module once, after everything at the root', () => {
    put('design/boards/top.json', { version: 1, order: 7, nodes: [] })
    expect(foldersAdd(root, ['decks'])).toEqual({ added: ['decks'], existing: [] })
    expect(foldersAdd(root, ['decks'])).toEqual({ added: [], existing: ['decks'] })
    expect(JSON.parse(read('design/boards/_folders.json')).folders).toEqual([{ name: 'decks', order: 8, type: 'deck' }])
    expect(() => foldersAdd(root, ['brand'])).toThrow(/unknown folder module/)
  })

  it('a feature board starts as three phase bands, its type from its folder', () => {
    addFolders(root, [{ name: 'features', type: 'feature' }])
    boardsNew(root, 'checkout', { folder: 'features' })
    const b = JSON.parse(read('design/boards/checkout.json'))
    expect(b.type).toBeUndefined()
    expect(b.layout.rows).toEqual([['checkout-specs'], { space: 3 }, ['checkout-lofi'], { space: 4 }, ['checkout']])
    expect(frontMatter(read('design/scenes/checkout-lofi/_brief.md')).data).toMatchObject({ phase: 'lofi' })
    expect(() => boardsNew(root, 'checkout', {})).toThrow(/never overwritten/)
  })

  it('a start board renders the index and the shipped record; a deck starts on a slide', () => {
    boardsNew(root, 'home', { type: 'start' })
    expect(read('design/scenes/home/index.tsx')).toMatch(/context\/INDEX\.md\?raw/)
    expect(JSON.parse(read('design/boards/home.json')).nodes).toEqual([{ frame: 'home/index' }, { frame: 'home/shipped' }])
    boardsNew(root, 'pitch', { type: 'deck', title: 'The pitch' })
    expect(read('design/scenes/pitch/01-title.tsx')).toMatch(/slide: true/)
    expect(() => boardsNew(root, 'x', { type: 'nope' })).toThrow(/--type nope/)
  })
})

// ---------------------------------------------------------------------------------------------
describe('marver context: init, index, check', () => {
  const pass = () => contextCheck(root)
  const rules = (r = pass()) => r.failures.map((f) => f.rule)
  beforeEach(() => {
    git('init', '-q')
    put('package.json', { name: '@acme/app' })
    contextInit(root)
  })

  it('init creates the files once, the playbooks managed, and routes the root AGENTS.md', () => {
    expect(read('context/INDEX.md')).toMatch(/^---\naudience: team\n---\n\n# app - the index/)
    expect(read('context/playbooks/reorganize-context/PLAYBOOK.md')).toMatch(/^<!-- marver:managed [0-9a-f]{64} /)
    expect(read('AGENTS.md')).toMatch(/start at context\/INDEX\.md/)
    expect(contextInit(root)).toEqual([])
    expect(read('AGENTS.md').match(/context\/INDEX\.md/g)).toHaveLength(1)
    expect(pass().exit).toBe(0)
  })

  it('index regenerates the table from the map; the check catches a drift', () => {
    put('context/map.json', { capabilities: { pay: { paths: ['src/pay/**'] } }, excluded: [] })
    expect(rules()).toContain('index-table')
    contextIndex(root)
    expect(read('context/INDEX.md')).toMatch(/\| `pay` \| none yet - see the map \|/)
    expect(rules()).not.toContain('index-table')
  })

  it('P0 probes: an unlabelled evidence cell, a citation that does not resolve', () => {
    const shipped = read('context/shipped.md')
    put('context/shipped.md', shipped + '| `pay` | `src/pay.ts` | `unknown` - none | available on production | - |\n')
    expect(pass().failures).toContainEqual(expect.objectContaining({ rule: 'shipped-level', what: 'the Available cell has no evidence level' }))
    put('context/shipped.md', shipped + '| `pay` | x | `unknown` - none | production - `confirmed` - `MISSING.md:999999` | - |\n')
    expect(rules()).toContain('dead-citation')
    put('context/shipped.md', shipped + '| `pay` | x | `unknown` - none | production - `confirmed` | - |\n')
    expect(rules()).toContain('shipped-citation')
  })

  it('contracts: no status line, no availability, no supersession; a contract state', () => {
    put('context/product/pay.md', '---\nstate: current\ncapability: pay\n---\n\nStatus: built\n\nIt went live on 3 May.\n\nSection 20 wins where it differs.\n')
    expect(rules()).toEqual(expect.arrayContaining(['status-line', 'availability', 'supersession']))
    put('context/product/pay.md', '---\nstate: done\n---\n')
    expect(rules()).toContain('state')
  })

  it('feedback: a state from the list, and shipped only on a confirmed availability', () => {
    put('context/feedback/f.md', '| Item | What | State | Resolved by |\n|---|---|---|---|\n| F1 | x | shipped | `reported` - `CHANGELOG.md:1` |\n| F2 | y | done | - |\n')
    const f = pass().failures
    expect(f).toContainEqual(expect.objectContaining({ rule: 'feedback-closed' }))
    expect(f).toContainEqual(expect.objectContaining({ rule: 'state', what: expect.stringMatching(/"done" is not a feedback state/) }))
  })

  it('audiences: restricted never tracked; nothing team reaches a published board', () => {
    put('context/private/notes.md', '---\naudience: restricted\n---\n')
    git('add', '-A')
    expect(rules()).toContain('audience')
    git('rm', '-q', '--cached', 'context/private/notes.md')
    expect(rules()).not.toContain('audience')
    boardsNew(root, 'home', { type: 'start' })
    put('design/publish.json', { boards: { home: 'read' } })
    expect(pass().failures.filter((f) => f.rule === 'audience').map((f) => f.where).sort()).toEqual(['context/INDEX.md', 'context/shipped.md'])
  })

  it('Done is never set by hand on a board', () => {
    put('design/boards/pay.json', { version: 1, status: 'done', nodes: [] })
    expect(rules()).toContain('board-status')
  })

  it('the index budget', () => {
    put('context/INDEX.md', read('context/INDEX.md') + 'word '.repeat(900))
    expect(rules()).toContain('index-budget')
  })

  it('a pull request touching a shared file needs every contract it feeds, or a stated reason', () => {
    put('src/shared.ts', 'export const a = 1\n')
    put('context/product/pay.md', '---\nstate: current\ncapability: pay\n---\n')
    put('context/product/ship.md', '---\nstate: current\ncapability: ship\n---\n')
    put('context/map.json', { capabilities: {
      pay: { contract: 'context/product/pay.md', paths: ['src/shared.ts'] },
      ship: { contract: 'context/product/ship.md', paths: ['src/{shared,ship}.ts'] },
    }, excluded: [] })
    contextIndex(root)
    const base = commitAll('base')
    put('src/shared.ts', 'export const a = 2\n')
    commitAll('change')
    let r = contextCheck(root, { base })
    expect(r.failures.filter((f) => f.rule === 'pr').map((f) => f.where).sort()).toEqual(['pay', 'ship'])
    r = contextCheck(root, { base, body: 'no-contract-change: pay - a constant\nno-contract-change: ship - a constant' })
    expect(r.failures.filter((f) => f.rule === 'pr')).toEqual([])
    put('context/product/pay.md', '---\nstate: current\ncapability: pay\n---\n\nNow 2.\n')
    commitAll('contract')
    r = contextCheck(root, { base, body: 'no-contract-change: ship - a constant' })
    expect(r.exit).toBe(0)
    expect(contextCheck(root, { base: 'no-such-ref' }).exit).toBe(2)
  })

  it('a playbook is current, stale or unknown since its last success', () => {
    put('deploy.yml', 'a\n')
    const rev = commitAll('base')
    put('context/playbooks/release/PLAYBOOK.md', `---\nname: release\nlast_success: { revision: ${rev} }\ndepends_on:\n  - deploy.yml\n---\n`)
    expect(pass().notes.find((n) => n.what.includes('release'))?.what).toMatch(/current since/)
    put('deploy.yml', 'b\n')
    expect(pass().notes.find((n) => n.what.includes('release'))?.what).toMatch(/stale - 1 dependencies changed/)
    expect(pass().notes.find((n) => n.what.includes('publish-canvas'))?.what).toMatch(/unknown - no last_success/)
  })

  it('the map: every source file mapped or excluded, as a note', () => {
    put('src/a.ts', '1'); put('src/b.ts', '2')
    put('context/map.json', { source: ['src/**'], capabilities: { a: { paths: ['src/a.ts'] } }, excluded: [] })
    contextIndex(root)
    git('add', '-A')
    expect(pass().notes.find((n) => n.rule === 'map')?.what).toMatch(/1 source files neither mapped nor excluded, e.g. src\/b.ts/)
  })
})

// ---------------------------------------------------------------------------------------------
describe('the review of 0.22: evidence, writes, the check', () => {
  it('availability is a clause that claims it - not staging, not a negation', () => {
    expect(availableLevels('staging only - `confirmed` by run 1234567')).toEqual([])
    expect(availableLevels('nowhere - `confirmed` rolled back')).toEqual([])
    expect(availableLevels('rolled back - `confirmed`; production - `reported`, `CHANGELOG.md:1`')).toEqual(['reported'])
    expect(availableLevels('production - `confirmed` by run 1234567; staging - `confirmed`')).toEqual(['confirmed'])
    expect(availableLevels('in the pipeline deploys - `confirmed` by runs 1234567, 2345678')).toEqual(['confirmed'])
  })

  it('knowledge work reads Done from a delivered record', () => {
    expect(shippedRows('| Project | Delivered | Evidence |\n|---|---|---|\n| `memo` | to the board - `confirmed` - `x.md` | `confirmed` |\n').map((r) => [r.capability, r.levels])).toEqual([['memo', ['confirmed']]])
  })

  it('malformed evidence is Unknown, never a stale Done', () => {
    put('context/shipped.md', '# A record with no capability table\n')
    expect(readContextFacts(root).unreadable.get('*')).toMatch(/no Capability table/)
    put('context/shipped.md', '| Capability | Available |\n|---|---|\n| `a` | production - `confirmed` - `x.md` |\n')
    put('context/product/a.md', '---\ncapability: a\n---\n')
    put('context/plans/b.md', '---\nstate: proposed\n')
    const f = readContextFacts(root)
    expect(f.unreadable.get('a')).toMatch(/state "" is not current/)
    expect(f.unreadable.get('*')).toMatch(/plans\/b\.md: .*never closes/)   // a plan that cannot be read may name anything
  })

  it('CRLF files read the same', () => {
    expect(frontMatter('---\r\nstate: current\r\n---\r\nbody\r\n').data).toEqual({ state: 'current' })
    expect(tables('| A | B |\r\n|---|---|\r\n| 1 | 2 |\r\n')[0].rows[0].cells).toEqual(['1', '2'])
  })

  it('a tree write from a shell that predates types keeps the folder type, and fields it does not manage', async () => {
    put('design/boards/_folders.json', { version: 1, folders: [{ name: 'features', order: 0, type: 'feature', color: 'teal' }] })
    put('design/boards/pay.json', { version: 1, nodes: [] })
    const b = await drive('GET', 'boards'), f = await drive('GET', 'folders')
    const r = await drive('POST', 'boards/reorder', { protocol: 2, tree: [{ folder: 'features', items: ['pay'] }], base: { boards: { pay: b.json[0].sha256 }, folders: f.json.sha256 } })
    expect(r.status).toBe(200)
    expect(JSON.parse(read('design/boards/_folders.json')).folders).toEqual([{ color: 'teal', name: 'features', order: 0, type: 'feature' }])
  })

  it('folders add keeps every field of the entries it appends after', () => {
    put('design/boards/_folders.json', { version: 1, folders: [{ name: 'mine', order: 0, color: 'teal', note: 'x' }] })
    foldersAdd(root, ['decks'])
    expect(JSON.parse(read('design/boards/_folders.json')).folders).toEqual([{ name: 'mine', order: 0, color: 'teal', note: 'x' }, { name: 'decks', order: 1, type: 'deck' }])
  })
})

describe('the review of 0.22: the check', () => {
  const pass = () => contextCheck(root)
  const rules = (r = pass()) => r.failures.map((f) => f.rule)
  beforeEach(() => { git('init', '-q'); contextInit(root) })

  it('the audience check follows layouts and data files a build would carry, not whole scenes', () => {
    put('design/scenes/app/home.tsx', 'export default () => null\n')
    put('design/scenes/app/draft.tsx', "import x from '../../../context/private/x.md?raw'\nexport default () => x\n")
    put('context/private/x.md', '---\naudience: restricted\n---\n')
    put('design/boards/b.json', { version: 1, nodes: [{ frame: 'app/home' }] })
    put('design/publish.json', { boards: { b: 'read' } })
    expect(rules()).not.toContain('audience')                       // an unpublished sibling frame is not shipped
    put('design/scenes/_layout.tsx', "import data from '../../context/data.json'\nexport default ({ children }) => children\n")
    put('context/data.json', '{}')
    expect(pass().failures).toContainEqual(expect.objectContaining({ rule: 'audience', where: 'context/data.json' }))
  })

  it('a shipped record the canvas cannot read fails; so does a table without outer pipes', () => {
    put('context/shipped.md', '# nothing\n\nCapability | Available\n---|---\n`a` | `unknown` - none\n')
    expect(rules()).toEqual(expect.arrayContaining(['shipped-shape', 'table-format']))
  })

  it('a cited file must exist, with or without a line', () => {
    put('context/shipped.md', read('context/shipped.md') + '| `a` | x | `unknown` - none | production - `confirmed` - `does-not-exist.md` | - |\n')
    expect(pass().failures).toContainEqual(expect.objectContaining({ rule: 'dead-citation', what: 'does-not-exist.md does not exist' }))
  })

  it('feedback closes on its resolution, not on a word in the quote', () => {
    put('context/feedback/f.md', '| Item | What was raised | State | Resolved by |\n|---|---|---|---|\n| F1 | "it is `confirmed` broken" | shipped | nothing |\n')
    expect(rules()).toContain('feedback-closed')
    put('context/feedback/f.md', '| Item | What was raised | State | Resolved by |\n|---|---|---|---|\n| F1 | x | shipped | production - `confirmed` by run 1234567 |\n')
    expect(rules()).not.toContain('feedback-closed')
  })

  it('the map: an invalid glob is a failure, not a crash; tests may be globs', () => {
    put('context/map.json', { capabilities: { a: { paths: ['src/{a'] } }, excluded: [] })
    expect(pass().failures).toContainEqual(expect.objectContaining({ rule: 'map', what: expect.stringMatching(/invalid glob/) }))
    put('test/a.test.ts', '1')
    git('add', '-A')
    put('context/map.json', { capabilities: { a: { paths: ['src/**'], tests: ['test/*.test.ts'] } }, excluded: [] })
    contextIndex(root)
    expect(rules()).not.toContain('map')
  })

  it('a pull request whose event cannot be read is cannot-determine, never a pass', () => {
    expect(contextCheck(root, { prError: 'the event could not be read' }).exit).toBe(2)
  })

  it('a playbook with a dependency outside git is never current', () => {
    put('deploy.yml', 'a\n')
    commitAll('base')
    const rev = git('rev-parse', 'HEAD').trim()
    put('context/playbooks/release/PLAYBOOK.md', `---\nname: release\nlast_success: { revision: ${rev} }\ndepends_on:\n  - deploy.yml\n  - "service: the app on Railway"\n---\n`)
    expect(pass().notes.find((n) => n.what.includes('release'))?.what).toMatch(/unknown - its files are unchanged since .*, 1 dependency outside git/)
  })

  it('a CRLF contract is read: its availability claim fails', () => {
    put('context/product/pay.md', '---\r\nstate: current\r\n---\r\n\r\nIt went live on 3 May.\r\n')
    expect(rules()).toContain('availability')
  })

  it('init --kind knowledge keeps a delivered record; without a canvas the conventions go to context/README.md', () => {
    rmSync(join(root, 'context'), { recursive: true })
    contextInit(root, 'knowledge')
    expect(read('context/shipped.md')).toMatch(/\| Project \| Delivered \| Evidence \| Contract \|/)
    expect(read('context/INDEX.md')).toMatch(/Was it delivered, to whom, and when\?/)
    expect(read('context/README.md')).toMatch(/^<!-- marver:managed [0-9a-f]{64} [\s\S]*# Context - what the product is/)
    expect(pass().exit).toBe(0)
  })

  it('init never truncates a file written meanwhile', () => {
    rmSync(join(root, 'context'), { recursive: true })
    put('context/INDEX.md', 'mine\n')
    contextInit(root)
    expect(read('context/INDEX.md')).toBe('mine\n')
  })
})

// ---------------------------------------------------------------------------------------------
describe('the review of 0.22, second pass', () => {
  it('a negation anywhere voids a clause; delivered work has no environments', () => {
    expect(availableLevels('production - rolled back, `confirmed` run 1234567')).toEqual([])
    expect(availableLevels('production - not available since May - `confirmed`')).toEqual([])
    expect(availableLevels('to the client: test strategy - `confirmed` - `x.md`', 'delivered')).toEqual(['confirmed'])
    expect(availableLevels('the test suite on production - `confirmed` by run 1234567')).toEqual(['confirmed'])
  })

  it('a plan may name its capabilities as a list', () => {
    put('context/plans/p.md', '---\nstate: proposed\ncapability: [pay, ship]\n---\n')
    expect([...readContextFacts(root).plans.keys()].sort()).toEqual(['pay', 'ship'])
  })

  it('a phase from a restricted brief keeps the status off a published canvas, and is named as evidence', () => {
    put('design/scenes/work/_brief.md', '---\nphase: hifi\naudience: restricted\n---\n')
    put('design/scenes/work/a.tsx', 'export default () => null\n')
    put('context/plans/p.md', '---\nstate: proposed\ncapability: x\naudience: publishable\n---\n')
    const a = annotateBoards(root, [{ name: 'x', json: { type: 'feature', layout: { rows: [['work']] } } }], [], () => null)
    expect(a.get('x')?.status).toMatchObject({ status: 'in-progress', fill: 3, audience: 'restricted' })
    expect(a.get('x')?.status?.evidence).toContain('design/scenes/work/_brief.md: phase hi-fi')
    expect(publishableStatus(a.get('x')?.status)).toBeNull()
  })

  it('a brief that names no audience is as public as its board - its phase publishes; one that says team does not', () => {
    put('design/scenes/work/_brief.md', '---\nphase: lofi\n---\n')
    put('design/scenes/work/a.tsx', 'export default () => null\n')
    put('context/plans/p.md', '---\nstate: proposed\ncapability: x\naudience: publishable\n---\n')
    const read = () => annotateBoards(root, [{ name: 'x', json: { type: 'feature', layout: { rows: [['work']] } } }], [], () => null).get('x')?.status
    expect(read()).toMatchObject({ status: 'in-progress', fill: 2, audience: 'publishable' })
    expect(publishableStatus(read())).toEqual({ status: 'in-progress', fill: 2 })
    put('design/scenes/work/_brief.md', '---\nphase: lofi\naudience: team\n---\n')
    expect(publishableStatus(read())).toBeNull()
  })

  it('a permission change on the record is never served from the cache as Done', () => {
    put('context/shipped.md', '| Capability | Available |\n|---|---|\n| `x` | production - `confirmed` - `a.md` |\n')
    expect(readContextFacts(root).shipped.get('x')?.levels).toEqual(['confirmed'])
    execFileSync('chmod', ['000', join(root, 'context/shipped.md')])
    try {
      expect(readContextFacts(root).unreadable.get('*')).toMatch(/context\/shipped\.md/)
    } finally { execFileSync('chmod', ['644', join(root, 'context/shipped.md')]) }
  })

  it('an empty glob is invalid', () => {
    expect(parseMap(JSON.stringify({ capabilities: { a: { paths: [''] } } }))).toMatch(/invalid glob ""/)
    expect(parseMap(JSON.stringify({ capabilities: {}, source: [''] }))).toMatch(/invalid glob ""/)
  })

  it('a held registry lock is a 409 for the dev server; a stale one is taken over', async () => {
    put('design/boards/_folders.json', { version: 1, folders: [{ name: 'f', order: 0 }] })
    put('design/boards/pay.json', { version: 1, nodes: [] })
    const b = await drive('GET', 'boards'), f = await drive('GET', 'folders')
    put('design/boards/.folders.lock', '999 0\n')
    const r = await drive('POST', 'boards/reorder', { protocol: 2, tree: [{ folder: 'f', items: ['pay'] }], base: { boards: { pay: b.json[0].sha256 }, folders: f.json.sha256 } })
    expect(r.status).toBe(409)
    const old = new Date(Date.now() - 60_000)
    utimesSync(join(root, 'design/boards/.folders.lock'), old, old)
    expect(foldersAdd(root, ['decks']).added).toEqual(['decks'])
    expect(existsSync(join(root, 'design/boards/.folders.lock'))).toBe(false)
  })
})

describe('the review of 0.22, second pass: the check', () => {
  const pass = () => contextCheck(root)
  const rules = (r = pass()) => r.failures.map((f) => f.rule)
  beforeEach(() => { git('init', '-q'); contextInit(root) })

  it('a CRLF index still equals its map', () => {
    put('context/INDEX.md', read('context/INDEX.md').replace(/\n/g, '\r\n'))
    expect(rules()).not.toContain('index-table')
  })

  it('citations: a bare name nothing carries fails; a range backwards fails; an ambiguous bare name is shorthand', () => {
    put('src/one.ts', 'a\nb\nc\n'); put('a/home.tsx', 'x\n'); put('b/home.tsx', 'y\n')
    git('add', '-A')
    put('context/product/p.md', '---\nstate: current\n---\n\n`missing.md:1` `src/one.ts:3-1` `one.ts:2` `one.ts:9` `home.tsx:40`\n')
    const f = pass().failures.filter((x) => x.rule === 'dead-citation').map((x) => x.what)
    expect(f).toEqual(['missing.md does not exist', 'src/one.ts:3-1 runs backwards', 'one.ts:9 is past the end of src/one.ts (4 lines)'])
  })

  it('a feedback resolution must claim availability, and its citations must resolve', () => {
    put('context/feedback/f.md', '| Item | What | State | Resolved by |\n|---|---|---|---|\n| F1 | x | shipped | nowhere - `confirmed` by run 1234567 |\n')
    expect(rules()).toContain('feedback-closed')
    put('context/feedback/f.md', '| Item | What | State | Resolved by |\n|---|---|---|---|\n| F1 | x | shipped | production - `confirmed` - `missing.md` |\n')
    expect(pass().failures).toContainEqual(expect.objectContaining({ rule: 'dead-citation', what: 'missing.md does not exist' }))
  })

  it('the graph follows root-relative imports, and the brief and notes a published frame carries', () => {
    put('design/scenes/app/home.tsx', "import x from '/context/secret.md?raw'\nexport default () => x\n")
    put('context/secret.md', '# secret\n')
    put('design/boards/b.json', { version: 1, nodes: [{ frame: 'app/home' }] })
    put('design/publish.json', { boards: { b: 'read' } })
    expect(pass().failures).toContainEqual(expect.objectContaining({ rule: 'audience', where: 'context/secret.md' }))
    put('design/scenes/app/home.tsx', 'export default () => null\n')
    put('design/scenes/app/_brief.md', '---\naudience: team\n---\nThe app, for the client only.\n')
    put('design/scenes/app/home.note.md', '---\naudience: restricted\n---\nA private aside.\n')
    expect(pass().failures.filter((f) => f.rule === 'audience').map((f) => f.where).sort()).toEqual(['design/scenes/app/_brief.md', 'design/scenes/app/home.note.md'])
  })
})

// ---------------------------------------------------------------------------------------------
describe('the review of 0.22, third pass', () => {
  it('pre-production places and pending words grant nothing toward a product\'s Done', () => {
    for (const c of ['local only - `confirmed` run 1234567', 'dev only - `confirmed` run 1234567', 'testing only - `confirmed` run 1234567', 'production - not yet live - `confirmed` run 1234567', 'production - planned for May - `confirmed` run 1234567'])
      expect(availableLevels(c)).toEqual([])
    expect(availableLevels('dev only - `confirmed`', 'delivered')).toEqual(['confirmed'])
  })

  it('the first folder creates the boards directory and its lock', async () => {
    const r = await drive('POST', 'boards/reorder', { protocol: 2, tree: [{ folder: 'new', items: [] }], base: { boards: {}, folders: null } })
    expect(r.status).toBe(200)
    expect(JSON.parse(read('design/boards/_folders.json')).folders).toEqual([{ name: 'new', order: 0 }])
  })
})

describe('the review of 0.22, third pass: the check', () => {
  const pass = () => contextCheck(root)
  const rules = (r = pass()) => r.failures.map((f) => f.rule)
  beforeEach(() => { git('init', '-q'); contextInit(root) })

  it('a backwards range fails even on an ambiguous bare name', () => {
    put('a/home.tsx', 'x\n'); put('b/home.tsx', 'y\n')
    git('add', '-A')
    put('context/product/p.md', '---\nstate: current\n---\n\n`home.tsx:40-1`\n')
    expect(pass().failures.map((f) => f.what)).toContain('home.tsx:40-1 runs backwards')
  })

  it('feedback closes on availability, never on implementation', () => {
    put('context/feedback/f.md', '| Item | What | State | Resolved by |\n|---|---|---|---|\n| F1 | x | shipped | implementation `confirmed` by run 1234567; availability `unknown` |\n')
    expect(rules()).toContain('feedback-closed')
  })

  it('a contract may not claim delivery either', () => {
    put('context/product/memo.md', '---\nstate: current\n---\n\nThe memo was delivered to the client on 1 October.\n')
    expect(rules()).toContain('availability')
  })

  it('the graph follows a list of extended configs, and a nested frame\'s scene brief and note', () => {
    put('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@ctx/*': ['./context/*'] } } }))
    put('design/tsconfig.json', JSON.stringify({ extends: ['../tsconfig.json'] }))
    put('design/scenes/app/nested/home.tsx', "import x from '@ctx/secret.md?raw'\nexport default () => x\n")
    put('context/secret.md', '# secret\n')
    put('design/scenes/app/_brief.md', '---\naudience: restricted\n---\nPrivate.\n')
    put('design/boards/b.json', { version: 1, nodes: [{ frame: 'app/nested/home' }] })
    put('design/publish.json', { boards: { b: 'read' } })
    const where = pass().failures.filter((f) => f.rule === 'audience').map((f) => f.where).sort()
    expect(where).toEqual(['context/secret.md', 'design/scenes/app/_brief.md'])
  })
})

// ---------------------------------------------------------------------------------------------
describe('the review of 0.22, final pass', () => {
  it('a byte-order mark never hides front matter', () => {
    expect(frontMatter('﻿---\naudience: restricted\n---\nx\n').data).toEqual({ audience: 'restricted' })
  })
})

describe('the review of 0.22, final pass: the check', () => {
  const pass = () => contextCheck(root)
  beforeEach(() => { git('init', '-q'); contextInit(root) })

  it('a $schema URL in tsconfig does not hide its aliases', () => {
    put('tsconfig.json', '{\n  "$schema": "https://json.schemastore.org/tsconfig", // the schema\n  "compilerOptions": { "paths": { "@ctx/*": ["./context/*"] } },\n}\n')
    put('design/tsconfig.json', JSON.stringify({ $schema: 'https://json.schemastore.org/tsconfig', extends: ['../tsconfig.json'] }))
    put('design/scenes/app/home.tsx', "import x from '@ctx/secret.md?raw'\nexport default () => x\n")
    put('context/secret.md', '# secret\n')
    put('design/boards/b.json', { version: 1, nodes: [{ frame: 'app/home' }] })
    put('design/publish.json', { boards: { b: 'read' } })
    expect(pass().failures).toContainEqual(expect.objectContaining({ rule: 'audience', where: 'context/secret.md' }))
  })

  it('a published component frame carries the components scene\'s brief and note - checked where they live', () => {
    put('design/components/card/button.tsx', 'export default () => null\n')
    put('design/scenes/components/_note.md', '---\naudience: restricted\n---\nPrivate.\n')
    put('design/boards/b.json', { version: 1, nodes: [{ frame: 'components/card/button' }] })
    put('design/publish.json', { boards: { b: 'read' } })
    expect(pass().failures).toContainEqual(expect.objectContaining({ rule: 'audience', where: 'design/scenes/components/_note.md' }))
  })

  it('feedback: "implemented and available in production - confirmed" closes it', () => {
    put('context/feedback/f.md', '| Item | What | State | Resolved by |\n|---|---|---|---|\n| F1 | x | shipped | implemented and available in production - `confirmed` by run 1234567 |\n')
    expect(pass().failures.map((f) => f.rule)).not.toContain('feedback-closed')
  })
})
