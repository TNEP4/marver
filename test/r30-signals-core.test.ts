import { describe, expect, it, vi } from 'vitest'
import { addRow, createRate, foldRows, keepLongest, nodesIn, normRoute, p50, pickLoafs, topWarnings, urlPath, type LoafEntry } from '../src/client/shell/recorder-signals-core.ts'
import { createBudget, createCounter, formatConsole, resourceOf, resourceUrl, stackOfArgs, viteEcho } from '../src/client/frame-host/signals.js'
import { cleanPageRecord } from '../src/server/perf.ts'
import type { RenderRow } from '../src/shared/perf-records.ts'

/**
 * Spec 30's signals, the parts with no browser (R5, R6): a request's route without its names (#31), a gesture's three
 * longest frames and what they ran (#35), a minute's rows (#36, #28), the budgets (#33), a console call's message as
 * produced and an element's URL without its query (#28, #32), and the server's allowlist for each new kind (#4).
 */

describe('#31: a route says what was asked, never its names or its query', () => {
  it('names and ids replaced', () => {
    expect(normRoute('/__mv/api/boards/my-secret-board')).toBe('boards/:board')
    expect(normRoute('/__mv/api/comments/my-secret-board')).toBe('comments/:board')
    expect(normRoute('http://localhost:5173/__mv/api/boards/x?y=1')).toBe('boards/:board')
  })
  it('a fixed word stays, under boards too', () => {
    for (const r of ['boards', 'boards/status', 'boards/pin', 'boards/rename', 'boards/reorder', 'jam/queue', 'jam/picture/live', 'sizes', 'work']) expect(normRoute(`/__mv/api/${r}`)).toBe(r)
  })
  it('never a query or a hash', () => {
    expect(normRoute('/__mv/api/jam/capture?id=SENTINEL')).toBe('jam/capture')
    expect(normRoute('/__mv/api/invite-info?token=SENTINEL')).toBe('invite-info')
    expect(normRoute('/__mv/api/shot?frame=SENTINEL#x')).toBe('shot')
  })
  it('an unknown route keeps its first word alone', () => {
    expect(normRoute('/__mv/api/nope/SENTINEL/more')).toBe('nope/:id/:id')
    expect(normRoute('/__mv/api/SENTINEL.json')).toBe(':id')
  })
  it('outside the API: the manifest by name, anything else by its first word', () => {
    expect(normRoute('/design/manifest.json')).toBe('design/manifest.json')
    expect(normRoute('/design/SENTINEL/x.json')).toBe('design/:path')
    expect(normRoute('/')).toBe('/')
  })
})

describe('#35: the three longest frames, attributed', () => {
  const script = (over: Record<string, unknown> = {}) => ({ duration: 40, sourceURL: 'http://x/design/scenes/kit/a.tsx?t=123&secret=1', sourceFunctionName: 'tick', invoker: 'TimerHandler:setTimeout', windowAttribution: 'descendant', ...over })
  const none = () => undefined

  it('takes the three longest, longest first', () => {
    const out = pickLoafs([60, 200, 90, 400, 70].map((duration) => ({ duration })), none)
    expect(out.map((l) => l.ms)).toEqual([400, 200, 90])
  })
  it('names the longest script of each: its path with no query, its function, its invoker, where it ran', () => {
    const [l] = pickLoafs([{ duration: 120, blockingDuration: 70, scripts: [script({ duration: 10, sourceFunctionName: 'short' }), script({ duration: 95 })] }], none)
    expect(l).toEqual({ ms: 120, blockMs: 70, script: { ms: 95, src: '/design/scenes/kit/a.tsx', fn: 'tick', invoker: 'TimerHandler:setTimeout', where: 'descendant' } })
  })
  it('a frame\'s module path names the frame; its window does when the path does not', () => {
    const win = {}
    const frameOf = (src: string, w: unknown) => (src === '/design/scenes/kit/a.tsx' ? 'kit/a' : w === win ? 'kit/b' : undefined)
    expect(pickLoafs([{ duration: 120, scripts: [script()] }], frameOf)[0].script!.frame).toBe('kit/a')
    expect(pickLoafs([{ duration: 120, scripts: [script({ sourceURL: 'http://x/node_modules/shared.js', window: win })] }], frameOf)[0].script!.frame).toBe('kit/b')
    expect(pickLoafs([{ duration: 120, scripts: [script({ sourceURL: 'http://x/other.js' })] }], frameOf)[0].script).not.toHaveProperty('frame')
  })
  it('bounds a function and an invoker to 64 characters, and takes a query off an invoker', () => {
    const long = 'x'.repeat(100)
    const [l] = pickLoafs([{ duration: 120, scripts: [script({ sourceFunctionName: long, invoker: `http://x/a.js?token=SENTINEL` })] }], none)
    expect(l.script!.fn).toHaveLength(64)
    expect(l.script!.invoker).toBe('http://x/a.js')
  })
  it('a long task (Safari, Firefox) is `ms` alone', () => {
    expect(pickLoafs([{ duration: 75.4 }], none)).toEqual([{ ms: 75 }])
  })
  it('keeps the longest as they arrive, however many come', () => {
    const top: LoafEntry[] = []
    for (const duration of [51, 70, 52, 300, 53, 200, 54]) keepLongest(top, { duration })
    expect(top.map((e) => e.duration)).toEqual([300, 200, 70])
  })
  it('urlPath: a path with no host or query; nothing from nothing', () => {
    expect(urlPath('http://x/a/b.js?q=1#h')).toBe('/a/b.js')
    expect(urlPath(undefined)).toBe('')
  })
})

describe('#36, #28: a minute\'s rows', () => {
  const row = (who: string, ms: number): RenderRow => ({ who, commits: 2, ms, maxMs: ms / 2, inGesture: 1 })
  it('the rows add up per who', () => {
    const rows = new Map<string, RenderRow>()
    addRow(rows, 'k1', 'kit/a', { commits: 1, ms: 5, maxMs: 5, inGesture: 0 })
    addRow(rows, 'k1', 'kit/a', { commits: 3, ms: 9, maxMs: 7, inGesture: 2 })
    expect(rows.get('k1')).toEqual({ who: 'k1', frame: 'kit/a', commits: 4, ms: 14, maxMs: 7, inGesture: 2 })
  })
  it('keeps every row up to the limit, heaviest first', () => {
    const out = foldRows([row('a', 1), row('b', 3), row('c', 2)])
    expect(out.map((r) => r.who)).toEqual(['b', 'c', 'a'])
  })
  it('past 64, the rest fold into one `others` row that says how many', () => {
    const out = foldRows(Array.from({ length: 70 }, (_, i) => row(`n${i}`, 70 - i)))
    expect(out).toHaveLength(65)
    expect(out[63].who).toBe('n63')
    expect(out[64]).toMatchObject({ who: 'others', rows: 6, commits: 12, inGesture: 6 })
    expect(out[64].ms).toBeCloseTo(6 + 5 + 4 + 3 + 2 + 1, 5)
    expect(out[64].maxMs).toBe(3)
  })
  it('warnings: the total, and the eight nodes with most', () => {
    const by = new Map(Array.from({ length: 10 }, (_, i) => [`n${i}`, i + 1] as const))
    const w = topWarnings(by)
    expect(w.n).toBe(55)
    expect(w.top).toHaveLength(8)
    expect(w.top[0]).toEqual({ node: 'n9', n: 10 })
    expect(w.top[7]).toEqual({ node: 'n2', n: 3 })
  })
})

describe('the rules: rates, medians, what a view shows', () => {
  it('a rate gives so many in a second, and more in the next', () => {
    let t = 1000
    const take = createRate(5, () => t)
    expect(Array.from({ length: 8 }, () => take()).filter(Boolean)).toHaveLength(5)
    t = 2000
    expect(take()).toBe(true)
  })
  it('the median is the nearest rank', () => {
    expect(p50([])).toBeUndefined()
    expect(p50([9])).toBe(9)
    expect(p50([3, 1, 2, 4])).toBe(2)
  })
  it('a node is in view by any part of its box, its title bar included', () => {
    const n = (key: string, x: number, y: number) => ({ key, x, y, w: 100, h: 100 })
    const v = { x: 0, y: 0, w: 200, h: 200 }
    expect(nodesIn([n('in', 10, 10), n('right', 300, 0), n('below', 0, 300), n('title', 0, -120)], v).map((x) => x.key)).toEqual(['in', 'title'])
  })
})

describe('#33: limited at the source', () => {
  it('5 a second, shared by every source; what it refuses is told with its source', () => {
    let t = 0
    const refused: string[] = []
    const b = createBudget({ perSecond: 5, perDoc: 50 }, (s: string) => refused.push(s), () => t)
    expect(['frame', 'console', 'console', 'resource', 'console'].every((s) => b.take(s))).toBe(true)
    expect(b.take('console')).toBe(false)
    expect(b.take('resource')).toBe(false)
    expect(refused).toEqual(['console', 'resource'])
    t = 1000
    expect(b.take('console')).toBe(true)
  })
  it('50 per document, whatever the second', () => {
    let t = 0
    const refused: string[] = []
    const b = createBudget({ perSecond: 5, perDoc: 50 }, (s: string) => refused.push(s), () => t)
    let passed = 0
    for (let s = 0; s < 20; s++) { t = s * 1000; for (let i = 0; i < 5; i++) if (b.take('console')) passed++ }
    expect(passed).toBe(50)
    expect(refused).toHaveLength(50)
  })
  it('a forced take always passes, and counts against the budget', () => {
    const b = createBudget({ perSecond: 1, perDoc: 50 }, () => {}, () => 0)
    expect(b.take('frame', true)).toBe(true)
    expect(b.take('console')).toBe(false)
    expect(b.take('frame', true)).toBe(true)
  })
  it('counts coalesce: the first at once, then at most one a second, a final one when asked and only with something to say', () => {
    vi.useFakeTimers()
    try {
      let t = 5000
      const sent: [Record<string, number>, boolean][] = []
      const c = createCounter(1000, (counts, final) => sent.push([counts, final]), () => t)
      c.final()
      expect(sent).toEqual([])
      c.add('console')
      vi.advanceTimersByTime(0)
      expect(sent).toEqual([[{ console: 1 }, false]])
      c.add('console', 3); c.add('frame')
      vi.advanceTimersByTime(999)
      expect(sent).toHaveLength(1)
      t += 1000
      vi.advanceTimersByTime(1)
      expect(sent[1]).toEqual([{ console: 3, frame: 1 }, false])
      c.add('resource')
      c.final()
      expect(sent[2]).toEqual([{ resource: 1 }, true])
      vi.advanceTimersByTime(5000)
      expect(sent).toHaveLength(3)
    } finally { vi.useRealTimers() }
  })
})

describe('#28, #32: what a console call and an element say', () => {
  it('the message as the code produced it', () => {
    expect(formatConsole(['plain'])).toBe('plain')
    expect(formatConsole(['a', 'b', 3])).toBe('a b 3')
    expect(formatConsole(['%s failed: %d of %i', 'it', 2.9, 3.1])).toBe('it failed: 2 of 3')
    expect(formatConsole(['%cstyled', 'color: red', 'after'])).toBe('styled after')
    expect(formatConsole(['100%% %s', 'done'])).toBe('100% done')
    expect(formatConsole(['%s %s', 'one'])).toBe('one %s')
    expect(formatConsole([new TypeError('bad')])).toBe('TypeError: bad')
    expect(formatConsole([new Error('bad')])).toBe('bad')
    expect(formatConsole([null, undefined, 1])).toBe('null undefined 1')
  })
  it('an object by its kind, never a deep read of it', () => {
    let read = 0
    const o = { get secret() { read++; return 'SENTINEL' }, toString() { read++; return 'SENTINEL' } }
    expect(formatConsole(['state', o])).toBe('state [Object]')
    expect(formatConsole([[1, 2, 3]])).toBe('[Array(3)]')
    expect(formatConsole([function named() {}])).toBe('[function named]')
    expect(read).toBe(0)
  })
  it('200 characters, and an argument that throws does not', () => {
    expect(formatConsole(['x'.repeat(500)])).toHaveLength(200)
    expect(formatConsole(['y'.repeat(300), 'z'.repeat(300)])).toHaveLength(200)
    const bad = { get name() { throw new Error('no') } }
    Object.setPrototypeOf(bad, Error.prototype)
    expect(formatConsole(['a', bad])).toBe('a ?')
  })
  it('a stack from the error among the arguments: three lines', () => {
    const e = new Error('x')
    e.stack = 'Error: x\n    at a (b:1:2)\n    at c (d:3:4)\n    at e (f:5:6)\n    at g (h:7:8)'
    expect(stackOfArgs(['msg', e])).toEqual(['at a (b:1:2)', 'at c (d:3:4)', 'at e (f:5:6)'])
    expect(stackOfArgs(['msg'])).toBeUndefined()
  })
  it('knows Vite\'s own echo of a server error', () => {
    expect(viteEcho(['[vite] Internal Server Error\nboom\nstack'])).toBe(true)
    expect(viteEcho(['[vite] something else'])).toBe(false)
    expect(viteEcho([new Error('x')])).toBe(false)
  })
  it('a same-origin URL is its path; another origin its origin; another scheme its scheme', () => {
    const base = 'http://localhost:5173/__mv/frame/?id=x'
    expect(resourceUrl('/design/assets/a.png?secret=SENTINEL#h', base)).toBe('/design/assets/a.png')
    expect(resourceUrl('../assets/a.png', base)).toBe('/__mv/assets/a.png')
    expect(resourceUrl('https://cdn.example.com/private/a.png?token=SENTINEL', base)).toBe('https://cdn.example.com')
    expect(resourceUrl('data:image/png;base64,SENTINEL', base)).toBe('data:')
    expect(resourceUrl('blob:http://localhost:5173/uuid', base)).toBe('blob:')
  })
  it('an element: the listed tags only, by the URL it asked for', () => {
    const base = 'http://x/'
    const el = (tagName: string, o: Record<string, string>) => ({ tagName, getAttribute: () => null, ...o })
    expect(resourceOf(el('IMG', { src: 'http://x/a.png?q=1', currentSrc: 'http://x/b.png?q=1' }), base)).toEqual({ tag: 'img', url: '/b.png' })
    expect(resourceOf(el('SCRIPT', { src: 'http://x/a.js?q=1' }), base)).toEqual({ tag: 'script', url: '/a.js' })
    expect(resourceOf(el('LINK', { href: 'http://x/a.css?q=1' }), base)).toEqual({ tag: 'link', url: '/a.css' })
    expect(resourceOf(el('SOURCE', { src: 'http://other/a.mp4' }), base)).toEqual({ tag: 'source', url: 'http://other' })
    expect(resourceOf(el('IFRAME', { src: 'http://x/a' }), base)).toBeNull()
    expect(resourceOf(null, base)).toBeNull()
  })
})

describe('the server\'s allowlist for each new kind (#4)', () => {
  const SENTINEL = 'SENTINEL-text'
  const env = (kind: string, body: Record<string, unknown>) => ({ ...body, v: 1, ws: 'a'.repeat(16), page: 'b'.repeat(12), load: 'c'.repeat(12), seq: 1, ts: Date.now(), kind, extra: SENTINEL })
  const t = 'd'.repeat(12), by = 'e'.repeat(12)

  it('`theme`', () => {
    const c = cleanPageRecord(env('theme', { t, scope: 'view', to: 'dark', by, frames: 3, applied: 2, p50Ms: 12.4, maxMs: 40, late: 1, outcome: 'timeout' }))!
    expect(c).toMatchObject({ t, scope: 'view', to: 'dark', by, frames: 3, applied: 2, p50Ms: 12, maxMs: 40, late: 1, outcome: 'timeout' })
    expect(JSON.stringify(c)).not.toContain(SENTINEL)
    expect(cleanPageRecord(env('theme', { t, scope: 'nope', to: 'dark', outcome: 'done' }))).toBeNull()
    expect(cleanPageRecord(env('theme', { t, scope: 'view', to: 'not a theme!', outcome: 'done' }))).toBeNull()
    expect(cleanPageRecord(env('theme', { t: SENTINEL, scope: 'view', to: 'dark', outcome: 'done' }))).toBeNull()
  })
  it('`mode`', () => {
    expect(cleanPageRecord(env('mode', { mode: 'comments', phase: 'enter', t, by, shownMs: 88, frames: 3, outcome: 'done' }))).toMatchObject({ mode: 'comments', phase: 'enter', t, by, shownMs: 88, frames: 3, outcome: 'done' })
    expect(cleanPageRecord(env('mode', { mode: 'play', phase: 'enter', t, firstFrameMs: 900, outcome: 'done' }))).toMatchObject({ firstFrameMs: 900 })
    expect(cleanPageRecord(env('mode', { mode: 'laser', phase: 'exit', t, heldMs: 5000, errors: 2 }))).toMatchObject({ heldMs: 5000, errors: 2 })
    expect(cleanPageRecord(env('mode', { mode: 'dancing', phase: 'enter', t }))).toBeNull()
    expect(cleanPageRecord(env('mode', { mode: 'laser', phase: 'sideways', t }))).toBeNull()
  })
  it('`hmr`', () => {
    expect(cleanPageRecord(env('hmr', { phase: 'lost' }))).toMatchObject({ phase: 'lost' })
    expect(cleanPageRecord(env('hmr', { phase: 'back', downMs: 1200 }))).toMatchObject({ phase: 'back', downMs: 1200 })
    expect(cleanPageRecord(env('hmr', { phase: 'gone' }))).toBeNull()
  })
  it('`warnings`: counts and nodes, no text', () => {
    const c = cleanPageRecord(env('warnings', { n: 12, top: [{ node: 'k1', n: 10, message: SENTINEL }, { node: 'shell', n: 2 }], message: SENTINEL }))!
    expect(c).toMatchObject({ n: 12, top: [{ node: 'k1', n: 10 }, { node: 'shell', n: 2 }] })
    expect(JSON.stringify(c)).not.toContain(SENTINEL)
    expect(cleanPageRecord(env('warnings', { n: 'many' }))).toBeNull()
  })
  it('`renders`: rows of numbers, at most 64 + others', () => {
    const minute = 1_800_000_000_000
    const rows = Array.from({ length: 80 }, (_, i) => ({ who: `k${i}`, frame: 'kit/a', commits: 1, ms: 2.34, maxMs: 2, inGesture: 0, props: SENTINEL }))
    const c = cleanPageRecord(env('renders', { minute, rows }))!
    expect((c.rows as unknown[])).toHaveLength(65)
    expect((c.rows as RenderRow[])[0]).toEqual({ who: 'k0', frame: 'kit/a', commits: 1, ms: 2.3, maxMs: 2, inGesture: 0 })
    expect(JSON.stringify(c)).not.toContain(SENTINEL)
    expect(cleanPageRecord(env('renders', { minute, rows: [] }))).toBeNull()
    expect(cleanPageRecord(env('renders', { minute: 'now', rows }))).toBeNull()
  })
  it('`error`: every new source and its fields; `modes` from the list', () => {
    expect(cleanPageRecord(env('error', { source: 'console', frame: 'kit/a', message: 'boom', modes: ['comments', 'dancing', 'comments'] }))).toMatchObject({ source: 'console', frame: 'kit/a', modes: ['comments'] })
    expect(cleanPageRecord(env('error', { source: 'api', message: 'GET boards/:board 500', route: 'boards/:board', method: 'GET', status: 500, ms: 12 }))).toMatchObject({ route: 'boards/:board', method: 'GET', status: 500, ms: 12 })
    expect(cleanPageRecord(env('error', { source: 'api', message: 'x', route: 'a', method: 'GET', status: 'timeout', ms: 1 }))).toMatchObject({ status: 'timeout' })
    expect(cleanPageRecord(env('error', { source: 'api', message: 'x', route: 'a b?c=d', method: 'nope', status: 'huge' }))).not.toHaveProperty('route')
    expect(cleanPageRecord(env('error', { source: 'resource', message: 'img /a.png', tag: 'img', url: '/a.png' }))).toMatchObject({ tag: 'img', url: '/a.png' })
    expect(cleanPageRecord(env('error', { source: 'resource', message: 'x', tag: 'marquee' }))).not.toHaveProperty('tag')
    expect(cleanPageRecord(env('error', { source: 'nope', message: 'x' }))).toBeNull()
  })
  it('`vite`: a file inside the repo is relative to it', () => {
    const c = cleanPageRecord(env('error', { source: 'vite', message: 'x', file: '/repo/design/scenes/a.tsx', plugin: 'vite:react-babel' }), Date.now(), '/repo')!
    expect(c).toMatchObject({ file: 'design/scenes/a.tsx', plugin: 'vite:react-babel' })
    expect(cleanPageRecord(env('error', { source: 'vite', message: 'x', file: '/elsewhere/a.tsx' }), Date.now(), '/repo')).toMatchObject({ file: '/elsewhere/a.tsx' })
  })
  it('`gesture`: scale, what was shown, the frames that blocked it, the command', () => {
    const c = cleanPageRecord(env('gesture', {
      type: 'zoom', ms: 500, frames: 30, p50: 16, p95: 33, max: 120, over17ms: 3, over33ms: 1, longFrames: 2,
      scale: { from: 1, to: 0.5, min: 0.5, max: 1 }, visible: 3, awake: 2, by,
      loaf: [{ ms: 120, blockMs: 70, script: { src: '/design/a.tsx?t=1', frame: 'kit/a', fn: 'f'.repeat(90), invoker: 'i', ms: 100, where: 'descendant', extra: SENTINEL } }, { ms: 90 }, { ms: 80 }, { ms: 70 }],
    }))!
    expect(c).toMatchObject({ scale: { from: 1, to: 0.5, min: 0.5, max: 1 }, visible: 3, awake: 2, by })
    const l = c.loaf as { ms: number; script?: { src: string; fn: string } }[]
    expect(l).toHaveLength(3)
    expect(l[0].script!.src).toBe('/design/a.tsx')
    expect(l[0].script!.fn).toHaveLength(64)
    expect(l[1]).toEqual({ ms: 90 })
    expect(JSON.stringify(c)).not.toContain(SENTINEL)
    // a 0.29 gesture still reads as it did
    expect(cleanPageRecord(env('gesture', { type: 'pan', ms: 5, frames: 3 }))).not.toHaveProperty('scale')
    expect(cleanPageRecord(env('gesture', { type: 'pan', ms: 5, frames: 3, scale: { from: 1 } }))).not.toHaveProperty('scale')
  })
  it('`dropped`: the new reasons', () => {
    for (const reason of ['console', 'api', 'resource', 'frame', 'theme', 'mode']) expect(cleanPageRecord(env('dropped', { n: 3, reason }))).toMatchObject({ n: 3, reason })
  })
})
