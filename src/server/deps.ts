/**
 * What each frame reads (spec 26): its own file, its `_layout` chain, `design/providers` for a TSX
 * frame, and everything those import - followed statically (imports.ts). The marks use it twice:
 * a shared file that changes lights every frame that reads it, and a boot compares each frame's
 * fingerprint with the last run's, so what changed while `marver dev` was off is seen too.
 */
import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hash } from './hash.ts'
import { imports } from './imports.ts'
import { noteFileFor, type FrameEntry } from './manifest.ts'

/** frame id -> the repository paths it reads, its own file first. */
export function frameDeps(root: string, frames: readonly Pick<FrameEntry, 'id' | 'file' | 'kind'>[]): Map<string, string[]> {
  const im = imports(root)
  const providers = ['tsx', 'jsx'].map((x) => `design/providers.${x}`).filter(im.isFile)
  const out = new Map<string, string[]>()
  for (const f of frames) {
    const queue = [f.file]
    if (f.kind === 'tsx') {
      // the wrappers the frame host puts around it: every _layout from the glob base down, then the providers
      const base = f.file.startsWith('design/components/') ? 'design/components' : 'design/scenes'
      for (let dir = dirname(f.file); dir.length >= base.length; dir = dirname(dir)) {
        for (const x of ['tsx', 'jsx']) if (im.isFile(`${dir}/_layout.${x}`)) queue.push(`${dir}/_layout.${x}`)
        if (dir === base) break
      }
      queue.push(...providers)
    }
    const reads = new Set<string>()
    while (queue.length) {
      const p = queue.shift()!
      if (reads.has(p)) continue
      reads.add(p)
      queue.push(...im.of(p).resolved)
    }
    out.set(f.id, [...reads])
  }
  return out
}

export const stat = (root: string, rel: string) => { try { const s = statSync(join(root, rel)); return `${s.size}:${s.mtimeMs}` } catch { return '-' } }

/** What a look at the disk keeps (deps.json): every file a frame reads, by size and mtime - a file once,
 *  however many frames read it - and per frame the set of paths it reads and its sticky note. Size and
 *  mtime only: a write that restores both is not seen, which a git checkout never does. */
export interface Observed { files: Record<string, string>; frames: Record<string, { reads: string; note: string }> }

export function observed(root: string, frames: readonly Pick<FrameEntry, 'id' | 'file' | 'kind'>[], deps = frameDeps(root, frames)): Observed {
  const out: Observed = { files: {}, frames: {} }
  for (const f of frames) {
    const reads = deps.get(f.id) ?? [f.file]
    for (const p of reads) out.files[p] ??= stat(root, p)
    out.frames[f.id] = { reads: hash([...reads].sort().join('\n')).slice(0, 16), note: stat(root, noteFileFor(f.file)) }
  }
  return out
}

/** What moved between two looks, per frame: `doc` - added (a new id, a rename too), what it reads
 *  changed (a file edited, added, removed or renamed), or app code it imports at `boot` (nothing
 *  applied it); `note` - its sticky note, or app code while dev runs (Fast Refresh applies it in place).
 *  `only`: compare these files alone (a hot update's own file). */
export function compare(was: Observed, now: Observed, deps: Map<string, string[]>, ids: readonly string[], boot: boolean, only?: ReadonlySet<string>): { doc: string[]; note: string[] } {
  const doc: string[] = [], note: string[] = []
  for (const id of ids) {
    const a = was.frames[id], b = now.frames[id]
    if (!b) continue
    if (!a || (!only && a.reads !== b.reads)) { doc.push(id); continue }
    const moved = (deps.get(id) ?? []).filter((p) => (!only || only.has(p)) && was.files[p] !== now.files[p])
    if (moved.some((p) => boot || !isApp(p))) doc.push(id)
    else if (moved.length || (!only && a.note !== b.note)) note.push(id)
  }
  return { doc, note }
}

/** App code: outside design/, and code (a component, a helper) - not content like a spec's markdown. */
export const isApp = (rel: string) => !rel.startsWith('design/') && /\.(tsx?|jsx?|mjs|cjs)$/.test(rel)
