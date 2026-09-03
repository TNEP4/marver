import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractMeta, frontMatter, scanFrames, sceneBrief } from '../src/server/manifest.ts'
import { readDescription } from '../src/shared/board-tree.ts'

// Descriptions: one optional sentence on every object, all surfaced by design/manifest.json -
// the file a new agent session reads first. The property under test is "what the files say
// reaches the manifest, trimmed, only for what exists".

describe('readDescription', () => {
  it('trims, collapses whitespace, caps at 300, and is absent for empty or non-strings', () => {
    expect(readDescription('  the   cart\n step ')).toBe('the cart step')
    expect(readDescription('x'.repeat(400))!.length).toBe(300)
    expect(readDescription('   ')).toBeUndefined()
    expect(readDescription(5)).toBeUndefined()
    expect(readDescription(undefined)).toBeUndefined()
  })
})

describe('meta.description on a frame', () => {
  it('is picked as a literal, like title; a computed one is ignored', () => {
    expect(extractMeta(`export const meta = { title: 'Cart', description: "Empty state before the first import" }`)).toEqual({ title: 'Cart', description: 'Empty state before the first import' })
    expect(extractMeta(`export const meta = { description: someVar }`)).toEqual({})
    expect(extractMeta(`export const meta = { description: '' }`)).toEqual({})
    expect(extractMeta(`export const meta = { description: "Draft" + phase, title: 'T' }`)).toEqual({ title: 'T' })   // a literal must END the value
    expect(extractMeta(`export const meta = { title: "Draft" + phase }`)).toEqual({})
    expect(extractMeta(`export const meta = { title: "It's \`quoted\`", covariant: 'x', variant: 'b' }`)).toEqual({ title: "It's `quoted`", variant: 'b' })
  })
})

describe('the manifest as the orientation file', () => {
  let root = ''
  const w = (rel: string, content: string) => { const p = join(root, ...rel.split('/')); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, content) }
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mv-desc-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('a scene takes the first line of its _brief.md, # stripped; no brief = no description', () => {
    w('design/scenes/checkout/cart.tsx', `export const meta = { title: 'Cart' }\nexport default () => null\n`)
    w('design/scenes/checkout/_brief.md', `\n# Checkout - the buyer's path from cart to receipt (v2)\n\nAudience: …\n`)
    w('design/scenes/plain/home.tsx', `export default () => null\n`)
    expect(sceneBrief(root, 'checkout')).toEqual({ brief: 'design/scenes/checkout/_brief.md', description: "Checkout - the buyer's path from cart to receipt (v2)" })
    expect(sceneBrief(root, 'plain')).toEqual({})
    expect(sceneBrief(root, '')).toEqual({})
    // a front-matter block is skipped; the first line after it is the sentence
    w('design/scenes/fm/_brief.md', `---\ntitle: x\n---\n\nOrders - the fulfilment desk (UNCONFIRMED)\n`)
    expect(sceneBrief(root, 'fm')).toMatchObject({ description: 'Orders - the fulfilment desk (UNCONFIRMED)' })
    const m = scanFrames(root)
    expect(m.scenes.find((s) => s.name === 'checkout')).toEqual({ name: 'checkout', frames: 1, brief: 'design/scenes/checkout/_brief.md', description: "Checkout - the buyer's path from cart to receipt (v2)" })
    expect(m.scenes.find((s) => s.name === 'plain')).toEqual({ name: 'plain', frames: 1 })
  })

  it('a scene takes its title from the brief’s front matter - quoted or bare - and the description from the line after the block', () => {
    w('design/scenes/mvp/home.tsx', `export default () => null\n`)
    w('design/scenes/mvp/_brief.md', `---\ntitle: "MVP 🚀"\nstatus: draft\n---\n\n# The launch scope\n`)
    expect(sceneBrief(root, 'mvp')).toEqual({ brief: 'design/scenes/mvp/_brief.md', title: 'MVP 🚀', description: 'The launch scope' })
    w('design/scenes/mvp/_brief.md', `---\ntitle: 'It''s UI'\n---\nbody\n`)
    expect(sceneBrief(root, 'mvp').title).toBe("It's UI")
    w('design/scenes/mvp/_brief.md', `---\ntitle: Bare Title\n---\n`)
    expect(sceneBrief(root, 'mvp')).toEqual({ brief: 'design/scenes/mvp/_brief.md', title: 'Bare Title' })
    expect(scanFrames(root).scenes.find((s) => s.name === 'mvp')).toMatchObject({ title: 'Bare Title' })
    // the reader itself: no block, an unclosed block, a non-scalar line
    expect(frontMatter(['# hi'])).toEqual({ fields: {}, end: 0 })
    expect(frontMatter(['---', 'title: x', 'nope', '- list'])).toEqual({ fields: { title: 'x' }, end: 4 })
  })

  it('carries the project, folders and boards in sidebar order (all-scenes never), each with its description', () => {
    w('design/scenes/app/home.tsx', `export const meta = { title: 'Home', description: "The founder's Monday read" }\nexport default () => null\n`)   // an apostrophe wants double quotes, like title
    w('design/boards/overview.json', JSON.stringify({ version: 1, nodes: [], order: 0, description: 'The primary flow - what we show first' }))
    w('design/boards/spec.json', JSON.stringify({ version: 1, nodes: [], order: 0, folder: 'research', title: 'The Spec' }))
    w('design/boards/all-scenes.json', JSON.stringify({ version: 1, nodes: [] }))
    w('design/boards/_folders.json', JSON.stringify({ version: 1, folders: [{ name: 'research', order: 1, title: 'R&D', description: 'The thinking behind the boards' }] }))
    const m = scanFrames(root, { name: 'pulse', description: 'Analytics for indie SaaS' })
    expect(m.project).toEqual({ name: 'pulse', description: 'Analytics for indie SaaS' })
    expect(m.folders).toEqual([{ name: 'research', title: 'R&D', description: 'The thinking behind the boards' }])
    expect(m.boards).toEqual([{ name: 'overview', description: 'The primary flow - what we show first' }, { name: 'spec', folder: 'research', title: 'The Spec' }])
    expect(m.frames[0]).toMatchObject({ id: 'app/home', description: "The founder's Monday read" })
    // the key order reads top-down: what this is, how it is organised, then the frames
    expect(Object.keys(m)).toEqual(['project', 'folders', 'boards', 'scenes', 'frames'])
  })

  it('no project, no boards, no folders = the keys are absent, never empty', () => {
    w('design/scenes/app/home.tsx', `export default () => null\n`)
    const m = scanFrames(root)
    expect(m.project).toBeUndefined(); expect(m.boards).toBeUndefined(); expect(m.folders).toBeUndefined()
    expect(scanFrames(root, { name: undefined, description: undefined }).project).toBeUndefined()
  })

  it('a malformed registry or a symlinked boards dir leaves the boards part out - the manifest still writes', () => {
    w('design/scenes/app/home.tsx', `export default () => null\n`)
    w('design/boards/one.json', JSON.stringify({ version: 1, nodes: [] }))
    w('design/boards/_folders.json', '{ nope')
    const m = scanFrames(root)
    expect(m.boards).toBeUndefined()
    expect(m.frames.length).toBe(1)
  })

  it('the published manifest ships descriptions of published things only; brief paths only with source revealed', async () => {
    const { publishedManifest } = await import('../src/server/build.ts')
    const full = {
      project: { name: 'pulse', description: 'Analytics for indie SaaS' },
      folders: [{ name: 'research', description: 'thinking' }, { name: 'private', description: 'never ships' }],
      boards: [{ name: 'overview', description: 'live' }, { name: 'spec', folder: 'research', description: 'the spec' }, { name: 'secret', folder: 'private', description: 'hidden' }],
      scenes: [{ name: 'app', frames: 2, title: 'The App', description: 'the app', brief: 'design/scenes/app/_brief.md' }, { name: 'hidden', frames: 1, title: 'Hidden!', description: 'secret scene' }],
      frames: [{ id: 'app/home', file: 'design/scenes/app/home.tsx', kind: 'tsx' as const, scene: 'app', description: 'home' }, { id: 'hidden/x', file: 'design/scenes/hidden/x.tsx', kind: 'tsx' as const, scene: 'hidden' }],
    }
    const pubFrames = [full.frames[0]!]
    const stripped = publishedManifest(full, pubFrames, ['overview', 'spec'], true)
    expect(stripped.project).toEqual(full.project)
    expect(stripped.folders).toEqual([{ name: 'research', description: 'thinking' }])
    expect(stripped.boards).toEqual([{ name: 'overview', description: 'live' }, { name: 'spec', folder: 'research', description: 'the spec' }])
    expect(stripped.scenes).toEqual([{ name: 'app', frames: 1, title: 'The App', description: 'the app' }])   // no brief path: source is stripped
    expect(JSON.stringify(stripped)).not.toMatch(/private|secret|hidden|Hidden|never ships|_brief/)
    expect(publishedManifest(full, pubFrames, ['overview', 'spec'], false).scenes[0]).toMatchObject({ brief: 'design/scenes/app/_brief.md' })
  })
})
