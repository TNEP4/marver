import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { framesFor } from '../src/server/updates.ts'
import { scanFrames } from '../src/server/manifest.ts'
import type { EnvironmentModuleNode } from 'vite'

// a module graph node as much as framesFor reads of it
type Mod = { file: string | null; importers: Set<Mod>; isSelfAccepting?: boolean }
const mod = (file: string | null, importers: Mod[] = [], accepts = false): Mod => ({ file, importers: new Set(importers), isSelfAccepting: accepts })
const as = (m: Mod[]) => m as unknown as EnvironmentModuleNode[]

describe('calm updates: which frames an edit reaches (spec 26 Part 2)', () => {
  let root = ''
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })
  const canvas = () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-upd-')))
    for (const p of ['design/scenes/s/a.tsx', 'design/scenes/s/b.tsx', 'design/scenes/t/c.tsx', 'design/scenes/t/page.html']) {
      mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), p.endsWith('.html') ? '<p>x</p>' : 'export default () => null\n')
    }
    return scanFrames(root)
  }
  const at = (p: string) => join(root, p)

  it('by path: a frame is itself; a provider reaches every TSX frame; a layout every TSX frame below it - created ones too', () => {
    const m = canvas()
    expect(framesFor(root, m, at('design/scenes/s/a.tsx'), []).doc).toEqual(['s/a'])
    expect(framesFor(root, m, at('design/providers.tsx'), []).doc.sort()).toEqual(['s/a', 's/b', 't/c'])
    expect(framesFor(root, m, at('design/scenes/t/_layout.tsx'), []).doc).toEqual(['t/c'])   // no module yet: a layout just created
  })

  it('by graph: a kit reaches the frames that import it, and a helper of a wrapper reaches what the wrapper wraps', () => {
    const m = canvas()
    const a = mod(at('design/scenes/s/a.tsx')), b = mod(at('design/scenes/s/b.tsx'))
    const kit = mod(at('design/scenes/s/_kit.tsx'), [a, b])
    expect(framesFor(root, m, kit.file!, as([kit])).doc.sort()).toEqual(['s/a', 's/b'])
    const layout = mod(at('design/scenes/t/_layout.tsx'))
    const helper = mod(at('design/scenes/t/_helper.ts'), [layout])
    expect(framesFor(root, m, helper.file!, as([helper])).doc).toEqual(['t/c'])
  })

  it('an HTML frame is reached through its own module', () => {
    const m = canvas()
    const page = mod(at('design/scenes/t/page.html'))
    const script = mod(at('design/scenes/t/_widget.ts'), [page])
    expect(framesFor(root, m, script.file!, as([script])).doc).toEqual(['t/page'])
  })

  it('past a module that accepts its own updates (an app component under Fast Refresh) the frames are touched, not reloaded', () => {
    const m = canvas()
    const a = mod(at('design/scenes/s/a.tsx')), c = mod(at('design/scenes/t/c.tsx'))
    const button = mod(at('src/Button.tsx'), [a], true)
    const util = mod(at('src/util.ts'), [button, c])          // a plain helper: c imports it directly
    const t = framesFor(root, m, util.file!, as([util]))
    expect(t.doc).toEqual(['t/c'])                              // no boundary on the way: c reloads
    expect(t.touched).toEqual(['s/a'])                          // a's Button applies it in place
  })

  it('a refresh refused at run time: the walk goes on from the refusing module\'s importers', () => {
    const m = canvas()
    const a = mod(at('design/scenes/s/a.tsx'))
    const card = mod(at('src/Card.tsx'), [a], true)             // it accepts - but refused this update
    expect(framesFor(root, m, card.file!, as([card]), true).doc).toEqual(['s/a'])
  })
})
