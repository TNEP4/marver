/**
 * `marver search <words>` (spec 35): the canvas's search for agents - the same documents and ranking as the ⌘K lens,
 * built from the files (no dev server needed). One call where an agent otherwise greps the frame files, the notes, the
 * board files, the folder types and the comment logs one by one. Neutral ranking: no recency, no current board.
 */
import { buildSearchDocs } from '../server/search-docs.ts'
import { buildIndex, search, KIND_ORDER, type Hit, type SearchKind } from '../shared/search.ts'
import { hashOfTarget, UNPLACED_BOARD } from '../shared/deep-link.ts'
import { findDev, unreachable } from './link.ts'
import { NAME } from './name.ts'

export interface SearchCliOptions { kind?: string; archive?: boolean; json?: boolean; limit?: string | number }

/** The canvas hash a result lands on: its board (a frame on none: the Not on a board view), the node a thread is
 *  pinned to, else the frame or scene, and the thread. A folder has no hash (the sidebar shows it). */
function hashOf(h: Hit): string | null {
  const d = h.doc.dest
  const board = d.board ?? (d.unplaced ? UNPLACED_BOARD : undefined)
  if (!board) return null
  return hashOfTarget({ board, ...(d.node ? { n: [d.node] } : d.frame ? { f: [d.frame] } : d.scene ? { s: [d.scene] } : {}), ...(d.thread ? { c: d.thread } : {}) })
}

export async function searchCommand(root: string, wordsArg: string[], opts: SearchCliOptions): Promise<void> {
  const query = wordsArg.join(' ').trim()
  if (!query) throw new Error(`name what to find: ${NAME} search <words>`)
  // the words people reach for: a thread is a comment, a sticky a note, a screen a frame
  const ALIAS: Record<string, SearchKind> = { thread: 'comment', sticky: 'note', screen: 'frame', page: 'frame', slide: 'frame' }
  const kinds = opts.kind ? String(opts.kind).split(',').map((k) => k.trim().toLowerCase().replace(/s$/, '')).filter(Boolean).map((k) => ALIAS[k] ?? k) as SearchKind[] : undefined
  const bad = kinds?.filter((k) => !KIND_ORDER.includes(k))
  if (bad?.length) throw new Error(`--kind takes ${KIND_ORDER.join(', ')} (got ${bad.join(', ')})`)
  const n = Number(opts.limit ?? 8)
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('--limit takes a whole number from 1 to 50')

  const { docs } = buildSearchDocs(root)
  const r = search(buildIndex(docs), query, { kinds, archive: !!opts.archive, perGroup: n })

  // a link only from a server that answers (a stale dev.json is not a server); offline is fine - ids and files suffice
  const found = await findDev(root).catch(() => null)
  const base = found && 'origin' in found ? found.origin : null
  const row = (h: Hit) => {
    const hash = hashOf(h)
    return {
      id: h.doc.id, key: h.doc.key, kind: h.doc.kind, title: h.doc.title, where: h.doc.where ?? null,
      device: h.doc.device ?? null, archived: !!h.doc.archived, matchedIn: h.matchedIn ?? 'name',
      file: h.doc.file ?? null, destination: h.doc.dest, hash, url: base && hash ? `${base}${hash}` : null,
      ...(h.doc.kind === 'comment' ? { open: !!h.doc.open, waiting: !!h.doc.waiting } : {}),
      ...(h.variants?.length ? { variants: h.variants.map((v) => v.key) } : {}),
    }
  }
  if (opts.json) {
    console.log(JSON.stringify({
      query: r.query, coverage: 'source', searched: r.searched,
      ...(r.didYouMean ? { didYouMean: r.didYouMean } : {}),
      best: r.top ? row(r.top) : null,
      groups: r.groups.map((g) => ({ kind: g.kind, results: g.hits.map(row), more: g.more })),
      partial: r.partial.map(row), archived: { count: r.archived.count, results: r.archived.hits.map(row) },
      server: base ? 'running' : found && 'unreachable' in found ? 'unreachable' : 'not running',
    }, null, 2))
    return
  }
  if (!r.groups.length) {
    console.log(`nothing for "${query}"${r.partial.length ? ` - ${r.partial.length} partial match${r.partial.length === 1 ? '' : 'es'} (not every word)` : ''}${r.archived.count ? `; ${r.archived.count} in the archive (--archive)` : ''}`)
    // only archived things match: name them (an agent told "54 in the archive" learns nothing, and greps)
    if (r.archived.hits.length) {
      console.log(`\nin the archive (--archive for all):`)
      for (const h of r.archived.hits.slice(0, 5)) { const x = row(h); console.log(`  ${x.key}  ${x.title}${x.where ? `  - ${x.where}` : ''}`); if (x.file) console.log(`      ${x.file}`) }
    }
    for (const h of r.partial.slice(0, 3)) console.log(`  partial: ${h.doc.key}  ${h.doc.title}`)
    console.log(`  (${NAME} search reads what the files say; words that only shared screen components show are not in it - grep those)`)
    return
  }
  if (r.didYouMean) console.log(`(searched "${r.didYouMean}")`)
  if (r.top) { const x = row(r.top); console.log(`best: ${x.key}  ${x.title}${x.url ? `\n  ${x.url}` : ''}`) }
  for (const g of r.groups) {
    console.log(`\n${g.kind}s`)
    for (const h of g.hits) {
      const x = row(h)
      console.log(`  ${x.key}  ${x.title}${x.where ? `  - ${x.where}` : ''}${x.matchedIn !== 'name' ? `  [in ${x.matchedIn}]` : ''}${x.archived ? '  [archived]' : ''}`)
      if (x.file) console.log(`      ${x.file}`)
      if (x.url) console.log(`      ${x.url}`)
    }
    if (g.more) console.log(`  +${g.more} more (--limit)`)
  }
  if (r.archived.count) console.log(`\n${r.archived.count} more in the archive (--archive)`)
  if (!base) console.log(found && 'unreachable' in found ? `\n(${unreachable(found.unreachable.pid)}: ids and files above)` : `\n(no dev server running: ids and files above; start one for links)`)
}
