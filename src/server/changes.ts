/**
 * An edit's identity, from the watcher to the send (spec 30 R1 #8-#12). Every watcher event mints an immutable token;
 * the hot-update run that comes for it takes the file's oldest open token and opens its bracket; whatever that run
 * causes keeps the token in its own closure, so a line deferred past `setTimeout` and `whenSettled` writes the token it
 * was given - never a lookup, and never a guess. What cannot be known says so (R0): a page-wide reload with no path
 * inside one bracket is that change, inside two is `ambiguous`, outside any is `unknown` (#11); a refused refresh has
 * no identity of its own (#8). Lines the dev server writes name no page: a change belongs to every page.
 *
 * Kept apart from plugin.ts so the attribution rules run under test with a fake clock (test/r30-edits-changes.test.ts).
 */
import { randomBytes } from 'node:crypto'
import { relative, sep } from 'node:path'
import { RELOAD_BOUNDS, UNKNOWN_CHANGE, type Candidates, type ChangeEvent, type FullReloadBy } from '../shared/perf-records.ts'

/** One watcher event, from `watchChange` to its `change` line. Identity (`change`, `file`, `event`, `at`) never
 *  changes; the rest is what its run came to. */
export interface ChangeToken {
  readonly change: string
  readonly file: string
  readonly event: ChangeEvent
  /** epoch ms, at the watcher */
  readonly at: number
  /** the hook options' `timestamp`: its hooks began */
  hmrTs?: number
  /** environments whose last hook ran */
  hits: number
  ended: boolean
  /** deferred lines holding it (`hold`): its `change` line waits for them, so its counts are whole */
  pending: number
  flightMs?: number
  reload: Set<string>
  inPlace: Set<string>
  fullReload?: 'passed' | 'dropped'
}

/**
 * What a line knows of the change behind it: the one `token`, or no token and the `candidates` it might be (`graphTs`
 * when a refused refresh read one). `by` only where #11 rules: a page-wide reload that named nothing.
 */
export interface Attribution { token?: ChangeToken; by?: FullReloadBy; candidates?: Candidates; graphTs?: number }
export type UpdateCause = 'update' | 'invalidate' | 'reload'
export type Line = Record<string, unknown>

/** A list in lines of at most `idsPerLine` (#10, #12): none for an empty one. */
function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += RELOAD_BOUNDS.idsPerLine) out.push(list.slice(i, i + RELOAD_BOUNDS.idsPerLine))
  return out
}
const bounded = (ids: readonly string[]): Candidates => ({ ids: ids.slice(0, RELOAD_BOUNDS.candidates), n: ids.length })

export type Changes = ReturnType<typeof createChanges>

export function createChanges(o: {
  root: string
  /** one append: the lines of one event stay together */
  write: (lines: Line[]) => void
  /** environments on this server: a token ends once its hooks landed in all of them */
  envs: () => number
  boot?: string
  now?: () => number
}) {
  const boot = o.boot ?? randomBytes(4).toString('hex')
  const now = o.now ?? Date.now
  let n = 0
  /** each file's open tokens, oldest first: a run takes the oldest whose hooks have not begun */
  const open = new Map<string, ChangeToken[]>()
  /** minted, not ended */
  const flying = new Set<ChangeToken>()
  /** its hooks are running now (several files' runs can overlap; Vite awaits one run's hooks in sequence) */
  const brackets = new Set<ChangeToken>()
  /** a run's identity, shared by its environments' hooks: file and timestamp */
  const runs = new Map<string, ChangeToken>()
  const runKey = (file: string, ts: number) => `${ts}|${file}`
  /** `hmrTs -> change`, the last 512: a refused refresh's candidates (#8) */
  const history: { hmrTs: number; change: string }[] = []
  const rel = (file: string) => relative(o.root, file).split(sep).join('/')
  const ids = (ts: Iterable<ChangeToken>) => [...ts].map((t) => t.change)

  function writeChange(t: ChangeToken): void {
    o.write([{
      kind: 'change', change: t.change, file: rel(t.file), event: t.event,
      ...(t.hmrTs !== undefined ? { hmrTs: t.hmrTs } : { outcome: 'no-hook' }),
      flightMs: t.flightMs, reloadN: t.reload.size, inPlaceN: t.inPlace.size,
      ...(t.fullReload ? { fullReload: t.fullReload } : {}),
    }])
  }

  /** A token's end: its hooks landed in every environment, or the 10 s safety path. Its line follows at once, or when
   *  the last deferred line that holds it has written. */
  function end(t: ChangeToken): void {
    if (t.ended) return
    t.ended = true
    t.flightMs = now() - t.at
    flying.delete(t)
    brackets.delete(t)
    if (t.hmrTs !== undefined) runs.delete(runKey(t.file, t.hmrTs))
    const q = open.get(t.file)
    if (q) {
      q.splice(q.indexOf(t), 1)
      if (!q.length) open.delete(t.file)
    }
    if (t.pending === 0) writeChange(t)
  }

  return {
    /** `watchChange`: a watcher event. */
    watch(file: string, event: ChangeEvent): ChangeToken {
      const t: ChangeToken = { change: `${boot}:${++n}`, file, event, at: now(), hits: 0, ended: false, pending: 0, reload: new Set(), inPlace: new Set() }
      flying.add(t)
      const q = open.get(file)
      if (q) q.push(t); else open.set(file, [t])
      return t
    },
    /** The `pre` hook, in the client environment (it runs first): this run takes the file's oldest open token. */
    begin(file: string, hmrTs: number): ChangeToken | undefined {
      const t = open.get(file)?.find((x) => x.hmrTs === undefined)
      if (!t) return undefined
      t.hmrTs = hmrTs
      brackets.add(t)
      runs.set(runKey(file, hmrTs), t)
      history.push({ hmrTs, change: t.change })
      if (history.length > RELOAD_BOUNDS.hmrHistory) history.shift()
      return t
    },
    /** The token of the run these hook options belong to, if it has one. */
    run: (file: string, hmrTs: number): ChangeToken | undefined => runs.get(runKey(file, hmrTs)),
    /** The `post` hook, per environment: the last one closes the bracket, and the token ends a tick later (Vite finishes
     *  the update after the hooks). */
    landed(file: string, hmrTs: number): void {
      const t = runs.get(runKey(file, hmrTs))
      if (!t || ++t.hits < o.envs()) return
      brackets.delete(t)
      setTimeout(() => end(t), 0)
    },
    /** The 10 s safety path (plugin.ts `flying`): every token of the file still in flight ends. One whose hooks never
     *  began says so: the watcher coalesced it, or Vite never brought it to the hooks. */
    expire(file: string): void {
      for (const t of [...(open.get(file) ?? [])]) end(t)
    },

    /** #11, at the guard: a page-wide reload that named nothing. */
    pathless(): Attribution {
      if (brackets.size === 1) return { token: [...brackets][0], by: 'hook' }
      if (brackets.size > 1) return { by: 'ambiguous', candidates: bounded(ids(brackets)) }
      return { by: 'unknown', candidates: bounded(ids(flying)) }
    },
    /** A page-wide reload that names its file (Vite's dead end, an HTML page), sent after the file's hooks: that file's
     *  token still in flight - no time-window guess. */
    ofFile(file: string): Attribution {
      const ts = open.get(file) ?? []
      if (ts.length === 1) return { token: ts[0] }
      return { candidates: bounded(ids(ts.length ? ts : flying)) }
    },
    /** #8: a refused refresh. `graphTs` is the module's timestamp as read, which a later save has already replaced: the
     *  change it names and those of the 10 s before it are candidates - never attributed to one. */
    refused(graphTs: number): Attribution {
      const named = history.filter((h) => h.hmrTs === graphTs)
      const before = history.filter((h) => h.hmrTs < graphTs && h.hmrTs >= graphTs - RELOAD_BOUNDS.lookBackMs).reverse()
      return { graphTs, candidates: bounded([...named, ...before].map((h) => h.change)) }
    },

    /** A line deferred past the hooks keeps the token: it holds the `change` line back until `release`. */
    hold(at: Attribution): () => void {
      const t = at.token
      if (!t) return () => {}
      t.pending++
      return () => { if (--t.pending === 0 && t.ended) writeChange(t) }
    },
    /** #10: the `update` line, full membership in `update-ids` parts. */
    update(cause: UpdateCause, file: string, reload: readonly string[], inPlace: readonly string[], at: Attribution): void {
      const r = chunks(reload), p = chunks(inPlace)
      const parts = Math.max(1, r.length, p.length)
      const change = at.token?.change ?? UNKNOWN_CHANGE
      const lines: Line[] = [{
        kind: 'update', cause, file: file ? rel(file) : null, reload: r[0] ?? [], inPlace: p[0] ?? [], change, reloadN: reload.length, inPlaceN: inPlace.length,
        ...(at.graphTs !== undefined ? { graphTs: at.graphTs } : {}), ...(at.candidates ? { candidates: at.candidates } : {}), ...(parts > 1 ? { parts } : {}),
      }]
      for (let i = 1; i < parts; i++) lines.push({ kind: 'update-ids', change, part: i + 1, parts, ...(r[i] ? { reload: r[i] } : {}), ...(p[i] ? { inPlace: p[i] } : {}) })
      o.write(lines)
      if (at.token) {
        for (const id of reload) at.token.reload.add(id)
        for (const id of inPlace) at.token.inPlace.add(id)
      }
    },
    /** #11: every page-wide reload Vite or a plugin tried to send, and what it knows of its change. */
    fullReload(p: { triggeredBy?: string; path?: string }, passed: boolean, at?: Attribution): void {
      if (at?.token) at.token.fullReload ??= passed ? 'passed' : 'dropped'
      o.write([{
        kind: 'full-reload', passed, triggeredBy: p.triggeredBy ?? null, path: p.path ?? null,
        ...(at?.by ? { by: at.by } : {}), ...(at?.token ? { change: at.token.change, file: rel(at.token.file) } : {}), ...(at?.candidates ? { candidates: at.candidates } : {}),
      }])
    },
    /** #12: the send, with every change it carries - many to many, every edge kept in `invalidate-ids` parts. */
    invalidate(revision: string, frames: number, changes: readonly string[]): void {
      const c = chunks(changes)
      const parts = Math.max(1, c.length)
      const lines: Line[] = [{ kind: 'invalidate', revision, frames, changes: c[0] ?? [], ...(parts > 1 ? { parts } : {}) }]
      for (let i = 1; i < parts; i++) lines.push({ kind: 'invalidate-ids', revision, part: i + 1, parts, changes: c[i] })
      o.write(lines)
    },
  }
}
