/**
 * What a canvas build carries, as repository paths - the same selection the build makes, so a
 * check against it judges what actually ships: the published boards' frames (every frame when
 * an `auto` board ships), each frame's `_layout` chain, `design/providers`, and everything they import -
 * relative paths, `design/tsconfig.json` aliases, `?raw` and asset strings. An import that looks
 * local and does not resolve is reported, never silently skipped.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { scanFrames } from './manifest.ts'
import { imports } from './imports.ts'
import { ALL_SCENES, framesOn, isBoardName } from '../shared/board-tree.ts'

export { parseJsonc } from './imports.ts'   // re-exported for its callers here

export interface PublishGraph { files: Set<string>; unresolved: { from: string; spec: string }[] }

/** The published board names, straight from design/publish.json (an unreadable policy ships nothing). */
function publishedBoards(root: string): string[] {
  try { return Object.keys(JSON.parse(readFileSync(join(root, 'design', 'publish.json'), 'utf8')).boards ?? {}) } catch { return [] }
}

export function publishGraph(root: string): PublishGraph {
  const files = new Set<string>()
  const unresolved: PublishGraph['unresolved'] = []
  const boards = publishedBoards(root)
  if (!boards.length) return { files, unresolved }
  const rel = (abs: string) => relative(root, abs).split(sep).join('/')
  const isFile = (p: string) => { try { return statSync(join(root, p)).isFile() } catch { return false } }

  // the frames: the build's own rule - what the published boards show (every frame, on an `auto` one)
  const manifest = scanFrames(root)
  const live = manifest.frames.map((f) => f.id)
  const wanted = new Set<string>()
  for (const b of boards) {
    if (!isBoardName(b) || b === ALL_SCENES) continue   // the build drops it too
    try { for (const f of framesOn(JSON.parse(readFileSync(join(root, 'design', 'boards', `${b}.json`), 'utf8')), live)) wanted.add(f) }
    catch { /* an unreadable board fails the build itself */ }
  }
  const entries = manifest.frames.filter((f) => wanted.has(f.id))
  const frames = entries.map((f) => rel(join(root, f.file)))
  const queue = [...frames]
  // what the published manifest carries beside each frame: its scene's brief (the description) and
  // the sticky notes - the scene's and the frame's own
  for (const [i, f] of frames.entries()) {
    // the manifest's rule: a frame's scene is its id's first segment, and that scene's brief and note
    // live in design/scenes/<scene>/ - for a component frame too; a nested frame's own directory may
    // carry notes as well
    const scene = entries[i].scene
    for (const dir of new Set([scene ? `design/scenes/${scene}` : dirname(f), dirname(f)])) for (const n of ['_brief.md', '_note.md']) if (isFile(`${dir}/${n}`)) queue.push(`${dir}/${n}`)
    const note = f.replace(/\.(tsx|jsx|html)$/, '.note.md')
    if (isFile(note)) queue.push(note)
  }

  // each frame's layout chain, up to its base, and the providers every frame wraps in
  for (const f of frames) {
    const base = f.startsWith('design/components/') ? 'design/components' : 'design/scenes'
    let dir = dirname(f)
    while (dir.length >= base.length) {
      for (const ext of ['tsx', 'jsx']) if (isFile(`${dir}/_layout.${ext}`)) queue.push(`${dir}/_layout.${ext}`)
      if (dir === base) break
      dir = dirname(dir)
    }
  }
  for (const ext of ['tsx', 'jsx']) if (isFile(`design/providers.${ext}`)) queue.push(`design/providers.${ext}`)

  const im = imports(root)
  while (queue.length) {
    const p = queue.pop()!
    if (files.has(p)) continue
    files.add(p)
    const { resolved, unresolved: miss } = im.of(p)
    queue.push(...resolved)
    for (const spec of miss) unresolved.push({ from: p, spec })
  }
  return { files, unresolved }
}

export const publishPolicyExists = (root: string): boolean => existsSync(join(root, 'design', 'publish.json'))
