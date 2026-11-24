/**
 * `marver search <words>` (spec 35): the canvas's search for agents - the same documents and ranking as the ⌘K lens,
 * built from the files (no dev server needed). One call where an agent otherwise greps the frame files, the notes, the
 * board files, the folder types and the comment logs one by one. Neutral ranking: no recency, no current board.
 */
import { buildSearchDocs } from '../server/search-docs.ts'
import { buildIndex, search, KIND_ORDER, type Hit, type SearchKind } from '../shared/search.ts'
import { hashOfTarget } from '../shared/deep-link.ts'
import { readDevInfo } from '../server/work.ts'
import { NAME } from './name.ts'

export interface SearchCliOptions { kind?: string; archive?: boolean; json?: boolean; limit?: string | number }

const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

/** The canvas hash a result lands on, or null when it needs a board it does not have. */
function hashOf(h: Hit): string | null {
  const d = h.doc.dest
  if (!d.board) return null
  return hashOfTarget({ board: d.board, ...(d.frame ? { f: [d.frame] } : d.scene ? { s: [d.scene] } : {}), ...(d.thread ? { c: d.thread } : {}) })
}

export async function searchCommand(root: string, wordsArg: string[], opts: SearchCliOptions): Promise<void> {
  const query = wordsArg.join(' ').trim()
  if (!query) throw new Error(`name what to find: ${NAME} search <words>`)
  const kinds = opts.kind ? String(opts.kind).split(',').map((k) => k.trim().replace(/s$/, '')).filter(Boolean) as SearchKind[] : undefined
  const bad = kinds?.filter((k) => !KIND_ORDER.includes(k))
  if (bad?.length) throw new Error(`--kind takes ${KIND_ORDER.join(', ')} (got ${bad.join(', ')})`)
  const limit = Math.max(1, Math.min(50, Number(opts.limit ?? 8) || 8))

  const { docs, manifest } = buildSearchDocs(root)
  const index = buildIndex(docs)
  const r = search(index, query, { kinds, archive: !!opts.archive, perGroup: limit })

  const dev = readDevInfo(root)
  const base = dev && alive(dev.pid) ? `http://localhost:${dev.port}/` : null
  const fileOf = new Map(manifest.frames.map((f) => [f.id, f.file]))
  const ordered: Hit[] = []
  for (const g of r.groups) ordered.push(...g.hits)
  const row = (h: Hit) => {
    const hash = hashOf(h)
    return {
      id: h.doc.key, kind: h.doc.kind, title: h.doc.title, where: h.doc.where ?? null,
      device: h.doc.device ?? null, archived: !!h.doc.archived, matchedIn: h.matchedIn ?? 'name',
      file: h.doc.frame ? fileOf.get(h.doc.frame) ?? null : null,
      destination: h.doc.dest, hash, url: base && hash ? `${base}${hash}` : null,
      ...(h.variants?.length ? { variants: h.variants.map((v) => v.key) } : {}),
    }
  }
  if (opts.json) {
    console.log(JSON.stringify({
      query: r.query, coverage: 'source', searched: r.searched,
      ...(r.didYouMean ? { didYouMean: r.didYouMean } : {}), ...(r.archivedOnly ? { archivedOnly: true } : {}),
      results: ordered.map(row), partial: r.partial.map(row), archived: { count: r.archived.count },
    }, null, 2))
    return
  }
  if (!ordered.length) {
    console.log(`nothing for "${query}"${r.partial.length ? ` - ${r.partial.length} partial match${r.partial.length === 1 ? '' : 'es'} (not every word)` : ''}${r.archived.count ? `; ${r.archived.count} in the archive (--archive)` : ''}`)
    console.log(`  (${NAME} search reads what the files say; words that only shared screen components show are not in it - grep those)`)
    return
  }
  if (r.didYouMean) console.log(`(searched "${r.didYouMean}")`)
  if (r.archivedOnly) console.log('(only archived matches)')
  for (const g of r.groups) {
    console.log(`\n${g.kind}s`)
    for (const h of g.hits) {
      const x = row(h)
      console.log(`  ${x.id}  ${x.title}${x.where ? `  - ${x.where}` : ''}${x.matchedIn !== 'name' ? `  [in ${x.matchedIn}]` : ''}${x.archived ? '  [archived]' : ''}`)
      if (x.file) console.log(`      ${x.file}`)
    }
    if (g.more) console.log(`  +${g.more} more (--limit)`)
  }
  if (r.archived.count) console.log(`\n${r.archived.count} more in the archive (--archive)`)
  if (!base) console.log(`\n(no dev server running: ids and files above; start one for links)`)
}
