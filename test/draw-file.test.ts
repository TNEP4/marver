import { describe, expect, it } from 'vitest'
import { assignIndexes, emptyDoc, ordered, parseDrawFile, serializeDrawFile, wholeElement } from '../src/server/draw/file.ts'
import type { DrawElement } from '../src/shared/draw-protocol.ts'

const element = (id: string, fields: Record<string, unknown> = {}) => wholeElement({ id, type: 'rectangle', seed: 7, versionNonce: 8, ...fields }, 'agent', 1000)
const map = (...els: DrawElement[]) => new Map(els.map((e) => [e.id, e]))

describe('drawing files', () => {
  it('round trips byte-stably with fixed key order and only the saved app state', () => {
    const doc = emptyDoc({ rev: 12, epoch: 'history-1', title: 'Checkout', size: { w: 960, h: 640 }, view: { x: 12.34, y: -5.67, zoom: 1.23456 } })
    doc.elements = map(element('cart', { index: 'a0', customData: { note: 'keep' } }))
    doc.files = { image: { dataURL: 'data:image/png;base64,AA==' } }
    const text = serializeDrawFile(doc)
    expect(serializeDrawFile(parseDrawFile(text))).toBe(text)
    expect(text.startsWith('{\n  "type": "excalidraw",\n  "version": 2,\n  "source": "marver",\n')).toBe(true)
    expect(text.endsWith('\n')).toBe(true)
    const raw = JSON.parse(text)
    expect(Object.keys(raw.elements[0]).slice(0, 6)).toEqual(['id', 'type', 'x', 'y', 'width', 'height'])
    expect(raw.appState).toEqual({ viewBackgroundColor: '#ffffff', gridSize: null })
    expect(raw.marver.view).toEqual({ x: 12.3, y: -5.7, zoom: 1.235 })
    expect(raw.files).toEqual(doc.files)
  })

  it('orders by fractional index, then id, independent of map insertion order', () => {
    const els = [element('last', { index: 'a2' }), element('z', { index: 'a0' }), element('first'), element('a', { index: 'a0' })]
    expect(ordered(els).map((e) => e.id)).toEqual(['first', 'a', 'z', 'last'])
    const doc = emptyDoc()
    doc.elements = map(...els)
    const text = serializeDrawFile(doc)
    doc.elements = map(...els.reverse())
    expect(serializeDrawFile(doc)).toBe(text)
  })

  it('rounds freedraw points to tenths without mutating the original or line points', () => {
    const points = [[1.234, -2.678], [4.999, 0.04]]
    const doc = emptyDoc()
    doc.elements = map(element('pen', { type: 'freedraw', points }), element('line', { type: 'line', points }))
    const parsed = parseDrawFile(serializeDrawFile(doc))
    expect(parsed.elements.get('pen')?.points).toEqual([[1.2, -2.7], [5, 0]])
    expect(parsed.elements.get('line')?.points).toEqual(points)
    expect(doc.elements.get('pen')?.points).toEqual(points)
    expect(serializeDrawFile(parsed)).toBe(serializeDrawFile(doc))
  })

  it('imports a foreign scene at rev zero and ignores deleted or malformed elements', () => {
    const doc = parseDrawFile(JSON.stringify({ type: 'excalidraw', elements: [element('live'), { ...element('gone'), isDeleted: true }, null, { id: 'no-type' }], appState: { zoom: 2, viewBackgroundColor: '#abc', gridSize: 20 } }))
    expect(doc.foreign).toBe(true)
    expect(doc.header).toEqual({ rev: 0, size: { w: 960, h: 640 } })
    expect([...doc.elements.keys()]).toEqual(['live'])
    expect(JSON.parse(serializeDrawFile(doc)).appState).toEqual({ viewBackgroundColor: '#abc', gridSize: null })
  })

  it.each(['not json', '{"type":"other","elements":[]}', '{"elements":{}}', 'null'])('rejects invalid scene %s', (text) => {
    expect(() => parseDrawFile(text)).toThrow()
  })

  it('fills shape defaults and preserves explicit fields and custom data', () => {
    const e = wholeElement({ id: 'box-cart', x: '12', y: 'bad', version: 7, versionNonce: 4, seed: 3, strokeWidth: 5, roundness: null, customData: { tag: 'cart' } }, 'agent:cli', 42)
    expect(e).toMatchObject({ id: 'box-cart', type: 'rectangle', x: 12, y: 0, width: 160, height: 80, version: 7, versionNonce: 4, seed: 3, strokeWidth: 5, roundness: null, isDeleted: false, updated: 42, customData: { tag: 'cart', mv: { by: 'agent:cli', at: 42 } } })
    expect(element('round').roundness).toEqual({ type: 3 })
    const generated = wholeElement({}, 'agent', 42)
    expect(generated.id).toMatch(/^mv-/)
    expect(Number.isInteger(generated.seed)).toBe(true)
    expect(generated.version).toBe(1)
  })

  it('fills text, arrow, line and freedraw defaults', () => {
    expect(element('label', { type: 'text', text: 'Cart' })).toMatchObject({ width: 50, height: 25, text: 'Cart', originalText: 'Cart', fontSize: 20, fontFamily: 5, lineHeight: 1.25, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true })
    expect(element('arrow', { type: 'arrow', width: 200, height: 0 })).toMatchObject({ points: [[0, 0], [200, 0]], startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: 'arrow', elbowed: false, roundness: { type: 2 } })
    expect(element('line', { type: 'line' })).toMatchObject({ points: [[0, 0], [160, 80]], lastCommittedPoint: null })
    expect(element('pen', { type: 'freedraw' })).toMatchObject({ points: [], pressures: [], simulatePressure: true, lastCommittedPoint: null })
  })

  it("sizes an agent's text from its words when it gives no box - a long, large label is never cut to a default (seen in the Mac app)", () => {
    const t = element('ask', { type: 'text', text: 'agent: is login needed?', fontSize: 28 })
    expect(t.width).toBeGreaterThanOrEqual(23 * 28 * 0.55)          // wider than the words at the hand-drawn font's width
    expect(t.height).toBe(Math.ceil(28 * 1.25))
    const two = element('two', { type: 'text', text: 'one line\nand a longer second line', fontSize: 20 })
    expect(two.height).toBe(Math.ceil(2 * 20 * 1.25))
    expect(two.width).toBeGreaterThanOrEqual(24 * 20 * 0.55)        // the longest line
    expect(element('given', { type: 'text', text: 'Cart', width: 300, height: 40 })).toMatchObject({ width: 300, height: 40 })   // an explicit box kept
  })

  it('assigns missing, invalid and colliding indexes after the current maximum', () => {
    const all = map(element('a', { index: 'a0' }), element('b', { index: 'a1' }))
    const fresh = [element('c'), element('d', { index: 'a0' }), element('e', { index: '!' })]
    assignIndexes(all, fresh)
    expect(fresh.map((e) => e.index)).toEqual(['a2', 'a3', 'a4'])
    expect([...all.values()].map((e) => e.index)).toEqual(['a0', 'a1'])
    for (const e of fresh) all.set(e.id, e)
    assignIndexes(all, fresh)
    expect(fresh.map((e) => e.index)).toEqual(['a2', 'a3', 'a4'])
  })

  it('keeps an existing valid index when updating the same element', () => {
    const e = element('a', { index: 'a0' })
    assignIndexes(map(e), [e])
    expect(e.index).toBe('a0')
  })

  // BUG src/server/draw/file.ts:159: keeping a fresh a0 does not advance `last`; the next element also gets a0.
  it('does not give two fresh elements the same index', () => {
    const fresh = [element('a', { index: 'a0' }), element('b')]
    assignIndexes(new Map(), fresh)
    expect(fresh.map((e) => e.index)).toEqual(['a0', 'a1'])
  })
})
