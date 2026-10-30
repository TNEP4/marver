/**
 * Live pictures, main's half (spec 28 A4.6 #35, r1 #5; app/src/main/live-picture.ts), through fake ports and a fake
 * view: `hidden` unless the person sees the tab; `busy` while one readback is out; `timeout` that keeps the slot until
 * the readback settles; after the readback everything again - a `gen` change, trust revoked, the window minimised, a
 * tab page raised, another document, another tab, the bridge's admission gone - each `stale`; `empty`; the 4096 px
 * cap; the rect times the page's zoom, rounded out; the bytes a `Uint8Array` of the PNG.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CaptureRect } from '../../../src/shared/app-api.ts'
import { livePictures, type PictureImage, type PictureLook } from '../../src/main/live-picture.ts'

vi.mock('electron', () => ({ app: {} }))

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const image = (w = 300, h = 200, empty = false): PictureImage & { resized?: { width: number; height: number } } => {
  const img: PictureImage & { resized?: { width: number; height: number } } = {
    isEmpty: () => empty,
    getSize: () => (img.resized ?? { width: w, height: h }),
    resize(o) { const r = image(o.width, o.height); r.resized = { width: o.width, height: o.height }; img.resized = { width: o.width, height: o.height }; return r },
    toPNG: () => Buffer.from(PNG),
  }
  return img
}

interface View { look: PictureLook; asked: CaptureRect[]; settle: ((img: PictureImage | null) => void)[]; img: () => PictureImage | Promise<PictureImage> | 'hang' | 'reject' }
let wcs = 0
function view(o: Partial<PictureLook> = {}, zoom = 1): View {
  const v = { asked: [], settle: [], img: () => image() } as unknown as View
  v.look = {
    wc: {
      id: ++wcs,
      getZoomFactor: () => zoom,
      capturePage: (r: CaptureRect) => {
        v.asked.push(r)
        const i = v.img()
        if (i === 'reject') return Promise.reject(new Error('gone'))
        if (i === 'hang') return new Promise((res) => { v.settle.push((x) => res(x as PictureImage)) })
        return Promise.resolve(i)
      },
    },
    active: true, live: true, trusted: true, doc: 'D1', commits: 3, gen: 7, windowShown: true, viewShown: true, ...o,
  }
  return v
}
const RECT = { x: 10, y: 20, width: 300, height: 200 }
const yes = () => true

describe('live pictures in main (A4.6 #35)', () => {
  it('a seen tab: the rect read back, the PNG\'s bytes a Uint8Array, its size', async () => {
    const v = view()
    const shoot = livePictures({ look: () => v.look })
    const a = await shoot('t1', 'D1', RECT, yes)
    expect(a).toEqual({ ok: true, png: PNG, width: 300, height: 200 })
    expect(a.ok && a.png instanceof Uint8Array).toBe(true)
    expect(v.asked).toEqual([RECT])
  })

  it('hidden: no view, not the active tab, no live document, the window hidden or minimised, the view hidden or under a tab page - nothing read', async () => {
    for (const o of [{ active: false }, { live: false }, { windowShown: false }, { viewShown: false }]) {
      const v = view(o)
      expect(await livePictures({ look: () => v.look })('t1', 'D1', RECT, yes), JSON.stringify(o)).toEqual({ ok: false, why: 'hidden' })
      expect(v.asked).toEqual([])
    }
    expect(await livePictures({ look: () => null })('t1', 'D1', RECT, yes)).toEqual({ ok: false, why: 'hidden' })
    // a document other than the one that asked
    const v = view({ doc: 'D2' })
    expect(await livePictures({ look: () => v.look })('t1', 'D1', RECT, yes)).toEqual({ ok: false, why: 'stale' })
  })

  it('one readback at a time per view: busy; past the deadline timeout, the slot held until the readback settles', async () => {
    const v = view()
    v.img = () => 'hang'
    const shoot = livePictures({ look: () => v.look, deadlineMs: 30 })
    const first = shoot('t1', 'D1', RECT, yes)
    expect(await shoot('t1', 'D1', RECT, yes)).toEqual({ ok: false, why: 'busy' })
    expect(await first).toEqual({ ok: false, why: 'timeout' })
    // abandoned, still out: the slot stays taken
    expect(await shoot('t1', 'D1', RECT, yes)).toEqual({ ok: false, why: 'busy' })
    expect(v.asked).toHaveLength(1)
    v.settle[0]!(image())
    await new Promise((r) => setTimeout(r, 0))
    v.img = () => image()
    expect((await shoot('t1', 'D1', RECT, yes)).ok).toBe(true)
    // another view is never held up by one whose readback is out
    const w = view()
    w.img = () => 'hang'
    void livePictures({ look: () => w.look, deadlineMs: 30 })('t2', 'D1', RECT, yes)
    const other = view()
    expect((await livePictures({ look: () => other.look })('t3', 'D1', RECT, yes)).ok).toBe(true)
    expect(await livePictures({ look: () => w.look })('t2', 'D1', RECT, yes)).toEqual({ ok: false, why: 'busy' })
  })

  it('after the readback everything again: a gen change, trust revoked, minimised, a tab page raised, another commit, another tab, the admission gone - each stale', async () => {
    const changes: [string, Partial<PictureLook> | 'still'][] = [
      ['gen', { gen: 8 }], ['trust revoked', { trusted: false }], ['minimised', { windowShown: false }], ['a tab page raised', { viewShown: false }],
      ['another commit', { commits: 4 }], ['another document', { doc: 'D9' }], ['another tab active', { active: false }], ['unloaded', { live: false }],
      ['the bridge\'s admission', 'still'],
    ]
    for (const [name, change] of changes) {
      const v = view()
      v.img = () => 'hang'
      let admitted = true
      const shoot = livePictures({ look: () => v.look })
      const p = shoot('t1', 'D1', RECT, () => admitted)
      await new Promise((r) => setTimeout(r, 0))
      if (change === 'still') admitted = false; else v.look = { ...v.look, ...change }
      v.settle[0]!(image())
      expect(await p, name).toEqual({ ok: false, why: 'stale' })
    }
    // the view gone meanwhile
    const v = view()
    v.img = () => 'hang'
    let there = true
    const p = livePictures({ look: () => (there ? v.look : null) })('t1', 'D1', RECT, yes)
    await new Promise((r) => setTimeout(r, 0))
    there = false
    v.settle[0]!(image())
    expect(await p).toEqual({ ok: false, why: 'stale' })
  })

  it('an empty image, or a readback that failed: empty', async () => {
    const v = view()
    v.img = () => image(300, 200, true)
    expect(await livePictures({ look: () => v.look })('t1', 'D1', RECT, yes)).toEqual({ ok: false, why: 'empty' })
    v.img = () => 'reject'
    expect(await livePictures({ look: () => v.look })('t1', 'D1', RECT, yes)).toEqual({ ok: false, why: 'empty' })
  })

  it('no resampling but down to a 4096 px long side', async () => {
    const v = view()
    v.img = () => image(8000, 2000)
    const a = await livePictures({ look: () => v.look })('t1', 'D1', RECT, yes)
    expect(a).toMatchObject({ ok: true, width: 4096, height: 1024 })
    v.img = () => image(4096, 4096)
    expect(await livePictures({ look: () => v.look })('t1', 'D1', RECT, yes)).toMatchObject({ ok: true, width: 4096, height: 4096 })
    v.img = () => image(1000, 4200)
    expect(await livePictures({ look: () => v.look })('t1', 'D1', RECT, yes)).toMatchObject({ ok: true, width: 975, height: 4096 })
  })

  it('the rect is CSS px: read back at the page\'s zoom (1.25), rounded out', async () => {
    const v = view({}, 1.25)
    await livePictures({ look: () => v.look })('t1', 'D1', { x: 10, y: 20, width: 101, height: 51 }, yes)
    // 12.5 -> 12, 25; (111 x 1.25 = 138.75) -> 139, (71 x 1.25 = 88.75) -> 89
    expect(v.asked).toEqual([{ x: 12, y: 25, width: 127, height: 64 }])
  })
})
