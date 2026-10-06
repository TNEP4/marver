/**
 * What a canvas build carries, as repository paths - the same selection the build makes, so a
 * check against it judges what actually ships: the published boards' frames (every frame when
 * `all-scenes` ships), each frame's `_layout` chain, `design/providers`, and everything they import -
 * relative paths, `design/tsconfig.json` aliases, `?raw` and asset strings. An import that looks
 * local and does not resolve is reported, never silently skipped.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { scanFrames } from './manifest.ts'

const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|['"]((?:\.{1,2}\/|\/)[^'"\s]+\.[a-z0-9]{1,5})(?:\?[a-z]+)?['"]/g
const CODE = /\.(tsx?|jsx?|mjs|cjs|mdx?)$/

export interface PublishGraph { files: Set<string>; unresolved: { from: string; spec: string }[] }

/** The published board names, straight from design/publish.json (an unreadable policy ships nothing). */
function publishedBoards(root: string): string[] {
  try { return Object.keys(JSON.parse(readFileSync(join(root, 'design', 'publish.json'), 'utf8')).boards ?? {}) } catch { return [] }
}

/** design/tsconfig.json's path aliases, resolved against the config that declares them - its own,
 *  or one it `extends` (the host's tsconfig), as TypeScript and Vite would. */
function aliases(root: string): { prefix: string; targets: string[] }[] {
  const read = (rel: string, depth: number): { prefix: string; targets: string[] }[] => {
    if (depth > 4) return []
    let cfg: { extends?: unknown; compilerOptions?: { paths?: Record<string, unknown>; baseUrl?: unknown } }
    try { cfg = JSON.parse(readFileSync(join(root, rel), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1')) } catch { return [] }
    const dir = dirname(rel)
    const base = typeof cfg.compilerOptions?.baseUrl === 'string' ? normalize(join(dir, cfg.compilerOptions.baseUrl)) : dir
    const own = Object.entries(cfg.compilerOptions?.paths ?? {}).flatMap(([k, v]) => (Array.isArray(v)
      ? [{ prefix: k.replace(/\*$/, ''), targets: (v as string[]).map((t) => normalize(join(base, t.replace(/\*$/, '')))) }]
      : []))
    // `extends` is one config or a list (TypeScript 5): later entries win, the config's own paths win over all
    const ext = (Array.isArray(cfg.extends) ? cfg.extends : [cfg.extends]).filter((e): e is string => typeof e === 'string' && e.startsWith('.'))
    let inherited: { prefix: string; targets: string[] }[] = []
    for (const e of ext) {
      const got = read(normalize(join(dir, e.endsWith('.json') ? e : `${e}.json`)), depth + 1)
      inherited = [...got, ...inherited.filter((p) => !got.some((g) => g.prefix === p.prefix))]
    }
    return [...own, ...inherited.filter((p) => !own.some((o) => o.prefix === p.prefix))]
  }
  return read('design/tsconfig.json', 0)
}

export function publishGraph(root: string): PublishGraph {
  const files = new Set<string>()
  const unresolved: PublishGraph['unresolved'] = []
  const boards = publishedBoards(root)
  if (!boards.length) return { files, unresolved }
  const rel = (abs: string) => relative(root, abs).split(sep).join('/')
  const isFile = (p: string) => { try { return statSync(join(root, p)).isFile() } catch { return false } }

  // the frames: the build's own rule - the nodes of the published boards, or every frame for all-scenes
  const manifest = scanFrames(root)
  let wanted: Set<string> | null = new Set()
  for (const b of boards) {
    if (b === 'all-scenes') { wanted = null; break }
    try {
      const j = JSON.parse(readFileSync(join(root, 'design', 'boards', `${b}.json`), 'utf8'))
      for (const n of Array.isArray(j?.nodes) ? j.nodes : []) if (typeof n?.frame === 'string') wanted.add(n.frame)
    } catch { /* an unreadable board fails the build itself */ }
  }
  const frames = manifest.frames.filter((f) => !wanted || wanted.has(f.id)).map((f) => rel(join(root, f.file)))
  const queue = [...frames]
  // what the published manifest carries beside each frame: its scene's brief (the description) and
  // the sticky notes - the scene's and the frame's own
  for (const f of frames) {
    // the scene is the first directory under design/scenes (or components); a nested frame's own
    // directory may carry notes too
    const parts = f.split('/')
    const sceneDir = parts.slice(0, 3).join('/')
    for (const dir of new Set([sceneDir, dirname(f)])) for (const n of ['_brief.md', '_note.md']) if (isFile(`${dir}/${n}`)) queue.push(`${dir}/${n}`)
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

  const al = aliases(root)
  const resolve = (from: string, spec: string): string | null => {
    const bare = spec.replace(/\?[a-z]+$/, '')
    let bases: string[] = []
    if (bare.startsWith('.')) bases = [normalize(join(dirname(from), bare))]
    else if (bare.startsWith('/')) bases = [normalize(bare.slice(1))]          // root-relative, as Vite serves it
    else {
      const a = al.find((x) => bare.startsWith(x.prefix) && x.prefix)
      if (!a) return ''                                       // a package: not ours to follow
      bases = a.targets.map((t) => normalize(join(t, bare.slice(a.prefix.length))))
    }
    for (const b of bases) {
      for (const cand of [b, `${b}.ts`, `${b}.tsx`, `${b}.js`, `${b}.jsx`, `${b}/index.ts`, `${b}/index.tsx`]) {
        if (!cand.startsWith('..') && isFile(cand)) return cand.split(sep).join('/')
      }
    }
    return null
  }
  while (queue.length) {
    const p = queue.pop()!
    if (files.has(p)) continue
    files.add(p)
    if (!CODE.test(p)) continue
    let text = ''
    try { text = readFileSync(join(root, p), 'utf8') } catch { continue }
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] || m[2] || m[3] || m[4] || ''
      if (!spec) continue
      const r = resolve(p, spec)
      if (r === '') continue
      if (r === null) { if (spec.startsWith('.') || spec.startsWith('/') || al.some((x) => x.prefix && spec.startsWith(x.prefix))) unresolved.push({ from: p, spec }); continue }
      queue.push(r)
    }
  }
  return { files, unresolved }
}

export const publishPolicyExists = (root: string): boolean => existsSync(join(root, 'design', 'publish.json'))
