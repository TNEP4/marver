/**
 * Two browser lanes never write one file: a capture's picture (the picture lane, at the size the frame was seen) and a
 * batch on the shot lane can render the same frame at once. Real shootFrame and shootBatch, a fake browser whose
 * screenshot is the width it was asked for.
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** frame B's render waits on this: the batch stays open while the picture lane shoots frame A */
let releaseB: () => void = () => {}
const holdB = new Promise<void>((r) => { releaseB = r })

vi.mock('../src/server/cdp.ts', async (orig) => {
  const real = await orig<typeof import('../src/server/cdp.ts')>()
  class FakeBrowser {
    dead: string | null = null
    static async launch() { return new FakeBrowser() }
    async send(method: string, params: any = {}) {
      if (method === 'Target.createTarget') return { targetId: 't' }
      if (method === 'Target.attachToTarget') return { sessionId: 's' }
      if (method === 'Page.navigate') { if (String(params.url).includes('b.html')) await holdB; return {} }
      if (method === 'Page.captureScreenshot') return { data: Buffer.from(`width ${params.clip.width}`).toString('base64') }
      if (method === 'Runtime.evaluate' && String(params.expression).includes('__mvFrameError')) return { result: { value: '' } }
      if (method === 'Runtime.evaluate') return { result: { value: true } }
      return {}
    }
    on() { return () => {} }
    abort() {}
    async close() {}
  }
  return { ...real, Browser: FakeBrowser }
})

describe('the shot lanes', () => {
  it('a capture\'s picture never overwrites the file a batch on the shot lane reports for the same frame', async () => {
    const { shootBatch, shootFrame, shotSeams } = await import('../src/server/shot.ts')
    shotSeams.noWindow = true
    const root = mkdtempSync(join(tmpdir(), 'mv-shot-lanes-'))
    try {
      mkdirSync(join(root, 'design'), { recursive: true })
      writeFileSync(join(root, 'design', 'manifest.json'), JSON.stringify({ frames: [
        { id: 'app/a', file: 'scenes/a.html', kind: 'html', viewport: 'desktop' },
        { id: 'app/b', file: 'scenes/b.html', kind: 'html', viewport: 'desktop' },
      ] }))
      const viewports = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } }
      const base = { root, viewports, theme: 'light', origin: 'http://localhost:1' }
      // the batch: A at 1440 is done, B still renders
      const batch = shootBatch({ ...base, frames: ['app/a', 'app/b'] })
      for (const by = Date.now() + 10_000; !existsSync(join(root, 'design', '.local', 'shots', 'app--a--light.png')) && Date.now() < by;) await new Promise((r) => setTimeout(r, 20))
      // meanwhile a capture shoots A as it was seen: 390 wide, on its own lane
      const pic = await shootFrame({ ...base, frameId: 'app/a', lane: 'picture', size: { w: 390, h: 844 } })
      expect(pic.ok).toBe(true)
      releaseB()
      const [a] = await batch
      expect(a.ok && a.width).toBe(1440)
      // the file the batch names for A is A at 1440 - never the picture's 390
      expect(readFileSync(join(root, (a as { path: string }).path), 'utf8')).toBe('width 1440')
      expect(readFileSync(join(root, (pic as { path: string }).path), 'utf8')).toBe('width 390')
    } finally {
      delete shotSeams.noWindow
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
