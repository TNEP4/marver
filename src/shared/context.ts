/**
 * Reading `context/` (spec 19) - pure parsers over file text, shared by the dev server (which
 * reads status off them, spec 20) and `marver context check` (which keeps them true). No fs, no
 * git: callers read the files and hand the text in, so every reader parses one way.
 */

/** The evidence levels a shipped-record cell carries. */
export type Level = 'confirmed' | 'reported' | 'unknown'
export const LEVEL = /`(confirmed|reported|unknown)`/g
/** What counts as a citation beside a level: a `path:line`, a run id, a cited file, or a link to a
 *  system of record (a deploy run's page). A cited file must also resolve - the check sees to it. */
export const CITATION = /`[^`\s]+:\d+(-\d+)?`|\bruns? \d{6,}(, \d{6,})*|`[^`\s]+\.(md|json|ts|tsx|js|mjs|yml|yaml|sql)`|\]\(https?:\/\/[^)\s]+\)/
/** A cited repository file inside a cell, with or without a line: `path/to/x.ts`, `CHANGELOG.md:12`. */
export const CITED_FILE = /`((?:\.{0,2}[\w@.-]+\/)*[\w@.$-]+\.(?:md|json|ts|tsx|js|jsx|mjs|yml|yaml|sql|txt))(?::(\d+)(?:-(\d+))?)?`/g

/** The audiences a context file declares (spec 19, Audiences): `team` when it says nothing. */
export type Audience = 'publishable' | 'team' | 'restricted'
export const readAudience = (v: unknown): Audience => (v === 'publishable' || v === 'restricted' ? v : 'team')
const AUDIENCE_RANK: Record<Audience, number> = { publishable: 0, team: 1, restricted: 2 }
/** The strictest of several audiences - what a conclusion drawn from them may be shown to. */
export const strictest = (...a: Audience[]): Audience => a.reduce((x, y) => (AUDIENCE_RANK[y] > AUDIENCE_RANK[x] ? y : x), 'publishable' as Audience)

/** Line endings normalized: every reader parses LF, so a CRLF file means the same thing. */
export const lf = (text: string): string => text.replace(/\r\n?/g, '\n')
/** The headers whose cells carry evidence in a shipped table. */
export const EVIDENCE_COLUMN = /^(evidence|verified|available|delivered)$/i

/** The context files' own front matter: a YAML subset - scalars, flow maps `{ a: b }`, flow
 *  lists `[a, b]`, block lists. `error` names a block that opens and never closes; a file
 *  with no front matter has `data: null`. */
export interface FrontMatter { data: Record<string, unknown> | null; body: string; offset: number; error?: string }
/** A Marver-managed file's first line (the playbooks Marver maintains) - front matter follows it. */
const MANAGED_LINE = /^<!-- marver:managed [^\n]*-->\n/
export function frontMatter(raw: string): FrontMatter {
  const text = lf(raw)
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
  lf(text).split('\n').forEach((line, i) => {
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

/** A table whose header row has no outer pipes - Markdown renders it, the readers here do not. The
 *  check rejects it rather than read past it. Returns the separator rows' line numbers. */
export function looseTables(text: string): number[] {
  return proseLines(text).filter(([, l]) => !/^\s*\|/.test(l) && /^\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(l)).map(([n]) => n)
}

/** The levels an availability cell grants, clause by clause (`;` separates them). A clause counts
 *  only when it claims availability: never one carrying a negation anywhere ("nowhere", "not
 *  available", "rolled back", "withdrawn") - and, for a product's Available cell, never one scoped to
 *  a pre-production place (staging, preview, sandbox) that does not also name production. A
 *  knowledge-work Delivered cell has no environments: only negations void it. */
const NEGATION = /\b(nowhere|none|never|no longer|not (yet )?(available|live|deployed|delivered|on|in|shipped|released|out)|not yet|pending|planned|scheduled|upcoming|awaiting|withdrawn|rolled back|reverted|removed|retired|pulled)\b|^\s*not\b/i
/** The places a product is NOT yet available to its users, unless the clause also names production. */
const PRE_PRODUCTION = /\b(staging|preview|sandbox|dev|development|local|locally|testing|test environment|qa)\b/i
export function availableLevels(cell: string, kind: 'available' | 'delivered' = 'available'): Level[] {
  const out: Level[] = []
  for (const clause of cell.split(';')) {
    const c = clause.replace(/\*\*/g, '').trim()
    if (NEGATION.test(c)) continue
    if (kind === 'available' && PRE_PRODUCTION.test(c) && !/\b(production|prod)\b/i.test(c)) continue
    out.push(...levelsIn(c))
  }
  return out
}

/** The shipped record's capability rows: every table whose first column is "Capability" (a
 *  product) or "Project" / "Deliverable" (knowledge work) and that has an "Available" or
 *  "Delivered" column. The capability is the first backticked slug in the row's first cell;
 *  `levels` are the ones its availability clauses grant (availableLevels). */
export interface ShippedRow { capability: string; line: number; available: string; levels: Level[] }
export const RECORD_KEY = /^(capability|project|deliverable)$/i
export const RECORD_AVAILABLE = /^(available|delivered)$/i
export const isRecordTable = (t: Table): boolean => RECORD_KEY.test(t.header[0] ?? '') && t.header.some((h) => RECORD_AVAILABLE.test(h))
export function shippedRows(text: string): ShippedRow[] {
  const out: ShippedRow[] = []
  for (const t of tables(text)) {
    if (!isRecordTable(t)) continue
    const a = t.header.findIndex((h) => RECORD_AVAILABLE.test(h))
    const kind = /^delivered$/i.test(t.header[a]) ? 'delivered' : 'available'
    for (const r of t.rows) {
      const slug = /`([a-z0-9][a-z0-9-]*)`/.exec(r.cells[0] ?? '')?.[1]
      if (!slug) continue
      const available = r.cells[a] ?? ''
      out.push({ capability: slug, line: r.line, available, levels: availableLevels(available, kind) })
    }
  }
  return out
}

/** Is this a glob the matcher reads? Balanced, unnested braces; no character classes. */
export const validGlob = (g: string): boolean => {
  if (typeof g !== 'string' || !g || /[[\]]/.test(g)) return false
  let depth = 0
  for (const c of g) { if (c === '{') { if (++depth > 1) return false } else if (c === '}') { if (--depth < 0) return false } }
  return depth === 0
}
export const hasGlob = (g: string): boolean => /[*?{]/.test(g)
/** A glob with **, *, ? and {a,b} as a RegExp over repo-relative paths (validGlob first). */
export function globRe(glob: string): RegExp {
  let re = '', brace = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') { i++; re += '(?:[\\s\\S]*/)?' } else re += '[\\s\\S]*'
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
/** Read a map's text: the map, or what is wrong with it - every field checked, every glob valid. */
export function parseMap(text: string): CapabilityMap | string {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return 'context/map.json is not valid JSON' }
  const m = raw as Partial<CapabilityMap> | null
  if (!m || typeof m !== 'object' || !m.capabilities || typeof m.capabilities !== 'object' || Array.isArray(m.capabilities)) return 'context/map.json needs a "capabilities" object'
  const globs = (where: string, v: unknown, required: boolean): string | null => {
    if (v === undefined && !required) return null
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return `context/map.json: ${where} must be a list of paths`
    const bad = (v as string[]).findIndex((g) => !validGlob(g))
    return bad >= 0 ? `context/map.json: ${where} has an invalid glob "${(v as string[])[bad]}" (not empty; balanced, unnested {a,b}; no [...])` : null
  }
  for (const [k, c] of Object.entries(m.capabilities)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(k)) return `context/map.json: "${k}" is not a capability slug`
    const cc = c as Record<string, unknown> | null
    if (!cc || typeof cc !== 'object') return `context/map.json: "${k}" must be an object`
    const e = globs(`"${k}".paths`, cc.paths, true) ?? globs(`"${k}".tests`, cc.tests, false)
    if (e) return e
    if (cc.contract !== undefined && typeof cc.contract !== 'string') return `context/map.json: "${k}".contract must be a path`
    if (cc.summary !== undefined && typeof cc.summary !== 'string') return `context/map.json: "${k}".summary must be text`
  }
  if (m.excluded !== undefined) {
    if (!Array.isArray(m.excluded)) return 'context/map.json: "excluded" must be a list'
    for (const x of m.excluded as unknown[]) {
      const e = x as { path?: unknown; reason?: unknown } | null
      if (!e || typeof e.path !== 'string' || !validGlob(e.path)) return 'context/map.json: every "excluded" entry needs a valid "path" glob'
      if (typeof e.reason !== 'string' || !e.reason.trim()) return `context/map.json: excluded "${e.path}" needs a "reason"`
    }
  }
  { const e = globs('"source"', (m as { source?: unknown }).source, false); if (e) return e }
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
