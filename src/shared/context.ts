/**
 * Reading `context/` (spec 19) - pure parsers over file text, shared by the dev server (which
 * reads status off them, spec 20) and `marver context check` (which keeps them true). No fs, no
 * git: callers read the files and hand the text in, so every reader parses one way.
 */

/** The evidence levels a shipped-record cell carries. */
export type Level = 'confirmed' | 'reported' | 'unknown'
export const LEVEL = /`(confirmed|reported|unknown)`/g
/** What counts as a citation beside a level: a `path:line`, a run id, or a cited file. */
export const CITATION = /`[^`\s]+:\d+(-\d+)?`|\bruns? \d{6,}(, \d{6,})*|`[^`\s]+\.(md|json|ts|tsx|js|mjs|yml|yaml|sql)`/
/** The headers whose cells carry evidence in a shipped table. */
export const EVIDENCE_COLUMN = /^(evidence|verified|available)$/i

/** The context files' own front matter: a YAML subset - scalars, flow maps `{ a: b }`, flow
 *  lists `[a, b]`, block lists. `error` names a block that opens and never closes; a file
 *  with no front matter has `data: null`. */
export interface FrontMatter { data: Record<string, unknown> | null; body: string; offset: number; error?: string }
/** A Marver-managed file's first line (the playbooks Marver maintains) - front matter follows it. */
const MANAGED_LINE = /^<!-- marver:managed [^\n]*-->\n/
export function frontMatter(text: string): FrontMatter {
  const managed = MANAGED_LINE.exec(text)
  if (managed) {
    const r = frontMatter(text.slice(managed[0].length))
    return { ...r, offset: r.offset + 1 }
  }
  if (!text.startsWith('---\n')) return { data: null, body: text, offset: 0 }
  const m = text.match(/^---\n([\s\S]*?)\n---[ \t]*(\n|$)/)
  if (!m) return { data: null, body: text, offset: 0, error: 'front matter opens with --- and never closes' }
  const data: Record<string, unknown> = {}
  let key: string | null = null
  for (const line of m[1].split('\n')) {
    const item = line.match(/^\s+-\s+(.*)$/)
    if (item && key) {
      if (!Array.isArray(data[key])) data[key] = []
      ;(data[key] as unknown[]).push(scalar(item[1]))
      continue
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!kv) continue
    key = kv[1]
    data[key] = kv[2] === '' ? [] : value(kv[2])
  }
  return { data, body: text.slice(m[0].length), offset: m[0].split('\n').length - 1 }
}
function scalar(s: string): string {
  s = s.trim().replace(/\s+#.*$/, '')
  if (/^".*"$|^'.*'$/.test(s)) return s.slice(1, -1)
  return s
}
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0, cur = '', q: string | null = null
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue }
    if (ch === '{' || ch === '[') depth++
    if (ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out
}
function value(s: string): unknown {
  s = s.trim().replace(/\s+#[^"'}\]]*$/, '')
  if (s.startsWith('{') && s.endsWith('}')) {
    const o: Record<string, unknown> = {}
    for (const part of splitTop(s.slice(1, -1))) {
      const i = part.indexOf(':')
      if (i > 0) o[part.slice(0, i).trim()] = value(part.slice(i + 1))
    }
    return o
  }
  if (s.startsWith('[') && s.endsWith(']')) return splitTop(s.slice(1, -1)).map((x) => value(x))
  return scalar(s)
}

/** Lines outside fenced code blocks, with their 1-based numbers in the whole file. */
export function proseLines(text: string, offset = 0): [number, string][] {
  const out: [number, string][] = []
  let fenced = false
  text.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return }
    if (!fenced) out.push([i + 1 + offset, line])
  })
  return out
}

/** Markdown tables outside code: each header and its rows, cells trimmed, with line numbers. */
export interface Table { header: string[]; headerLine: number; rows: { line: number; cells: string[] }[] }
export function tables(text: string): Table[] {
  const out: Table[] = []
  let cur: Table | null = null
  for (const [n, line] of proseLines(text)) {
    if (!/^\s*\|/.test(line)) { cur = null; continue }
    if (/^\s*\|[\s|:-]+\|\s*$/.test(line)) continue
    const cells = splitRow(line)
    if (!cur) { cur = { header: cells, headerLine: n, rows: [] }; out.push(cur); continue }
    cur.rows.push({ line: n, cells })
  }
  return out
}
/** A table row's cells - pipes inside backticks stay in their cell. */
function splitRow(line: string): string[] {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const out: string[] = []
  let cur = '', code = false
  for (const ch of s) {
    if (ch === '`') code = !code
    if (ch === '|' && !code) { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  out.push(cur.trim())
  return out
}

export const levelsIn = (cell: string): Level[] => [...cell.matchAll(LEVEL)].map((m) => m[1] as Level)

/** The shipped record's capability rows: every table whose first column is "Capability" and that
 *  has an "Available" column. The capability is the first backticked slug in the row's first cell. */
export interface ShippedRow { capability: string; line: number; available: string; levels: Level[] }
export function shippedRows(text: string): ShippedRow[] {
  const out: ShippedRow[] = []
  for (const t of tables(text)) {
    if (!/^capability$/i.test(t.header[0] ?? '')) continue
    const a = t.header.findIndex((h) => /^available$/i.test(h))
    if (a < 0) continue
    for (const r of t.rows) {
      const slug = /`([a-z0-9][a-z0-9-]*)`/.exec(r.cells[0] ?? '')?.[1]
      if (!slug) continue
      const available = r.cells[a] ?? ''
      out.push({ capability: slug, line: r.line, available, levels: levelsIn(available) })
    }
  }
  return out
}

/** A glob with **, *, ? and {a,b} as a RegExp over repo-relative paths. */
export function globRe(glob: string): RegExp {
  let re = '', brace = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') { brace++; re += '(?:' }
    else if (c === '}' && brace) { brace--; re += ')' }
    else if (c === ',' && brace) re += '|'
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** `context/map.json`'s shape. */
export interface CapabilityMap {
  /** `summary` - a few words the index shows beside the slug, so a reader routes without opening the contract */
  capabilities: Record<string, { contract?: string; summary?: string; paths: string[]; tests?: string[] }>
  excluded: { path: string; reason: string }[]
  /** the globs whose files must be mapped or excluded - the check reports any that is neither */
  source?: string[]
}
/** Read a map's text: the map, or what is wrong with it. */
export function parseMap(text: string): CapabilityMap | string {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return 'context/map.json is not valid JSON' }
  const m = raw as Partial<CapabilityMap> | null
  if (!m || typeof m !== 'object' || !m.capabilities || typeof m.capabilities !== 'object') return 'context/map.json needs a "capabilities" object'
  for (const [k, c] of Object.entries(m.capabilities)) {
    if (!c || !Array.isArray((c as { paths?: unknown }).paths)) return `context/map.json: "${k}" needs a "paths" list`
  }
  const source = Array.isArray(m.source) ? m.source.filter((x): x is string => typeof x === 'string') : undefined
  return { capabilities: m.capabilities as CapabilityMap['capabilities'], excluded: Array.isArray(m.excluded) ? m.excluded : [], ...(source ? { source } : {}) }
}

/** The index's generated capability table, between `<!-- generated ... -->` fences. */
export const GENERATED = /<!-- generated[^>]*-->([\s\S]*?)<!-- \/generated -->/
/** The table the index generates from the map: one row per capability, its contract linked. */
export function capabilityTable(map: CapabilityMap): string {
  const rows = Object.entries(map.capabilities).map(([k, c]) => {
    const name = `\`${k}\`${typeof c.summary === 'string' && c.summary.trim() ? ` - ${c.summary.trim().replace(/\|/g, '/')}` : ''}`
    const rel = c.contract?.replace(/^context\//, '')
    return rel ? `| ${name} | [\`${rel}\`](${rel}) |` : `| ${name} | none yet - see the map |`
  })
  return ['| Capability | Contract |', '|---|---|', ...rows].join('\n')
}

/** Words in a document's body (front matter excluded) - the index's budget counts these. */
export const wordCount = (text: string): number => frontMatter(text).body.split(/\s+/).filter(Boolean).length
