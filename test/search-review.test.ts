import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIndex, fuzzy, search, type SearchDoc } from '../src/shared/search.ts'
import { classifyArchive, frameWords } from '../src/server/search-docs.ts'

/** Codex's step-1 review of search (spec 35): each of its reproductions, kept fixed. */

const frame = (key: string, title: string, extra: Partial<SearchDoc> = {}): SearchDoc => ({ id: `frame:${key}`, kind: 'frame', key, title, dest: { frame: key }, ...extra })
const keys = (r: ReturnType<typeof search>) => r.groups.flatMap((g) => g.hits.map((h) => h.doc.key))

describe('the engine, after review', () => {
  it('fuzzy takes the best alignment, not the first: "fp" matches Draft · Filter panel at its word starts', () => {
    const m = fuzzy('fp', 'Draft · Filter panel')
    expect(m).not.toBeNull()
    expect(m!.at).toEqual([8, 15])
    expect(fuzzy('in', 'Sign in')!.at).toEqual([5, 6])
  })
  it('word matches are not overturned by fuzzy bonuses; the order does not flip with the query', () => {
    const idx = buildIndex([frame('a/1', 'Feed · filtered'), frame('a/2', 'Filter the feed')])
    expect(search(idx, 'feed filter').top?.doc.key).toBe(search(idx, 'filter feed').top?.doc.key)
  })
  it('tier 4 is the phrase in order, whole: "glass keyboard" is not "glass panes beside a keyboard"', () => {
    const idx = buildIndex([frame('a/1', 'One', { summary: 'glass panes beside a keyboard' }), frame('a/2', 'Two', { summary: 'the glass keyboard, open' })])
    const r = search(idx, 'glass keyboard')
    expect(r.top?.doc.key).toBe('a/2')
    expect(r.groups[0].hits[0].tier).toBeLessThan(r.groups[0].hits[1].tier)
  })
  it('a basename is not an exact name: "04-filter" does not make an unrelated archived frame exact', () => {
    const idx = buildIndex([frame('old/04-filter', 'Something else', { archived: true }), frame('feed/04-filter', 'Filter')])
    const r = search(idx, '04-filter')
    expect(keys(r)).not.toContain('old/04-filter')
    expect(r.archived.count).toBe(1)
  })
  it('typos never lose results or variants: 20 keyboard frames found through "keybaord", folded once', () => {
    const docs = Array.from({ length: 20 }, (_, i) => frame(`k/${i}`, `Glass keyboard ${i}`, i < 4 ? { variantGroup: 'v', variant: String(i) } : {}))
    const idx = buildIndex(docs)
    const right = search(idx, 'glass keyboard'), typo = search(idx, 'glass keybaord')
    expect(typo.didYouMean).toBe('glass keyboard')
    const total = (r: typeof right) => r.groups.reduce((n, g) => n + g.hits.length + g.more, 0)
    expect(total(typo)).toBe(total(right))
    expect(typo.groups[0].hits.find((h) => h.doc.variantGroup === 'v')?.variants).toHaveLength(3)
    expect(typo.partial).toHaveLength(0)
  })
  it('typo eligibility is scoped: a board holding the typo does not stop a frame-only correction', () => {
    const idx = buildIndex([frame('k/1', 'Glass keyboard'), { id: 'board:x', kind: 'board', key: 'x', title: 'keybaord notes', dest: { board: 'x' } }])
    expect(keys(search(idx, 'glass keybaord', { kinds: ['frame'] }))).toContain('k/1')
  })
  it('an id is never corrected', () => {
    const idx = buildIndex([frame('feed-night/04-filter', 'Filter')])
    const r = search(idx, 'feed-night/04-filtre')
    expect(r.didYouMean).toBeUndefined()
  })
  it('the order is deterministic: any input order gives the same ranking under recency', () => {
    const docs = [frame('a/1', 'alpha one'), frame('a/2', 'alpha two'), frame('a/3', 'alpha three')]
    const recency = new Map([['frame:a/1', 0.1], ['frame:a/2', 0.5], ['frame:a/3', 0.9]])
    const a = keys(search(buildIndex(docs), 'alpha', { recency }))
    const b = keys(search(buildIndex([...docs].reverse()), 'alpha', { recency }))
    expect(a).toEqual(b)
  })
  it('a resolved thread is found by every channel when nothing else matches (fuzzy too)', () => {
    const idx = buildIndex([{ id: 'comment:b:t', kind: 'comment', key: 'b:t', title: 'Glass keyboard', comments: 'Glass keyboard', open: false, dest: { board: 'b', thread: 't' } }])
    expect(keys(search(idx, 'gk'))).toContain('b:t')
  })
  it('Needs you with nothing typed lists every waiting thread, and waiting is the marks rule (not only asks)', () => {
    const idx = buildIndex([
      { id: 'comment:b:1', kind: 'comment', key: 'b:1', title: 'Done, have a look', open: true, waiting: true, asks: false, at: 2, dest: { board: 'b' } },
      { id: 'comment:b:2', kind: 'comment', key: 'b:2', title: 'Mine', open: true, waiting: false, at: 3, dest: { board: 'b' } },
    ])
    expect(keys(search(idx, '', { needsYou: true }))).toEqual(['b:1'])
  })
  it('fast at ten times Calepin: 36,000 documents, a Zipf vocabulary of 3,000 words, every query of 2+ letters under 16 ms warm', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const base = 'feed filter glass keyboard sign ipad iphone mail compose reply night day settings inbox reader library shelf note page deck slide portrait landscape draft review'.split(' ')
    // the named words at middling ranks (as "feed" is on Calepin), the commonest ranks filler
    const filler = Array.from({ length: 3000 }, (_, i) => `w${i.toString(36)}${'abcdefghij'[i % 10]}x`)
    const vocab = [...filler.slice(0, 40), ...base, ...filler.slice(40)]
    const zipf = () => vocab[Math.min(vocab.length - 1, Math.floor(Math.exp(rnd() * Math.log(vocab.length + 1)) - 1))]
    const docs: SearchDoc[] = Array.from({ length: 36000 }, (_, i) => frame(`s${i % 900}/${i}`, `${zipf()} ${zipf()} ${i}`, { summary: `${zipf()} ${zipf()} ${zipf()}`, source: Array.from({ length: 40 }, zipf).join(' '), device: i % 3 ? 'ipad' : 'iphone', archived: i % 10 === 0 }))
    const idx = buildIndex(docs)
    for (const q of ['feed', 'ipad sign in', 'glass keybaord', 's12/12', 'gk', 'in', 'portrait landscape draft']) {
      for (let k = 0; k < 3; k++) search(idx, q)
      const ts: number[] = []
      for (let k = 0; k < 9; k++) { const t0 = performance.now(); search(idx, q); ts.push(performance.now() - t0) }
      expect(ts.sort((a, b) => a - b)[4], q).toBeLessThan(16)   // the median: one GC pause is not the engine
    }
  }, 60_000)
})

describe('the builder, after review', () => {
  const root = mkdtempSync(join(tmpdir(), 'mv-search-review-'))
  const w = (rel: string, s: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), s) }
  it('a frame\'s words: {"Continue"}, multi-line and long literals, text around {expressions}; never comments or class lists', () => {
    w('f.tsx', [
      `// an old idea about pricing`,
      `/* commented prose */`,
      `export default () => <main className="flex items-center gap-4 TEXT-LG">`,
      `  <button>{'Continue'}</button>`,
      `  <p>Hello {name} welcome back</p>`,
      `  <Md>{\`A long multi-line`,
      `paragraph about the reading shelf\`}</Md>`,
      `  <p>{'${'x'.repeat(10)} ${'longword '.repeat(40)}'}</p>`,
      `</main>`,
    ].join('\n'))
    const s = frameWords(root, 'f.tsx') ?? ''
    expect(s).toContain('Continue')
    expect(s).toMatch(/Hello/); expect(s).toMatch(/welcome back/)
    expect(s).toContain('reading shelf')
    expect(s).toContain('longword')
    expect(s).not.toContain('pricing'); expect(s).not.toContain('commented prose')
    expect(s).not.toContain('items-center')
  })
  it('extraction is linear: 64 KB after an unmatched > reads in well under 100 ms', () => {
    w('big.tsx', `export default () => <p>a > ${'word '.repeat(13000)}</p>`)
    const t0 = performance.now(); frameWords(root, 'big.tsx')
    expect(performance.now() - t0).toBeLessThan(100)
  })
  it('archive: a board\'s own type wins (plain in an archive folder is live); nearest declared type; names only when nothing is declared', () => {
    const a = classifyArchive({
      folders: [{ name: 'archive' }, { name: 'keep', type: 'project', parent: 'archive' }, { name: 'stash', type: 'archive' }],
      boards: [{ name: 'p', type: 'plain', folder: 'archive' }, { name: 'q', folder: 'archive' }, { name: 'r', folder: 'keep' }, { name: 's', folder: 'stash' }, { name: 't', status: 'archived' }],
    })
    expect([...a.boards].sort()).toEqual(['q', 's', 't'])
    expect(a.folders.has('keep')).toBe(false)
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))
})
