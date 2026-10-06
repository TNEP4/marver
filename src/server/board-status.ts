/**
 * Every board's type and status, read off the files (spec 20) - for the dev API's board list, the
 * manifest and the build. The rules live in shared/board-types.ts and shared/status.ts; this module
 * only reads: `context/` (the shipped record, the contracts, the plans), the boards and their
 * folders, and the briefs of the scenes a board shows. Errors never throw: unreadable evidence is
 * a fact the resolver turns into Unknown.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveType, readCapability, readReason, readStatusWord, type BoardType } from '../shared/board-types.ts'
import { frontMatter, shippedRows } from '../shared/context.ts'
import { NO_CONTEXT, resolveStatus, type ContextFacts, type StatusResult } from '../shared/status.ts'
import type { FolderRow } from '../shared/board-tree.ts'

const isDir = (p: string) => { try { return lstatSync(p).isDirectory() } catch { return false } }
const mdIn = (dir: string): string[] => (isDir(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('.')) : [])
/** Plan states that mean the plan is no longer open. */
const CLOSED_PLAN = new Set(['historical', 'done', 'landed', 'declined', 'closed', 'superseded'])

/** What `context/` says, for the resolver. Read whole, once per pass. */
export function readContextFacts(root: string): ContextFacts {
  const dir = join(root, 'context')
  if (!isDir(dir)) return NO_CONTEXT
  const facts: ContextFacts = { present: true, unreadable: new Map(), shipped: new Map(), contracts: new Map(), plans: new Map() }

  const shippedFile = join(dir, 'shipped.md')
  if (existsSync(shippedFile)) {
    try {
      const text = readFileSync(shippedFile, 'utf8')
      const fm = frontMatter(text)
      if (fm.error) facts.unreadable.set('*', `context/shipped.md: ${fm.error}`)
      for (const r of shippedRows(text)) facts.shipped.set(r.capability, { levels: r.levels, where: `context/shipped.md:${r.line}` })
    } catch (e) { facts.unreadable.set('*', `context/shipped.md: ${(e as Error).message}`) }
  }

  for (const f of mdIn(join(dir, 'product'))) {
    const where = `context/product/${f}`
    const slug = f.slice(0, -3)
    try {
      const fm = frontMatter(readFileSync(join(dir, 'product', f), 'utf8'))
      if (fm.error || !fm.data) { facts.unreadable.set(slug, `${where}: ${fm.error ?? 'no front matter'}`); continue }
      const cap = readCapability(fm.data.capability) ?? slug
      facts.contracts.set(cap, { state: typeof fm.data.state === 'string' ? fm.data.state : '', where })
    } catch (e) { facts.unreadable.set(slug, `${where}: ${(e as Error).message}`) }
  }

  for (const f of mdIn(join(dir, 'plans'))) {
    const where = `context/plans/${f}`
    try {
      const fm = frontMatter(readFileSync(join(dir, 'plans', f), 'utf8'))
      if (!fm.data) continue
      if (typeof fm.data.state === 'string' && CLOSED_PLAN.has(fm.data.state)) continue
      const caps = [fm.data.capability, ...(Array.isArray(fm.data.capabilities) ? fm.data.capabilities : [])].map(readCapability).filter((c): c is string => !!c)
      for (const c of caps) facts.plans.set(c, [...(facts.plans.get(c) ?? []), where])
    } catch { /* an unreadable plan opens nothing */ }
  }
  return facts
}

/** The scenes a board shows: its layout rows, and the scene of every frame it pins. */
export function boardScenes(json: unknown): string[] {
  const o = json as { layout?: { rows?: unknown }; nodes?: unknown } | null
  const out = new Set<string>()
  const rows = o?.layout?.rows
  if (Array.isArray(rows)) for (const r of rows) if (Array.isArray(r)) for (const s of r) if (typeof s === 'string') out.add(s)
  if (Array.isArray(o?.nodes)) for (const n of o.nodes as unknown[]) {
    const f = (n as { frame?: unknown })?.frame
    if (typeof f === 'string' && f.includes('/')) out.add(f.split('/')[0])
  }
  return [...out]
}

/** Does a scene hold a frame yet? A phase scene counts toward the fill only once it does - a board's
 *  starting layout names all three phase scenes before any frame exists. */
function sceneHasFrames(root: string, scene: string): boolean {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(scene)) return false
  try { return readdirSync(join(root, 'design', 'scenes', scene)).some((f) => /\.(tsx|jsx|html)$/.test(f) && !f.startsWith('_')) } catch { return false }
}

/** A scene brief's declared phase, if any. */
function scenePhase(root: string, scene: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(scene)) return undefined
  try {
    const fm = frontMatter(readFileSync(join(root, 'design', 'scenes', scene, '_brief.md'), 'utf8'))
    return typeof fm.data?.phase === 'string' ? fm.data.phase : undefined
  } catch { return undefined }
}

export interface BoardAnnotation { type: BoardType; status: StatusResult | null }

/** Every board's resolved type and status. `boards` are the board files' names and JSON; `folders`
 *  the registry rows; `folderOf` the folder each board sits in directly (the tree's answer). */
export function annotateBoards(
  root: string,
  boards: { name: string; json: unknown }[],
  folders: FolderRow[],
  folderOf: (board: string) => string | null,
  facts: ContextFacts = readContextFacts(root),
): Map<string, BoardAnnotation> {
  const byName = new Map(folders.map((f) => [f.name, f]))
  const out = new Map<string, BoardAnnotation>()
  for (const b of boards) {
    const o = (b.json ?? {}) as Record<string, unknown>
    const f = folderOf(b.name)
    const folder = f ? byName.get(f) : undefined
    const parent = folder?.parent ? byName.get(folder.parent) : undefined
    const type = resolveType(o.type, folder?.type, parent?.type)
    const scenes = boardScenes(b.json).filter((name) => sceneHasFrames(root, name)).map((name) => ({ name, phase: scenePhase(root, name) }))
    const status = resolveStatus({
      name: b.name, type,
      capability: readCapability(o.capability), status: readStatusWord(o.status), reason: readReason(o.reason),
      scenes,
    }, facts)
    out.set(b.name, { type, status })
  }
  return out
}

