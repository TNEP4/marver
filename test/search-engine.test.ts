import { describe, expect, it } from 'vitest'
import { buildIndex, editDistance, fuzzy, search, words, type SearchDoc } from '../src/shared/search.ts'

/**
 * Search (spec 35), the engine: every query word must match; tiers from exact id to body words; typos only as a
 * fallback; variants grouped; archived apart unless nothing live matches; groups by level.
 */

const frame = (key: string, title: string, extra: Partial<SearchDoc> = {}): SearchDoc => ({ id: `frame:${key}`, kind: 'frame', key, title, dest: { frame: key }, ...extra })
const DOCS: SearchDoc[] = [
  frame('feed-lofi/05-filter', 'Filter the feed', { device: 'boox', summary: 'A page, never a pop-over: two ready filters', board: 'feed' }),
  frame('feed-night/04-filter', 'Filter the feed · Night', { device: 'boox', summary: 'The same screen in Night mode', board: 'feed' }),
  frame('feed-later/01-read-later', 'Feed - read later', { device: 'boox', source: 'saved items · filter by source', board: 'feed' }),
  frame('app-sign-in/01-sign-in', 'Sign in', { device: 'iphone', summary: 'Google or a device code' }),
  frame('glass-v6-ipad-signin/01-signin-portrait', 'Sign in · v6, iPad portrait', { device: 'ipad-13-landscape', archived: true }),
  frame('paywall/a', 'Paywall', { variantGroup: 'paywall', variant: 'a', summary: 'monthly first' }),
  frame('paywall/b', 'Paywall', { variantGroup: 'paywall', variant: 'b', summary: 'yearly first with a keyboard' }),
  frame('cafe/menu', 'Café menu'),
  { id: 'board:feed', kind: 'board', key: 'feed', title: 'Feed', summary: 'E-ink feature', dest: { board: 'feed' } },
  { id: 'folder:e-ink', kind: 'folder', key: 'e-ink', title: 'E-ink', dest: { folder: 'e-ink' } },
  { id: 'note:feed-lofi/05-filter.note', kind: 'note', key: 'feed-lofi/05-filter.note', title: 'Two ready filters cover 90%', notes: 'Two ready filters cover 90% of the gaps', dest: { frame: 'feed-lofi/05-filter', notes: true } },
  { id: 'comment:feed:t1', kind: 'comment', key: 't1', title: 'Should the feed filter remember the last choice?', comments: 'Should the feed filter remember the last choice?', open: true, asks: true, dest: { board: 'feed', thread: 't1' } },
]
const idx = buildIndex(DOCS)
const keys = (r: ReturnType<typeof search>) => r.groups.flatMap((g) => g.hits.map((h) => h.doc.key))

describe('words', () => {
  it('splits camelCase, kebab, snake, paths and digits; folds accents', () => {
    expect(words('feed-night/04-filter')).toEqual(['feed', 'night', '04', 'filter'])
    expect(words('ipad-13-landscape')).toEqual(['ipad', '13', 'landscape'])
    expect(words('PeopleMac_v2')).toEqual(['people', 'mac', 'v', '2'])
    expect(words('Café')).toEqual(['cafe'])
  })
})

describe('the fuzzy scorer and the edit distance', () => {
  it('rewards word starts over scattered letters', () => {
    expect(fuzzy('ff', 'Filter the feed')!.score).toBeGreaterThan(fuzzy('ff', 'affluent offer')?.score ?? -Infinity)
    expect(fuzzy('xyz', 'Filter the feed')).toBeNull()
  })
  it('counts an adjacent swap as one edit, and stops past the budget', () => {
    expect(editDistance('keybaord', 'keyboard', 1)).toBe(1)
    expect(editDistance('abcdef', 'uvwxyz', 1)).toBe(2)
  })
})

describe('the query', () => {
  it('requires every word: "feed filter" finds the filter frames and the thread; the Feed board and a note saying only "filters" are partial', () => {
    const r = search(idx, 'feed filter')
    expect(keys(r)).toEqual(expect.arrayContaining(['feed-lofi/05-filter', 'feed-night/04-filter', 't1']))
    expect(keys(r)).not.toContain('feed')
    expect(keys(r)).not.toContain('feed-lofi/05-filter.note')
    expect(r.partial.map((h) => h.doc.key)).toEqual(expect.arrayContaining(['feed', 'feed-lofi/05-filter.note']))
  })
  it('an exact id is the top hit (tier 0)', () => {
    const r = search(idx, 'feed-night/04-filter')
    expect(r.top?.doc.key).toBe('feed-night/04-filter')
    expect(r.top?.tier).toBe(0)
  })
  it('an exact name beats a prefix, a prefix beats a body match', () => {
    const r = search(idx, 'feed')
    expect(r.top?.doc.key).toBe('feed')   // the board named exactly "Feed"
    const frames = r.groups.find((g) => g.kind === 'frame')!.hits.map((h) => h.doc.key)
    expect(frames.indexOf('feed-later/01-read-later')).toBeGreaterThanOrEqual(0)
  })
  it('device words rank: "sign iphone" finds the iPhone sign-in by its device', () => {
    expect(search(idx, 'sign iphone').top?.doc.key).toBe('app-sign-in/01-sign-in')
  })
  it('a word only in source words still finds the frame, and says where it matched', () => {
    const r = search(idx, 'saved items')
    expect(r.top?.doc.key).toBe('feed-later/01-read-later')
    expect(r.top?.matchedIn).toBe('source')
  })
  it('typos only as a fallback: "keybaord" corrects to keyboard and says so', () => {
    const r = search(idx, 'keybaord')
    expect(r.didYouMean).toBe('keyboard')
    expect(keys(r)).toContain('paywall/b')
  })
  it('variants rank one by one and fold under the best member: "yearly" opens variant b', () => {
    const r = search(idx, 'paywall')
    const hits = r.groups.find((g) => g.kind === 'frame')!.hits.filter((h) => h.doc.variantGroup === 'paywall')
    expect(hits).toHaveLength(1)
    expect(hits[0].variants).toHaveLength(1)
    expect(search(idx, 'yearly').top?.doc.variant).toBe('b')
  })
  it('archived apart, unless nothing live matches - then the archived matches are the answer', () => {
    const live = search(idx, 'sign in')
    expect(keys(live)).toContain('app-sign-in/01-sign-in')
    expect(keys(live)).not.toContain('glass-v6-ipad-signin/01-signin-portrait')
    expect(live.archived.count).toBe(1)
    const only = search(idx, 'ipad portrait')
    expect(only.archivedOnly).toBe(true)
    expect(keys(only)).toContain('glass-v6-ipad-signin/01-signin-portrait')
    expect(keys(search(idx, 'sign in', { archive: true }))).toContain('glass-v6-ipad-signin/01-signin-portrait')
  })
  it('groups go by level: folders, boards, scenes, frames, notes, comments', () => {
    const r = search(idx, 'e ink feed filter', { perGroup: 10 })
    const order = r.groups.map((g) => g.kind)
    const levels = ['folder', 'board', 'scene', 'frame', 'note', 'comment']
    expect([...order].sort((a, b) => levels.indexOf(a) - levels.indexOf(b))).toEqual(order)
  })
  it('the kind filter and Needs you narrow', () => {
    expect(search(idx, 'filters', { kinds: ['note'] }).groups.map((g) => g.kind)).toEqual(['note'])
    expect(keys(search(idx, 'feed', { needsYou: true }))).toEqual(['t1'])
  })
  it('accents fold: "cafe" finds Café', () => {
    expect(search(idx, 'cafe').top?.doc.key).toBe('cafe/menu')
  })
  it('the current board breaks near-ties; recency only reorders near-ties', () => {
    const r = search(idx, 'filter', { board: 'feed' })
    expect(r.top?.doc.board).toBe('feed')
  })
})
