/**
 * Which session a background run copies (spec 29b, Part 4): the owner's selected session, else the
 * newest of this repo - a connected one first, else the newest transcript on disk (read for its id
 * only). Interactive sessions only: a headless run (Marver's own, a review) is never a source.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ForkAgent = 'claude' | 'codex'

/** A transcript too long to copy is not copied: the run starts fresh and its lane line says so. */
export const FORK_MAX_BYTES = 12 * 1024 * 1024

export interface ForkSource { agent: ForkAgent; session: string; bytes: number; file: string }

const claudeHome = (env: NodeJS.ProcessEnv) => env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const codexHome = (env: NodeJS.ProcessEnv) => env.CODEX_HOME || join(homedir(), '.codex')
/** The same folder, links resolved (macOS's /var is /private/var; a repo opened through a link). */
const real = (p: string) => { try { return realpathSync(p) } catch { return p } }
const sameDir = (a: unknown, b: string) => typeof a === 'string' && (a === b || real(a) === real(b))

/** Claude Code's folder for a project: its path with every character but letters and digits made a dash. */
export const claudeSlug = (root: string) => root.replace(/[^A-Za-z0-9]/g, '-')

/** The first `max` bytes of a file, as lines (the last, maybe cut, dropped). */
function headLines(file: string, max = 64 * 1024): string[] {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(max)
    const n = readSync(fd, buf, 0, max, 0)
    const lines = buf.subarray(0, n).toString('utf8').split('\n')
    return n === max ? lines.slice(0, -1) : lines
  } catch { return [] } finally { if (fd !== undefined) closeSync(fd) }
}

/** A Claude Code session's transcript, when it is an interactive one of this repo. */
export function claudeTranscript(root: string, session: string, env: NodeJS.ProcessEnv = process.env): ForkSource | null {
  if (!/^[0-9a-f-]{36}$/.test(session)) return null
  const file = join(claudeHome(env), 'projects', claudeSlug(root), `${session}.jsonl`)
  let bytes: number
  try { bytes = statSync(file).size } catch { return null }
  return claudeInteractive(file, root) ? { agent: 'claude', session, bytes, file } : null
}

/** Is this Claude Code transcript a person's session of this repo (entrypoint `cli`, its `cwd` the repo), not a
 *  headless run - Marver's own runs and copies are `sdk-cli`? */
function claudeInteractive(file: string, root: string): boolean {
  for (const l of headLines(file)) {
    try { const o = JSON.parse(l); if (typeof o.entrypoint === 'string') return o.entrypoint === 'cli' && sameDir(o.cwd, root) } catch { /* a cut line */ }
  }
  return false
}

/** The newest interactive Claude Code session of this repo, on disk. */
export function newestClaude(root: string, env: NodeJS.ProcessEnv = process.env): ForkSource | null {
  const dir = join(claudeHome(env), 'projects', claudeSlug(real(root)))
  let names: string[]
  try { names = readdirSync(dir).filter((n) => /^[0-9a-f-]{36}\.jsonl$/.test(n)) } catch { return null }
  const files = names.map((n) => { try { const st = statSync(join(dir, n)); return { n, t: st.mtimeMs, bytes: st.size } } catch { return null } })
    .filter((x): x is { n: string; t: number; bytes: number } => !!x).sort((a, b) => b.t - a.t)
  for (const f of files.slice(0, 12)) if (claudeInteractive(join(dir, f.n), root)) return { agent: 'claude', session: f.n.slice(0, -6), bytes: f.bytes, file: join(dir, f.n) }
  return null
}

/** A Codex rollout's header: its thread id, folder and source. */
function codexMeta(file: string): { id: string; cwd: string; source?: string } | null {
  const first = headLines(file, 256 * 1024)[0]
  try {
    const o = JSON.parse(first)
    const p = o?.type === 'session_meta' ? o.payload : null
    return p && typeof p.id === 'string' && typeof p.cwd === 'string' ? { id: p.id, cwd: p.cwd, source: typeof p.source === 'string' ? p.source : undefined } : null
  } catch { return null }
}
/** The sources a person's Codex session carries: its terminal app, its desktop and editor apps. Anything else - an
 *  `exec` run (Marver's own, a review), a subagent, a source not known - is never copied. */
const PERSON = new Set(['cli', 'vscode'])

/** Codex rollouts, newest first, from the last few days' folders. */
function codexRollouts(env: NodeJS.ProcessEnv, days = 14): { file: string; t: number; bytes: number }[] {
  const base = join(codexHome(env), 'sessions')
  const out: { file: string; t: number; bytes: number }[] = []
  const now = new Date()
  for (let d = 0; d < days; d++) {
    const day = new Date(now.getTime() - d * 86_400_000)
    const dir = join(base, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    let names: string[]
    try { names = readdirSync(dir) } catch { continue }
    for (const n of names) if (n.startsWith('rollout-') && n.endsWith('.jsonl')) { try { const st = statSync(join(dir, n)); out.push({ file: join(dir, n), t: st.mtimeMs, bytes: st.size }) } catch { /* gone */ } }
  }
  return out.sort((a, b) => b.t - a.t)
}

/** A Codex thread's rollout, when it is an interactive one of this repo. */
export function codexTranscript(root: string, thread: string, env: NodeJS.ProcessEnv = process.env): ForkSource | null {
  for (const r of codexRollouts(env)) {
    if (!r.file.endsWith(`${thread}.jsonl`)) continue
    const m = codexMeta(r.file)
    return m && m.id === thread && sameDir(m.cwd, root) && PERSON.has(m.source ?? '') ? { agent: 'codex', session: thread, bytes: r.bytes, file: r.file } : null
  }
  return null
}

/** The newest interactive Codex session of this repo, on disk. */
export function newestCodex(root: string, env: NodeJS.ProcessEnv = process.env): ForkSource | null {
  for (const r of codexRollouts(env).slice(0, 40)) {
    const m = codexMeta(r.file)
    if (m && sameDir(m.cwd, root) && PERSON.has(m.source ?? '')) return { agent: 'codex', session: m.id, bytes: r.bytes, file: r.file }
  }
  return null
}

export const transcriptOf = (root: string, agent: ForkAgent, session: string, env: NodeJS.ProcessEnv = process.env) =>
  agent === 'claude' ? claudeTranscript(root, session, env) : codexTranscript(root, session, env)
export const newestOf = (root: string, agent: ForkAgent, env: NodeJS.ProcessEnv = process.env) =>
  agent === 'claude' ? newestClaude(root, env) : newestCodex(root, env)
/** The newest person's session of this repo in either tool (by its transcript's last write). */
export function newestAny(root: string, can: (a: ForkAgent) => boolean, env: NodeJS.ProcessEnv = process.env): ForkSource | null {
  const all = (['claude', 'codex'] as ForkAgent[]).filter(can).map((a) => newestOf(root, a, env)).filter((x): x is ForkSource => !!x)
  const t = (x: ForkSource) => { try { return statSync(x.file).mtimeMs } catch { return 0 } }
  return all.sort((a, b) => t(b) - t(a))[0] ?? null
}
export const forkable = (s: ForkSource | null): s is ForkSource => !!s && existsSync(s.file) && s.bytes <= FORK_MAX_BYTES
