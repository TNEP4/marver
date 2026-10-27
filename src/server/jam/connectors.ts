/**
 * Connectors (spec 29b, Part 2): the hooks that connect Claude Code, Codex and Cursor sessions in this
 * repo to Live Jam - written by `marver init`, by `marver dev` at boot, and when a Jam session starts.
 * The owner never writes them; they are what makes starting a Jam session the one switch.
 *
 * Every entry runs one command, `<repo>/node_modules/.bin/marver jam hook|listen ...`. The merge only
 * ever touches Marver's own entries (recognised by that command), keeps every other key and hook, and
 * leaves alone a file that does not parse, a file git tracks, and an entry the owner removed by hand.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { onPath } from './agent.ts'
import { jamDir, readPrefs, writeAtomic, writePrefs, type ConnAgent } from './conn.ts'

/** Marver's own hook commands - how an entry is recognised as ours, whatever path it was written with. */
export const OURS = /\bmarver(?:\.mjs)?["']?\s+jam\s+(?:hook|listen)\b/

export type ConnectorState = 'installed' | 'present' | 'tracked' | 'unreadable' | 'removed' | 'off' | 'no-bin' | 'absent' | 'failed'
export interface ConnectorResult { agent: ConnAgent; file: string; state: ConnectorState; note?: string }

const FILES: Record<ConnAgent, string> = {
  claude: '.claude/settings.local.json',
  codex: '.codex/hooks.json',
  cursor: '.cursor/hooks.json',
}
/** The CLIs (and app) whose presence means the owner uses that tool here. */
const BINS: Record<ConnAgent, string[]> = { claude: ['claude'], codex: ['codex'], cursor: ['cursor-agent', 'cursor'] }

/** The marver the hooks run: the repo's own install (fast, no network). */
export const hookBin = (root: string): string | null => {
  const bin = join(root, 'node_modules', '.bin', 'marver')
  return existsSync(bin) ? bin : null
}
const q = (s: string) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`

type Json = Record<string, any>
type Handler = { type?: string; command?: string; async?: boolean; timeout?: number }

/** Every event's handlers, as Claude Code and Codex nest them: `hooks[event] = [{ matcher?, hooks: [handler] }]`. */
function mergeNested(file: Json, want: Record<string, Handler[]>): Json {
  const hooks: Json = file.hooks && typeof file.hooks === 'object' && !Array.isArray(file.hooks) ? { ...file.hooks } : {}
  // ours go first out of every event (whatever version wrote them), then come back as they are now
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue
    hooks[ev] = hooks[ev].map((g: Json) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h: Handler) => !(typeof h?.command === 'string' && OURS.test(h.command))) } : g))
      .filter((g: Json) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0))
    if (!hooks[ev].length) delete hooks[ev]
  }
  for (const [ev, handlers] of Object.entries(want)) hooks[ev] = [...(Array.isArray(hooks[ev]) ? hooks[ev] : []), { hooks: handlers }]
  return { ...file, hooks }
}

/** Cursor's flat shape: `hooks[event] = [{ command, ... }]`, with `version: 1`. */
function mergeFlat(file: Json, want: Record<string, Json[]>): Json {
  const hooks: Json = file.hooks && typeof file.hooks === 'object' && !Array.isArray(file.hooks) ? { ...file.hooks } : {}
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue
    hooks[ev] = hooks[ev].filter((h: Json) => !(typeof h?.command === 'string' && OURS.test(h.command)))
    if (!hooks[ev].length) delete hooks[ev]
  }
  for (const [ev, entries] of Object.entries(want)) hooks[ev] = [...(Array.isArray(hooks[ev]) ? hooks[ev] : []), ...entries]
  return { version: 1, ...file, hooks }
}

/** Is any entry of ours in this file? (Each command looked at as written - in JSON its quotes are escaped.) */
const hasOurs = (file: Json): boolean => {
  const cmds: string[] = []
  const walk = (v: unknown) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'command' && typeof x === 'string') cmds.push(x); else walk(x) } }
  walk(file.hooks)
  return cmds.some((c) => OURS.test(c))
}

/** What each tool's file should hold, for this repo's marver. */
export function wanted(agent: ConnAgent, bin: string, root: string): { nested?: Record<string, Handler[]>; flat?: Record<string, Json[]> } {
  // every command names the repo: a hook runs wherever its session's folder is
  const r = ` --root ${q(root)}`
  if (agent === 'claude') {
    // the listener on both: a new session listens from its first second, an open one from its next prompt (S29-5, S29-5b)
    const listen: Handler = { type: 'command', command: `${q(bin)} jam listen${r}`, async: true }
    return { nested: { SessionStart: [listen], UserPromptSubmit: [listen], SessionEnd: [{ type: 'command', command: `${q(bin)} jam hook claude end${r}`, timeout: 10 }] } }
  }
  if (agent === 'codex') {
    const h = (ev: string): Handler => ({ type: 'command', command: `${q(bin)} jam hook codex ${ev}${r}`, timeout: 10 })
    return { nested: { SessionStart: [h('start')], UserPromptSubmit: [h('prompt')], Stop: [h('stop')], SessionEnd: [h('end')] } }
  }
  // Cursor runs project hooks from the project root
  const h = (ev: string, extra: Json = {}): Json => ({ command: `${q(bin)} jam hook cursor ${ev}${r}`, timeout: 10, ...extra })
  return { flat: { sessionStart: [h('start')], beforeSubmitPrompt: [h('prompt')], stop: [h('stop', { loop_limit: 20 })], sessionEnd: [h('end')] } }
}

// ---- git: never a tracked file; an untracked one kept out of commits ----------------------------

const git = (root: string, args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5_000 })
const inGit = (root: string) => git(root, ['rev-parse', '--git-dir']).status === 0
export const tracked = (root: string, rel: string): boolean => inGit(root) && git(root, ['ls-files', '--error-unmatch', '--', rel]).status === 0
const ignored = (root: string, rel: string): boolean => git(root, ['check-ignore', '-q', '--', rel]).status === 0

/** Keep `rel` out of commits without touching a committed file: .git/info/exclude is local. */
function exclude(root: string, rel: string): void {
  if (!inGit(root) || ignored(root, rel)) return
  const r = git(root, ['rev-parse', '--git-path', 'info/exclude'])
  if (r.status !== 0) return
  const p = r.stdout.trim()
  const file = isAbsolute(p) ? p : join(root, p)
  const line = `/${rel.split('\\').join('/')}`
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { /* none yet */ }
  if (text.split('\n').some((l) => l.trim() === line)) return
  mkdirSync(dirname(file), { recursive: true })
  writeAtomic(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}# marver: Live Jam's local hooks\n${line}\n`, 0o644)
}

// ---- what was installed (a removal by hand is remembered) ----------------------------------------

const recordFile = (root: string) => join(jamDir(root), 'connectors.json')
type Installed = Partial<Record<ConnAgent, { file: string; at: number }>>
const readInstalled = (root: string): Installed => { try { return JSON.parse(readFileSync(recordFile(root), 'utf8')) } catch { return {} } }
const writeInstalled = (root: string, r: Installed) => { mkdirSync(jamDir(root), { recursive: true, mode: 0o700 }); writeAtomic(recordFile(root), JSON.stringify(r, null, 1)) }

/** Is this tool used on this Mac (its CLI on PATH, or - Cursor - its app)? */
export function present(agent: ConnAgent, env: NodeJS.ProcessEnv = process.env): boolean {
  if (BINS[agent].some((b) => onPath(b, env))) return true
  return agent === 'cursor' && existsSync('/Applications/Cursor.app')
}

/**
 * Write the connectors this repo is missing. `force` (the start sheet turning a tool back on) writes
 * one the owner had removed. Never throws: each tool's result says what happened.
 */
export function ensureConnectors(root: string, opts: { agents?: ConnAgent[]; force?: ConnAgent[]; env?: NodeJS.ProcessEnv; bin?: string | null } = {}): ConnectorResult[] {
  const env = opts.env ?? process.env
  const agents = opts.agents ?? (['claude', 'codex', 'cursor'] as ConnAgent[]).filter((a) => present(a, env))
  const bin = opts.bin === undefined ? hookBin(root) : opts.bin
  const prefs = readPrefs(root)
  const installed = readInstalled(root)
  const out: ConnectorResult[] = []
  // a tool turned back on in the sheet is on again, written or not
  if (opts.force?.some((a) => prefs.off?.[a])) {
    for (const a of opts.force) delete prefs.off?.[a]
    try { writePrefs(root, prefs) } catch { /* said below if it matters */ }
  }
  for (const agent of agents) {
    const rel = FILES[agent]
    const file = join(root, rel)
    const res = (state: ConnectorState, note?: string) => out.push({ agent, file: rel, state, ...(note ? { note } : {}) })
    try {
      if (prefs.off?.[agent] && !opts.force?.includes(agent)) { res('off'); continue }
      if (!bin) { res('no-bin', 'marver is not installed in this repo (node_modules/.bin/marver)'); continue }
      let cur: Json = {}
      if (existsSync(file)) {
        if (!statSync(file).isFile()) { res('unreadable', `${rel} is not a file`); continue }
        try { cur = JSON.parse(readFileSync(file, 'utf8') || '{}') } catch { res('unreadable', `${rel} does not parse - left as it is`); continue }
        if (!cur || typeof cur !== 'object' || Array.isArray(cur)) { res('unreadable', `${rel} is not a JSON object - left as it is`); continue }
      }
      if (tracked(root, rel)) { res('tracked', `${rel} is committed to git - Marver never changes a committed file`); continue }
      // ours were here and are gone - the entries, or the whole file: you removed them - not written again until you
      // turn this tool back on in the start sheet
      if (installed[agent] && (!existsSync(file) || !hasOurs(cur)) && !opts.force?.includes(agent)) { res('removed'); continue }
      const w = wanted(agent, bin, root)
      const next = w.nested ? mergeNested(cur, w.nested) : mergeFlat(cur, w.flat!)
      if (JSON.stringify(next) === JSON.stringify(cur)) { exclude(root, rel); res('present'); continue }
      mkdirSync(dirname(file), { recursive: true })
      writeAtomic(file, JSON.stringify(next, null, 2) + '\n', 0o644)
      exclude(root, rel)
      installed[agent] = { file: rel, at: Date.now() }
      res('installed')
    } catch (err) { res('failed', (err as Error).message) }
  }
  try { writeInstalled(root, installed) } catch { /* the record is a convenience */ }
  return out
}

/** One line for the dev server and init: what the connectors did, or nothing worth saying. */
export function connectorLine(results: ConnectorResult[]): string | null {
  const name: Record<ConnAgent, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' }
  const made = results.filter((r) => r.state === 'installed').map((r) => name[r.agent])
  const skipped = results.filter((r) => ['tracked', 'unreadable', 'failed'].includes(r.state))   // (no local marver: quiet - an npx run, a scratch folder)
  const parts: string[] = []
  if (made.length) parts.push(`jam: connected ${made.join(', ')} sessions in this repo - their hooks are in ${results.filter((r) => r.state === 'installed').map((r) => r.file).join(', ')} (local, never committed)${results.some((r) => r.state === 'installed' && r.agent === 'codex') ? '; Codex asks you to trust them once (/hooks)' : ''}`)
  for (const s of skipped) parts.push(`jam: ${name[s.agent]} not connected - ${s.note ?? s.state}`)
  return parts.length ? parts.map((p) => `  ${p}`).join('\n') : null
}

/** The repo-relative path of a connector file, for messages. */
export const connectorFile = (agent: ConnAgent) => FILES[agent]
