import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A theme switch in the store. sh:theme-applied acks (setThemeOn): a burst is one store update an animation frame; each
// batch is flushed once, by its first timer - a later batch is never flushed early by a timer of an earlier one; an
// ack lands only on the document that sent it (a same-board reload, a board left and come back to, a board reusing
// the key). setTheme: the frame index's first match, a frame's own meta.theme kept, pins cleared, a node it does not
// change kept as it is.

vi.mock('virtual:sh-config', () => ({ default: { viewports: { desktop: { width: 1440, height: 900 } }, themes: ['light', 'dark'], noTheme: false } }))
vi.mock('virtual:sh-data', () => ({ default: null }))
const g = globalThis as Record<string, unknown>
g.addEventListener ??= () => {}
g.removeEventListener ??= () => {}
g.window ??= globalThis
g.document ??= { cookie: '', querySelector: () => null, addEventListener: () => {}, visibilityState: 'visible' }
g.location ??= { origin: 'http://localhost', hash: '', pathname: '/', search: '' }

let frames = 0
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  frames = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames++; return setTimeout(() => cb(0), 16) as unknown as number })
  vi.stubGlobal('cancelAnimationFrame', (h: number) => clearTimeout(h))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const node = (key: string) => ({ key, frame: `s/${key}`, x: 0, y: 0, w: 400, h: 300, theme: 'dark', status: 'ready' as const })
async function store(board: string, keys: string[]) {
  const { useStore } = await import('../src/client/shell/store.ts')
  useStore.setState({ board, nodes: keys.map(node) })
  return useStore
}
const on = (s: Awaited<ReturnType<typeof store>>, key: string) => s.getState().nodes.find((n) => n.key === key)?.themeOn


// ---- the real board paths: the manifest and the boards a fetch stub serves, the frame registry
type At = { key: string; frame: string; x: number; y: number; w: number; h: number }
const at = (key: string, frame: string): At => ({ key, frame, x: 0, y: 0, w: 400, h: 300 })
const MANIFEST = { frames: ['s/f', 's/g'].map((id) => ({ id, file: `${id}.tsx`, kind: 'tsx', scene: 's' })), scenes: [{ name: 's', frames: 2 }] }
let documentLiveFn: ((key: string, iframe: HTMLIFrameElement, boot: unknown) => boolean) | undefined
/** The store on board `name`, loaded through switchBoard from `boards` (read at each fetch: a test may change them). */
async function onBoard(name: string, boards: Record<string, At[]>) {
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, headers: new Map() }) as unknown as Response
  vi.stubGlobal('fetch', async (url: string) => {
    const u = String(url)
    if (u.includes('manifest.json')) return json(MANIFEST)
    const b = /\/api\/boards\/([^/?]+)/.exec(u)?.[1]
    if (b && boards[b]) return json({ board: { version: 1, name: b, auto: false, nodes: boards[b] }, sha256: `sha-${b}-${JSON.stringify(boards[b])}` })
    return json({})
  })
  const { useStore } = await import('../src/client/shell/store.ts')
  documentLiveFn = (await import('../src/client/shell/canvas/frame-registry.ts')).documentLive
  useStore.setState({ board: '__none__', nodes: [], dirty: false, manifest: null })
  await useStore.getState().switchBoard(name)
  expect(useStore.getState().board).toBe(name)
  return useStore
}
/** An iframe for `key` in the registry, its committed document's boot `boot`. */
async function registered(key: string, boot: string) {
  const win = { __mvBoot: boot } as { __mvBoot: string }
  const iframe = { contentWindow: win } as unknown as HTMLIFrameElement
  ;(await import('../src/client/shell/canvas/frame-registry.ts')).registerFrame(win as unknown as WindowProxy, { key, iframe })
  return { win, iframe }
}

describe('theme acks', () => {
  it('a burst is one store update, scheduled once - two acks for the same key included', async () => {
    const s = await store('a', ['k1', 'k2', 'k3'])
    let updates = 0
    const off = s.subscribe(() => { updates++ })
    for (const k of ['k1', 'k1', 'k2', 'k1', 'k3']) s.getState().setThemeOn(k, 'dark')   // k1 twice while it is the batch's only key
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
    await vi.advanceTimersByTimeAsync(14)            // 116: its own frame
    expect(on(s, 'k2')).toBe('dark')
  })
  // Through the real paths: switchBoard and boot (keepDocuments applied) fetching the boards below, the registry's
  // documentLive with a registered iframe. The iframe element is kept by its key, and its old document stays committed
  // until a new one does: these tests leave it committed (a navigation still pending), as a real one is for a while.
  it('a document that reloaded itself (its boot changed) before the flush: its old ack never lands', async () => {
    const s = await onBoard('a', { a: [at('k', 's/f')] })
    const frame = await registered('k', 'b-old')
    s.getState().setThemeOn('k', 'dark', () => documentLiveFn!('k', frame.iframe, 'b-old'))
    frame.win.__mvBoot = 'b-new'                         // the new document committed
    await vi.advanceTimersByTimeAsync(120)
    expect(on(s, 'k')).toBeUndefined()
  })
  it('board a -> b -> a before the flush, the same key, frame and navigation back and the old document still there: the ack of the visit left never lands', async () => {
    const s = await onBoard('a', { a: [at('k', 's/f')], b: [at('k', 's/g')] })
    const frame = await registered('k', 'b-old')
    s.getState().setThemeOn('k', 'dark', () => documentLiveFn!('k', frame.iframe, 'b-old'))
    await s.getState().switchBoard('b')
    await s.getState().switchBoard('a')
    expect(s.getState().nodes[0]).toMatchObject({ key: 'k', frame: 's/f' })
    expect(documentLiveFn!('k', frame.iframe, 'b-old')).toBe(true)   // the iframe-side check alone would let it through
    await vi.advanceTimersByTimeAsync(120)
    expect(on(s, 'k')).toBeUndefined()
  })
  it('one board, k\'s frame F -> G -> F before the flush (two reloads through keepDocuments): the ack of F\'s first document never lands', async () => {
    const boards = { a: [at('k', 's/f')] }
    const s = await onBoard('a', boards)
    const frame = await registered('k', 'b-old')
    s.getState().setThemeOn('k', 'dark', () => documentLiveFn!('k', frame.iframe, 'b-old'))
    boards.a = [at('k', 's/g')]; await s.getState().boot()
    boards.a = [at('k', 's/f')]; await s.getState().boot()
    expect(s.getState().nodes[0]).toMatchObject({ key: 'k', frame: 's/f' })
    await vi.advanceTimersByTimeAsync(120)
    expect(on(s, 'k')).toBeUndefined()
  })
  it('a reload of the board that keeps the node\'s document keeps its ack: it lands', async () => {
    const s = await onBoard('a', { a: [at('k', 's/f')] })
    s.setState({ nodes: s.getState().nodes.map((n) => ({ ...n, status: 'ready' as const })) })   // its document is up
    const frame = await registered('k', 'b-old')
    s.getState().setThemeOn('k', 'dark', () => documentLiveFn!('k', frame.iframe, 'b-old'))
    await s.getState().boot()                            // the same board file again: the document is kept
    await vi.advanceTimersByTimeAsync(120)
    expect(on(s, 'k')).toBe('dark')
  })
  it('a board that reuses the key: an ack heard on board a never lands on board b\'s node', async () => {
    const s = await onBoard('a', { a: [at('k', 's/f')], b: [at('k', 's/f')] })
    const frame = await registered('k', 'b-old')
    s.getState().setThemeOn('k', 'dark', () => documentLiveFn!('k', frame.iframe, 'b-old'))
    await s.getState().switchBoard('b')
    await vi.advanceTimersByTimeAsync(120)
    expect(on(s, 'k')).toBeUndefined()
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
