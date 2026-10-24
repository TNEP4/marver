/**
 * S15's variant 3 as built (spec 28 A3.8 #3; S15, 24 Oct), without Electron: the cover's picture (captureApp's
 * layer, A3.8 #14), the layout's gate on the cover's readiness (every canvas below the strip while it does not cover),
 * and the GPU process lost reaching the cover (present.ts `onGpuLost`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { coverBitmap, DOT } from '../../src/main/cover.ts'
import { commitLayout, coverCovers, docInset, placed, rectFor, seeThrough, setCoverReady, setGround } from '../../src/main/layout.ts'
import { gpuGone, noteGpu, onGpuLost, resetPresent } from '../../src/main/present.ts'
import { GROUND } from '../../src/main/plan.ts'
import { blankTab, type Tab } from '../../src/main/tabs.ts'

const rgb = (hex: string) => [parseInt(hex.slice(5, 7), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(1, 3), 16), 255]   // BGRA
const px = (b: Buffer, w: number, x: number, y: number) => [...b.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)]

describe('the cover\'s picture (coverBitmap)', () => {
  it('the ground of the look, with a dot at the centre of every 20 pt tile from the window\'s origin, as the page\'s CSS draws it', () => {
    const w = 80, h = 88   // 40 x 44 pt at 2 px per pt
    const b = coverBitmap(w, h, 2, false, true)
    expect(b.length).toBe(w * h * 4)
    expect(px(b, w, 0, 0)).toEqual(rgb(GROUND.light))
    expect(px(b, w, 20, 20)).toEqual(rgb(DOT.light))     // (10, 10) pt
    expect(px(b, w, 60, 20)).toEqual(rgb(DOT.light))     // (30, 10) pt
    expect(px(b, w, 60, 60)).toEqual(rgb(DOT.light))     // (30, 30) pt
    expect(px(b, w, 40, 20)).toEqual(rgb(GROUND.light))  // (20, 10) pt: between two dots
    const d = coverBitmap(w, h, 2, true, true)
    expect(px(d, w, 0, 0)).toEqual(rgb(GROUND.dark))
    expect(px(d, w, 20, 20)).toEqual(rgb(DOT.dark))
  })

  it('no dots while the cover does not cover (its renderer has not made a frame): the ground alone', () => {
    const b = coverBitmap(80, 88, 2, false, false)
    for (let i = 0; i < b.length; i += 4) expect([...b.subarray(i, i + 4)]).toEqual(rgb(GROUND.light))
  })

  it('a flash\'s 480 px picture of a wide window still shows each dot as a pixel', () => {
    const sf = 480 / 1280
    const w = 480, h = Math.round(44 * sf)
    const b = coverBitmap(w, h, sf, false, true)
    let dots = 0
    for (let i = 0; i < b.length; i += 4) if (b[i] === rgb(DOT.light)[0] && b[i + 2] === rgb(DOT.light)[2]) dots++
    expect(dots).toBeGreaterThanOrEqual(64)   // 64 tiles across, two rows partly in 16 px
  })
})

describe('the layout while the cover does not cover (layout.ts setCoverReady)', () => {
  afterEach(() => { setCoverReady(true); setGround(false) })
  const canvas = (): Tab => blankTab('t1', 'local', 'Canvas', {
    reg: { state: 'ready', file: '/f', instance: 'i1', ws: 'ws', origin: 'http://[::1]:5301', port: 5301, slot: 1, features: ['bridge', 'inset'] },
  })

  it('a document committed full is placed below and never seen through until the cover covers; its inset is still 44', () => {
    setGround(true)
    const t = canvas()
    commitLayout(t, { kind: 'start', gen: 1 })
    commitLayout(t, { kind: 'commit', gen: 1, attributed: true, instance: 'i1' })
    commitLayout(t, { kind: 'hello', inset: 44 })
    t.doc = { gen: 1, url: 'u', trusted: true, doc: 'd1', commits: 1, shown: true, lifted: true }
    expect(t.geo.layout).toBe('full')
    setCoverReady(false)
    expect(coverCovers()).toBe(false)
    expect(placed(t)).toBe('below')
    expect(rectFor(t, 1000, 700)).toEqual({ x: 0, y: 44, width: 1000, height: 656 })
    expect(seeThrough(t)).toBe(false)
    // the next document is still told 44: the gate is the cover's to open, the document's inset its own
    commitLayout(t, { kind: 'start', gen: 2 })
    expect(docInset(t)).toBe(44)
    setCoverReady(true)
    commitLayout(t, { kind: 'commit', gen: 2, attributed: true, instance: 'i1' })
    commitLayout(t, { kind: 'hello', inset: 44 })
    expect(placed(t)).toBe('full')
    expect(rectFor(t, 1000, 700)).toEqual({ x: 0, y: 0, width: 1000, height: 700 })
    expect(seeThrough(t)).toBe(true)
  })

  it('Home and Settings stay at the full height whatever the cover says (they paint their own ground, A3.8 #32)', () => {
    setCoverReady(false)
    expect(rectFor(blankTab('home', 'home', 'Home'), 1000, 700)).toEqual({ x: 0, y: 0, width: 1000, height: 700 })
  })
})

describe('the GPU process lost reaches the cover (present.ts onGpuLost)', () => {
  afterEach(() => resetPresent())

  it('gone, or replaced with no event, tells every listener once; an unchanged identity tells none', () => {
    const heard: number[] = []
    const off = onGpuLost(() => heard.push(heard.length))
    noteGpu({ pid: 10, born: 1 })        // the first read is a baseline
    expect(heard).toHaveLength(0)
    noteGpu({ pid: 10, born: 1 })
    expect(heard).toHaveLength(0)
    noteGpu({ pid: 11, born: 2 })        // replaced
    expect(heard).toHaveLength(1)
    gpuGone()                            // child-process-gone, type GPU
    expect(heard).toHaveLength(2)
    noteGpu({ pid: 12, born: 3 })        // the replacement after a gone is the fresh baseline, not a second loss
    expect(heard).toHaveLength(2)
    off()
    gpuGone()
    expect(heard).toHaveLength(2)
  })
})
