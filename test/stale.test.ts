import { describe, expect, it } from 'vitest'
import { staleSurface } from '../src/server/stale.ts'
import { png, type Px } from './png-fixture.ts'

/**
 * The guard against Chrome's tiled stale surface (#14, #24), on PNGs built here - independently of it: a pixel
 * function, every row filter, any number of IDAT chunks.
 */

// a varied tile: no two pixels alike in a row, so a repeat is real evidence
const W0 = 30, H0 = 20
const tile: Px = (x, y) => [(x * 7 + y * 3) & 255, (x * 13 + y * 29) & 255, (x * y + 11) & 255, 255]
const tiled: Px = (x, y) => tile(x % W0, y % H0)
const noise: Px = (x, y) => [(x * 31 + y * 17 + ((x * y) >> 2)) & 255, (x * 5 + y * 41) & 255, (x ^ y) & 255, 255]

describe('the stale-surface guard (#14, #24)', () => {
  it('a picture tiled from the view\'s old surface is stale - RGBA and RGB, and sizes that are not a multiple of the tile', async () => {
    expect(await staleSurface(png(75, 50, tiled), W0, H0)).toBe('stale')
    expect(await staleSurface(png(75, 50, tiled, { channels: 3 }), W0, H0)).toBe('stale')
    expect(await staleSurface(png(70, 45, tiled), W0, H0)).toBe('stale')
  })

  it('tiled along one axis only - wider than the view, or taller', async () => {
    expect(await staleSurface(png(75, 20, tiled), W0, H0)).toBe('stale')
    expect(await staleSurface(png(30, 50, tiled), W0, H0)).toBe('stale')
  })

  it('a real picture is clean; so is one no bigger than the view', async () => {
    expect(await staleSurface(png(75, 50, noise), W0, H0)).toBe('clean')
    expect(await staleSurface(png(30, 20, tiled), W0, H0)).toBe('clean')
  })

  it('a single-colour first tile proves nothing - even a whole blank page', async () => {
    expect(await staleSurface(png(75, 50, () => [255, 255, 255, 255]), W0, H0)).toBe('clean')
    // blank top, content below: the repeat of a blank tile is not evidence
    expect(await staleSurface(png(75, 50, (x, y) => (y < H0 ? [250, 250, 250, 255] : noise(x, y))), W0, H0)).toBe('clean')
  })

  it('repeated artwork that is not a tile - identical panels across the top, different below - is clean', async () => {
    const panels: Px = (x, y) => (y < H0 ? tile(x % W0, y) : noise(x, y))
    expect(await staleSurface(png(75, 50, panels), W0, H0)).toBe('clean')
    // two identical full tile-height panels, different only further down: the whole image is read before a verdict
    const deep: Px = (x, y) => (y < 2 * H0 ? tiled(x, y) : noise(x, y))
    expect(await staleSurface(png(75, 90, deep), W0, H0)).toBe('clean')
    const lastRow: Px = (x, y) => (y < 89 ? tiled(x, y) : noise(x, y))
    expect(await staleSurface(png(75, 90, lastRow), W0, H0)).toBe('clean')
  })

  it('alpha counts: the same colours with a different alpha are not a repeat', async () => {
    const alpha: Px = (x, y) => { const p = tiled(x, y); return [p[0], p[1], p[2], x >= W0 ? 128 : 255] }
    expect(await staleSurface(png(75, 50, alpha), W0, H0)).toBe('clean')
  })

  it('every row filter (0-4) and several IDAT chunks decode the same', async () => {
    expect(await staleSurface(png(75, 50, tiled, { filter: (y) => y % 5, parts: 7 }), W0, H0)).toBe('stale')
    expect(await staleSurface(png(75, 50, noise, { filter: (y) => (y * 3) % 5, parts: 3 }), W0, H0)).toBe('clean')
  })

  it('what it cannot read is "unknown", never clean: truncated, 16-bit, a palette, interlaced, not a PNG', async () => {
    const good = png(75, 50, tiled)
    expect(await staleSurface(good.subarray(0, good.length - 40), W0, H0)).toBe('unknown')
    expect(await staleSurface(png(75, 50, tiled, { depth: 16 }), W0, H0)).toBe('unknown')
    expect(await staleSurface(png(75, 50, tiled, { channels: 3, colour: 3 }), W0, H0)).toBe('unknown')
    const interlaced = Buffer.from(good); interlaced[8 + 8 + 12] = 1
    expect(await staleSurface(interlaced, W0, H0)).toBe('unknown')
    expect(await staleSurface(Buffer.from('not a png at all, just bytes in a buffer'), W0, H0)).toBe('unknown')
    expect(await staleSurface(png(75, 50, tiled), 0, 0)).toBe('unknown')
    // cut at the very end: no IEND, or half of it - the envelope is not whole
    expect(await staleSurface(good.subarray(0, good.length - 12), W0, H0)).toBe('unknown')
    expect(await staleSurface(good.subarray(0, good.length - 5), W0, H0)).toBe('unknown')
    // IHDR methods Chrome never writes
    const comp = Buffer.from(good); comp[8 + 8 + 10] = 1
    expect(await staleSurface(comp, W0, H0)).toBe('unknown')
    const filt = Buffer.from(good); filt[8 + 8 + 11] = 1
    expect(await staleSurface(filt, W0, H0)).toBe('unknown')
  })

  it('a real picture, however tall, costs its first rows - it stops at the first row that breaks the repeat', async () => {
    const tall = png(1200, 20_000, noise, { channels: 3 })
    const t = performance.now()
    expect(await staleSurface(tall, 300, 200)).toBe('clean')
    expect(performance.now() - t).toBeLessThan(100)
    // a tall tiled one is read to the end, and still found
    expect(await staleSurface(png(1200, 6_000, (x, y) => tile(x % 300, y % 200), { channels: 3 }), 300, 200)).toBe('stale')
  })

  it('a deadline already passed gives up: "unknown"', async () => {
    expect(await staleSurface(png(75, 50, tiled), W0, H0, Date.now() - 1)).toBe('unknown')
  })
})
