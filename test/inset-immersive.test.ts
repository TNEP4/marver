import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Spec 32 C3, the written amendment to the frozen inset.ts (A3.8 #53), without a browser: `TOP`, `VISIBLE_TOP`,
 * `onScreen()` and `applyInset()` keep their contract and `--mv-top` stays 44; `applyInset()` also sets `--mv-play-top`
 * to `TOP`; `setImmersiveTop(true)` - immersive play granted by main - drops `usable()`'s top and `--mv-play-top` to 0,
 * toggles `:root.mv-immersive` and tells `onTopChange` listeners once per change; `false` brings it all back. Without
 * the inset (Chrome, app 0.1) there is nothing to drop. The shell in a real Chrome is inset-browser.test.ts.
 */

interface Root { props: Map<string, string>; classes: Set<string> }
async function load(app: Record<string, unknown> | null): Promise<{ m: typeof import('../src/client/shell/inset.ts'); root: Root }> {
  vi.resetModules()
  const root: Root = { props: new Map(), classes: new Set() }
  const el = {
    style: { setProperty: (k: string, v: string) => { root.props.set(k, v) } },
    classList: {
      add: (c: string) => { root.classes.add(c) },
      toggle: (c: string, on?: boolean) => { if (on ?? !root.classes.has(c)) root.classes.add(c); else root.classes.delete(c) },
    },
  }
  vi.stubGlobal('document', { documentElement: el })
  vi.stubGlobal('innerWidth', 1280)
  vi.stubGlobal('innerHeight', 800)
  vi.stubGlobal('marverApp', app ?? undefined)
  const m = await import('../src/client/shell/inset.ts')
  return { m, root }
}
const APP = (topInset: number) => ({
  v: 1, topInset, reopen: false, hello() {}, theme() {}, busy() {}, menu() {}, onAppState: () => () => {}, onMenuClick: () => () => {},
  onPresent: () => () => {}, presented() {},
})
afterEach(() => { vi.unstubAllGlobals() })

describe('inset.ts, amended for immersive play (spec 32 C3)', () => {
  it('applyInset sets --mv-play-top beside --mv-top; usable() follows setImmersiveTop, --mv-top never moves', async () => {
    const { m, root } = await load(APP(44))
    expect([m.TOP, m.VISIBLE_TOP]).toEqual([44, 60])
    m.applyInset()
    expect([root.props.get('--mv-top'), root.props.get('--mv-play-top')]).toEqual(['44px', '44px'])
    expect(m.usable()).toEqual({ top: 44, left: 0, width: 1280, height: 756 })
    let told = 0
    const off = m.onTopChange(() => { told += 1 })
    m.setImmersiveTop(true)
    expect(m.usable()).toEqual({ top: 0, left: 0, width: 1280, height: 800 })
    expect([root.props.get('--mv-top'), root.props.get('--mv-play-top'), root.classes.has('mv-immersive'), told]).toEqual(['44px', '0px', true, 1])
    m.setImmersiveTop(true)                       // no change: no one told
    expect(told).toBe(1)
    m.setImmersiveTop(false)
    expect(m.usable().top).toBe(44)
    expect([root.props.get('--mv-top'), root.props.get('--mv-play-top'), root.classes.has('mv-immersive'), told]).toEqual(['44px', '44px', false, 2])
    // the frozen pieces are unchanged by it: onScreen still cuts at VISIBLE_TOP
    expect([m.TOP, m.VISIBLE_TOP]).toEqual([44, 60])
    off()
    m.setImmersiveTop(true)
    expect(told).toBe(2)
  })
  it('without the inset (Chrome, app 0.1, half the contract) there is nothing to drop: usable() stays the whole view, no one is told', async () => {
    for (const app of [null, APP(0), { ...APP(44), onPresent: undefined }]) {
      const { m, root } = await load(app)
      expect(m.TOP).toBe(0)
      let told = 0
      m.onTopChange(() => { told += 1 })
      m.setImmersiveTop(true)
      m.setImmersiveTop(false)
      expect([m.usable().top, told, root.props.size, root.classes.size]).toEqual([0, 0, 0, 0])
    }
  })
})
