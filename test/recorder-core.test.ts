import { describe, expect, it } from 'vitest'
import { adopt, bound, bytesOf, fitWithin, gestureStats, KEEPALIVE_BYTES, newId, Outbox, outcomeOf, stackLines, type PerfRecord, type Track } from '../src/client/shell/recorder-core.ts'

/** The recorder's pure parts (spec 28 A1.7): the bounded outbox, UTF-8 sizes, the last keepalive send, a gesture's
 *  numbers, and a node's outcome from what its live document said. The page's half is page-recorder-browser.test.ts. */

let seq = 0
const rec = (kind: PerfRecord['kind'], body: Record<string, unknown> = {}): PerfRecord => ({ v: 1, ws: '0123456789abcdef', page: 'aaaaaaaaaaaa', load: 'bbbbbbbbbbbb', seq: seq++, ts: 1, kind, ...body })

describe('the outbox', () => {
  it('past its count the oldest go, counted', () => {
    const o = new Outbox()
    const first = rec('quiet', { ms: 1 })
    o.push(first)
    for (let i = 0; i < 2_000; i++) o.push(rec('quiet', { ms: i }))
    expect(o.size).toBe(2_000)
    expect(o.dropped).toBe(1)
    expect(o.has(first)).toBe(false)
  })

  it('past its bytes too - counted in UTF-8, not in characters', () => {
    const o = new Outbox(100, 4_000)
    const wide = rec('error', { source: 'shell', message: 'é'.repeat(900) })   // 900 characters, 1,800 bytes
    expect(bytesOf(wide)).toBeGreaterThan(1_800)
    o.push(wide); o.push(rec('error', { source: 'shell', message: 'é'.repeat(900) }))
    expect(o.dropped).toBe(0)
    o.push(rec('error', { source: 'shell', message: 'é'.repeat(900) }))
    expect(o.dropped).toBe(1)
    expect(o.bytes).toBeLessThanOrEqual(4_000)
  })

  it('a dropped record that goes past the bound takes what it counted with it', () => {
    const o = new Outbox(2)
    o.push(rec('dropped', { n: 7, reason: 'errors' }))
    o.push(rec('quiet', { ms: 1 }))
    o.push(rec('quiet', { ms: 2 }))
    expect(o.dropped).toBe(7)
    o.push(rec('quiet', { ms: 3 }))
    expect(o.dropped).toBe(8)
  })

  it('takeAll empties it; a record changed in place is sized again', () => {
    const o = new Outbox(100, 1_000)
    const m = rec('move', { node: 'k', dx: 1 })
    o.push(m)
    const before = o.bytes
    m.dx = 123456
    o.touch(m)
    expect(o.bytes).toBe(before + 5)
    expect(o.has(m)).toBe(true)
    expect(o.takeAll()).toEqual([m])
    expect([o.size, o.bytes, o.has(m)]).toEqual([0, 0, false])
  })
})

describe('the last send of a page that is going', () => {
  it('the cut first, then the oldest, the whole body within 16 KB with room for a dropped record', () => {
    const cut = rec('cut', { reason: 'hidden', ms: 4000 })
    const rest = Array.from({ length: 300 }, (_, i) => rec('move', { node: `k-${i}`, dx: i, dy: 0, dw: 0, dh: 0, cause: 'reflow:measured' }))
    const { fit, lost } = fitWithin([cut], rest)
    expect(fit[0]).toBe(cut)
    expect(fit[1]).toBe(rest[0])
    expect(bytesOf({ records: fit }) + 160).toBeLessThanOrEqual(KEEPALIVE_BYTES)
    expect(lost).toBe(rest.length - (fit.length - 1))
    expect(lost).toBeGreaterThan(0)
  })

  it('nothing fits but the cut: the cut alone', () => {
    const cut = rec('cut', { reason: 'hidden', ms: 4000 })
    const big = rec('error', { source: 'shell', message: 'x'.repeat(20_000) })
    expect(fitWithin([cut], [big])).toEqual({ fit: [cut], lost: 1 })
  })
})

describe('a gesture', () => {
  it('a steady 33 ms cadence: p50 33, every interval over 17 ms, none over 33', () => {
    expect(gestureStats(Array(30).fill(33), 0)).toEqual({ frames: 30, p50: 33, p95: 33, max: 33, over17ms: 30, over33ms: 0, longFrames: 0 })
  })
  it('one slow frame among smooth ones', () => {
    const s = gestureStats([...Array(20).fill(16.7), 50], 2)
    expect(s).toMatchObject({ frames: 21, p50: 16.7, max: 50, over17ms: 1, over33ms: 1, longFrames: 2 })
  })
  it('none at all', () => {
    expect(gestureStats([], 0)).toEqual({ frames: 0, p50: 0, p95: 0, max: 0, over17ms: 0, over33ms: 0, longFrames: 0 })
  })
})

describe('a node\'s outcome, from its live document', () => {
  const node = { w: 760, nav: 0 }
  it('a message from a document that is not the live one is never adopted', () => {
    const t: Track = { frame: 'a/b' }
    expect(adopt(t, 'old-doc', 'new-doc')).toBe(false)
    expect(adopt(t, undefined, 'new-doc')).toBe(false)
    expect(adopt(t, 'new-doc', undefined)).toBe(false)   // nothing booted there yet
    expect(t.boot).toBeUndefined()
  })
  it('a new live document starts the story over', () => {
    const t: Track = { frame: 'a/b' }
    expect(adopt(t, 'd1', 'd1')).toBe(true)
    t.readyAt = 5; t.settled = { at: 6, w: 760 }; t.errorAt = 7; t.firstMeasureAt = 4; t.admittedAt = 1
    expect(adopt(t, 'd2', 'd2')).toBe(true)
    expect(t).toEqual({ frame: 'a/b', boot: 'd2', admittedAt: 1 })
  })
  it('ready counts while its document is live; a replaced or still-booting document sends it back to pending', () => {
    const t: Track = { frame: 'a/b', boot: 'd1', readyAt: 5 }
    expect(outcomeOf('ready', t, 'd1', node)).toBe('ready')
    expect(outcomeOf('ready', t, 'd2', node)).toBeNull()
    expect(outcomeOf('ready', t, undefined, node)).toBeNull()
    expect(outcomeOf('ready', undefined, 'd1', node)).toBeNull()
  })
  it('a measuring node is settled only at its width now', () => {
    const t: Track = { frame: 'a/b', boot: 'd1', readyAt: 5, settled: { at: 9, w: 760 } }
    expect(outcomeOf('measure', t, 'd1', node)).toBe('settled')
    expect(outcomeOf('measure', t, 'd1', { w: 1280 })).toBeNull()
    expect(outcomeOf('measure', { ...t, settled: undefined }, 'd1', node)).toBeNull()   // ready is not enough
  })
  it('an error from the live document is an outcome', () => {
    expect(outcomeOf('measure', { frame: 'a/b', boot: 'd1', errorAt: 3 }, 'd1', node)).toBe('error')
    expect(outcomeOf('measure', { frame: 'a/b', boot: 'd1', errorAt: 3 }, 'd2', node)).toBeNull()
  })
  it('a reload the shell asked for sends the node back to pending while the document it replaces is still there', () => {
    const t: Track = { frame: 'a/b' }
    expect(adopt(t, 'd1', 'd1', { gen: '3', nav: 0 })).toBe(true)
    t.readyAt = 5
    expect(t).toMatchObject({ boot: 'd1', gen: '3', nav: 0 })
    expect(outcomeOf('ready', t, 'd1', { w: 760, nav: 0, gen: '3' })).toBe('ready')
    // reloadFrame: the node's nav moved on before its iframe got the new URL - d1 is still the live document
    expect(outcomeOf('ready', t, 'd1', { w: 760, nav: 1, gen: '3' })).toBeNull()
    expect(outcomeOf('ready', t, 'd1', { w: 760, nav: 1, gen: '4' })).toBeNull()
    // a file swap: a new URL with no new nav
    expect(outcomeOf('ready', t, 'd1', { w: 760, nav: 0, gen: '4' })).toBeNull()
    // a late message from d1 after the reload began is still d1's: it does not move d1 onto the new navigation
    expect(adopt(t, 'd1', 'd1', { gen: '3', nav: 1 })).toBe(true)
    expect(outcomeOf('ready', t, 'd1', { w: 760, nav: 1, gen: '4' })).toBeNull()
    expect(outcomeOf('measure', { ...t, settled: { at: 6, w: 760 } }, 'd1', { w: 760, nav: 1, gen: '4' })).toBeNull()
    expect(outcomeOf('ready', { ...t, errorAt: 7 }, 'd1', { w: 760, nav: 1, gen: '4' })).toBeNull()
    // the new document: its own story, on the new navigation
    expect(adopt(t, 'd2', 'd2', { gen: '4', nav: 1 })).toBe(true)
    expect(outcomeOf('ready', t, 'd2', { w: 760, nav: 1, gen: '4' })).toBeNull()
    t.readyAt = 9
    expect(outcomeOf('ready', t, 'd2', { w: 760, nav: 1, gen: '4' })).toBe('ready')
  })
  it('missing whatever the documents; never-ready holds for its navigation, and a live message replaces it', () => {
    expect(outcomeOf('missing', undefined, undefined, node)).toBe('missing')
    const t: Track = { frame: 'a/b', neverReady: { at: 20_000, nav: 0 } }
    expect(outcomeOf('ready', t, undefined, node)).toBe('never-ready')
    expect(outcomeOf('ready', t, 'd9', node)).toBe('never-ready')
    expect(outcomeOf('ready', t, undefined, { w: 760, nav: 1 })).toBeNull()   // a new navigation
    expect(adopt(t, 'd9', 'd9')).toBe(true)
    t.readyAt = 21_000
    expect(outcomeOf('ready', t, 'd9', node)).toBe('ready')
    expect(t.neverReady).toBeUndefined()
  })
})

describe('the small parts', () => {
  it('three stack lines, Chrome\'s and Safari\'s, 200 characters each', () => {
    const chrome = `TypeError: Cannot read properties of undefined (reading 'x')\n    at Boom (http://localhost/design/scenes/kit/boom.tsx:3:9)\n    at renderWithHooks (react.js:1:1)\n    at mountIndeterminateComponent (react.js:2:2)\n    at beginWork (react.js:3:3)`
    expect(stackLines(chrome)).toEqual(['at Boom (http://localhost/design/scenes/kit/boom.tsx:3:9)', 'at renderWithHooks (react.js:1:1)', 'at mountIndeterminateComponent (react.js:2:2)'])
    const safari = `Boom@http://localhost/design/scenes/kit/boom.tsx:3:9\nrenderWithHooks@http://localhost/react.js:1:1\n@http://localhost/x.js:2:2\nlast@http://localhost/y.js:9:9`
    expect(stackLines(safari)).toEqual(['Boom@http://localhost/design/scenes/kit/boom.tsx:3:9', 'renderWithHooks@http://localhost/react.js:1:1', '@http://localhost/x.js:2:2'])
    expect(stackLines(`Error: x\n    at ${'y'.repeat(500)}`)![0].length).toBe(200)
    expect(stackLines('no frames here')).toBeUndefined()
    expect(stackLines(undefined)).toBeUndefined()
  })
  it('bounded strings and ids', () => {
    expect(bound('x'.repeat(300))!.length).toBe(200)
    expect(bound('')).toBeUndefined()
    expect(bound(5)).toBeUndefined()
    expect(newId()).toMatch(/^[0-9a-f]{12}$/)
    expect(newId()).not.toBe(newId())
  })
})
