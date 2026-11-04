/**
 * `marver perf --live [--all] [--kinds a,b] [--json]` (spec 30 R11 #47): a tail in the terminal. It follows the live files
 * of the repo (or every known canvas) and the app's `app.jsonl`, from their ends, polling every 500 ms. No server
 * endpoint, no app panel.
 *
 * Each file is held open by identity (device and inode). At each poll the open descriptor is drained to its end, a
 * partial last line kept until it completes, and only then, if the path now names another file, that one is opened
 * from its start. A rename keeps the old inode, so a tail appended just before a rotation is read from the old
 * descriptor: nothing is skipped or read twice. A path with no file yet is opened from its start when one comes.
 *
 * One line per record (time, canvas, kind, the fields that matter), or the raw line with `--json`; every page and shell
 * line once by `(page, seq)` (#7), every app event by its flavour, launch and `seq`: their counters are not one.
 * Latency is the page's 2 s batch plus the app's 2 s flush, about 3 s.
 */
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { APP_LOG } from '../shared/app-perf.ts'
import { perfDir } from '../server/perf.ts'
import { marverHome } from '../server/slots.ts'
import { knownCanvases } from './perf-all.ts'

export const LIVE_POLL_MS = 500
/** Enough for a page that retried a batch; a line older than this repeating is a reader's report's to dedupe. */
const SEEN_MAX = 8192
/** A partial line longer than this is no line (never a whole file held in memory). */
const PARTIAL_MAX = 8 * 2 ** 20
const REFRESH_POLLS = 20

/** One file, held by identity. `end`: start from the file's end (a path found at the tail's start). */
export class Tail {
  private fd: number | null = null
  private ino = -1
  private dev = -1
  private pos = 0
  private partial = Buffer.alloc(0)
  constructor(readonly path: string, end: boolean) {
    if (end && this.open()) this.pos = fstatSync(this.fd!).size
  }
  private open(): boolean {
    try {
      const fd = openSync(this.path, 'r')
      const st = fstatSync(fd)
      if (!st.isFile()) { closeSync(fd); return false }
      this.fd = fd; this.ino = st.ino; this.dev = st.dev; this.pos = 0; this.partial = Buffer.alloc(0)
      return true
    } catch { return false }
  }
  /** The open descriptor to its end: its whole lines, the partial one kept. */
  private drain(): string[] {
    if (this.fd === null) return []
    const chunks: Buffer[] = [this.partial]
    for (;;) {
      const b = Buffer.alloc(1 << 16)
      let n = 0
      try { n = readSync(this.fd, b, 0, b.length, this.pos) } catch { break }
      if (n <= 0) break
      chunks.push(b.subarray(0, n))
      this.pos += n
    }
    const all = Buffer.concat(chunks)
    const nl = all.lastIndexOf(0x0a)
    if (nl < 0) { this.partial = all.length > PARTIAL_MAX ? Buffer.alloc(0) : all; return [] }
    this.partial = all.subarray(nl + 1).length > PARTIAL_MAX ? Buffer.alloc(0) : Buffer.from(all.subarray(nl + 1))
    return all.subarray(0, nl).toString('utf8').split('\n').filter(Boolean)
  }
  /** One poll: what the open file holds now, then - only then - the file the path names now, if it is another. */
  poll(): string[] {
    const out = this.drain()
    let st
    try { st = statSync(this.path) } catch { return out }
    if (this.fd !== null && st.ino === this.ino && st.dev === this.dev) return out
    if (this.fd !== null) { try { closeSync(this.fd) } catch { /* closed */ } this.fd = null }
    if (this.open()) out.push(...this.drain())
    return out
  }
  close(): void { if (this.fd !== null) { try { closeSync(this.fd) } catch { /* closed */ } this.fd = null } }
}

type Rec = Record<string, any>
const shorten = (v: unknown, n = 80) => { const s = String(v); return s.length > n ? `${s.slice(0, n - 1)}…` : s }
/** The fields that matter, by what a record holds; the rest is `--json`'s. */
const FIELDS = ['board', 'cause', 'trigger', 'reason', 'request', 'ms', 'node', 'frame', 'outcome', 'file', 'event', 'change', 'revision', 'cmd', 'phase', 'via', 'in', 'keys', 'why', 'mode', 'to', 'scope', 'source', 'type', 'p95', 'n', 'readyMs', 'tab', 'noAfterUpdate', 'message'] as const
/** One line for a record: its time, its canvas, its kind, the fields that matter. */
export function liveLine(canvas: string, r: Rec): string {
  const t = typeof r.ts === 'number' ? new Date(r.ts).toLocaleTimeString() : '-'
  const bits: string[] = []
  for (const k of FIELDS) { const v = r[k]; if (v !== undefined && v !== null && typeof v !== 'object') bits.push(`${k} ${shorten(v, k === 'message' ? 120 : 40)}`) }
  if (Array.isArray(r.reload)) bits.push(`reload ${r.reloadN ?? r.reload.length}`)
  return `${t}  ${canvas}  ${String(r.kind ?? 'run')}${bits.length ? `  ${bits.join(' · ')}` : ''}`
}

export interface LiveSource { canvas: string; dir: string }
/** What one record is, once (#7), in its own source's terms - an app event may name a page, and its `seq` is the launch's,
 *  never the page's; null for a line that names none, which was written once and always prints. */
function identity(r: Rec, app: boolean): string | null {
  if (typeof r.seq !== 'number') return null
  if (app) return typeof r.app === 'string' ? `app/${String(r.flavour ?? '')}/${r.app}/${r.seq}` : null
  return typeof r.page === 'string' ? `page/${r.page}/${r.seq}` : null
}
export interface LiveOptions { kinds?: readonly string[]; json?: boolean; print?: (line: string) => void }
const CANVAS_FILES = ['page.jsonl', 'reloads.jsonl', 'jam.jsonl', 'runs.jsonl']

/**
 * The tails and what they print. `add` follows a canvas's live files from their ends (a file not there yet from its
 * start); `poll` prints what came since. Separate from the timer so a test can drive it, poll by poll.
 */
export class Live {
  private tails: { tail: Tail; canvas: string; app: boolean }[] = []
  private known = new Set<string>()
  private seen = new Set<string>()
  private kinds: Set<string> | null
  private print: (line: string) => void
  constructor(private o: LiveOptions = {}) {
    this.kinds = o.kinds?.length ? new Set(o.kinds) : null
    this.print = o.print ?? ((l) => console.log(l))
  }
  follow(path: string, canvas: string, app = false): void {
    if (this.known.has(path)) return
    this.known.add(path)
    this.tails.push({ tail: new Tail(path, true), canvas, app })
  }
  addCanvas(root: string, canvas: string): void { for (const f of CANVAS_FILES) this.follow(join(perfDir(root), f), canvas) }
  addApp(home: string): void { for (const f of Object.values(APP_LOG)) this.follow(join(home, 'perf', f), 'app', true) }
  poll(): void {
    for (const { tail, canvas, app } of this.tails) for (const line of tail.poll()) this.line(canvas, line, app)
  }
  private line(canvas: string, text: string, app: boolean): void {
    let r: Rec
    try { r = JSON.parse(text) } catch { return }
    if (!r || typeof r !== 'object') return
    if (this.kinds && !this.kinds.has(String(r.kind ?? 'run'))) return
    const k = identity(r, app)
    if (k !== null) {
      if (this.seen.has(k)) return
      this.seen.add(k)
      if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string)
    }
    this.print(this.o.json ? text : liveLine(canvas, r))
  }
  close(): void { for (const { tail } of this.tails) tail.close() }
}

/** `marver perf --live`: until Ctrl-C. */
export function livePerf(root: string, opts: { all?: boolean; json?: boolean; kinds?: string }): Promise<void> {
  const kinds = typeof opts.kinds === 'string' ? opts.kinds.split(',').map((k) => k.trim()).filter(Boolean) : []
  const live = new Live({ kinds, json: opts.json })
  const home = marverHome()
  const add = () => {
    if (opts.all) for (const c of knownCanvases(home)) live.addCanvas(c.root, c.name)
    live.addApp(home)
  }
  if (!opts.all) live.addCanvas(root, root.split('/').at(-1) ?? root)
  add()
  if (!opts.json) console.log(`following ${opts.all ? 'every known canvas' : 'this repo'} and the app, from now - about 3 s behind (Ctrl-C ends it)`)
  return new Promise((done) => {
    let n = 0
    const timer = setInterval(() => {
      live.poll()
      // a canvas started since
      if (opts.all && ++n % REFRESH_POLLS === 0) add()
    }, LIVE_POLL_MS)
    process.once('SIGINT', () => { clearInterval(timer); live.close(); done() })
  })
}
