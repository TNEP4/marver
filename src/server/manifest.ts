import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface FrameMeta { title?: string; viewport?: string; theme?: string }
export interface FrameEntry {
  id: string
  file: string
  kind: 'tsx' | 'html'
  scene: string
  title?: string
  viewport?: string
}
export interface Manifest {
  frames: FrameEntry[]
  scenes: { name: string; frames: number }[]
  boards: string[]
}

const FRAME_EXT = /\.(tsx|jsx|html)$/
const RESERVED_SCENES = new Set(['components', 'screens'])

/** Extract `export const meta = {...}` with literal string values only. Anything else is silently omitted (spec §6). */
export function extractMeta(src: string): FrameMeta {
  const m = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\}/.exec(src)
  if (!m) return {}
  const body = m[1]
  const pick = (key: string) => {
    const r = new RegExp(`${key}\\s*:\\s*(['"\`])([^'"\`]*)\\1`).exec(body)
    return r ? r[2] : undefined
  }
  const out: FrameMeta = {}
  const title = pick('title'); if (title) out.title = title
  const viewport = pick('viewport'); if (viewport) out.viewport = viewport
  const theme = pick('theme'); if (theme) out.theme = theme
  return out
}

/** id = path relative to design/, extension dropped, `scenes/` prefix dropped. Always `/`-separated. */
export function toFrameId(designRelPath: string): string {
  const posix = designRelPath.split(sep).join('/')
  const noExt = posix.replace(FRAME_EXT, '')
  return noExt.startsWith('scenes/') ? noExt.slice('scenes/'.length) : noExt
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

export function scanFrames(root: string): Manifest {
  const design = join(root, 'design')
  const frames: FrameEntry[] = []
  for (const base of ['scenes', 'components']) {
    for (const abs of walk(join(design, base))) {
      const name = abs.split(sep).pop()!
      if (name.startsWith('_') || !FRAME_EXT.test(name)) continue
      const rel = relative(design, abs).split(sep).join('/')
      const id = toFrameId(rel)
      const scene = id.includes('/') ? id.split('/')[0] : ''
      if (base === 'scenes' && RESERVED_SCENES.has(scene)) {
        console.error(`[showhome] scene "${scene}" is a reserved name - "${rel}" skipped. Rename the scene.`)
        continue
      }
      const kind = name.endsWith('.html') ? 'html' as const : 'tsx' as const
      const entry: FrameEntry = { id, file: `design/${rel}`, kind, scene }
      if (kind === 'tsx') {
        const meta = extractMeta(readFileSync(abs, 'utf8'))
        if (meta.title) entry.title = meta.title
        if (meta.viewport) entry.viewport = meta.viewport
      }
      frames.push(entry)
    }
  }
  frames.sort((a, b) => a.id.localeCompare(b.id))
  // duplicate id check (e.g. foo.tsx + foo.html)
  const seen = new Map<string, string>()
  for (const f of frames) {
    const prev = seen.get(f.id)
    if (prev) console.error(`[showhome] duplicate frame id "${f.id}" (${prev} vs ${f.file}) - keep one.`)
    seen.set(f.id, f.file)
  }

  const sceneCounts = new Map<string, number>()
  for (const f of frames) sceneCounts.set(f.scene, (sceneCounts.get(f.scene) ?? 0) + 1)
  const scenes = [...sceneCounts.entries()].map(([name, n]) => ({ name, frames: n })).sort((a, b) => a.name.localeCompare(b.name))

  const boardsDir = join(design, 'boards')
  const boards = existsSync(boardsDir)
    ? readdirSync(boardsDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
    : []
  if (!boards.includes('everything')) boards.unshift('everything')

  return { frames, scenes, boards }
}

/** Write design/manifest.json only when content changed. Returns the manifest either way. */
export function writeManifest(root: string, manifest: Manifest): boolean {
  const file = join(root, 'design', 'manifest.json')
  const next = JSON.stringify(manifest, null, 2) + '\n'
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (hash(prev) === hash(next)) return false
  mkdirSync(join(root, 'design'), { recursive: true })
  writeFileSync(file, next)
  return true
}

export const hash = (s: string) => createHash('sha256').update(s).digest('hex')
