import { describe, expect, it } from 'vitest'
import { publishedAsks, publishedIndex, indexKey } from '../src/server/publish-bakes.ts'
import { ASK_MAX } from '../src/server/bake.ts'

// What the build asks the compiler for: every published node the way the shell sizes it, every
// theme, within the compiler's limits; and what the index admits.

const VP = { mobile: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } }
const frames = [
  { id: 'a', kind: 'tsx' as const, file: 'a.tsx', viewport: 'desktop' },
  { id: 'doc', kind: 'tsx' as const, file: 'doc.tsx', contentWidth: 800 },
  { id: 'docvp', kind: 'tsx' as const, file: 'docvp.tsx', contentWidth: 800, viewport: 'desktop' },
  { id: 'h', kind: 'html' as const, file: 'h.html' },
]

describe('publishedAsks', () => {
  it('a node\'s own size, else the frame\'s default per dimension; every theme; one ask per size', () => {
    const asks = publishedAsks({ b: { nodes: [{ frame: 'a', w: 1000, h: 700 }, { frame: 'a', w: 1000, h: 700 }, { frame: 'a', w: 640 }, { frame: 'h' }] } }, ['light', 'dark'], frames, VP)
    expect(asks.map(indexKey).sort()).toEqual(['a|dark|1000|700', 'a|dark|640|800', 'a|light|1000|700', 'a|light|640|800', 'h|dark|390|844', 'h|light|390|844'])
  })
  it('a content-sized frame rests live unless its measured height is stored (viewport or not)', () => {
    const asks = publishedAsks({ b: { nodes: [{ frame: 'doc' }, { frame: 'docvp', w: 800 }, { frame: 'doc', w: 800, h: 1234 }] } }, ['light'], frames, VP)
    expect(asks.map(indexKey)).toEqual(['doc|light|800|1234'])
  })
  it('rounds first, then holds to the compiler\'s limits; unknown frames and tiny nodes are skipped', () => {
    const asks = publishedAsks({ b: { nodes: [{ frame: 'a', w: ASK_MAX.side + 0.4, h: 100.6 }, { frame: 'a', w: ASK_MAX.side + 0.6, h: 100 }, { frame: 'nope', w: 500, h: 500 }, { frame: 'a', w: 100, h: 100 }] } }, ['light'], frames, VP)
    expect(asks.map(indexKey)).toEqual([`a|light|${ASK_MAX.side}|101`])
  })
  it('a slide rests at its stage whatever its node\'s size - the node only scales the document', () => {
    const slides = [{ id: 's', kind: 'tsx' as const, file: 's.tsx', slide: true }, { id: 'sl', kind: 'tsx' as const, file: 'sl.tsx', slide: true, viewport: 'desktop' }]
    const asks = publishedAsks({ b: { nodes: [{ frame: 's', w: 640, h: 360 }, { frame: 's' }, { frame: 'sl', w: 900, h: 300 }] } }, ['light'], slides, VP)
    expect(asks.map(indexKey).sort()).toEqual(['sl|light|1280|800', 's|light|1280|720'])
  })
  it('a published all-scenes board asks for every frame at its default size', () => {
    const asks = publishedAsks({}, ['light'], frames, VP, true)
    expect(asks.map(indexKey).sort()).toEqual(['a|light|1280|800', 'h|light|390|844'])
  })
})

describe('publishedIndex', () => {
  it('admits only answers with a certified texture, and only those targets', () => {
    const t = (verified: boolean) => ({ sel: 'x', rect: { x: 0, y: 0, w: 1, h: 1 }, filter: 'blur(1px)', level: 0, texture: verified ? '/__mv/bakes/7/k/0.png' : '', verified, maxErr: 0, bad: 0 })
    const index = publishedIndex(7, [
      { frame: 'a', theme: 'light', w: 1, h: 1, ok: true, targets: [t(true), t(false)], levels: 1, rejected: 1, ms: 1 },
      { frame: 'b', theme: 'light', w: 1, h: 1, ok: true, targets: [t(false)], levels: 1, rejected: 1, ms: 1 },
      { frame: 'c', theme: 'light', w: 1, h: 1, ok: false, error: 'no' },
    ])
    expect(Object.keys(index.answers)).toEqual(['a|light|1|1'])
    expect(index.answers['a|light|1|1'].targets).toHaveLength(1)
    expect(index.gen).toBe(7)
  })
})
