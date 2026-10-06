/**
 * `marver context` (spec 19) - the conventions P0 proved, for any repository:
 *   init   create context/ (the index, the shipped record, the map, the playbooks Marver maintains)
 *   check  keep it true - deterministic, run in ci; exit 0 pass, 1 fail, 2 cannot determine
 *   index  rewrite the index's generated capability table from the map
 * The parsing is shared with the dev server (shared/context.ts), so the canvas's statuses and the
 * check read the files one way.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, normalize } from 'node:path'
import { NAME } from './name.ts'
import { pkgDir } from '../server/managed.ts'
import { writeManaged } from './managed-write.ts'
import { checkRealDirs } from '../server/boards.ts'
import { readStatusWord } from '../shared/board-types.ts'
import {
  CITATION, CITED_FILE, EVIDENCE_COLUMN, GENERATED, LEVEL, availableLevels, capabilityTable, frontMatter, globRe, hasGlob, isRecordTable, levelsIn, lf,
  looseTables, parseMap, proseLines, tables, wordCount, type CapabilityMap,
} from '../shared/context.ts'
import { publishGraph } from '../server/publish-graph.ts'

export const INDEX_BUDGET = 800
const CONTEXT = 'context'

// ---------------------------------------------------------------------------------------------
// init

/** Create context/ - never overwriting. The playbooks are managed: pristine ones take Marver's
 *  updates on a re-run, edited ones are kept and the new version staged for a merge. */
export function contextInit(root: string, kind: 'product' | 'knowledge' = 'product'): string[] {
  const created: string[] = []
  const templates = join(pkgDir(), 'templates')
  const name = projectName(root)
  // context/ and its playbooks must be real directories inside the project - a symlink could send a
  // write anywhere - and a file is created only where nothing is (exclusive: never truncating one
  // another author wrote a moment ago)
  const bad = checkRealDirs(root, [[join(root, CONTEXT), `${CONTEXT}/`], [join(root, CONTEXT, 'playbooks'), `${CONTEXT}/playbooks/`]])
  if (bad) throw new Error(bad)
  const plain = (rel: string, body: string) => {
    const file = join(root, CONTEXT, rel)
    mkdirFor(file)
    try { writeFileSync(file, body, { flag: 'wx' }); created.push(`${CONTEXT}/${rel}`) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  }
  plain('INDEX.md', readFileSync(join(templates, 'context', 'INDEX.md'), 'utf8').replaceAll('{{NAME}}', name)
    .replace('{{RECORD_QUESTION}}', kind === 'knowledge' ? 'Was it delivered, to whom, and when?' : 'Is it available, where, for whom, since when?'))
  // knowledge work keeps a delivered record (spec 20: it reads Done from it) - same file, same rules
  plain('shipped.md', readFileSync(join(templates, 'context', kind === 'knowledge' ? 'shipped-knowledge.md' : 'shipped.md'), 'utf8'))
  plain('map.json', readFileSync(join(templates, 'context', 'map.json'), 'utf8'))
  const pbRoot = join(templates, 'playbooks')
  for (const pb of readdirSync(pbRoot)) {
    for (const f of readdirSync(join(pbRoot, pb)).filter((x) => x.endsWith('.md'))) {
      const rel = `playbooks/${pb}/${f}`
      writeManaged({
        base: join(root, CONTEXT), rel, body: readFileSync(join(pbRoot, pb, f), 'utf8'), shown: `${CONTEXT}/${rel}`,
        stageDir: join(root, 'design', '.local', 'latest', CONTEXT), created, rerun: `\`npx ${NAME} context init\``,
      })
    }
  }
  // the conventions themselves: a canvas project has them at design/instructions/context.md (init
  // installs them); a repository without one gets the same managed file as context/README.md
  if (!existsSync(join(root, 'design', 'instructions', 'context.md'))) {
    writeManaged({
      base: join(root, CONTEXT), rel: 'README.md', body: readFileSync(join(templates, 'instructions', 'context.md'), 'utf8'), shown: `${CONTEXT}/README.md`,
      stageDir: join(root, 'design', '.local', 'latest', CONTEXT), created, rerun: `\`npx ${NAME} context init\``,
    })
  }
  // the shared entry point routes here: one line in the root AGENTS.md, appended once - atomically,
  // and only onto the file as it was read (a concurrent edit is never written over)
  const agents = join(root, 'AGENTS.md')
  const route = 'Any question about the product - what is available, how it works, why, what is next: start at context/INDEX.md.'
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = existsSync(agents) ? readFileSync(agents, 'utf8') : null
    if (cur !== null && cur.includes('context/INDEX.md')) break
    if (cur === null) {
      try { writeFileSync(agents, `# ${name}\n\n${route}\n`, { flag: 'wx' }); created.push('AGENTS.md'); break }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue; throw e }
    }
    const tmp = `${agents}.${process.pid}.${attempt}.tmp`
    writeFileSync(tmp, cur.replace(/\n*$/, '') + `\n\n${route}\n`, { flag: 'wx' })
    if (readFileSync(agents, 'utf8') !== cur) { rmSync(tmp, { force: true }); continue }
    renameSync(tmp, agents)
    created.push('AGENTS.md (updated)')
    break
  }
  return created
}

function projectName(root: string): string {
  try {
    const n = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
    if (typeof n === 'string' && n) return n.replace(/^@[^/]+\//, '')
  } catch { /* no package.json */ }
  return basename(root)
}
const mkdirFor = (file: string) => mkdirSync(dirname(file), { recursive: true })

// ---------------------------------------------------------------------------------------------
// index

/** Rewrite the index's generated table from the map. Returns the words now in the index. */
export function contextIndex(root: string): { words: number; changed: boolean } {
  const indexFile = join(root, CONTEXT, 'INDEX.md')
  const mapFile = join(root, CONTEXT, 'map.json')
  if (!existsSync(indexFile)) throw new Error(`${CONTEXT}/INDEX.md is missing - run \`npx ${NAME} context init\``)
  if (!existsSync(mapFile)) throw new Error(`${CONTEXT}/map.json is missing - run \`npx ${NAME} context init\``)
  const map = parseMap(readFileSync(mapFile, 'utf8'))
  if (typeof map === 'string') throw new Error(map)
  const text = readFileSync(indexFile, 'utf8')
  const m = GENERATED.exec(text)
  if (!m) throw new Error(`${CONTEXT}/INDEX.md has no <!-- generated --> ... <!-- /generated --> fences for the capability table`)
  const opening = text.slice(m.index, m.index + m[0].indexOf('-->') + 3)
  const next = text.slice(0, m.index) + `${opening}\n${capabilityTable(map)}\n<!-- /generated -->` + text.slice(m.index + m[0].length)
  if (next !== text) writeFileSync(indexFile, next)
  return { words: wordCount(next), changed: next !== text }
}

// ---------------------------------------------------------------------------------------------
// check

export interface Finding { rule: string; where: string; what: string }
export interface CheckResult { exit: 0 | 1 | 2; failures: Finding[]; unsure: Finding[]; notes: Finding[] }
export interface CheckOpts { base?: string; head?: string; body?: string; /** a pull request's event that could not be read */ prError?: string }

/** The supersession smells a current document never carries. */
const SUPERSEDED = /wins where it differs|wins over sections?|overrides (section|§)|section \d+ wins|supersedes section|amended by section/i
/** Availability is the shipped record's alone - a contract saying what is live is the smell. */
const AVAILABILITY = /\b(on production|on staging|in production since|live since|went live|deployed to|released to|rolled out to|shipped (on|to|in|since))\b/i
const CONTRACT_STATES = ['current', 'proposed', 'historical']
const FEEDBACK_STATES = ['new', 'triaged', 'proposed', 'planned', 'shipped', 'declined']
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g
/** A `path:line` citation - a path from the root, or a bare name the resolver looks up by basename
 *  (`run.ts:12` when one tracked file is run.ts; shorthand for the file named before it when several are). */
const CITE = /`((?:\.{0,2}[\w@.-]+\/)*[\w@.$-]+\.[a-z]{1,5}):(\d+)(?:-(\d+))?`/g
const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|['"]((?:\.{1,2}\/)+[^'"]+\.(?:md|mdx|png|jpe?g|webp|svg|pdf|json|txt|csv))(?:\?raw)?['"]/g

export function contextCheck(root: string, opts: CheckOpts = {}): CheckResult {
  const failures: Finding[] = [], unsure: Finding[] = [], notes: Finding[] = []
  const fail = (rule: string, where: string, what: string) => failures.push({ rule, where, what })
  const cannot = (rule: string, what: string) => unsure.push({ rule, where: '', what })
  const note = (rule: string, what: string) => notes.push({ rule, where: '', what })
  const exists = (p: string) => existsSync(join(root, p))
  const read = (p: string) => readFileSync(join(root, p), 'utf8')
  // a large monorepo's file list runs to megabytes: a deliberate ceiling, and NUL-separated paths
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 })

  if (!exists(CONTEXT)) {
    fail('context', `${CONTEXT}/`, `missing - run \`npx ${NAME} context init\``)
    return { exit: 1, failures, unsure, notes }
  }

  const walk = (dir: string): string[] => {
    if (!exists(dir)) return []
    const out: string[] = []
    for (const n of readdirSync(join(root, dir))) {
      const p = `${dir}/${n}`
      const st = lstatSync(join(root, p))
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) out.push(...walk(p)); else out.push(p)
    }
    return out
  }
  const docs = walk(CONTEXT).filter((p) => p.endsWith('.md')).map((path) => {
    const text = read(path)
    return { path, text, ...frontMatter(text) }
  })
  for (const d of docs) if (d.error) fail('front-matter', d.path, d.error)
  const isContract = (d: (typeof docs)[number]) => d.data?.state === 'current' && /^context\/(product|system)\//.test(d.path)

  // 1. status lines and availability claims in current contracts - each kind on its own terms
  for (const d of docs.filter(isContract)) {
    for (const [n, line] of proseLines(d.body, d.offset)) {
      if (/^\s*\**status\**\s*:/i.test(line)) fail('status-line', `${d.path}:${n}`, `a status line in a current contract - status lives in ${CONTEXT}/shipped.md`)
      const a = line.match(AVAILABILITY)
      if (a) fail('availability', `${d.path}:${n}`, `"${a[0]}" - availability lives in ${CONTEXT}/shipped.md`)
    }
  }

  // 2. supersession smells in any current document
  for (const d of docs.filter((x) => x.data?.state === 'current')) {
    for (const [n, line] of proseLines(d.body, d.offset)) {
      const m = line.match(SUPERSEDED)
      if (m) fail('supersession', `${d.path}:${n}`, `"${m[0]}" - fold the amendment in; one answer per rule`)
    }
  }

  let tracked: Set<string> | null = null
  try { tracked = new Set(git('ls-files', '-z').split('\0').filter(Boolean)) } catch { cannot('git', 'git ls-files failed - not a repository?') }
  /** A cited file, resolved: a path from the root, or a bare name (`run.test.ts`) that one tracked
   *  file carries - several mean the citation is shorthand for the one named before it. Returns the
   *  path, 'ambiguous', or null when nothing carries it. */
  const byBase = new Map<string, string[]>()
  if (tracked) for (const t of tracked) { const b = t.slice(t.lastIndexOf('/') + 1); byBase.set(b, [...(byBase.get(b) ?? []), t]) }
  const resolveCited = (f: string): string | 'ambiguous' | null => {
    if (exists(f)) return statSync(join(root, f)).isFile() ? f : null
    if (f.includes('/')) return null
    const hits = byBase.get(f) ?? []
    return hits.length === 1 ? hits[0] : hits.length > 1 ? 'ambiguous' : null
  }
  const lines = new Map<string, number>()
  const linesOf = (p: string) => { if (!lines.has(p)) lines.set(p, read(p).split('\n').length); return lines.get(p)! }
  /** What is wrong with a citation - a file nothing carries, a line past its end, a range backwards - or null. */
  const citationProblem = (file: string, from?: string, to?: string): string | null => {
    const f = file.replace(/^\.\//, '')
    const r = resolveCited(f)
    if (r === null) return `${f} does not exist`
    if (r === 'ambiguous' || !from) return null
    const a = Number(from), z = Number(to ?? from)
    if (z < a) return `${f}:${from}-${to} runs backwards`
    if (z > linesOf(r)) return `${f}:${from}${to ? `-${to}` : ''} is past the end of ${r} (${linesOf(r)} lines)`
    return null
  }

  // 3. the shipped record: a level in every evidence cell, a citation beside confirmed and reported
  const shippedPath = `${CONTEXT}/shipped.md`
  if (!exists(shippedPath)) fail('shipped', shippedPath, 'missing')
  else {
    const text = read(shippedPath)
    if (!tables(text).some(isRecordTable)) fail('shipped-shape', shippedPath, 'no Capability (or Project) table with an Available (or Delivered) column - the canvas cannot read a status from it')
    for (const n of looseTables(text)) fail('table-format', `${shippedPath}:${n}`, 'a table without outer pipes - start and end every row with |')
    for (const t of tables(text)) {
      for (const r of t.rows) {
        const where = `${shippedPath}:${r.line}`
        if (!r.cells.some((c) => levelsIn(c).length)) fail('shipped-level', where, 'a row with no evidence level')
        r.cells.forEach((c, i) => {
          if (EVIDENCE_COLUMN.test(t.header[i] ?? '') && !/^nowhere\b/i.test(c) && !levelsIn(c).length)
            fail('shipped-level', where, `the ${t.header[i]} cell has no evidence level`)
          for (const m of c.matchAll(LEVEL))
            if (m[1] !== 'unknown' && !CITATION.test(c)) fail('shipped-citation', where, `\`${m[1]}\` with no citation in its cell`)
          // a cited file must resolve, with or without a line
          if (levelsIn(c).length) for (const m of c.matchAll(CITED_FILE)) {
            const problem = citationProblem(m[1], m[2], m[3])
            if (problem) fail('dead-citation', where, problem)
          }
        })
      }
    }
  }

  // 4. links and citations resolve
  for (const d of docs) {
    for (const [n, line] of proseLines(d.body, d.offset)) {
      for (const m of line.matchAll(LINK)) {
        const href = m[1].split('#')[0]
        if (!href || /^[a-z]+:/i.test(href)) continue
        if (!exists(normalize(join(dirname(d.path), href)))) fail('dead-link', `${d.path}:${n}`, `${m[1]} does not exist`)
      }
      // a historical document cites files as they were at its revision, and says so
      if (d.data?.state === 'historical') continue
      for (const m of line.matchAll(CITE)) {
        const problem = citationProblem(m[1], m[2], m[3])
        if (problem) fail('dead-citation', `${d.path}:${n}`, problem)
      }
    }
  }

  // 5. the index: under budget, its generated table equal to the map
  let map: CapabilityMap | null = null
  const mapPath = `${CONTEXT}/map.json`
  if (!exists(mapPath)) fail('map', mapPath, 'missing')
  else {
    const m = parseMap(read(mapPath))
    if (typeof m === 'string') fail('map', mapPath, m); else map = m
  }
  const indexPath = `${CONTEXT}/INDEX.md`
  if (!exists(indexPath)) fail('index', indexPath, 'missing')
  else {
    const text = read(indexPath)
    const words = wordCount(text)
    if (words > INDEX_BUDGET) fail('index-budget', indexPath, `${words} words, budget ${INDEX_BUDGET}`)
    else note('index', `${words} / ${INDEX_BUDGET} words`)
    if (map) {
      const fenced = GENERATED.exec(text)?.[1]
      if (fenced === undefined) fail('index-table', indexPath, 'no <!-- generated --> fences around the capability table')
      else {
        const want = capabilityTable(map).trim(), have = lf(fenced).trim()
        if (want !== have) fail('index-table', indexPath, `the capability table differs from ${mapPath} - run \`npx ${NAME} context index\``)
      }
    }
  }

  // 6. audiences: restricted never tracked; nothing but publishable reachable from a published board
  if (tracked) for (const d of docs) if (d.data?.audience === 'restricted' && tracked.has(d.path)) fail('audience', d.path, 'restricted, yet tracked by git')
  // what a build would carry - the build's own selection, layouts, providers and aliases included
  const graph = publishGraph(root)
  let inContext = 0
  for (const p of graph.files) {
    const md = /\.mdx?$/.test(p)
    const declared = md ? frontMatter(read(p)).data?.audience : undefined
    if (p.startsWith(`${CONTEXT}/`)) {
      inContext++
      // under context/ everything is team unless a markdown file says publishable - data files included
      const audience = typeof declared === 'string' ? declared : 'team'
      if (audience !== 'publishable') fail('audience', p, `${audience} material reachable from design/publish.json`)
    } else if (typeof declared === 'string' && declared !== 'publishable') fail('audience', p, `${declared} material reachable from design/publish.json`)
  }
  for (const u of graph.unresolved) {
    if (/context\//.test(u.spec)) cannot('audience', `${u.from} imports ${u.spec}, which does not resolve - cannot tell what it would publish`)
  }
  note('audience', `${graph.files.size} files reachable from design/publish.json; ${inContext} under ${CONTEXT}/`)

  // 7. each kind's own states
  for (const d of docs) {
    if (d.path.startsWith(`${CONTEXT}/product/`) && d.data && !CONTRACT_STATES.includes(String(d.data.state)))
      fail('state', d.path, `state "${String(d.data.state)}" is not a contract state (${CONTRACT_STATES.join(', ')})`)
    if (!d.path.startsWith(`${CONTEXT}/feedback/`)) continue
    for (const n of looseTables(d.text)) fail('table-format', `${d.path}:${n}`, 'a table without outer pipes - start and end every row with |')
    for (const t of tables(d.text)) {
      const si = t.header.findIndex((h) => /^state$/i.test(h))
      if (si < 0) continue
      // what closed it: the "Resolved by" column when there is one, else the last - never a quote
      let ri = t.header.findIndex((h) => /resolv/i.test(h))
      if (ri < 0) ri = t.header.length - 1
      for (const r of t.rows) {
        const state = (r.cells[si] ?? '').replace(/`/g, '').trim()
        const where = `${d.path}:${r.line}`
        if (!FEEDBACK_STATES.includes(state)) fail('state', where, `"${state}" is not a feedback state (${FEEDBACK_STATES.join(', ')})`)
        const resolution = r.cells[ri] ?? ''
        if (state !== 'shipped') continue
        if (ri === si || !availableLevels(resolution).includes('confirmed') || !CITATION.test(resolution))
          fail('feedback-closed', where, 'shipped without a cited `confirmed` availability in its resolution')
        for (const m of resolution.matchAll(CITED_FILE)) { const problem = citationProblem(m[1], m[2], m[3]); if (problem) fail('dead-citation', where, problem) }
      }
    }
  }

  // 8. the map: contracts and tests exist; every source file mapped or excluded (a note)
  if (map) {
    for (const [cap, c] of Object.entries(map.capabilities)) {
      if (c.contract && !exists(c.contract)) fail('map', mapPath, `${cap}: contract ${c.contract} does not exist`)
      for (const t of c.tests ?? []) {
        const found = hasGlob(t) ? (tracked ? [...tracked].some((f) => globRe(t).test(f)) : true) : exists(t)
        if (!found) fail('map', mapPath, `${cap}: test ${t} ${hasGlob(t) ? 'matches no tracked file' : 'does not exist'}`)
      }
    }
    if (tracked && map.source?.length) {
      const inSource = map.source.map(globRe)
      const covered = [...Object.values(map.capabilities).flatMap((c) => [...c.paths, ...(c.tests ?? [])]), ...map.excluded.map((e) => e.path)].map(globRe)
      const loose = [...tracked].filter((p) => inSource.some((r) => r.test(p)) && !covered.some((r) => r.test(p)))
      note('map', loose.length ? `${loose.length} source files neither mapped nor excluded, e.g. ${loose.slice(0, 5).join(', ')}` : 'every source file is mapped or excluded')
    }
  }

  // 9. boards: Done is never set by hand
  const boardsDir = join(root, 'design', 'boards')
  if (existsSync(boardsDir)) {
    for (const f of readdirSync(boardsDir).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
      try {
        const j = JSON.parse(readFileSync(join(boardsDir, f), 'utf8'))
        if (readStatusWord(j?.status) === 'done') fail('board-status', `design/boards/${f}`, '"status": "done" - Done comes only from the shipped record; remove it')
      } catch { /* a malformed board is the dev server's and the build's to report */ }
    }
  }

  // 10. playbooks: current, stale or unknown since their last success
  for (const d of docs.filter((x) => /\/playbooks\/[^/]+\/PLAYBOOK\.md$/.test(x.path))) {
    const ls = d.data?.last_success as { revision?: unknown } | undefined
    const rev = typeof ls === 'object' && ls ? ls.revision : undefined
    const all = ([] as unknown[]).concat(d.data?.depends_on ?? []).filter((x): x is string => typeof x === 'string')
    const deps = all.filter((x) => !/^(service|account)\s*:/.test(x))
    const outside = all.length - deps.length
    if (typeof rev !== 'string') { note('playbook', `${d.path}: unknown - no last_success.revision`); continue }
    try {
      git('cat-file', '-e', `${rev}^{commit}`)
      const changed = deps.length ? git('diff', '--name-only', rev, '--', ...deps).trim() : ''
      // a service or an account cannot be read from git: the playbook is current only as far as its files say
      note('playbook', `${d.path}: ${changed ? `stale - ${changed.split('\n').length} dependencies changed since ${rev}` : outside ? `unknown - its files are unchanged since ${rev}, ${outside} dependenc${outside === 1 ? 'y' : 'ies'} outside git (a service, an account) cannot be checked` : `current since ${rev} (working tree included)`}`)
    } catch { note('playbook', `${d.path}: unknown - ${rev} is not in this clone's history`) }
  }

  // 11. a pull request: a change to a contracted capability's code changes its contract, or says why not
  if (opts.prError) cannot('pr', opts.prError)
  if (opts.base && map) {
    let changed: string[] | null = null
    try { changed = git('diff', '--name-only', '-z', `${opts.base}...${opts.head ?? 'HEAD'}`).split('\0').filter(Boolean) }
    catch { cannot('pr', `no merge base between ${opts.base} and ${opts.head ?? 'HEAD'} - fetch full history (fetch-depth: 0)`) }
    if (changed) {
      for (const [cap, c] of Object.entries(map.capabilities)) {
        if (!c.contract) continue
        const res = c.paths.map(globRe)
        const hit = changed.filter((p) => res.some((r) => r.test(p)))
        if (!hit.length || changed.includes(c.contract)) continue
        const waiver = new RegExp(`no-contract-change:\\s*${cap}\\s*-\\s*\\S`, 'i')
        if (!waiver.test(opts.body ?? ''))
          fail('pr', cap, `changes ${hit.length} mapped file(s) (${hit.slice(0, 3).join(', ')}) without ${c.contract} - update it, or write "no-contract-change: ${cap} - <why>" in the pull request`)
      }
    }
  }

  return { exit: failures.length ? 1 : unsure.length ? 2 : 0, failures, unsure, notes }
}

/** The pull request this ci run checks, from GitHub's event payload: base, head and body. */
export function pullRequestFromEnv(env = process.env): CheckOpts | null {
  if (!/^pull_request(_target)?$/.test(env.GITHUB_EVENT_NAME ?? '')) return null
  try {
    const ev = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8'))
    const pr = ev.pull_request
    if (typeof pr?.base?.sha !== 'string' || typeof pr?.head?.sha !== 'string') throw new Error('no base and head in the event')
    return { base: pr.base.sha, head: pr.head.sha, body: typeof pr.body === 'string' ? pr.body : '' }
  } catch (e) {
    // a pull request we cannot read is never a pass without the rule
    return { prError: `the pull request event (GITHUB_EVENT_PATH) could not be read: ${(e as Error).message}` }
  }
}

/** The human report. */
export function printCheck(r: CheckResult) {
  for (const n of r.notes) console.log(`  ${n.rule}  ${n.what}`)
  for (const u of r.unsure) console.log(`? ${u.rule}  cannot determine: ${u.what}`)
  for (const f of r.failures) console.log(`✗ ${f.rule}  ${f.where}  ${f.what}`)
  console.log(`\ncontext check: ${r.exit === 0 ? 'pass' : r.exit === 1 ? `${r.failures.length} failing` : 'cannot determine'}`)
}

/** Where this repository's context conventions live - the canvas's instruction, else context/README.md. */
export const conventionsPath = (root: string): string =>
  existsSync(join(root, 'design', 'instructions', 'context.md')) ? 'design/instructions/context.md' : `${CONTEXT}/README.md`
