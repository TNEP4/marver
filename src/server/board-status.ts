/**
 * Every board's type and status, read off the files (spec 20) - for the dev API's board list, the
 * manifest and the build. The rules live in shared/board-types.ts and shared/status.ts; this module
 * only reads: `context/` (the shipped record, the contracts, the plans, each with its audience), the
 * boards and their folders, and the briefs of the scenes a status board shows. Errors never throw:
 * evidence that cannot be read is a fact the resolver turns into Unknown - never a stale Done.
 *
 * The sidebar re-reads on every `sh:boards` and every poll, so the facts are cached by the files'
 * signature (names, sizes, mtimes) and a pass reads each scene brief once.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HAS_STATUS, resolveType, readCapability, readReason, readStatusWord, type BoardType } from '../shared/board-types.ts'
import { frontMatter, isRecordTable, readAudience, shippedRows, tables } from '../shared/context.ts'
import { NO_CONTEXT, resolveStatus, type ContextFacts, type StatusResult } from '../shared/status.ts'
import type { FolderRow } from '../shared/board-tree.ts'

const isDir = (p: string) => { try { return lstatSync(p).isDirectory() } catch { return false } }
/** Plan states that mean the plan is no longer open. */
const CLOSED_PLAN = new Set(['historical', 'done', 'landed', 'declined', 'closed', 'superseded'])
const CONTRACT_STATES = new Set(['current', 'proposed', 'historical'])

/** The markdown files of a context sub-directory - or the error that kept them from being read. */
function mdIn(dir: string): { files: string[]; error?: string } {
  if (!isDir(dir)) return { files: [] }
  try { return { files: readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('.')).sort() } }
  catch (e) { return { files: [], error: (e as Error).message } }
}

/** What decides the facts: every file they are read from, by size and mtime. */
function signature(dir: string): string {
  const parts: string[] = []
  const stamp = (p: string) => { try { const s = statSync(p); parts.push(`${p}:${s.size}:${s.mtimeMs}`) } catch { parts.push(`${p}:-`) } }
  stamp(join(dir, 'shipped.md'))
  for (const sub of ['product', 'plans']) {
    const d = join(dir, sub)
    stamp(d)
    for (const f of mdIn(d).files) stamp(join(d, f))
  }
  return parts.join('|')
}

const cache = new Map<string, { sig: string; facts: ContextFacts }>()

/** What `context/` says, for the resolver - cached until a file it reads changes. */
export function readContextFacts(root: string): ContextFacts {
  const dir = join(root, 'context')
  if (!isDir(dir)) return NO_CONTEXT
  const sig = signature(dir)
  const hit = cache.get(root)
  if (hit && hit.sig === sig) return hit.facts
  const facts = readFresh(dir)
  cache.set(root, { sig, facts })
  return facts
}

function readFresh(dir: string): ContextFacts {
  const facts: ContextFacts = { present: true, unreadable: new Map(), shipped: new Map(), contracts: new Map(), plans: new Map() }

  const shippedFile = join(dir, 'shipped.md')
  let text: string | null = null
  try { text = readFileSync(shippedFile, 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') facts.unreadable.set('*', `context/shipped.md: ${(e as Error).message}`)
  }
  if (text !== null) {
    const fm = frontMatter(text)
    // a record the resolver cannot read is Unknown for every board - never "nothing is available"
    if (fm.error) facts.unreadable.set('*', `context/shipped.md: ${fm.error}`)
    else if (!tables(text).some(isRecordTable)) facts.unreadable.set('*', 'context/shipped.md: no Capability table with an Available column')
    else {
      const audience = readAudience(fm.data?.audience)
      for (const r of shippedRows(text)) facts.shipped.set(r.capability, { levels: r.levels, where: `context/shipped.md:${r.line}`, audience })
    }
  }

  const product = mdIn(join(dir, 'product'))
  if (product.error) facts.unreadable.set('*', `context/product/: ${product.error}`)
  for (const f of product.files) {
    const where = `context/product/${f}`
    const slug = f.slice(0, -3)
    try {
      const fm = frontMatter(readFileSync(join(dir, 'product', f), 'utf8'))
      if (fm.error || !fm.data) { facts.unreadable.set(slug, `${where}: ${fm.error ?? 'no front matter'}`); continue }
      const cap = readCapability(fm.data.capability) ?? slug
      const state = typeof fm.data.state === 'string' ? fm.data.state : ''
      if (!CONTRACT_STATES.has(state)) { facts.unreadable.set(cap, `${where}: state "${state}" is not current, proposed or historical`); continue }
      facts.contracts.set(cap, { state, where, audience: readAudience(fm.data.audience) })
    } catch (e) { facts.unreadable.set(slug, `${where}: ${(e as Error).message}`) }
  }

  const plans = mdIn(join(dir, 'plans'))
  if (plans.error) facts.unreadable.set('*', `context/plans/: ${plans.error}`)
  for (const f of plans.files) {
    const where = `context/plans/${f}`
    const slug = f.slice(0, -3)
    try {
      const fm = frontMatter(readFileSync(join(dir, 'plans', f), 'utf8'))
      // a plan that cannot be read may be open - Unknown for the capability its file names
      if (fm.error || !fm.data) { facts.unreadable.set(slug, `${where}: ${fm.error ?? 'no front matter'}`); continue }
      if (typeof fm.data.state === 'string' && CLOSED_PLAN.has(fm.data.state)) continue
      const caps = [fm.data.capability, ...(Array.isArray(fm.data.capabilities) ? fm.data.capabilities : [])].map(readCapability).filter((c): c is string => !!c)
      const audience = readAudience(fm.data.audience)
      for (const c of caps) facts.plans.set(c, [...(facts.plans.get(c) ?? []), { where, audience }])
    } catch (e) { facts.unreadable.set(slug, `${where}: ${(e as Error).message}`) }
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

const SCENE = /^[a-z0-9][a-z0-9-]*$/
/** A scene as the fill reads it: does it hold a frame yet (a phase counts only once it does - a
 *  feature's starting layout names its three phase scenes before any frame exists), and the
 *  `phase` its brief declares. */
function readScene(root: string, scene: string): { frames: boolean; phase?: string } {
  if (!SCENE.test(scene)) return { frames: false }
  const dir = join(root, 'design', 'scenes', scene)
  let frames = false
  try { frames = readdirSync(dir).some((f) => /\.(tsx|jsx|html)$/.test(f) && !f.startsWith('_')) } catch { /* absent */ }
  let phase: string | undefined
  try {
    const fm = frontMatter(readFileSync(join(dir, '_brief.md'), 'utf8'))
    if (typeof fm.data?.phase === 'string') phase = fm.data.phase
  } catch { /* no brief */ }
  return { frames, ...(phase ? { phase } : {}) }
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
  const scenes = new Map<string, { frames: boolean; phase?: string }>()
  const scene = (s: string) => { let v = scenes.get(s); if (!v) { v = readScene(root, s); scenes.set(s, v) } return v }
  const out = new Map<string, BoardAnnotation>()
  for (const b of boards) {
    const o = (b.json ?? {}) as Record<string, unknown>
    const f = folderOf(b.name)
    const folder = f ? byName.get(f) : undefined
    const parent = folder?.parent ? byName.get(folder.parent) : undefined
    const type = resolveType(o.type, folder?.type, parent?.type)
    if (!HAS_STATUS.includes(type)) { out.set(b.name, { type, status: null }); continue }
    const shown = boardScenes(b.json).flatMap((name) => {
      const sc = scene(name)
      return sc.frames ? [{ name, ...(sc.phase ? { phase: sc.phase } : {}) }] : []
    })
    const status = resolveStatus({
      name: b.name, type,
      capability: readCapability(o.capability), status: readStatusWord(o.status), reason: readReason(o.reason),
      scenes: shown,
    }, facts)
    out.set(b.name, { type, status })
  }
  return out
}
