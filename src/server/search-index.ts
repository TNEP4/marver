/**
 * Search (spec 35): the dev server's copy of the search documents. v1 spike: rebuilt when anything they read changed
 * (the design folder's files, the comment logs), else served from memory. The persisted index with patches over the
 * socket is the next step.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildSearchDocs } from './search-docs.ts'
import type { SearchDoc } from '../shared/search.ts'

let cache: { root: string; key: string; at: number; docs: SearchDoc[]; version: number } | null = null
let version = 0

/** A cheap fingerprint of what the documents read: the newest change time under design/ (boards, comments, scenes). */
function fingerprint(root: string): string {
  let newest = 0, count = 0
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return
    let names: string[]
    try { names = readdirSync(dir) } catch { return }
    for (const n of names) {
      if (n === '.local' || n === 'node_modules' || n === '.dist') continue
      const p = join(dir, n)
      let s; try { s = statSync(p) } catch { continue }
      if (s.isDirectory()) walk(p, depth + 1)
      else { count++; if (s.mtimeMs > newest) newest = s.mtimeMs }
    }
  }
  walk(join(root, 'design'), 0)
  return `${count}:${newest}`
}

export function searchDocsCached(root: string): { docs: SearchDoc[]; version: number } {
  const key = fingerprint(root)
  if (cache && cache.root === root && cache.key === key) return { docs: cache.docs, version: cache.version }
  const { docs } = buildSearchDocs(root)
  cache = { root, key, at: Date.now(), docs, version: ++version }
  return { docs, version: cache.version }
}
