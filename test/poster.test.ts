import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePoster, isLocalClip, posterNameFor } from '../src/server/poster.ts'
import { findChrome } from '../src/server/shot.ts'

// Generated posters: the convention, the clip grammar, and - above all - containment. Chrome
// reads the clip and the poster is written into design/assets/, so a symlink in there must
// never point either side outside. The render itself is proven in the browser suite.
describe('poster - convention and clip grammar', () => {
  it('names the poster beside the clip', () => {
    expect(posterNameFor('intro.mp4')).toBe('intro.mp4.poster.png')
    expect(posterNameFor('clips/a.webm')).toBe('clips/a.webm.poster.png')
  })
  it('accepts only relative, forward-slash, dot-free local clips', () => {
    expect(isLocalClip('intro.mp4')).toBe(true)
    expect(isLocalClip('clips/intro.webm')).toBe(true)
    for (const bad of ['https://x/y.mp4', 'http://x/y.mp4', '/etc/x.mp4', '../x.mp4', 'a/../x.mp4', './x.mp4', 'a\\b.mp4', 'c:\\x.mp4', 'a//b.mp4', 'poster.png', 'x.mp4/'])
      expect(isLocalClip(bad), bad).toBe(false)
  })
})

describe.skipIf(!findChrome())('poster - containment against a real filesystem', () => {
  let root = '', assets = '', outside = ''
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mv-poster-'))
    assets = join(root, 'design', 'assets'); mkdirSync(assets, { recursive: true })
    outside = join(root, 'outside'); mkdirSync(outside)
    copyFileSync(join(import.meta.dirname, 'fixtures', 'clip.webm'), join(outside, 'secret.webm'))
    copyFileSync(join(import.meta.dirname, 'fixtures', 'clip.webm'), join(assets, 'real.webm'))
    symlinkSync(join(outside, 'secret.webm'), join(assets, 'linked.webm'))       // a clip that is really elsewhere
    symlinkSync(outside, join(assets, 'escape'))                                  // a folder that is really elsewhere
    copyFileSync(join(import.meta.dirname, 'fixtures', 'clip.webm'), join(outside, 'inner.webm'))
  })
  afterAll(() => { rmSync(root, { recursive: true, force: true }) })

  it('renders a poster for a clip that really lives in design/assets/', async () => {
    const r = await ensurePoster(assets, 'real.webm')
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.generated).toBe(true); expect([r.width, r.height]).toEqual([320, 180]) }
    const b = readFileSync(join(assets, 'real.webm.poster.png'))
    expect(b.subarray(1, 4).toString()).toBe('PNG')
    // idempotent: the second call leaves the file alone
    const again = await ensurePoster(assets, 'real.webm')
    expect(again.ok && !again.generated).toBe(true)
  }, 30_000)

  it('refuses a clip that is a symlink to a file outside design/assets/ - Chrome never reads it', async () => {
    const r = await ensurePoster(assets, 'linked.webm')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/resolves outside/)
    expect(existsSync(join(assets, 'linked.webm.poster.png'))).toBe(false)
  })

  it('refuses to write into a symlinked folder that resolves outside design/assets/', async () => {
    const r = await ensurePoster(assets, 'escape/inner.webm')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/resolves outside/)
    expect(existsSync(join(outside, 'inner.webm.poster.png'))).toBe(false)
  })

  it('never overwrites an authored poster', async () => {
    writeFileSync(join(assets, 'real2.webm'), readFileSync(join(assets, 'real.webm')))
    writeFileSync(join(assets, 'real2.webm.poster.png'), 'authored')
    const r = await ensurePoster(assets, 'real2.webm')
    expect(r.ok && !r.generated).toBe(true)
    expect(readFileSync(join(assets, 'real2.webm.poster.png'), 'utf8')).toBe('authored')
  })
})
