import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A theme switch in the store.
//  - sh:theme-applied acks (setThemeOn) are batched, and applied before anything else reads or writes the store: the
//    model test drives the real store with seeded random interleavings of acks and every other kind of action (board
//    switches, reloads of the board - incl. a live manifest landing mid-fetch, the fetched-then-live double apply -
//    manifest changes, frame reloads, reload jobs, the error retry, removals, theme switches, status changes), once
//    batched and once with each ack written the moment it comes, as before batching; the two stores must be equal after
//    every other action and at the end;
//  - a burst is one store update; the 100 ms timer flushes when no animation frame comes; the last ack of a key wins;
//  - setTheme: the frame index's first match, a frame's own meta.theme kept, pins cleared, an unchanged node kept.

vi.mock('virtual:sh-config', () => ({ default: { viewports: { desktop: { width: 1440, height: 900 } }, themes: ['light', 'dark'], noTheme: false } }))
vi.mock('virtual:sh-data', () => ({ default: null }))
const g = globalThis as Record<string, unknown>
g.addEventListener ??= () => {}
g.removeEventListener ??= () => {}
g.window ??= globalThis
g.document ??= { cookie: '', querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, visibilityState: 'visible' }
g.location ??= { origin: 'http://localhost', hash: '', pathname: '/', search: '' }

let frames = 0
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  frames = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames++; return setTimeout(() => cb(0), 16) as unknown as number })
  vi.stubGlobal('cancelAnimationFrame', (h: number) => clearTimeout(h))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

type Store = typeof import('../src/client/shell/store.ts')['useStore']
const node = (key: string) => ({ key, frame: `s/${key}`, x: 0, y: 0, w: 400, h: 300, theme: 'dark', status: 'ready' as const })
async function store(board: string, keys: string[]) {
  const { useStore } = await import('../src/client/shell/store.ts')
  useStore.setState({ board, nodes: keys.map(node) })
  return useStore
}
const on = (s: Store, key: string) => s.getState().nodes.find((n) => n.key === key)?.themeOn

describe('theme acks', () => {
  it('a burst is one store update, scheduled once - two acks for the same key included', async () => {
    const s = await store('a', ['k1', 'k2', 'k3'])
    let updates = 0
    const off = s.subscribe(() => { updates++ })
    for (const k of ['k1', 'k1', 'k2', 'k1', 'k3']) s.getState().setThemeOn(k, 'dark')
    expect(frames).toBe(1)
    expect(on(s, 'k1')).toBeUndefined()   // not yet: the next animation frame
    await vi.advanceTimersByTimeAsync(17)
    expect(updates).toBe(1)
    expect(['k1', 'k2', 'k3'].map((k) => on(s, k))).toEqual(['dark', 'dark', 'dark'])
    off()
  })
  it('a batch is flushed by its own first timer: the earlier batch\'s timeout never flushes it early', async () => {
    const s = await store('a', ['k1', 'k2'])
    s.getState().setThemeOn('k1', 'dark')          // at 0: its frame at 16, its timeout at 100
    await vi.advanceTimersByTimeAsync(17)
    expect(on(s, 'k1')).toBe('dark')
    await vi.advanceTimersByTimeAsync(82)            // 99: a new ack, its frame at 115
    s.getState().setThemeOn('k2', 'dark')
    await vi.advanceTimersByTimeAsync(3)             // 102: the first batch's timeout (100) must not have flushed it
    expect(on(s, 'k2')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(14)
    expect(on(s, 'k2')).toBe('dark')
  })
  it('the 100 ms timeout flushes a batch when no animation frame comes (a hidden page)', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1)   // never runs
    const s = await store('a', ['k'])
    s.getState().setThemeOn('k', 'dark')
    await vi.advanceTimersByTimeAsync(99)
    expect(on(s, 'k')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2)
    expect(on(s, 'k')).toBe('dark')
  })
  it('two acks of one key in a batch, two themes: the last one lands', async () => {
    const s = await store('a', ['k'])
    s.getState().setThemeOn('k', 'dark')
    s.getState().setThemeOn('k', 'light')
    await vi.advanceTimersByTimeAsync(17)
    expect(on(s, 'k')).toBe('light')
  })
  it('anything else that writes the store, from an action or from outside, lands after the acks that came before it', async () => {
    const s = await store('a', ['k'])
    s.getState().setThemeOn('k', 'dark')
    s.getState().reloadFrame('k')                    // an action: the ack is in the state it starts from
    expect(on(s, 'k')).toBe('dark')
    s.getState().setThemeOn('k', 'light')
    s.setState({ selection: ['k'] })                 // a write from outside
    expect(on(s, 'k')).toBe('light')
  })
})

// ---- the model: the real store, batched, against the same store with every ack written at once ----------------------

/** A seeded generator (mulberry32): the same sequences on every run. */
function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const FRAMES = (fFile = 's/f.tsx', withG = true, fKind = 'tsx') => ({
  frames: [{ id: 's/f', file: fFile, kind: fKind, scene: 's' }, ...(withG ? [{ id: 's/g', file: 's/g.tsx', kind: 'tsx', scene: 's' }] : []), { id: 's/h', file: 's/h.tsx', kind: 'tsx', scene: 's', theme: 'light' }],
  scenes: [{ name: 's', frames: withG ? 3 : 2 }],
})
const MANIFESTS = [FRAMES(), FRAMES('s/f2.tsx'), FRAMES('s/f.tsx', false), FRAMES('s/f.html', true, 'html')]
const at = (key: string, frame: string) => ({ key, frame, x: 0, y: 0, w: 400, h: 300 })
/** What the server holds: the manifest and the boards - a step may change them before a reload. */
const server = { manifest: MANIFESTS[0] as unknown, boards: {} as Record<string, ReturnType<typeof at>[]> }
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, headers: new Map() }) as unknown as Response
function serve() {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('manifest.json')) return json(server.manifest)
    const b = /\/api\/boards\/([^/?]+)/.exec(u)?.[1]
    if (b && (!init?.method || init.method === 'GET')) return server.boards[b] ? json({ board: { version: 1, name: b, auto: false, nodes: server.boards[b] }, sha256: `sha-${b}-${JSON.stringify(server.boards[b])}` }) : json({ board: null })
    if (b) return json({ sha256: `saved-${b}` })
    return json({})
  })
}
/** Two independent stores: the batched one, and the reference - acks written at once, as setThemeOn did before. */
async function pair(): Promise<{ batched: Store; ref: Store }> {
  vi.resetModules()
  const batched = (await import('../src/client/shell/store.ts')).useStore
  vi.resetModules()
  const ref = (await import('../src/client/shell/store.ts')).useStore
  for (const s of [batched, ref]) { s.setState({ board: '__none__', nodes: [], dirty: false, manifest: null, viewTheme: 'light' }); await s.getState().switchBoard('a') }
  return { batched, ref }
}
const ackRef = (s: Store, key: string, theme: string) => s.setState((st) => ({ nodes: st.nodes.map((n) => (n.key === key ? { ...n, themeOn: theme } : n)) }))
/** What the comparison reads, once the batch has landed (its timer: the same on every build): the board, the theme,
 *  every node's own fields. */
const seen = (s: Store) => { const st = s.getState(); return { board: st.board, viewTheme: st.viewTheme, nodes: st.nodes.map((n) => ({ ...n })), frames: st.manifest?.frames.map((f) => `${f.id}:${f.kind}:${f.file}`) } }

describe('theme acks against acks written at once (the model)', () => {
  it('300 seeded interleavings: equal after every other action and at the end', async () => {
    serve()
    const KEYS = ['k1', 'k2', 'k3', 'k4']
    for (let seq = 0; seq < 300; seq++) {
      const r = rng(1000 + seq), pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]
      server.manifest = MANIFESTS[0]
      server.boards = { a: [at('k1', 's/f'), at('k2', 's/g'), at('k3', 's/h')], b: [at('k1', 's/g'), at('k4', 's/f')] }
      const { batched, ref } = await pair()
      const log: string[] = []
      const ack = () => { const k = pick(KEYS), t = pick(['light', 'dark']); log.push(`ack ${k} ${t}`); batched.getState().setThemeOn(k, t); ackRef(ref, k, t) }
      const both = async (name: string, fn: (s: Store) => unknown, during = 0) => {
        log.push(name)
        const pa = fn(batched), pb = fn(ref)
        for (let i = 0; i < during; i++) ack()   // acks that come while the action awaits the server
        await pa; await pb
        await vi.advanceTimersByTimeAsync(120)
        expect(seen(batched), `seq ${seq}: ${log.join(' · ')}`).toEqual(seen(ref))
      }
      for (let step = 0; step < 14; step++) {
        const kind = r()
        if (kind < 0.4) { ack(); continue }
        const k = pick(KEYS), during = Math.floor(r() * 3)
        const what = Math.floor(r() * 10)
        if (what === 0) await both(`switch ${pick(['a', 'b'])}`, (s) => s.getState().switchBoard(log.at(-1)!.split(' ')[1] as string), during)
        else if (what === 1) { const f = pick(['s/g', 's/h', 's/f']); server.boards.a = server.boards.a.map((n) => (n.key === 'k2' ? { ...n, frame: f } : n)); await both(`boot (k2 ${f})`, (s) => s.getState().boot(), during) }
        else if (what === 2) { const m = pick(MANIFESTS); server.manifest = m; await both(`boot (manifest ${MANIFESTS.indexOf(m)})`, (s) => s.getState().boot(), during) }
        else if (what === 3) {
          // the double apply: the fetch reads one manifest, a live one lands meanwhile and is applied after the commit
          const fetched = pick(MANIFESTS), live = pick(MANIFESTS)
          server.manifest = fetched
          await both(`boot with live ${MANIFESTS.indexOf(fetched)}->${MANIFESTS.indexOf(live)}`, async (s) => { const p = s.getState().boot(); await Promise.resolve(); s.setState({ manifest: live as never }); return p }, during)
        }
        else if (what === 4) { const m = pick(MANIFESTS); await both(`manifest ${MANIFESTS.indexOf(m)}`, (s) => s.getState().applyManifest(m as never)) }
        else if (what === 5) await both(`reloadFrame ${k}`, (s) => s.getState().reloadFrame(k))
        else if (what === 6) await both(`startReload ${k}`, (s) => s.getState().startReload(k))
        else if (what === 7) await both(`removeNode ${k}`, (s) => s.getState().removeNode(k))
        else if (what === 8) { const t = pick(['light', 'dark']); await both(`setTheme ${t}`, (s) => s.getState().setTheme(t)) }
        else { const st = pick(['ready', 'error', 'loading'] as const); await both(`setStatus ${k} ${st}`, (s) => s.getState().setStatus(k, st, st === 'error' ? 'x' : undefined)) }
      }
      await vi.advanceTimersByTimeAsync(120)   // the last batch lands
      expect(seen(batched), `seq ${seq} (end): ${log.join(' · ')}`).toEqual(seen(ref))
    }
  }, 120_000)
})

describe('setTheme', () => {
  const frame = (id: string, theme?: string) => ({ id, file: `${id}.tsx`, kind: 'tsx' as const, scene: 's', ...(theme ? { theme } : {}) })
  it('every node the view theme, by the index: the first entry of an id, a frame\'s own meta.theme kept, pins cleared, an unchanged node kept as it is', async () => {
    const { useStore } = await import('../src/client/shell/store.ts')
    const nodes = [
      { key: 'plain', frame: 's/plain', x: 0, y: 0, w: 400, h: 300, theme: 'light', status: 'ready' as const },
      { key: 'meta', frame: 's/meta', x: 0, y: 0, w: 400, h: 300, theme: 'dark', status: 'ready' as const },
      { key: 'pinned', frame: 's/plain', x: 0, y: 0, w: 400, h: 300, theme: 'light', themeUser: 'light', status: 'ready' as const },
      { key: 'twice', frame: 's/twice', x: 0, y: 0, w: 400, h: 300, theme: 'light', status: 'ready' as const },
      { key: 'already', frame: 's/plain', x: 0, y: 0, w: 400, h: 300, theme: 'dark', status: 'ready' as const },
    ]
    useStore.setState({ board: 'a', viewTheme: 'light', dirty: false, nodes, manifest: { frames: [frame('s/plain'), frame('s/meta', 'dark'), frame('s/twice', 'light'), frame('s/twice', 'dark')], scenes: [{ name: 's', frames: 4 }] } })
    useStore.getState().setTheme('dark')
    const st = useStore.getState(), by = (k: string) => st.nodes.find((n) => n.key === k)!
    expect(st.viewTheme).toBe('dark')
    expect(st.dirty).toBe(true)
    expect(by('plain').theme).toBe('dark')
    expect(by('meta').theme).toBe('dark')             // its own meta.theme (dark), whatever the view
    expect(by('pinned')).toMatchObject({ theme: 'dark', themeUser: undefined })   // a global set clears the pin
    expect(by('twice').theme).toBe('light')           // the FIRST entry of a duplicated id declares light
    expect(by('already')).toBe(nodes[4])              // nothing to change: the same object
    useStore.getState().setTheme('light')
    const back = useStore.getState(), b = (k: string) => back.nodes.find((n) => n.key === k)!
    expect(b('meta').theme).toBe('dark')
    expect(b('meta')).toBe(by('meta'))                // unchanged again: the same object
    expect(b('plain').theme).toBe('light')
  })
})
