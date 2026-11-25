import { describe, expect, it } from 'vitest'
import { wholeElement } from '../src/server/draw/file.ts'
import { agentOps, moveOps, ownerOps, repairRefs } from '../src/server/draw/merge.ts'
import type { DrawElement } from '../src/shared/draw-protocol.ts'

const el = (id: string, fields: Record<string, unknown> = {}) => wholeElement({ id, type: 'rectangle', index: 'a0', seed: 1, versionNonce: 2, ...fields }, 'agent', 100)
const map = (...els: DrawElement[]) => new Map(els.map((e) => [e.id, e]))

describe('ownerOps', () => {
  it('places an owner edit above the current version, preserving a higher incoming version', () => {
    const cur = map(el('a', { version: 7 }), el('b', { version: 2 }))
    const ops = ownerOps(cur, new Map(), [el('a', { x: 50, version: 3 }), el('b', { version: 10, versionNonce: 99 })], [], 200)
    expect(ops.map((o) => o.v)).toEqual([8, 10])
    expect(ops[0].el).toMatchObject({ x: 50, version: 8, customData: { mv: { by: 'owner', at: 200 } } })
    expect(ops[1].el?.versionNonce).toBe(99)
    expect(cur.get('a')?.version).toBe(7)
  })

  it('resurrects on owner undo above the tombstone version', () => {
    const [op] = ownerOps(new Map(), new Map([['a', 9]]), [el('a', { version: 2, isDeleted: true })], [], 200)
    expect(op).toMatchObject({ id: 'a', v: 10, el: { version: 10, isDeleted: false } })
  })

  it('versions deletes above current state and ignores already absent ids', () => {
    const ops = ownerOps(map(el('a', { version: 5 }), el('b')), new Map(), [], [{ id: 'a', version: 2 }, { id: 'b', version: 12 }, { id: 'missing', version: 4 }], 200)
    expect(ops).toEqual([{ id: 'a', el: null, v: 6 }, { id: 'b', el: null, v: 12 }])
  })
})

describe('agentOps', () => {
  it('applies the agent change and bumps from the current version, keeping unrelated person additions', () => {
    const a = el('a', { version: 2 })
    const cur = map({ ...a, version: 5 }, el('person-added'))
    const result = agentOps(map(a), map({ ...a, x: 70 }), cur, new Map(), new Map([['person-added', 3]]), 'agent:cli', 200)
    expect(result.lost).toEqual([])
    expect(result.ops).toHaveLength(1)
    expect(result.ops[0]).toMatchObject({ id: 'a', v: 6, el: { x: 70, customData: { mv: { by: 'agent:cli', at: 200 } } } })
  })

  it('reports person-touched changes and deletes as lost, even if their content returned to the base', () => {
    const a = el('a'), b = el('b')
    const result = agentOps(map(a, b), map({ ...a, x: 70 }), map(a, { ...b, x: 20 }), new Map(), new Map([['a', 4], ['b', 5]]), 'agent', 200)
    expect(result.ops).toEqual([])
    expect(result.lost).toEqual([{ id: 'a', by: 'owner', rev: 4 }, { id: 'b', by: 'owner', rev: 5 }])
  })

  it('deletes only ids removed from the base and keeps person additions', () => {
    const a = el('a', { version: 3 }), b = el('b')
    const result = agentOps(map(a, b), map(b), map(a, b, el('new-owner')), new Map(), new Map([['new-owner', 4]]), 'agent', 200)
    expect(result).toEqual({ ops: [{ id: 'a', el: null, v: 4 }], lost: [] })
  })

  it('does not replay unchanged elements or treat bookkeeping as edits', () => {
    const a = el('a')
    expect(agentOps(map(a), map({ ...a, version: 99, versionNonce: 999, updated: 999, customData: { mv: { by: 'owner', at: 999 } } }), map({ ...a, x: 80 }), new Map(), new Map([['a', 4]]), 'agent', 200)).toEqual({ ops: [], lost: [] })
  })

  it('merges a two-way import without inferring deletions', () => {
    const a = el('a')
    const result = agentOps(null, map({ ...a, x: 30 }), map(a, el('keep')), new Map(), new Map(), 'agent', 200)
    expect(result.ops.map((o) => [o.id, o.el?.x])).toEqual([['a', 30]])
    expect(agentOps(null, new Map(), map(a), new Map(), new Map(), 'agent', 200).ops).toEqual([])
  })

  it.each([null, new Map<string, DrawElement>()])('refuses stale resurrection without a live base (%s)', (base) => {
    expect(agentOps(base, map(el('gone', { version: 100 })), new Map(), new Map([['gone', 5]]), new Map(), 'agent', 200)).toEqual({ ops: [], lost: [] })
  })

  it('refuses resurrection when the person deleted an element after the base', () => {
    const a = el('a')
    expect(agentOps(map(a), map({ ...a, x: 40 }), new Map(), new Map([['a', 5]]), new Map([['a', 8]]), 'agent', 200)).toEqual({ ops: [], lost: [{ id: 'a', by: 'owner', rev: 8 }] })
  })
})

describe('repairRefs', () => {
  it('removes dangling container, frame, arrow and bound-element references', () => {
    const all = map(el('box', { boundElements: [{ id: 'gone', type: 'text' }, { id: 'arrow', type: 'arrow' }] }), el('label', { type: 'text', containerId: 'gone', frameId: 'gone' }), el('arrow', { type: 'arrow', startBinding: { elementId: 'gone' }, endBinding: { elementId: 'box', focus: 0, gap: 4 } }))
    const fixed = repairRefs(all, ['gone'], 200)
    expect(fixed.map((e) => e.id).sort()).toEqual(['arrow', 'box', 'label'])
    expect(all.get('box')?.boundElements).toEqual([{ id: 'arrow', type: 'arrow' }])
    expect(all.get('label')).toMatchObject({ containerId: null, frameId: null, updated: 200 })
    expect(all.get('arrow')).toMatchObject({ startBinding: null, endBinding: { elementId: 'box', focus: 0, gap: 4 } })
    expect(fixed.every((e) => e.version > 1)).toBe(true)
    expect(repairRefs(all, ['gone'], 300)).toEqual([])
  })

  it('adds a bound label to its container without duplicating it', () => {
    const all = map(el('box'), el('label', { type: 'text', containerId: 'box' }))
    expect(repairRefs(all, ['label'], 200).map((e) => e.id)).toEqual(['box'])
    expect(all.get('box')?.boundElements).toEqual([{ id: 'label', type: 'text' }])
    expect(repairRefs(all, ['label'], 300)).toEqual([])
  })

  // BUG src/server/draw/merge.ts:89: repairRefs only discovers containerId text, never startBinding/endBinding arrows.
  it('adds bound arrows to their endpoint containers', () => {
    const all = map(el('box'), el('arrow', { type: 'arrow', startBinding: { elementId: 'box', focus: 0, gap: 4 } }))
    repairRefs(all, ['arrow'], 200)
    expect(all.get('box')?.boundElements).toEqual([{ id: 'arrow', type: 'arrow' }])
  })
})

describe('moveOps', () => {
  const drawing = () => map(
    el('a', { x: 10, y: 20 }), el('b', { x: 300, y: 20 }),
    el('label', { type: 'text', x: 30, y: 40, containerId: 'a' }),
    el('arrow', { type: 'arrow', x: 170, y: 60, width: 130, height: 10, points: [[0, 0], [65, 10], [130, 0]], startBinding: { elementId: 'a', focus: 0, gap: 4 }, endBinding: { elementId: 'b', focus: 0, gap: 4 } }),
  )

  it('moves the container and bound text once, carrying only the arrow start', () => {
    const all = drawing()
    const ops = moveOps(all, ['a', 'label', 'a'], 20, 30, 'agent', 200)
    expect(ops.map((o) => o.id)).toEqual(['a', 'label', 'arrow'])
    expect(ops[0].el).toMatchObject({ x: 30, y: 50, version: 2, customData: { mv: { by: 'agent', at: 200 } } })
    expect(ops[1].el).toMatchObject({ x: 50, y: 70 })
    expect(ops[2].el).toMatchObject({ x: 190, y: 90, points: [[0, 0], [45, -20], [110, -30]] })
    expect(all.get('a')?.x).toBe(10)
  })

  it('carries only the arrow end when the destination moves', () => {
    const ops = moveOps(drawing(), ['b'], 20, 30, 'agent', 200)
    expect(ops.find((o) => o.id === 'arrow')?.el).toMatchObject({ x: 170, y: 60, points: [[0, 0], [65, 10], [150, 30]] })
  })

  it('translates the whole arrow when both containers move or the arrow is selected explicitly', () => {
    for (const ids of [['a', 'b'], ['a', 'b', 'arrow']]) {
      const arrows = moveOps(drawing(), ids, 20, 30, 'agent', 200).filter((o) => o.id === 'arrow')
      expect(arrows).toHaveLength(1)
      expect(arrows[0].el).toMatchObject({ x: 190, y: 90, points: [[0, 0], [65, 10], [130, 0]] })
    }
  })

  // BUG src/server/draw/merge.ts:121: endpoint points change but width/height remain 130/10 instead of 150/30.
  it('updates the arrow bounding box when one bound endpoint moves', () => {
    const arrow = moveOps(drawing(), ['b'], 20, 30, 'agent', 200).find((o) => o.id === 'arrow')!.el!
    expect({ width: arrow.width, height: arrow.height }).toEqual({ width: 150, height: 30 })
  })
})
