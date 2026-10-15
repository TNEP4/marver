/**
 * Following a design file's imports statically, as repository paths: relative and root-relative
 * specifiers, `design/tsconfig.json` aliases, side-effect imports, `?raw` and asset strings. Shared
 * by what a build carries (publish-graph.ts) and what each frame reads (deps.ts). An approximation
 * by design: globs, computed paths and CSS `@import` are outside it.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'

const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|['"]((?:\.{1,2}\/|\/)[^'"\s]+\.[a-z0-9]{1,5})(?:\?[a-z]+)?['"]|\bimport\s*['"]([^'"]+)['"]/g
export const CODE = /\.(tsx?|jsx?|mjs|cjs|mdx?)$/

/** JSON with comments and trailing commas, as tsconfig allows - comments stripped outside strings only
 *  (a "$schema": "https://..." is a string, not a comment). */
export function parseJsonc(text: string): unknown {
  let out = '', i = 0, str = false
  const t = text.replace(/^﻿/, '')
  while (i < t.length) {
    const c = t[i]
    if (str) { out += c; if (c === '\\') { out += t[i + 1] ?? ''; i += 2; continue } if (c === '"') str = false; i++; continue }
    if (c === '"') { str = true; out += c; i++; continue }
    if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; continue }
    if (c === '/' && t[i + 1] === '*') { i += 2; while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) i++; i += 2; continue }
    out += c; i++
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** design/tsconfig.json's path aliases, resolved against the config that declares them - its own,
 *  or one it `extends` (the host's tsconfig), as TypeScript and Vite would. */
function aliases(root: string): { prefix: string; targets: string[] }[] {
  const read = (rel: string, depth: number): { prefix: string; targets: string[] }[] => {
    if (depth > 4) return []
    let cfg: { extends?: unknown; compilerOptions?: { paths?: Record<string, unknown>; baseUrl?: unknown } }
    try { cfg = parseJsonc(readFileSync(join(root, rel), 'utf8')) as typeof cfg } catch { return [] }
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

export interface Imports {
  /** `from`'s imports: resolved repository paths, and the local-looking ones that resolve nowhere. */
  of(from: string): { resolved: string[]; unresolved: string[] }
  isFile(rel: string): boolean
}

/** One resolver per pass: the aliases are read once, each file's imports at most once. */
export function imports(root: string): Imports {
  const al = aliases(root)
  const isFile = (p: string) => { try { return statSync(join(root, p)).isFile() } catch { return false } }
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
  const seen = new Map<string, { resolved: string[]; unresolved: string[] }>()
  return {
    isFile,
    of(from) {
      const hit = seen.get(from)
      if (hit) return hit
      const out = { resolved: [] as string[], unresolved: [] as string[] }
      seen.set(from, out)
      if (!CODE.test(from)) return out
      let text = ''
      try { text = readFileSync(join(root, from), 'utf8') } catch { return out }
      for (const m of text.matchAll(IMPORT)) {
        const spec = m[1] || m[2] || m[3] || m[4] || m[5] || ''
        if (!spec) continue
        const r = resolve(from, spec)
        if (r === '') continue
        if (r === null) { if (spec.startsWith('.') || spec.startsWith('/') || al.some((x) => x.prefix && spec.startsWith(x.prefix))) out.unresolved.push(spec); continue }
        out.resolved.push(r)
      }
      return out
    },
  }
}
