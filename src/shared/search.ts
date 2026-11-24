/**
 * Search (spec 35): the engine, pure - the same code ranks in the shell's worker and in `marver search`.
 *
 * Documents come from the builder (server/search-docs.ts): one per folder, board, scene, frame, sticky note and comment
 * thread, each with its fields. A query is words; EVERY word must match somewhere in a document (any field, any order)
 * for it to be a full match - documents matching only some go to Partial. Full matches are ranked in tiers, a lower
 * tier never above a higher one:
 *
 *   0 exact id ("feed-night/04-filter")      4 every word, whole, in the summary
 *   1 exact name                              5 fuzzy name (characters in order, fzf-style bonuses), above a threshold
 *   2 the name starts with the query          6 every word in name, device or summary (prefixes)
 *   3 every word starts a word of the name    7 a word only in a body field (notes, comments, source)
 *     or the device
 *
 * then by score inside a tier: the match itself, the context (current board, folder), the person's recency (bounded to
 * near-ties), the shorter name. Typos (one edit, or a swap, on words of 5+ letters; two on 9+) run only when fewer than
 * 5 full matches exist. Variants rank one by one and group after. Archived documents are held apart unless asked for.
 */

export type SearchKind = 'folder' | 'board' | 'scene' | 'frame' | 'note' | 'comment'
/** By level: folders hold boards, boards show scenes, scenes hold frames, then the notes and comments on them. */
export const KIND_ORDER: readonly SearchKind[] = ['folder', 'board', 'scene', 'frame', 'note', 'comment']

/** Where a result goes - applied by the shell's non-mutating show path (never goTo). */
export interface Destination { board?: string; frame?: string; scene?: string; folder?: string; node?: string; thread?: string; notes?: boolean }

export interface SearchDoc {
  /** `<kind>:<key>` - stable across rebuilds */
  id: string
  kind: SearchKind
  /** the thing's own id: a frame id, a board or folder or scene name, a thread id */
  key: string
  /** what a person reads as its name */
  title: string
  /** the device (viewport) name, for frames */
  device?: string
  summary?: string
  notes?: string
  comments?: string
  source?: string
  /** where it is, for the second line: "Feed › Feed, lo-fi" */
  where?: string
  board?: string
  folder?: string
  scene?: string
  frame?: string
  archived?: boolean
  variantGroup?: string
  variant?: string
  /** the frame the live preview renders for a board or scene (its first frame) */
  preview?: string
  /** comment threads: open, and whether the last word asks the person */
  open?: boolean
  asks?: boolean
  dest: Destination
}

// ---- words ---------------------------------------------------------------------------------------------

/** Lower case, accents folded. */
export const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** The words of a string: camelCase, kebab-case, snake_case, paths, digits split; folded. */
export function words(s: string | undefined): string[] {
  if (!s) return []
  const spaced = s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
  return fold(spaced).split(/[^a-z0-9]+/).filter(Boolean)
}

/** A device name read as words people type: `ipad-13-landscape` → ipad 13 landscape; `boox` stays. */
export const deviceWords = (d: string | undefined): string[] => words(d)

// ---- the fuzzy name scorer (VS Code / fzf style) -----------------------------------------------------------

const SEP = /[\s\-_/.:'"·›,()]/
/**
 * Characters of `q` in order in `text` (folded), scored: +1 a match, consecutive runs +5 each, a word start +8
 * (after a separator, or the very start), a camelCase capital +4, a gap -1 per skipped character (capped).
 * Returns the score and the matched positions, or null when not every character matches.
 */
export function fuzzy(q: string, text: string): { score: number; at: number[] } | null {
  const fq = fold(q).replace(/\s+/g, ''), ft = fold(text)
  if (!fq) return null
  let qi = 0, score = 0, last = -2
  const at: number[] = []
  for (let i = 0; i < ft.length && qi < fq.length; i++) {
    if (ft[i] !== fq[qi]) continue
    const start = i === 0 || SEP.test(text[i - 1] ?? ' ')
    const camel = i > 0 && /[a-z]/.test(text[i - 1] ?? '') && /[A-Z]/.test(text[i] ?? '')
    score += 1 + (last === i - 1 ? 5 : 0) + (start ? 8 : 0) + (camel ? 4 : 0) - (last >= 0 ? Math.min(i - last - 1, 6) : Math.min(i, 3))
    at.push(i); last = i; qi++
  }
  return qi === fq.length ? { score, at } : null
}

/** Below this per-character score a fuzzy name match is noise (a scattered subsequence). */
const FUZZY_FLOOR = 3

// ---- Damerau-Levenshtein, bounded --------------------------------------------------------------------------

/** Edit distance with adjacent swaps, stopping early past `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const n = b.length
  let prev2: number[] = [], prev = Array.from({ length: n + 1 }, (_, j) => j), cur: number[] = []
  for (let i = 1; i <= a.length; i++) {
    cur = [i]
    let low = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1)
      cur[j] = v
      if (v < low) low = v
    }
    if (low > max) return max + 1
    prev2 = prev; prev = cur
  }
  return prev[n]
}
const typoBudget = (w: string): number => (w.length >= 9 ? 2 : w.length >= 5 ? 1 : 0)

// ---- the index -----------------------------------------------------------------------------------------------

type Field = 'name' | 'device' | 'summary' | 'notes' | 'comments' | 'source'
const BODY: readonly Field[] = ['notes', 'comments', 'source']
const WEIGHT: Record<Field, number> = { name: 10, device: 6, summary: 5, notes: 4, comments: 3, source: 1 }

interface Prepared {
  doc: SearchDoc
  idFold: string
  titleFold: string
  /** words per field */
  f: Record<Field, string[]>
  /** every word of the doc, for "each query word somewhere" */
  all: Set<string>
}

export interface SearchIndex {
  docs: Prepared[]
  /** sorted distinct words, for prefix and typo lookups */
  vocab: string[]
  /** word -> doc indexes */
  postings: Map<string, number[]>
  version: number
}

export function buildIndex(docs: readonly SearchDoc[], version = 0): SearchIndex {
  const prepared: Prepared[] = []
  const postings = new Map<string, number[]>()
  docs.forEach((doc, i) => {
    const fileName = doc.key.split('/').pop() ?? doc.key
    const f: Record<Field, string[]> = {
      name: [...new Set([...words(doc.title), ...words(fileName), ...(doc.kind === 'frame' || doc.kind === 'scene' ? words(doc.key) : [])])],
      device: deviceWords(doc.device),
      summary: words(doc.summary),
      notes: words(doc.notes),
      comments: words(doc.comments),
      source: words(doc.source),
    }
    const all = new Set<string>()
    for (const k of Object.keys(f) as Field[]) for (const w of f[k]) all.add(w)
    for (const w of all) { const p = postings.get(w); if (p) p.push(i); else postings.set(w, [i]) }
    prepared.push({ doc, idFold: fold(doc.key), titleFold: fold(doc.title).trim(), f, all })
  })
  return { docs: prepared, vocab: [...postings.keys()].sort(), postings, version }
}

/** Words of the vocabulary starting with `p` (binary search on the sorted list). */
function withPrefix(vocab: string[], p: string): string[] {
  let lo = 0, hi = vocab.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (vocab[m] < p) lo = m + 1; else hi = m }
  const out: string[] = []
  for (let i = lo; i < vocab.length && vocab[i].startsWith(p); i++) out.push(vocab[i])
  return out
}

// ---- the query -------------------------------------------------------------------------------------------------

export interface SearchOptions {
  /** kinds to include; empty or absent = all */
  kinds?: readonly SearchKind[]
  /** include archived documents in the ranked groups */
  archive?: boolean
  /** "Needs you": only threads asking the person */
  needsYou?: boolean
  /** context boosts */
  board?: string
  folder?: string
  /** doc id -> a recency weight 0..1 (frecency, computed by the caller) */
  recency?: ReadonlyMap<string, number>
  /** results kept per group (default 6) */
  perGroup?: number
}

export interface Hit {
  doc: SearchDoc
  tier: number
  score: number
  /** which field matched outside the name, for "in note" */
  matchedIn?: 'note' | 'comment' | 'source' | 'summary'
  /** a corrected word, when the match came from the typo pass */
  corrected?: string
  /** matched character positions in the title (fuzzy) */
  at?: number[]
  /** variant siblings folded under this hit */
  variants?: SearchDoc[]
}

export interface SearchResult {
  query: string
  /** best first */
  top?: Hit
  groups: { kind: SearchKind; hits: Hit[]; more: number }[]
  partial: Hit[]
  archived: { count: number; hits: Hit[] }
  /** how many documents were searched */
  searched: number
  /** a typo correction used for the whole query, when one was */
  didYouMean?: string
  /** nothing live matched: the groups hold archived results */
  archivedOnly?: boolean
}

interface Scored { i: number; tier: number; score: number; matchedIn?: Hit['matchedIn']; at?: number[] }

/** Does query word `q` match document word set `ws` (as a prefix of one of its words)? */
const matchesIn = (q: string, ws: readonly string[]): boolean => ws.some((w) => w.startsWith(q))

export function search(index: SearchIndex, query: string, opts: SearchOptions = {}): SearchResult {
  const q = query.trim()
  const terms = words(q)
  const perGroup = opts.perGroup ?? 6
  const kinds = opts.kinds?.length ? new Set(opts.kinds) : null
  const empty: SearchResult = { query: q, groups: [], partial: [], archived: { count: 0, hits: [] }, searched: index.docs.length }
  if (!terms.length) return empty

  // resolved threads - one rule for the lens and the CLI: only when comments are the only kind asked for, or (second
  // pass, below) when nothing else matches
  const onlyComments = !!kinds && kinds.size === 1 && kinds.has('comment')
  let allowResolved = onlyComments
  const eligible = (p: Prepared) => (!kinds || kinds.has(p.doc.kind)) && (!opts.needsYou || (p.doc.kind === 'comment' && p.doc.open && p.doc.asks))
    && (allowResolved || p.doc.kind !== 'comment' || p.doc.open !== false)

  // candidates: documents holding a word that starts with each term (intersection = full; union = partial)
  const perTerm = terms.map((t) => {
    const set = new Set<number>()
    for (const w of withPrefix(index.vocab, t)) for (const i of index.postings.get(w) ?? []) set.add(i)
    return set
  })
  // fuzzy names: every eligible doc's title against the whole query (cheap: a few thousand short strings)
  const fuzzyHits = new Map<number, { score: number; at: number[] }>()
  const qCompact = terms.join('')
  if (qCompact.length >= 2) {
    index.docs.forEach((p, i) => {
      if (!eligible(p)) return
      const fz = fuzzy(qCompact, p.doc.title)
      if (fz && fz.score / qCompact.length >= FUZZY_FLOOR) fuzzyHits.set(i, fz)
    })
  }

  const full = new Set<number>()
  const partial = new Set<number>()
  const counts = new Map<number, number>()
  perTerm.forEach((set) => { for (const i of set) counts.set(i, (counts.get(i) ?? 0) + 1) })
  for (const [i, n] of counts) { if (!eligible(index.docs[i])) continue; if (n === terms.length) full.add(i); else partial.add(i) }
  for (const i of fuzzyHits.keys()) { full.add(i); partial.delete(i) }

  const qFold = fold(q)
  const scoreDoc = (i: number): Scored => {
    const p = index.docs[i], d = p.doc
    const nameAndDevice = [...p.f.name, ...p.f.device]
    let tier = 7, score = 0
    let matchedIn: Hit['matchedIn']
    const fz = fuzzyHits.get(i)
    if (p.idFold === qFold) tier = 0
    else if (p.titleFold === qFold || (d.key.split('/').pop() ?? '') === qFold) tier = 1
    else if (p.titleFold.startsWith(qFold)) tier = 2
    else if (terms.every((t) => matchesIn(t, nameAndDevice))) tier = 3
    else if (terms.every((t) => p.f.summary.includes(t))) { tier = 4; matchedIn = 'summary' }
    else if (fz) tier = 5
    else if (terms.every((t) => matchesIn(t, [...nameAndDevice, ...p.f.summary]))) { tier = 6; matchedIn = 'summary' }
    else {
      tier = 7
      for (const fld of BODY) if (terms.some((t) => matchesIn(t, p.f[fld]))) { matchedIn = fld === 'notes' ? 'note' : fld === 'comments' ? 'comment' : 'source'; break }
    }
    // the match itself: each term's best field weight, exact words over prefixes, the fuzzy score
    for (const t of terms) {
      let best = 0
      for (const fld of Object.keys(p.f) as Field[]) {
        const ws = p.f[fld]
        if (ws.includes(t)) best = Math.max(best, WEIGHT[fld] * 1.5)
        else if (matchesIn(t, ws)) best = Math.max(best, WEIGHT[fld])
      }
      score += best
    }
    if (fz) score += fz.score / 4
    if (opts.board && d.board === opts.board) score += 6
    else if (opts.folder && d.folder === opts.folder) score += 3
    score -= Math.min(d.title.length, 80) / 40   // the shorter name, by a hair
    return { i, tier, score, matchedIn, at: fz?.at }
  }

  if (!full.size && !allowResolved && !opts.needsYou) {
    allowResolved = true
    for (const [i, n] of counts) { if (!eligible(index.docs[i])) continue; if (n === terms.length) full.add(i); else partial.add(i) }
  }
  let scored = [...full].map(scoreDoc)
  let didYouMean: string | undefined
  // typos: only when exact and prefix matching found little
  if (scored.filter((s) => !index.docs[s.i].doc.archived).length < 5) {
    const fixed = terms.map((t) => {
      const budget = typoBudget(t)
      if (!budget || /^\d+$/.test(t) || index.postings.has(t) || withPrefix(index.vocab, t).length) return t
      let best: { w: string; d: number } | null = null
      for (const w of index.vocab) {
        if (Math.abs(w.length - t.length) > budget) continue
        const dist = editDistance(t, w, budget)
        if (dist <= budget && (!best || dist < best.d || (dist === best.d && (index.postings.get(w)?.length ?? 0) > (index.postings.get(best.w)?.length ?? 0)))) best = { w, d: dist }
      }
      return best?.w ?? t
    })
    if (fixed.some((w, k) => w !== terms[k])) {
      didYouMean = fixed.join(' ')
      const again = search(index, didYouMean, { ...opts })
      const seen = new Set(scored.map((s) => s.i))
      const extra: Scored[] = []
      const take = (h: Hit) => { const i = index.docs.findIndex((p) => p.doc.id === h.doc.id); if (i >= 0 && !seen.has(i)) { seen.add(i); extra.push({ i, tier: h.tier + 10, score: h.score, matchedIn: h.matchedIn, at: h.at }) } }
      if (again.top) take(again.top)
      for (const g of again.groups) g.hits.forEach(take)
      again.archived.hits.forEach(take)
      scored = [...scored, ...extra]
    }
  }

  // recency: only between near-ties (within 15% of each other's match score), so it never lifts a weak match
  const rank = (a: Scored, b: Scored): number => {
    if (a.tier !== b.tier) return a.tier - b.tier
    const ra = opts.recency?.get(index.docs[a.i].doc.id) ?? 0, rb = opts.recency?.get(index.docs[b.i].doc.id) ?? 0
    const near = Math.abs(a.score - b.score) <= 0.15 * Math.max(Math.abs(a.score), Math.abs(b.score), 1)
    if (near && ra !== rb) return rb - ra
    if (a.score !== b.score) return b.score - a.score
    return index.docs[a.i].doc.title.length - index.docs[b.i].doc.title.length
  }
  scored.sort(rank)

  const toHit = (s: Scored): Hit => ({ doc: index.docs[s.i].doc, tier: s.tier, score: s.score, ...(s.matchedIn ? { matchedIn: s.matchedIn } : {}), ...(s.at ? { at: s.at } : {}), ...(s.tier >= 10 && didYouMean ? { corrected: didYouMean } : {}) })

  // archived apart (an exact id or name of an archived thing still ranks)
  let live: Hit[] = [], archived: Hit[] = []
  for (const s of scored) {
    const h = toHit(s)
    if (h.doc.archived && !opts.archive && s.tier > 1) archived.push(h); else live.push(h)
  }
  // nothing live matches: the archived matches ARE the answer - shown, marked archived, never an empty glass
  const archivedOnly = !live.length && archived.length > 0
  if (archivedOnly) { live = archived; archived = [] }
  // variants: members ranked one by one, then folded under the best of each group
  const folded: Hit[] = []
  const byGroup = new Map<string, Hit>()
  for (const h of live) {
    const g = h.doc.variantGroup
    if (!g) { folded.push(h); continue }
    const lead = byGroup.get(g)
    if (lead) (lead.variants ??= []).push(h.doc)
    else { byGroup.set(g, h); folded.push(h) }
  }

  const top = folded[0]
  const groups = KIND_ORDER.map((kind) => {
    const all = folded.filter((h) => h.doc.kind === kind)
    return { kind, hits: all.slice(0, perGroup), more: Math.max(0, all.length - perGroup) }
  }).filter((g) => g.hits.length)
  const partialHits = [...partial].map((i) => toHit({ ...scoreDoc(i), tier: 20 })).filter((h) => !h.doc.archived || opts.archive).sort((a, b) => b.score - a.score).slice(0, perGroup)
  return { query: q, top, groups, partial: partialHits, archived: { count: archived.length, hits: archived.slice(0, perGroup) }, searched: index.docs.length, ...(archivedOnly ? { archivedOnly } : {}), ...(didYouMean ? { didYouMean } : {}) }
}
