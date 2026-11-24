/**
 * Search (spec 35): the engine, pure - the same code ranks in the shell and in `marver search`.
 *
 * Documents come from the builder (server/search-docs.ts): one per folder, board, scene, frame, sticky note and comment
 * thread. A query is words; EVERY word must match somewhere in a document (any field, any order) for a full match -
 * documents matching only some are Partial. Full matches go in tiers, a lower tier never above a higher one:
 *
 *   0 exact id ("feed-night/04-filter")          4 the words, in order and whole, in the summary
 *   1 exact name (the title)                     5 fuzzy name (characters in order, best alignment, fzf-style)
 *   2 the name starts with the query             6 every word in name, device, kind words or summary
 *   3 every word starts a word of the name,      7 a word only in a body field (notes, comments, source)
 *     its device or its kind words
 *
 * then a deterministic order: the match score in fixed cohorts, the context (current board, then folder), the person's
 * recency, the score itself, the shorter name, the newer file, the id. Typos (one edit or swap on words of 5+ letters,
 * two on 9+; never ids or numbers) are a separate channel, used only when fewer than 5 live full matches exist, ranked
 * after every exact match. Variants fold under their best member. Archived documents are held behind a fold unless
 * asked for - an exact id or name of an archived thing is still a result.
 *
 * Cost (Codex's step-1 review): candidates come from postings and a letter-mask prefilter, never an alignment of every
 * title; partials are ranked cheaply; the typo channel scans only vocabulary words of a near length and the same first
 * letter. Everything found is ordered, partitioned, folded and truncated once. Every hit keeps its document index.
 */

export type SearchKind = 'folder' | 'board' | 'scene' | 'frame' | 'note' | 'comment'
/** By level: folders hold boards, boards show scenes, scenes hold frames, then the notes and comments on them. */
export const KIND_ORDER: readonly SearchKind[] = ['folder', 'board', 'scene', 'frame', 'note', 'comment']

/** Where a result goes - applied by the shell's non-mutating show path (never goTo). */
export interface Destination { board?: string; frame?: string; scene?: string; folder?: string; node?: string; thread?: string; notes?: boolean; unplaced?: boolean }

export interface SearchDoc {
  /** `<kind>:<key>` - stable across rebuilds (a thread's carries its board) */
  id: string
  kind: SearchKind
  /** the thing's own id: a frame id, a board or folder or scene name, a thread id */
  key: string
  /** what a person reads as its name */
  title: string
  /** the device (viewport) name, for frames */
  device?: string
  /** words that say what kind of thing it is: a board's or folder's type and status, a frame's intent, "slide" */
  kinds?: string
  summary?: string
  notes?: string
  comments?: string
  source?: string
  /** where it is, for the second line: "Feed › Feed, lo-fi" */
  where?: string
  /** every board it is on (a frame, a scene), or its own (a board, a thread); sidebar order */
  boards?: string[]
  /** its folder chain, nearest first */
  folders?: string[]
  board?: string
  scene?: string
  frame?: string
  /** the file it comes from (repo-relative) */
  file?: string
  /** newest change (ms): a file's mtime, a thread's last message */
  at?: number
  archived?: boolean
  variantGroup?: string
  variant?: string
  /** the frame the live preview renders for a board or scene (its first frame) */
  preview?: string
  /** comment threads: open; waiting on the person (the marks' rule: the last word is Marver's); that word asks */
  open?: boolean
  waiting?: boolean
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

/** A letter mask (a-z, and one bit for any digit): a cheap "could these characters be in this title" prefilter. */
function maskOf(s: string): number {
  let m = 0
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k)
    if (c >= 97 && c <= 122) m |= 1 << (c - 97)
    else if (c >= 48 && c <= 57) m |= 1 << 26
  }
  return m
}

// ---- the fuzzy name scorer (fzf-style, best alignment) -------------------------------------------------------

const SEP = /[\s\-_/.:'"·›,()]/
const bonusAt = (text: string, i: number): number => {
  if (i === 0 || SEP.test(text[i - 1] ?? ' ')) return 8
  if (/[a-z]/.test(text[i - 1] ?? '') && /[A-Z]/.test(text[i] ?? '')) return 6
  return 0
}
/**
 * The best alignment of `q`'s characters, in order, in `text` (folded): +1 a match, +8 at a word start, +6 at a
 * camelCase capital, +4 for continuing a run; a gap costs 1 per skipped character, at most 4; a late first match costs
 * up to 3. Dynamic programming over (query char, text position): every alignment is considered, not the first one
 * found. Null when the characters do not all appear in order.
 */
export function fuzzy(q: string, text: string): { score: number; at: number[] } | null {
  return fuzzyFolded(fold(q).replace(/\s+/g, ''), fold(text), text)
}
function fuzzyFolded(fq: string, ft: string, text: string): { score: number; at: number[] } | null {
  const n = fq.length, m = ft.length
  if (!n || n > m) return null
  // in order at all? (linear; most candidates stop here)
  for (let k = 0, j = 0; k < n; k++, j++) { j = ft.indexOf(fq[k], j); if (j < 0) return null }
  const NEG = -1e9
  const S: Float64Array[] = [], P: Int32Array[] = []
  for (let k = 0; k < n; k++) {
    const cur = new Float64Array(m).fill(NEG), ptr = new Int32Array(m).fill(-1)
    const prev = k ? S[k - 1] : null
    // prefix maximum of the previous row (value and where), for gaps longer than 4
    let pmV = NEG, pmAt = -1
    for (let j = 0; j < m; j++) {
      if (prev && j - 5 >= 0 && prev[j - 5] > pmV) { pmV = prev[j - 5]; pmAt = j - 5 }
      if (ft[j] !== fq[k]) continue
      const base = 1 + bonusAt(text, j)
      if (!prev) { cur[j] = base - Math.min(j, 3); continue }
      let bestV = NEG, bestAt = -1
      if (j >= 1 && prev[j - 1] > NEG) { bestV = prev[j - 1] + 4; bestAt = j - 1 }   // a run
      for (let g = 1; g <= 3; g++) { const i = j - 1 - g; if (i >= 0 && prev[i] > NEG && prev[i] - g > bestV) { bestV = prev[i] - g; bestAt = i } }
      if (pmAt >= 0 && pmV > NEG && pmV - 4 > bestV) { bestV = pmV - 4; bestAt = pmAt }
      if (bestAt >= 0) { cur[j] = bestV + base; ptr[j] = bestAt }
    }
    S.push(cur); P.push(ptr)
  }
  let end = -1, score = NEG
  for (let j = 0; j < m; j++) if (S[n - 1][j] > score) { score = S[n - 1][j]; end = j }
  if (end < 0) return null
  const at: number[] = new Array(n)
  for (let k = n - 1, j = end; k >= 0; k--) { at[k] = j; j = P[k][j] }
  return { score, at }
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

type Field = 'name' | 'device' | 'kinds' | 'summary' | 'notes' | 'comments' | 'source'
const FIELDS: readonly Field[] = ['name', 'device', 'kinds', 'summary', 'notes', 'comments', 'source']
const BODY: readonly Field[] = ['notes', 'comments', 'source']
const WEIGHT: Record<Field, number> = { name: 10, device: 6, kinds: 6, summary: 5, notes: 4, comments: 3, source: 1 }

/** One bit per field, in FIELDS order: postings carry which fields of a document hold a word. */
const BIT: Record<Field, number> = { name: 1, device: 2, kinds: 4, summary: 8, notes: 16, comments: 32, source: 64 }
const NAMEISH = BIT.name | BIT.device | BIT.kinds
const BODY_BITS = BIT.notes | BIT.comments | BIT.source
/** The best field weight a mask of fields gives a word: [exact][mask] */
const BEST: [Float64Array, Float64Array] = [new Float64Array(128), new Float64Array(128)]
for (let m = 0; m < 128; m++) for (const f of FIELDS) if (m & BIT[f]) { BEST[0][m] = Math.max(BEST[0][m], WEIGHT[f]); BEST[1][m] = Math.max(BEST[1][m], WEIGHT[f] * 1.5) }

interface Prepared {
  doc: SearchDoc
  idFold: string
  titleFold: string
  titleMask: number
  /** letters that start a word of the title (a fuzzy match must begin at one) */
  startMask: number
  summary: string[]
}

export interface SearchIndex {
  docs: Prepared[]
  /** sorted distinct words, for prefix lookups */
  vocab: string[]
  /** word -> doc indexes, and which fields of each hold it */
  postings: Map<string, number[]>
  fieldsOf: Map<string, number[]>
  /** first letter + length -> vocabulary words, for the typo channel */
  byShape: Map<string, string[]>
  /** exact id (folded) -> doc indexes */
  ids: Map<string, number[]>
  version: number
}

export function buildIndex(docs: readonly SearchDoc[], version = 0): SearchIndex {
  const prepared: Prepared[] = []
  const postings = new Map<string, number[]>()
  const fieldsOf = new Map<string, number[]>()
  const ids = new Map<string, number[]>()
  docs.forEach((doc, i) => {
    const frameish = doc.kind === 'frame' || doc.kind === 'scene'
    const f: Record<Field, string[]> = {
      name: [...new Set([...words(doc.title), ...(frameish ? words(doc.key) : [])])],
      device: words(doc.device),
      kinds: words(doc.kinds),
      summary: words(doc.summary),
      notes: words(doc.notes),
      comments: words(doc.comments),
      source: words(doc.source),
    }
    const all = new Map<string, number>()
    for (const k of FIELDS) for (const w of f[k]) all.set(w, (all.get(w) ?? 0) | BIT[k])
    for (const [w, m] of all) { const p = postings.get(w); if (p) { p.push(i); fieldsOf.get(w)!.push(m) } else { postings.set(w, [i]); fieldsOf.set(w, [m]) } }
    const idf = fold(doc.key)
    const l = ids.get(idf); if (l) l.push(i); else ids.set(idf, [i])
    const titleFold = fold(doc.title).trim()
    let startMask = 0
    for (let k = 0; k < doc.title.length; k++) if (bonusAt(doc.title, k) > 0) startMask |= maskOf(fold(doc.title[k]))
    prepared.push({ doc, idFold: idf, titleFold, titleMask: maskOf(titleFold), startMask, summary: f.summary })
  })
  const vocab = [...postings.keys()].sort()
  const byShape = new Map<string, string[]>()
  for (const w of vocab) { const k = `${w[0]}${w.length}`; const l = byShape.get(k); if (l) l.push(w); else byShape.set(k, [w]) }
  return { docs: prepared, vocab, postings, fieldsOf, byShape, ids, version }
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
  /** "Needs you": only open threads waiting on the person (with no words: all of them, newest first) */
  needsYou?: boolean
  /** context: the current board, its folder */
  board?: string
  folder?: string
  /** doc id -> a recency weight 0..1 (computed by the caller) */
  recency?: ReadonlyMap<string, number>
  /** results kept per group (default 6) */
  perGroup?: number
}

export interface Hit {
  doc: SearchDoc
  /** the document's index in the search index */
  i: number
  tier: number
  score: number
  /** which field matched outside the name, for "in note" */
  matchedIn?: 'note' | 'comment' | 'source' | 'summary'
  /** the corrected query, when the match came from the typo channel */
  corrected?: string
  /** matched character positions in the title (fuzzy) */
  at?: number[]
  /** variant siblings folded under this hit */
  variants?: SearchDoc[]
}

export interface SearchResult {
  query: string
  /** the best result */
  top?: Hit
  groups: { kind: SearchKind; hits: Hit[]; more: number }[]
  partial: Hit[]
  archived: { count: number; hits: Hit[] }
  /** how many documents were searched */
  searched: number
  /** the corrected query, when the typo channel found matches */
  didYouMean?: string
}

interface Scored { i: number; tier: number; score: number; ctx: number; matchedIn?: Hit['matchedIn']; at?: number[]; corrected?: boolean }

/** A query that names an id (a scene/frame path): looked up exactly, never corrected. */
const ID_LIKE = /^[\w.-]+\/[\w./-]+$/
const prefixIn = (t: string, ws: readonly string[]): boolean => { for (const w of ws) if (w.startsWith(t)) return true; return false }

export function search(index: SearchIndex, query: string, opts: SearchOptions = {}): SearchResult {
  const q = query.trim()
  const perGroup = opts.perGroup ?? 6
  const kinds = opts.kinds?.length ? new Set(opts.kinds) : null
  const onlyComments = !!kinds && kinds.size === 1 && kinds.has('comment')
  const eligibleWith = (allowResolved: boolean) => (p: Prepared) =>
    (!kinds || kinds.has(p.doc.kind))
    && (!opts.needsYou || (p.doc.kind === 'comment' && !!p.doc.waiting))
    && (allowResolved || !!opts.needsYou || p.doc.kind !== 'comment' || p.doc.open !== false)
  const ctxOf = (p: Prepared): number => (opts.board && p.doc.boards?.includes(opts.board) ? 2 : opts.folder && p.doc.folders?.includes(opts.folder) ? 1 : 0)

  // Needs you with nothing typed: every open thread waiting on the person, newest first
  if (!q) {
    if (!opts.needsYou) return finish(index, q, [], [], opts, perGroup)
    const el = eligibleWith(false)
    const scored: Scored[] = []
    index.docs.forEach((p, i) => { if (el(p)) scored.push({ i, tier: 7, score: (p.doc.at ?? 0) / 1e12, ctx: ctxOf(p) }) })
    return finish(index, q, scored, [], opts, perGroup)
  }

  // a lone letter beside longer words says nothing ("s12/12", "sign in a"); a digit does ("feed 4")
  const all = words(q)
  const terms = all.length > 1 && all.some((t) => t.length > 1) ? all.filter((t) => t.length > 1 || /\d/.test(t)) : all
  if (!terms.length) return finish(index, q, [], [], opts, perGroup)
  const qFold = fold(q)
  const idQuery = ID_LIKE.test(q)

  const N = index.docs.length
  /** Every term as a prefix of a word, from the postings alone: per document how many terms matched, the best field
   *  weight of each, whether every term is in the name (or device, kind words), in the name or summary, and which body
   *  fields held one - no document's words are read. */
  const run = (ts: string[], eligible: (p: Prepared) => boolean) => {
    const counts = new Int32Array(N), name = new Int32Array(N), nameSum = new Int32Array(N), body = new Int32Array(N)
    const score = new Float64Array(N), tBest = new Float64Array(N), tMask = new Int32Array(N), stamp = new Int32Array(N)
    const touched: number[] = []
    ts.forEach((t, k) => {
      const mine: number[] = []
      for (const w of withPrefix(index.vocab, t)) {
        const exact = w === t ? 1 : 0, ds = index.postings.get(w)!, ms = index.fieldsOf.get(w)!
        for (let j = 0; j < ds.length; j++) {
          const d = ds[j], m = ms[j]
          if (stamp[d] !== k + 1) { stamp[d] = k + 1; tBest[d] = 0; tMask[d] = 0; mine.push(d); if (!counts[d]) touched.push(d); counts[d]++ }
          const v = BEST[exact][m]; if (v > tBest[d]) tBest[d] = v
          tMask[d] |= m
        }
      }
      for (const d of mine) { score[d] += tBest[d]; const m = tMask[d]; if (m & NAMEISH) name[d]++; if (m & (NAMEISH | BIT.summary)) nameSum[d]++; body[d] |= m & BODY_BITS }
    })
    const full = new Map<number, Scored>()
    const partialCount = new Map<number, number>()
    const n = ts.length
    for (const d of touched) {
      const p = index.docs[d]
      if (!eligible(p)) continue
      if (counts[d] < n) { partialCount.set(d, counts[d]); continue }
      let tier: number, matchedIn: Hit['matchedIn']
      if (p.idFold === qFold) tier = 0
      else if (p.titleFold === qFold) tier = 1
      else if (p.titleFold.startsWith(qFold)) tier = 2
      else if (name[d] === n) tier = 3
      else if (nameSum[d] === n && phraseIn(ts, p.summary)) { tier = 4; matchedIn = 'summary' }
      else if (nameSum[d] === n) { tier = 6; matchedIn = 'summary' }
      else { tier = 7; const b = body[d]; matchedIn = b & BIT.notes ? 'note' : b & BIT.comments ? 'comment' : 'source' }
      full.set(d, { i: d, tier, score: score[d], ctx: ctxOf(p), ...(matchedIn ? { matchedIn } : {}) })
    }
    // fuzzy names: only titles holding every query letter, the first at a word start, get an alignment
    // one word only - an abbreviation ("gk", "setipad"); several words are words, and scattered letters across them
    // are noise. A two-letter word that already matched broadly gains nothing from scattered letters either
    const compact = ts.length === 1 && !/\s/.test(q) ? ts[0] : ''
    if (compact.length >= 3 || (compact.length === 2 && full.size < 20)) {
      const qm = maskOf(compact), first = maskOf(compact[0])
      for (let d = 0; d < N; d++) {
        const p = index.docs[d]
        if ((p.titleMask & qm) !== qm || (p.startMask & first) === 0 || p.titleFold.length > 48 || full.has(d) || !eligible(p)) continue   // names, not a note's first line
        const fz = fuzzyFolded(compact, p.titleFold, p.doc.title)
        if (!fz || fz.score / compact.length < FUZZY_FLOOR) continue
        partialCount.delete(d)
        full.set(d, { i: d, tier: 5, score: fz.score, ctx: ctxOf(p), at: fz.at })
      }
    }
    return { full, partialCount }
  }

  const scope = (allowResolved: boolean) => {
    const eligible = eligibleWith(allowResolved)
    const base = run(terms, eligible)
    // an exact id is always found (a structured query is never "corrected")
    if (idQuery) for (const i of index.ids.get(qFold) ?? []) if (eligible(index.docs[i]) && !base.full.has(i)) base.full.set(i, { i, tier: 0, score: 100, ctx: ctxOf(index.docs[i]) })
    let didYouMean: string | undefined
    let liveFull = 0
    for (const s of base.full.values()) if (!index.docs[s.i].doc.archived) liveFull++
    if (!idQuery && liveFull < 5) {
      const fixed = terms.map((t) => correct(index, t, eligible))
      if (fixed.some((w, k) => w !== terms[k])) {
        const typo = run(fixed, eligible)
        let added = 0
        for (const [i, s] of typo.full) if (!base.full.has(i)) { base.full.set(i, { ...s, tier: s.tier + 10, corrected: true }); base.partialCount.delete(i); added++ }
        if (added) didYouMean = fixed.join(' ')
      }
    }
    return { ...base, didYouMean }
  }

  let r = scope(onlyComments)
  // resolved threads - one rule for the lens and the CLI: only when comments are the only kind asked for, or when
  // nothing else matches (every channel run again under that rule)
  if (!r.full.size && !onlyComments && !opts.needsYou) r = scope(true)
  const partial: Scored[] = []
  for (const [i, n] of r.partialCount) partial.push({ i, tier: 20, score: n * 10 - index.docs[i].doc.title.length / 1000, ctx: 0 })
  return finish(index, q, [...r.full.values()], partial, opts, perGroup, r.didYouMean)
}

/** The words of `ts`, in order and whole (the last may be a prefix), somewhere in `ws`. */
function phraseIn(ts: string[], ws: string[]): boolean {
  if (!ts.length || ws.length < ts.length) return false
  outer: for (let k = 0; k + ts.length <= ws.length; k++) {
    for (let j = 0; j < ts.length; j++) {
      const w = ws[k + j], t = ts[j]
      if (j === ts.length - 1 ? !w.startsWith(t) : w !== t) continue outer
    }
    return true
  }
  return false
}

/** A word nothing eligible holds, corrected: the closest vocabulary word of a near length and the same first letter that
 *  an eligible document holds (most documents first on a tie). Never a word with a digit. */
function correct(index: SearchIndex, t: string, eligible: (p: Prepared) => boolean): string {
  const budget = typoBudget(t)
  if (!budget || /\d/.test(t)) return t
  const held = (w: string) => { for (const i of index.postings.get(w) ?? []) if (eligible(index.docs[i])) return true; return false }
  for (const w of withPrefix(index.vocab, t)) if (held(w)) return t
  let best: { w: string; d: number; n: number } | null = null
  for (let len = t.length - budget; len <= t.length + budget; len++) {
    for (const w of index.byShape.get(`${t[0]}${len}`) ?? []) {
      const d = editDistance(t, w, budget)
      if (d > budget || !held(w)) continue
      const n = index.postings.get(w)?.length ?? 0
      if (!best || d < best.d || (d === best.d && n > best.n)) best = { w, d, n }
    }
  }
  return best?.w ?? t
}

/** Order, partition, fold and truncate - once, on everything found. */
function finish(index: SearchIndex, q: string, scored: Scored[], partial: Scored[], opts: SearchOptions, perGroup: number, didYouMean?: string): SearchResult {
  const doc = (s: Scored) => index.docs[s.i].doc
  // a deterministic order: fixed score cohorts (no pairwise near-tie rule, so it is transitive); keys computed once
  type K = Scored & { coh: number; rec: number; tl: number; mt: number; id: string }
  const keyed = (s: Scored): K => { const d = doc(s); return { ...s, coh: Math.floor(s.score / 3), rec: opts.recency?.get(d.id) ?? 0, tl: d.title.length, mt: d.at ?? 0, id: d.id } }
  const cmp = (a: K, b: K): number => a.tier - b.tier || b.coh - a.coh || b.ctx - a.ctx || b.rec - a.rec || b.score - a.score || a.tl - b.tl || b.mt - a.mt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const toHit = (s: Scored): Hit => ({ doc: doc(s), i: s.i, tier: s.tier, score: s.score, ...(s.matchedIn ? { matchedIn: s.matchedIn } : {}), ...(s.at ? { at: s.at } : {}), ...(s.corrected && didYouMean ? { corrected: didYouMean } : {}) })
  // archived behind the fold - an exact id or exact name of an archived thing stays a result. Only the first few
  // archived are ever shown: picked, not sorted
  const liveK: K[] = [], archTop: K[] = []
  let archCount = 0
  for (const s of scored) {
    if (doc(s).archived && !opts.archive && s.tier > 1) {
      archCount++
      const k = keyed(s)
      if (archTop.length < perGroup || cmp(k, archTop[archTop.length - 1]) < 0) { archTop.push(k); archTop.sort(cmp); if (archTop.length > perGroup) archTop.pop() }
    } else liveK.push(keyed(s))
  }
  liveK.sort(cmp)
  const live = liveK.map(toHit)
  const archived = { count: archCount, hits: archTop.map(toHit) }
  // variants: members ranked one by one, folded under the best of each group
  const folded: Hit[] = []
  const lead = new Map<string, Hit>()
  for (const h of live) {
    const g = h.doc.variantGroup
    if (!g) { folded.push(h); continue }
    const l = lead.get(g)
    if (l) (l.variants ??= []).push(h.doc); else { lead.set(g, h); folded.push(h) }
  }
  const groups = KIND_ORDER.map((kind) => {
    const all = folded.filter((h) => h.doc.kind === kind)
    return { kind, hits: all.slice(0, perGroup), more: Math.max(0, all.length - perGroup) }
  }).filter((g) => g.hits.length)
  const part = partial.filter((s) => !doc(s).archived || opts.archive).sort((a, b) => b.score - a.score || doc(a).title.length - doc(b).title.length).slice(0, perGroup).map(toHit)
  return { query: q, ...(folded[0] ? { top: folded[0] } : {}), groups, partial: part, archived, searched: index.docs.length, ...(didYouMean ? { didYouMean } : {}) }
}
