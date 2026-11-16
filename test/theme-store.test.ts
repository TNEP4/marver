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
  it('an ack from a document replaced before the flush (a reload of the same board) never lands on the one there now', async () => {
    const s = await store('a', ['k'])
    let doc = 'd1'
    s.getState().setThemeOn('k', 'light', () => doc === 'd1')   // heard from d1
    doc = 'd2'                                                   // k's frame reloads: d2 is there now
    s.setState({ nodes: [node('k')] })
    await vi.advanceTimersByTimeAsync(120)
    expect(on(s, 'k')).toBeUndefined()
    s.getState().setThemeOn('k', 'dark', () => doc === 'd2')    // d2's own
    await vi.advanceTimersByTimeAsync(17)
    expect(on(s, 'k')).toBe('dark')
  })
  it('board a -> b -> a before the flush: the ack of a\'s first document is dropped, though the board name matches again', async () => {
    const s = await store('a', ['k'])
    let doc = 'a1'
    s.getState().setThemeOn('k', 'light', () => doc === 'a1')
    s.setState({ board: 'b', nodes: [node('k')] }); doc = 'b1'
    s.setState({ board: 'a', nodes: [node('k')] }); doc = 'a2'
    await vi.advanceTimersByTimeAsync(120)
    expect(on(s, 'k')).toBeUndefined()
  })
  it('the real guard: an ack queued before a same-board reload replaced the node\'s frame never lands on the replacement - though the iframe element and its old document are still there', async () => {
    const s = await store('a', ['k'])
    const { keepDocuments } = await import('../src/client/shell/store.ts')
    const { documentLive, registerFrame } = await import('../src/client/shell/canvas/frame-registry.ts')
    const win = { __mvBoot: 'b-old' }
    const iframe = { contentWindow: win } as unknown as HTMLIFrameElement
    registerFrame(win as unknown as WindowProxy, { key: 'k', iframe })
    s.getState().setThemeOn('k', 'dark', () => documentLive('k', iframe, 'b-old'))   // App's own closure
    // the board file changed: k now shows another frame - keepDocuments discards the old document's state; the iframe
    // element stays (FrameNode is keyed by k) and still holds the old document until the new one commits
    const mounted = s.getState().nodes
    s.setState({ nodes: keepDocuments(mounted, [{ ...node('k'), frame: 's/new', theme: 'light' }]).nodes })
    expect(documentLive('k', iframe, 'b-old')).toBe(true)   // the committed-document check alone would let it through
    await vi.advanceTimersByTimeAsync(120)
    expect(s.getState().nodes[0].frame).toBe('s/new')
    expect(s.getState().nodes[0].themeOn).toBeUndefined()   // dark never landed on the replacement
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
  it('an ack heard on board a never lands on board b\'s node of the same key', async () => {
    const s = await store('a', ['k'])
    s.getState().setThemeOn('k', 'light')
    s.setState({ board: 'b', nodes: [node('k')] })   // the switch commits before the flush; b reuses the key
    await vi.advanceTimersByTimeAsync(120)
    expect(on(s, 'k')).toBeUndefined()
    s.getState().setThemeOn('k', 'dark')             // b's own document's ack
    await vi.advanceTimersByTimeAsync(17)
    expect(on(s, 'k')).toBe('dark')
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
