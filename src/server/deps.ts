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

const stat = (root: string, rel: string) => { try { const s = statSync(join(root, rel)); return `${s.size}:${s.mtimeMs}` } catch { return '-' } }

/** Three fingerprints per frame. `doc`: what it renders - its file and what it reads under design/
 *  or as content (a spec read with ?raw); a file changed, added, removed or renamed moves it.
 *  `note`: its sticky note. `app`: an embedded app's code it imports, which Fast Refresh updates in
 *  place - seen without a new document. Size and mtime only: a write that restores both is not seen,
 *  which a git checkout never does. */
export function fingerprints(root: string, frames: readonly Pick<FrameEntry, 'id' | 'file' | 'kind'>[], deps = frameDeps(root, frames)): Record<string, [doc: string, note: string, app: string]> {
  const out: Record<string, [string, string, string]> = {}
  const fp = (paths: string[]) => hash(paths.sort().map((p) => `${p}:${stat(root, p)}`).join('\n')).slice(0, 16)
  for (const f of frames) {
    const reads = deps.get(f.id) ?? [f.file]
    const app = reads.filter(isApp)
    out[f.id] = [fp(reads.filter((p) => !isApp(p))), stat(root, noteFileFor(f.file)), app.length ? fp(app) : '']
  }
  return out
}

/** App code: outside design/, and code (a component, a helper) - not content like a spec's markdown. */
export const isApp = (rel: string) => !rel.startsWith('design/') && /\.(tsx?|jsx?|mjs|cjs)$/.test(rel)
