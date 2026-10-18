/**
 * Every element knows its source (spec 27, Part 6). A dev-only transform on design files adds
 * `data-mv-loc="<path>:<line>:<col>"` to every HOST JSX element - a lowercase plain name (`<div>`,
 * `<button>`, `<my-el>`). Components (`<Card>`) and member names (`<motion.div>`) are skipped: they
 * may not pass attributes on. The laser and a capture's bundles already read `dataset.mvLoc` into
 * `source` (frame-host/inspect.js), so a pick names its file and line and the agent goes there first.
 *
 * It parses with Vite's own `parseSync` (oxc), so anything Vite compiles it reads, and inserts the
 * attribute right after the tag name - FIRST, so an explicit `data-mv-loc` or a spread later in the
 * tag wins. Edits go through magic-string, whose hires map composes with Vite's.
 *
 * Location: the `<` of the opening tag in the ORIGINAL source, 1-based line and 1-based column, the
 * column in UTF-16 code units - what JS string indices, source maps and editors' column counters
 * (VS Code included) use, so an emoji before the tag counts 2.
 */
import MagicString from 'magic-string'
import { parseSync, type Plugin } from 'vite'
import { realpathSync } from 'node:fs'
import { relative, sep } from 'node:path'

const DESIGN_FILE = /\.(tsx|jsx)$/

/** Line starts of `code`, so an offset becomes a 1-based line and column. */
function lineIndex(code: string): (offset: number) => { line: number; col: number } {
  const starts = [0]
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1)
  return (offset) => {
    let lo = 0, hi = starts.length - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1 }
    return { line: lo + 1, col: offset - starts[lo] + 1 }
  }
}

/** Add `data-mv-loc` to every host element of one design file. `file` is the path the attribute
 *  names (relative to the repo root, forward slashes). Null when there is nothing to add or the
 *  file does not parse - Vite then reports the error as it would have. */
export function addSourceLocations(code: string, file: string): { code: string; map: ReturnType<MagicString['generateMap']> } | null {
  if (!code.includes('<')) return null
  const parsed = parseSync(file, code, { lang: file.endsWith('.jsx') ? 'jsx' : 'tsx', sourceType: 'module' })
  if (parsed.errors.length) return null
  const at = lineIndex(code)
  const s = new MagicString(code)
  let added = 0
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { for (const x of n) walk(x); return }
    const node = n as { type?: string; name?: { type?: string; name?: string; end?: number }; start?: number }
    if (node.type === 'JSXOpeningElement' && node.name?.type === 'JSXIdentifier' && /^[a-z]/.test(node.name.name ?? '') && typeof node.start === 'number' && typeof node.name.end === 'number') {
      const { line, col } = at(node.start)
      // an expression, not a string literal: a path is never mistaken for JSX text, whatever it holds
      s.appendLeft(node.name.end, ` data-mv-loc={${JSON.stringify(`${file}:${line}:${col}`)}}`)
      added++
    }
    for (const k in node) if (k !== 'parent') walk((node as Record<string, unknown>)[k])
  }
  walk(parsed.program)
  if (!added) return null
  return { code: s.toString(), map: s.generateMap({ hires: true, source: file, includeContent: true }) }
}

/** The dev server's plugin: design/**\/*.tsx|jsx only, never node_modules, never the published
 *  build (dev.ts adds it; build.ts does not). Ids are real paths, so the root is matched both ways. */
export function locPlugin(root: string): Plugin {
  const roots = [...new Set([root, safeReal(root)])]
  const repoPath = (id: string): string | null => {
    const file = id.split('?')[0]
    if (!DESIGN_FILE.test(file) || file.includes(`${sep}node_modules${sep}`) || file.includes('/node_modules/')) return null
    for (const r of roots) {
      const rel = relative(r, file)
      if (!rel.startsWith('..') && (rel.startsWith(`design${sep}`) || rel.startsWith('design/'))) return rel.split(sep).join('/')
    }
    return null
  }
  return {
    name: 'marver:loc',
    enforce: 'pre',
    apply: 'serve',
    transform(code, id) {
      const file = repoPath(id)
      return file ? addSourceLocations(code, file) : null
    },
  }
}

function safeReal(p: string): string {
  try { return realpathSync(p) } catch { return p }
}
