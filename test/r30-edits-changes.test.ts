import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Plugin, type ViteDevServer } from 'vite'
import { createChanges, type Attribution, type Changes, type Line } from '../src/server/changes.ts'
import { guardUpdates, updatesBeginPlugin, updatesPlugin, type Touched, type UpdateHooks } from '../src/server/updates.ts'
import { scanFrames } from '../src/server/manifest.ts'
import { noteWrite, writerFrom, writerOf } from '../src/server/board-writes.ts'
import { CHANGE_ID, RELOAD_BOUNDS, UNKNOWN_CHANGE, WRITE_MATCH_MS } from '../src/shared/perf-records.ts'

/**
 * An edit's identity on the server (spec 30 R1 #8-#12, R2 #18). The bracket rules run against REAL Vite: its own
 * `handleHMRUpdate`, its real hook order and environments, with a slow plugin holding runs open so they truly overlap -
 * what the spec's rules exist for, and what a fake of Vite's order could not prove. The line shapes and bounds run on the
 * ledger alone, under a fake clock.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('the ledger', () => {
  const ledger = (over: { envs?: () => number; now?: () => number } = {}) => {
    const lines: Line[] = []
    const changes = createChanges({ root: '/r', boot: 'abcd1234', envs: over.envs ?? (() => 1), now: over.now, write: (l) => lines.push(...l) })
    return { changes, lines, of: (kind: string) => lines.filter((l) => l.kind === kind) }
  }

  it('mints one id per event, in the shared format', () => {
    const { changes } = ledger()
    const a = changes.watch('/r/a.tsx', 'update'), b = changes.watch('/r/a.tsx', 'update')
    expect(a.change).toMatch(CHANGE_ID)
    expect(b.change).not.toBe(a.change)
  })

  it('a change line at its end: file repo-relative, flight, counts, hmrTs', async () => {
    let t = 1000
    const { changes, of } = ledger({ now: () => t })
    const token = changes.watch('/r/design/a.tsx', 'update')
    changes.begin('/r/design/a.tsx', 5000)
    changes.update('update', '/r/design/a.tsx', ['s/a', 's/b'], ['s/c'], { token })
    t = 1250
    changes.landed('/r/design/a.tsx', 5000)
    await sleep(5)
    expect(of('change')).toEqual([{ kind: 'change', change: token.change, file: 'design/a.tsx', event: 'update', hmrTs: 5000, flightMs: 250, reloadN: 2, inPlaceN: 1 }])
  })

  it('a token with no run says no-hook, at the safety path - and one with hooks does not', async () => {
    const { changes, of } = ledger()
    const never = changes.watch('/r/a.tsx', 'create')
    changes.expire('/r/a.tsx')
    expect(of('change')[0]).toMatchObject({ change: never.change, event: 'create', outcome: 'no-hook' })
    expect(of('change')[0]).not.toHaveProperty('hmrTs')
    const ran = changes.watch('/r/b.tsx', 'update')
    changes.begin('/r/b.tsx', 7000)
    changes.expire('/r/b.tsx')   // began, never landed: ended by the safety path, its hooks did run
    expect(of('change')[1]).toMatchObject({ change: ran.change, hmrTs: 7000 })
    expect(of('change')[1]).not.toHaveProperty('outcome')
  })

  it('a deferred line holds the change line back, so its counts are whole', async () => {
    const { changes, of } = ledger()
    const token = changes.watch('/r/a.tsx', 'update')
    changes.begin('/r/a.tsx', 5000)
    const release = changes.hold({ token })
    changes.landed('/r/a.tsx', 5000)
    await sleep(5)
    expect(of('change')).toHaveLength(0)   // ended, but record() has not run yet
    changes.update('update', '/r/a.tsx', ['s/a'], [], { token })
    release()
    expect(of('change')).toHaveLength(1)
    expect(of('change')[0]).toMatchObject({ reloadN: 1 })
  })

  it('a token ends once its hooks landed in every environment, and only once', async () => {
    const { changes, of } = ledger({ envs: () => 2 })
    changes.watch('/r/a.tsx', 'update')
    changes.begin('/r/a.tsx', 5000)
    changes.landed('/r/a.tsx', 5000)
    await sleep(5)
    expect(of('change')).toHaveLength(0)
    changes.landed('/r/a.tsx', 5000)
    await sleep(5)
    changes.landed('/r/a.tsx', 5000)   // a stray late hook
    changes.expire('/r/a.tsx')
    await sleep(5)
    expect(of('change')).toHaveLength(1)
  })

  it('update-ids keep every id: the first 256 on the line, the rest in parts, nothing lost', () => {
    const { changes, lines } = ledger()
    const token = changes.watch('/r/a.tsx', 'update')
    const reload = Array.from({ length: 600 }, (_, i) => `s/r${i}`), inPlace = Array.from({ length: 300 }, (_, i) => `s/p${i}`)
    changes.update('update', '/r/a.tsx', reload, inPlace, { token })
    expect(lines.map((l) => l.kind)).toEqual(['update', 'update-ids', 'update-ids'])
    expect(lines[0]).toMatchObject({ change: token.change, reloadN: 600, inPlaceN: 300, parts: 3 })
    expect((lines[0].reload as string[]).length).toBe(RELOAD_BOUNDS.idsPerLine)
    expect(lines.slice(1).map((l) => [l.part, l.parts])).toEqual([[2, 3], [3, 3]])
    expect(lines.flatMap((l) => (l.reload as string[]) ?? [])).toEqual(reload)
    expect(lines.flatMap((l) => (l.inPlace as string[]) ?? [])).toEqual(inPlace)
  })

  it('a short update is one line, with no parts', () => {
    const { changes, lines } = ledger()
    const token = changes.watch('/r/a.tsx', 'update')
    changes.update('update', '/r/a.tsx', ['s/a'], [], { token })
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toHaveProperty('parts')
  })

  it('invalidate-ids keep every edge, many to many', () => {
    const { changes, lines } = ledger()
    const ids = Array.from({ length: 300 }, (_, i) => `abcd1234:${i}`)
    changes.invalidate('9:1', 12, ids)
    expect(lines.map((l) => l.kind)).toEqual(['invalidate', 'invalidate-ids'])
    expect(lines[0]).toMatchObject({ revision: '9:1', frames: 12, parts: 2 })
    expect(lines[1]).toMatchObject({ revision: '9:1', part: 2, parts: 2 })
    expect(lines.flatMap((l) => l.changes as string[])).toEqual(ids)
    // the same change in a later revision: its edge is kept too
    changes.invalidate('9:2', 1, [ids[0]])
    expect(lines.at(-1)).toMatchObject({ revision: '9:2', changes: [ids[0]] })
  })

  it('a refused refresh is never one change: the one its timestamp names, and the 10 s before it', () => {
    const { changes } = ledger()
    const at = (ts: number) => { const t = changes.watch('/r/a.tsx', 'update'); changes.begin('/r/a.tsx', ts); return t.change }
    const old = at(1_000), a = at(50_000), b = at(55_000), after = at(70_000)
    const r = changes.refused(55_000)
    expect(r.token).toBeUndefined()
    expect(r.graphTs).toBe(55_000)
    expect(r.candidates).toEqual({ ids: [b, a], n: 2 })           // the named first; never B alone
    expect(r.candidates!.ids).not.toContain(old)                   // past the look-back
    expect(r.candidates!.ids).not.toContain(after)                 // after the timestamp
  })

  it('candidates: at most 8 ids, and their count', () => {
    const { changes } = ledger()
    for (let i = 0; i < 20; i++) { changes.watch('/r/a.tsx', 'update'); changes.begin('/r/a.tsx', 50_000 + i) }
    const r = changes.refused(50_019)
    expect(r.candidates!.ids).toHaveLength(RELOAD_BOUNDS.candidates)
    expect(r.candidates!.n).toBe(20)
  })

  it('keeps the last 512 timestamps', () => {
    const { changes } = ledger()
    let first = ''
    for (let i = 0; i < RELOAD_BOUNDS.hmrHistory + 1; i++) {
      const t = changes.watch(`/r/${i}.tsx`, 'update')
      if (!i) first = t.change
      changes.begin(`/r/${i}.tsx`, 100_000 + i)
    }
    expect(changes.refused(100_000).candidates).toEqual({ ids: [], n: 0 })
    expect(first).toMatch(CHANGE_ID)
    expect(changes.refused(100_001).candidates!.n).toBe(1)
  })

  it('a full-reload line says what it knows', () => {
    const { changes, lines } = ledger()
    const token = changes.watch('/r/a.tsx', 'update')
    changes.fullReload({}, false, { token, by: 'hook' })
    expect(lines.at(-1)).toEqual({ kind: 'full-reload', passed: false, triggeredBy: null, path: null, by: 'hook', change: token.change, file: 'a.tsx' })
    expect(token.fullReload).toBe('dropped')
    changes.fullReload({}, false, { by: 'ambiguous', candidates: { ids: ['x', 'y'], n: 2 } })
    expect(lines.at(-1)).toEqual({ kind: 'full-reload', passed: false, triggeredBy: null, path: null, by: 'ambiguous', candidates: { ids: ['x', 'y'], n: 2 } })
    // the optimiser's: it passes, and no change is claimed
    changes.fullReload({ path: '*' }, true)
    expect(lines.at(-1)).toEqual({ kind: 'full-reload', passed: true, triggeredBy: null, path: '*' })
  })

  it('an unattributed update line says unknown, with its candidates', () => {
    const { changes, lines } = ledger()
    changes.update('invalidate', '/r/a.tsx', ['s/a'], [], { graphTs: 42, candidates: { ids: ['x'], n: 1 } })
    expect(lines[0]).toMatchObject({ change: UNKNOWN_CHANGE, graphTs: 42, candidates: { ids: ['x'], n: 1 } })
  })
})

describe('real Vite: the bracket, under runs that truly overlap', () => {
  let root = ''
  let server: ViteDevServer
  let changes: Changes
  const lines: Line[] = []
  const frames: { t: Touched; cause: string; at: Attribution }[] = []
  const reloads: { passed: boolean; at?: Attribution }[] = []
  const refusals: ((p: { path?: string }) => void)[] = []
  /** a plugin's own hook holds a run open until released; `reloadIn` sends Tailwind's bare full-reload from inside it */
  const gates = new Map<string, { open: Promise<void>; go: () => void; inside: Promise<void>; entered: () => void }>()
  const hold = (file: string) => {
    let go!: () => void, entered!: () => void
    const open = new Promise<void>((r) => { go = r }), inside = new Promise<void>((r) => { entered = r })
    gates.set(file, { open, go, inside, entered })
    return gates.get(file)!
  }
  const reloadIn = new Set<string>()
  const f = (name: string) => join(root, 'design/scenes/s', name)
  const fire = (file: string) => server.watcher.emit('change', file)
  const quiet = async () => { for (let i = 0; i < 40 && frames.length + reloads.length === 0; i++) await sleep(5) }
  const settle = () => sleep(60)

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-chg-')))
    for (const n of ['a.tsx', 'b.tsx']) { mkdirSync(join(root, 'design/scenes/s'), { recursive: true }); writeFileSync(f(n), 'export default () => null\n') }
    const manifest = scanFrames(root)
    const hooks: UpdateHooks = {
      onFrames: (t, cause, at) => { frames.push({ t, cause, at }) },
      onReload: (_p, passed, at) => { reloads.push({ passed, at }) },
    }
    // as Tailwind's generate:serve: `enforce: 'pre'` and an unordered hook - our `order: 'pre'` still runs before it
    const tailwindLike: Plugin = {
      name: 'test:tailwind-like', enforce: 'pre',
      async hotUpdate(opts) {
        if (this.environment.name !== 'client') return
        const g = gates.get(opts.file)
        if (g) { g.entered(); await g.open }
        if (reloadIn.delete(opts.file)) this.environment.hot.send({ type: 'full-reload' })
      },
    }
    changes = createChanges({ root, envs: () => Object.keys(server.environments).length, write: (l) => lines.push(...l) })
    const watcher: Plugin = { name: 'test:watch', watchChange(id, c) { changes.watch(id, c.event) } }
    server = await createServer({
      configFile: false, root, logLevel: 'silent', appType: 'custom',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, hmr: { port: 10100 + Math.floor(Math.random() * 200) }, watch: { ignored: ['**'] } },
      plugins: [watcher, tailwindLike, updatesBeginPlugin(changes), updatesPlugin(root, () => manifest, () => hooks, () => {}, changes)],
    })
    const hot = server.environments.client.hot as unknown as { on: (ev: string, fn: (p: { path?: string }) => void) => void }
    const on = hot.on.bind(hot)
    hot.on = (ev, fn) => { if (ev === 'vite:invalidate') refusals.push(fn); else on(ev, fn) }
    guardUpdates(server, root, () => manifest, hooks, changes)
  }, 60_000)
  afterAll(async () => { await server?.close(); if (root) rmSync(root, { recursive: true, force: true }) })
  afterEach(async () => {
    for (const g of gates.values()) g.go()
    gates.clear()
    await settle()
    lines.length = 0; frames.length = 0; reloads.length = 0
  })

  it('Vite has more than one environment here: the rules below are not trivially true', () => {
    expect(Object.keys(server.environments).length).toBeGreaterThan(1)
  })

  it('one save: its update keeps its token, and one change line follows, though its hooks run per environment', async () => {
    fire(f('a.tsx'))
    await quiet()
    await settle()
    expect(frames).toHaveLength(1)
    expect(frames[0].cause).toBe('update')
    expect(frames[0].at.token?.file).toBe(f('a.tsx'))
    expect(frames[0].at.token?.hmrTs).toBeGreaterThan(0)
    const ch = lines.filter((l) => l.kind === 'change')
    expect(ch).toHaveLength(1)
    expect(ch[0]).toMatchObject({ change: frames[0].at.token!.change, file: 'design/scenes/s/a.tsx', event: 'update', hmrTs: frames[0].at.token!.hmrTs })
    expect(ch[0]).not.toHaveProperty('outcome')
  })

  it('two saves of one file, overlapping: each keeps its own change, in order', async () => {
    const g = hold(f('a.tsx'))
    fire(f('a.tsx'))
    await g.inside                        // the first run's hooks are open, its token taken
    gates.delete(f('a.tsx'))
    fire(f('a.tsx'))                      // the second runs through while the first waits
    await quiet()
    expect(frames).toHaveLength(1)
    const second = frames[0].at.token!
    g.go()
    await settle()
    expect(frames).toHaveLength(2)
    const first = frames[1].at.token!
    expect(first.change).not.toBe(second.change)
    expect(Number(first.change.split(':')[1])).toBeLessThan(Number(second.change.split(':')[1]))   // FIFO: the older run took the older token
    expect(first.hmrTs).toBeLessThan(second.hmrTs!)
    expect(lines.filter((l) => l.kind === 'change').map((l) => l.change).sort()).toEqual([first.change, second.change].sort())
  })

  it('two files whose hooks overlap each keep their own change', async () => {
    const a = hold(f('a.tsx')), b = hold(f('b.tsx'))
    fire(f('a.tsx')); fire(f('b.tsx'))
    await Promise.all([a.inside, b.inside])
    b.go()                                 // the later one finishes first
    await settle()
    a.go()
    await settle()
    expect(frames.map((x) => x.at.token?.file)).toEqual([f('b.tsx'), f('a.tsx')])
    expect(frames[0].at.token!.change).not.toBe(frames[1].at.token!.change)
    expect(frames[0].t.doc).toEqual(['s/b'])
    expect(frames[1].t.doc).toEqual(['s/a'])
  })

  it('a pathless reload inside one bracket is that change: by hook - and the guard still reloads every frame', async () => {
    reloadIn.add(f('a.tsx'))
    fire(f('a.tsx'))
    await quiet()
    await settle()
    expect(reloads).toHaveLength(1)
    expect(reloads[0].passed).toBe(false)
    expect(reloads[0].at?.by).toBe('hook')
    expect(reloads[0].at?.token?.file).toBe(f('a.tsx'))
    const dropped = frames.find((x) => x.cause === 'reload')!
    expect(dropped.t.unattributed).toBe(true)
    expect(dropped.t.doc.sort()).toEqual(['s/a', 's/b'])   // R17: every frame, still
    expect(dropped.at.token).toBe(reloads[0].at?.token)
  })

  it('a pathless reload inside two brackets is ambiguous, with both candidates - never one of them', async () => {
    const a = hold(f('a.tsx')), b = hold(f('b.tsx'))
    reloadIn.add(f('a.tsx'))
    fire(f('a.tsx')); fire(f('b.tsx'))
    await Promise.all([a.inside, b.inside])   // both runs are in their hooks, truly at once
    expect(reloads).toHaveLength(0)
    a.go()
    await settle()
    expect(reloads).toHaveLength(1)
    expect(reloads[0].at?.by).toBe('ambiguous')
    expect(reloads[0].at?.token).toBeUndefined()
    expect(reloads[0].at?.candidates?.n).toBe(2)
    const named = frames.filter((x) => x.cause === 'update').map((x) => x.at.token!.change)
    expect(reloads[0].at?.candidates?.ids).toContain(named[0])   // a's own, written already
    b.go()
    await settle()
    const both = frames.filter((x) => x.cause === 'update').map((x) => x.at.token!.change)
    expect([...reloads[0].at!.candidates!.ids].sort()).toEqual([...both].sort())
    const dropped = frames.find((x) => x.cause === 'reload')!
    expect(dropped.at.token).toBeUndefined()                     // its update line names no change
    // and neither change claims the reload
    expect(lines.filter((l) => l.kind === 'change').every((l) => !('fullReload' in l))).toBe(true)
  })

  it('a pathless reload outside any bracket is unknown: the tokens in flight are candidates, no time-window guess', async () => {
    server.environments.client.hot.send({ type: 'full-reload' })
    expect(reloads[0].at).toEqual({ by: 'unknown', candidates: { ids: [], n: 0 } })   // nothing in flight: nothing named
    // an event minted, its hooks not begun: in flight, but no bracket
    const t = changes.watch(f('b.tsx'), 'update')
    server.environments.client.hot.send({ type: 'full-reload' })
    expect(reloads[1].at).toEqual({ by: 'unknown', candidates: { ids: [t.change], n: 1 } })
    changes.expire(f('b.tsx'))
  })

  it('the one that passes - no path to reload, no file named - goes out, naming no change', () => {
    const before = reloads.length
    server.environments.client.hot.send({ type: 'full-reload', path: '*' })
    expect(reloads[before].passed).toBe(true)
    expect(reloads[before].at).toBeUndefined()
  })

  it('a reload that names its file (a dead end) is that file\'s token in flight - not the other file\'s', async () => {
    const a = hold(f('a.tsx')), b = hold(f('b.tsx'))
    fire(f('a.tsx')); fire(f('b.tsx'))
    await Promise.all([a.inside, b.inside])
    server.environments.client.hot.send({ type: 'full-reload', triggeredBy: f('a.tsx'), path: '*' })
    const at = reloads.at(-1)!.at!
    expect(at.token?.file).toBe(f('a.tsx'))
    expect(at.by).toBeUndefined()
    a.go(); b.go()
    await settle()
  })

  it('a refused refresh of A arriving after B was saved: change unknown, A and B candidates, never B alone', async () => {
    fire(f('a.tsx'))                       // A
    await quiet(); await settle()
    const A = frames[0].at.token!
    frames.length = 0
    fire(f('a.tsx'))                       // B: the module's timestamp is now B's
    await quiet(); await settle()
    const B = frames[0].at.token!
    frames.length = 0
    const page = { file: f('a.tsx'), importers: new Set(), isSelfAccepting: false }
    const mod = { url: '/design/scenes/s/_card.tsx', file: f('b.tsx'), importers: new Set([page]), lastHMRTimestamp: B.hmrTs }
    server.environments.client.moduleGraph.urlToModuleMap.set(mod.url, mod as never)
    for (const fn of refusals) fn({ path: mod.url })
    const got = frames.find((x) => x.cause === 'invalidate')!
    expect(got.at.token).toBeUndefined()
    expect(got.at.graphTs).toBe(B.hmrTs)
    // the change its timestamp names, then the 10 s before it, newest first - this file's earlier saves are in there too
    expect(got.at.candidates!.ids.slice(0, 2)).toEqual([B.change, A.change])
    expect(got.at.candidates!.n).toBeGreaterThanOrEqual(2)
    changes.update('invalidate', got.t.file, got.t.doc, got.t.touched, got.at)
    expect(lines.at(-1)).toMatchObject({ kind: 'update', cause: 'invalidate', change: UNKNOWN_CHANGE, graphTs: B.hmrTs })
    server.environments.client.moduleGraph.urlToModuleMap.delete(mod.url)
  })
})

describe('who may have written a board (#18)', () => {
  const R = '/project', PAGE = 'aaaaaaaaaaaa', OTHER = 'bbbbbbbbbbbb', CMD = 'cccccccccccc'
  const who = (page: string, ids: string[] = [], n = ids.length) => ({ page, cmds: { ids, n } })

  it('no write seen: unknown, whoever it was', () => {
    expect(writerOf(`${R}/a`, 'main', 'h1', 1000)).toEqual({ writer: 'unknown' })
  })
  it('one match: a candidate with its page and command ids - never more than that', () => {
    noteWrite(`${R}/b`, 'main', 'h1', who(PAGE, [CMD]), 1000)
    expect(writerOf(`${R}/b`, 'main', 'h1', 2000)).toEqual({ writer: 'candidate', candidates: [{ page: PAGE, cmds: [CMD], n: 1 }] })
  })
  it('two writes of these bytes: ambiguous, with both', () => {
    noteWrite(`${R}/c`, 'main', 'h1', who(PAGE), 1000)
    noteWrite(`${R}/c`, 'main', 'h1', who(OTHER), 1500)
    const w = writerOf(`${R}/c`, 'main', 'h1', 2000)
    expect(w.writer).toBe('ambiguous')
    expect(w.candidates?.map((c) => c.page)).toEqual([PAGE, OTHER])
  })
  it('other bytes, another board, or past 10 s: unknown', () => {
    noteWrite(`${R}/d`, 'main', 'h1', who(PAGE), 1000)
    expect(writerOf(`${R}/d`, 'main', 'h2', 1500).writer).toBe('unknown')
    expect(writerOf(`${R}/d`, 'other', 'h1', 1500).writer).toBe('unknown')
    expect(writerOf(`${R}/d`, 'main', 'h1', 1000 + WRITE_MATCH_MS).writer).toBe('unknown')
  })
  it('the same bytes read again within 10 s are still only a candidate: nothing here can tell an editor from the page', () => {
    noteWrite(`${R}/e`, 'main', 'h1', who(PAGE), 1000)
    expect(writerOf(`${R}/e`, 'main', 'h1', 5000).writer).toBe('candidate')
    expect(writerOf(`${R}/e`, 'main', 'h1', 9000).writer).toBe('candidate')
  })
  it('a request names a page in its format, or none; its command ids read back with their count', () => {
    expect(writerFrom({})).toBeNull()
    expect(writerFrom({ 'x-mv-page': 'nic@example.com' })).toBeNull()
    expect(writerFrom({ 'x-mv-page': PAGE })).toEqual({ page: PAGE, cmds: { ids: [], n: 0 } })
    expect(writerFrom({ 'x-mv-page': PAGE, 'x-mv-cmds': `${CMD};n=12` })).toEqual({ page: PAGE, cmds: { ids: [CMD], n: 12 } })
    expect(writerFrom({ 'x-mv-page': PAGE, 'x-mv-cmds': 'free text' })).toEqual({ page: PAGE, cmds: { ids: [], n: 0 } })
  })
})
