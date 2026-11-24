import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveByNameOnly, buildSearchDocs, frameWords, plain } from '../src/server/search-docs.ts'
import { scanFrames } from '../src/server/manifest.ts'
import { buildIndex, search } from '../src/shared/search.ts'

/** Search (spec 35), the document builder on a small canvas: every kind, archive rules, comments replayed, briefs. */

let root = ''
const w = (p: string, s: string) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), s) }

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mv-search-docs-'))
  w('package.json', '{"name":"fixture","private":true}')
  w('design/scenes/feed/filter.tsx', `export const meta = { title: 'Filter the feed', viewport: 'boox', description: 'Two ready filters, never a pop-over' }
export default () => <main><h1>Filter the feed</h1><p>Unread from people</p><button className="px-4 py-2">Apply</button></main>`)
  w('design/scenes/feed/filter.note.md', 'Two ready filters cover 90% of the gaps')
  w('design/scenes/feed/_brief.md', '---\ntitle: Feed - lo-fi\n---\nThe feed on e-ink.\n\nIt shows what Delos picked for today, quietly.')
  w('design/scenes/old-feed/filter.tsx', `export const meta = { title: 'Filter · v1' }\nexport default () => <main>Old filter</main>`)
  w('design/scenes/spec/overview.tsx', `import src from './overview.md?raw'\nexport const meta = { title: 'Overview' }\nexport default () => <div>{src}</div>`)
  w('design/scenes/spec/overview.md', '# The one sentence\nSearch finds anything on the canvas, quickly.')
  w('design/boards/_folders.json', JSON.stringify({ version: 1, folders: [
    { name: 'e-ink', order: 0, title: 'E-ink' },
    { name: 'arch-glass', order: 1, title: 'Glass v1' },
    { name: 'ideas', order: 2, title: 'Old ideas', type: 'project' },
  ] }))
  w('design/boards/feed.json', JSON.stringify({ version: 1, name: 'feed', folder: 'e-ink', title: 'Feed', description: 'The feed board', nodes: [{ key: 'a', frame: 'feed/filter' }, { key: 's', frame: 'spec/overview' }] }))
  w('design/boards/glass.json', JSON.stringify({ version: 1, name: 'glass', folder: 'arch-glass', title: 'Glass v1', nodes: [{ key: 'b', frame: 'old-feed/filter' }] }))
  w('design/boards/kept.json', JSON.stringify({ version: 1, name: 'kept', folder: 'ideas', title: 'Kept ideas', nodes: [] }))
  w('design/comments/feed.jsonl', [
    { id: 'e1', type: 'create', commentId: 't1', board: 'feed', frame: 'feed/filter', body: 'Should the filter remember the last choice?', author: { name: 'Nic' }, ts: 1 },
    { id: 'e2', type: 'reply', commentId: 'r1', parentId: 't1', body: 'Which choice first?', agent: true, asks: true, ts: 2 },
    { id: 'e3', type: 'create', commentId: 't2', board: 'feed', body: 'Old idea about filtering', author: { name: 'Nic' }, ts: 3 },
    { id: 'e4', type: 'resolve', commentId: 't2', ts: 4 },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('the document builder', () => {
  it('makes a document for every kind, with where each sits', () => {
    const { docs } = buildSearchDocs(root)
    const by = (id: string) => docs.find((d) => d.id === id)
    expect(by('frame:feed/filter')).toMatchObject({ title: 'Filter the feed', device: 'boox', board: 'feed', where: 'Feed › Feed - lo-fi', archived: false })
    expect(by('note:feed/filter')).toMatchObject({ kind: 'note', dest: { frame: 'feed/filter', notes: true } })
    expect(by('scene:feed')?.summary).toContain('what Delos picked for today')   // the brief's body, not only its first line
    expect(by('board:feed')).toMatchObject({ kind: 'board', folders: ['e-ink'] })
    // a thread is found by what it is on: its frame's and its board's names
    expect(docs.find((d) => d.kind === 'comment')?.summary).toContain('Feed')
    expect(by('folder:e-ink')).toMatchObject({ kind: 'folder', title: 'E-ink' })
  })
  it('archive: an arch- folder with no type is archive by its name; an explicit other type never is', () => {
    const { docs } = buildSearchDocs(root)
    const by = (id: string) => docs.find((d) => d.id === id)
    expect(by('board:glass')?.archived).toBe(true)
    expect(by('frame:old-feed/filter')?.archived).toBe(true)
    expect(by('board:kept')?.archived).toBe(false)   // "Old ideas" says old, but the folder is typed project
    expect(by('frame:feed/filter')?.archived).toBe(false)
  })
  it('comments replayed: a thread with its replies, open and asking; a resolved thread found only when asked for', () => {
    const { docs } = buildSearchDocs(root)
    const t1 = docs.find((d) => d.id === 'comment:feed:t1')!
    expect(t1).toMatchObject({ open: true, asks: true, dest: { board: 'feed', thread: 't1', frame: 'feed/filter' } })
    expect(t1.comments).toContain('Which choice first?')
    const idx = buildIndex(docs)
    expect(search(idx, 'old idea filtering').groups.flatMap((g) => g.hits.map((h) => h.doc.key))).toContain('feed:t2')   // nothing else matches
    expect(search(idx, 'filter').groups.flatMap((g) => g.hits.map((h) => h.doc.key))).not.toContain('feed:t2')
    expect(search(idx, 'filter', { kinds: ['comment'] }).groups.flatMap((g) => g.hits.map((h) => h.doc.key))).toContain('feed:t2')
  })
  it("a frame's own words: its prose and the Markdown it binds, never class lists", () => {
    const w1 = frameWords(root, 'design/scenes/feed/filter.tsx')!
    expect(w1).toContain('Unread from people')
    expect(w1).not.toContain('px-4')
    expect(frameWords(root, 'design/scenes/spec/overview.tsx')).toContain('Search finds anything on the canvas')
  })
})

describe('titles read as plain text (Nic, 24 Nov: "**Area A on iPhone**" showed its stars)', () => {
  it('drops Markdown marks and keeps everything else', () => {
    const cases: [string, string][] = [
      ['**Area A on iPhone: shell and Home**', 'Area A on iPhone: shell and Home'],
      ['**Time and People, iPhone** (20 frames)', 'Time and People, iPhone (20 frames)'],
      ['- see [the doc](http://x) and `code`', 'see the doc and code'],
      ['## Title', 'Title'], ['*em* text', 'em text'],
      ['snake_case_name stays', 'snake_case_name stays'], ['2 * 3 = 6', '2 * 3 = 6'], ['a * b * c', 'a * b * c'],
    ]
    for (const [md, text] of cases) expect(plain(md)).toBe(text)
  })
})

describe('the spec\'s last pieces (final check, 24 Nov)', () => {
  it('names the folders read as archive by their name alone, outermost only, never a typed one', () => {
    expect(archiveByNameOnly(root)).toEqual(['arch-glass'])
  })
  it('a frame opts out of the live preview with meta.preview: false - both meta readers', () => {
    const r = mkdtempSync(join(tmpdir(), 'mv-search-optout-'))
    try {
      mkdirSync(join(r, 'design/scenes/s'), { recursive: true })
      writeFileSync(join(r, 'package.json'), '{"name":"fixture","private":true}')
      writeFileSync(join(r, 'design/scenes/s/a.tsx'), `export const meta = { title: 'A', preview: false }\nexport default () => <main>a</main>`)
      // a meta the strict tokenizer cannot follow (a computed value) falls back to the lenient reader
      writeFileSync(join(r, 'design/scenes/s/b.tsx'), `const t = 1\nexport const meta = { title: 'B', preview: false, n: t + 1 }\nexport default () => <main>b</main>`)
      writeFileSync(join(r, 'design/scenes/s/c.tsx'), `export const meta = { title: 'C', preview: true }\nexport default () => <main>c</main>`)
      const by = new Map(scanFrames(r).frames.map((f) => [f.id, f]))
      expect(by.get('s/a')?.preview).toBe(false)
      expect(by.get('s/b')?.preview).toBe(false)
      expect(by.get('s/c')?.preview).toBeUndefined()
    } finally { rmSync(r, { recursive: true, force: true }) }
  })
})
