import { describe, expect, it, vi } from 'vitest'

// applyManifest never writes to a node object a published state holds: it copies the nodes it changes. A subscriber
// told mid-apply (an auto board's pruning toast notifies before the final set) reads the state it was given, and a
// memo keyed by the nodes array (FrameNode's scene notes) can trust it: same array, same nodes.

vi.mock('virtual:sh-config', () => ({ default: { viewports: { desktop: { width: 1440, height: 900 } }, themes: ['light', 'dark'], noTheme: false } }))
vi.mock('virtual:sh-data', () => ({ default: null }))
const g = globalThis as Record<string, unknown>
g.addEventListener ??= () => {}
g.removeEventListener ??= () => {}
g.window ??= globalThis
g.document ??= { cookie: '', querySelector: () => null, addEventListener: () => {}, visibilityState: 'visible' }
g.location ??= { origin: 'http://localhost', hash: '', pathname: '/', search: '' }

describe('applyManifest', () => {
  it('an auto board losing the frame that hosted a scene note: mid-apply subscribers see the old nodes intact, the final state the new host', async () => {
    const { useStore } = await import('../src/client/shell/store.ts')
    const { sceneNoteHost } = await import('../src/client/shell/notes.ts')
    const frame = (id: string) => ({ id, file: `${id}.tsx`, kind: 'tsx' as const, scene: 's' })
    const scenes = [{ name: 's', frames: 2, note: 'the scene' }]
    const nodes = [
      { key: 'a', frame: 's/a', x: 0, y: 0, w: 400, h: 300, theme: 'light', status: 'ready' as const },
      { key: 'b', frame: 's/b', x: 500, y: 0, w: 400, h: 300, theme: 'light', status: 'ready' as const },
    ]
    useStore.setState({ manifest: { frames: [frame('s/a'), frame('s/b')], scenes }, nodes, boardAuto: true, viewTheme: 'light' })
    const before = useStore.getState().nodes
    const host = (s: ReturnType<typeof useStore.getState>) => sceneNoteHost(s.nodes, (id) => s.manifest?.frames.find((f) => f.id === id)?.scene, 's')
    const seen: { host: string | null; same: boolean }[] = []
    const off = useStore.subscribe((s) => { seen.push({ host: host(s), same: s.nodes === before }) })
    useStore.getState().applyManifest({ frames: [frame('s/b')], scenes })   // s/a deleted
    off()
    // the toast's notification carries the nodes as they were: a still hosts the note there
    expect(seen[0]).toEqual({ host: 'a', same: true })
    expect(before.map((n) => n.missing)).toEqual([undefined, undefined])
    // the final state: a pruned, b hosts it
    expect(useStore.getState().nodes.map((n) => n.key)).toEqual(['b'])
    expect(seen.at(-1)?.host).toBe('b')
  })

  it('a frame file\'s theme edited while a capture records is no step of it; the person\'s theme change still is one', async () => {
    vi.useFakeTimers()   // the capture's view sampler and the board's autosave never run
    try {
      g.CSS ??= { escape: (x: string) => x }
      g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
      const { useStore } = await import('../src/client/shell/store.ts')
      const { useJamCapture } = await import('../src/client/shell/jam-capture.ts')
      const frame = (theme?: string) => ({ id: 's/a', file: 's/a.tsx', kind: 'tsx' as const, scene: 's', ...(theme ? { theme } : {}) })
      const scenes = [{ name: 's', frames: 1 }]
      useStore.setState({ board: 'home', boardAuto: false, viewTheme: 'light', selection: [], play: null, manifest: { frames: [frame()], scenes },
        nodes: [{ key: 'a', frame: 's/a', x: 0, y: 0, w: 400, h: 300, theme: 'light', status: 'ready' }] })
      useJamCapture.getState().start()
      const id = useJamCapture.getState().current!
      const themes = () => useJamCapture.getState().caps[id].steps.filter((x) => x.event === 'theme')
      useStore.getState().applyManifest({ frames: [frame('dark')], scenes })   // the file now declares meta.theme dark
      expect(useStore.getState().nodes[0].theme).toBe('dark')                  // the node took it...
      expect(themes()).toEqual([])                                            // ...and the capture holds no step for it
      useStore.setState({ selection: ['a'] })
      useStore.getState().setSelectedTheme('light')                            // the shell's control, by the person
      expect(themes()).toMatchObject([{ frame: 's/a', theme: 'light' }])
      useJamCapture.getState().drop()
    } finally { vi.useRealTimers() }
  })
})
