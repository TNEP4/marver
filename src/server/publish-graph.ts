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

const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|['"]((?:\.{1,2}\/)+[^'"\s]+\.[a-z0-9]{1,5})(?:\?[a-z]+)?['"]/g
const CODE = /\.(tsx?|jsx?|mjs|cjs|mdx?)$/

export interface PublishGraph { files: Set<string>; unresolved: { from: string; spec: string }[] }

/** The published board names, straight from design/publish.json (an unreadable policy ships nothing). */
function publishedBoards(root: string): string[] {
  try { return Object.keys(JSON.parse(readFileSync(join(root, 'design', 'publish.json'), 'utf8')).boards ?? {}) } catch { return [] }
}

/** design/tsconfig.json's path aliases, resolved from design/ ("@/*" -> ["../src/*"]). */
function aliases(root: string): { prefix: string; targets: string[] }[] {
  try {
    const raw = readFileSync(join(root, 'design', 'tsconfig.json'), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    const paths = JSON.parse(raw)?.compilerOptions?.paths ?? {}
    return Object.entries(paths).flatMap(([k, v]) => (Array.isArray(v)
      ? [{ prefix: k.replace(/\*$/, ''), targets: (v as string[]).map((t) => normalize(join('design', t.replace(/\*$/, '')))) }]
      : []))
  } catch { return [] }
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
      if (r === null) { if (spec.startsWith('.') || al.some((x) => x.prefix && spec.startsWith(x.prefix))) unresolved.push({ from: p, spec }); continue }
      queue.push(r)
    }
  }
  return { files, unresolved }
}

export const publishPolicyExists = (root: string): boolean => existsSync(join(root, 'design', 'publish.json'))
