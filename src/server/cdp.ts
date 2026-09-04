/**
 * A headless Chrome driven over CDP through Chrome's own debugging PIPE - fds 3 (we write,
 * Chrome reads) and 4 (Chrome writes, we read), NUL-terminated JSON. No port, no stderr
 * scrape, no WebSocket - and the one property everything else here rests on: when the read
 * side of that pipe hits EOF Chrome shuts itself down, and the kernel closes the pipe on ANY
 * death of this process (Ctrl-C, a closed terminal, `kill -9`, OOM). A shot browser cannot
 * outlive the server that started it, whatever happens to the server.
 *
 * One browser belongs to one operation (a shot, a batch, a poster): `launch()` → sends →
 * `close()` in a finally. Nothing is shared or kept warm - a headless instance of the user's
 * own Chrome registers with macOS Launch Services as that Chrome, and a stray one can swallow
 * the machine's link opens; the shortest possible life is the fix.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
]

/** The browser binary to drive, or null. MARVER_CHROME overrides; otherwise first known install. */
export function findChrome(): string | null {
  const env = process.env.MARVER_CHROME
  if (env) return existsSync(env) ? env : null
  return CHROMES.find((p) => existsSync(p)) ?? null
}

/** Profile directories marver has ever created (the sweep in shot.ts looks for both). */
export const PROFILE_PREFIXES = ['mv-shot-', 'mv-browser-']

// No --disable-gpu: it made headless Chrome composite in software, which cost ~0.5s per
// start AND ~0.5s per new tab (renderer spawns serialised behind it). Without it the GPU
// process composites, tabs open in ~45ms, and on a machine with no GPU Chrome falls back to
// software by itself. Measured 2026-09-04; the PNGs differ only in edge antialiasing.
const FLAGS = ['--headless=new', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions']
const HANDSHAKE_MS = 15_000
const MAX_MESSAGE = 1 << 30   // a screenshot answer is hundreds of MB of base64 at most; past this it is a runaway

type Pending = { owner: object | undefined; resolve: (r: any) => void; reject: (e: Error) => void; method: string }

/** The pipe's framing: NUL-terminated messages, arriving in chunks split anywhere - inside a
 *  message, inside a multibyte character, or several messages in one chunk. Segments are held
 *  and concatenated ONCE per delimiter (a screenshot answer is many chunks; re-concatenating
 *  the remainder per chunk would be quadratic). The size guard runs BEFORE a segment is held. */
export class Frames {
  private chunks: Buffer[] = []
  private held = 0
  constructor(private readonly max = MAX_MESSAGE) {}
  /** Feed one chunk; returns the complete messages it finished, or throws on a runaway. */
  push(d: Buffer): string[] {
    const out: string[] = []
    let from = 0
    for (;;) {
      const nul = d.indexOf(0, from)
      if (nul < 0) break
      this.hold(d.subarray(from, nul))
      out.push(Buffer.concat(this.chunks).toString('utf8'))
      this.chunks = []; this.held = 0
      from = nul + 1
    }
    if (from < d.length) this.hold(d.subarray(from))
    return out
  }
  private hold(seg: Buffer) {
    if (this.held + seg.length > this.max) { this.chunks = []; this.held = 0; throw new Error('the browser sent a runaway message') }
    this.chunks.push(seg); this.held += seg.length
  }
}

export class Browser {
  private proc!: ChildProcess
  private out!: NodeJS.WritableStream
  private seq = 0
  private pending = new Map<number, Pending>()
  private listeners = new Set<(m: any) => void>()
  private profile!: string
  /** Set once the browser is gone or unusable; every send after that rejects at once. */
  dead: string | null = null
  private exited: Promise<void> = Promise.resolve()

  get pid(): number | undefined { return this.proc.pid }

  /** Spawn and handshake (`Browser.getVersion` within 15s), or throw with the reason. A Chrome
   *  that starts but never brings up CDP is killed here - it can never hold a lane. */
  static async launch(prefix = 'mv-shot-'): Promise<Browser> {
    const bin = findChrome()
    if (!bin) throw new Error('no Chrome/Chromium found - install one or set MARVER_CHROME to a browser binary')
    const b = new Browser()
    b.profile = mkdtempSync(join(tmpdir(), prefix))
    b.proc = spawn(bin, [...FLAGS, `--user-data-dir=${b.profile}`, '--remote-debugging-pipe', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
    b.out = b.proc.stdio[3] as NodeJS.WritableStream
    const inp = b.proc.stdio[4] as NodeJS.ReadableStream
    b.exited = new Promise<void>((res) => b.proc.once('exit', () => res()))
    // One idempotent failure path for every way the pipe or the process can go: the first
    // reason wins, every pending send settles, nothing awaiting a `send` can wedge.
    inp.on('data', (d: Buffer) => b.feed(d))
    inp.on('end', () => b.fail('the browser closed its devtools pipe'))
    inp.on('error', () => b.fail('devtools pipe error'))
    inp.on('close', () => b.fail('the browser closed its devtools pipe'))
    b.out.on('error', () => b.fail('devtools pipe error'))
    b.proc.on('error', (e) => b.fail(`could not start the browser - ${e.message}`))
    b.proc.on('exit', (code, sig) => b.fail(`the browser exited (${sig ?? code})`))
    b.proc.once('exit', () => { void b.rmProfile() })
    const handshake = setTimeout(() => b.fail('the browser did not answer in time'), HANDSHAKE_MS)
    try { await b.send('Browser.getVersion') } catch (e) { await b.close(); throw e } finally { clearTimeout(handshake) }
    return b
  }

  private frames = new Frames()
  private feed(d: Buffer) {
    let msgs: string[]
    try { msgs = this.frames.push(d) } catch (e) { return this.fail((e as Error).message) }
    for (const text of msgs) {
      let m: any
      try { m = JSON.parse(text) } catch { continue }   // CDP is always JSON; ignore anything else
      if (m.id != null && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!; this.pending.delete(m.id)
        m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result)
      } else for (const l of this.listeners) l(m)
    }
  }

  private fail(why: string) {
    if (this.dead) return
    this.dead = why
    for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(new Error(`${p.method}: ${why}`)) }
    try { this.proc.kill('SIGKILL') } catch { /* already gone */ }
  }

  /** Send one CDP command. `owner` tags the call so `abort(owner)` can settle a shot's calls
   *  without touching another shot's in the same browser. */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, owner?: object): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      if (this.dead) return reject(new Error(`${method}: ${this.dead}`))
      const gone = owner && this.aborted.get(owner)
      if (gone) return reject(new Error(`${method}: ${gone}`))
      const id = ++this.seq
      this.pending.set(id, { owner, resolve, reject, method })
      try { this.out.write(JSON.stringify({ id, method, params, sessionId }) + '\0') } catch (e) { this.pending.delete(id); reject(e as Error) }
    })
  }

  private aborted = new WeakMap<object, string>()
  /** Reject every pending call tagged `owner` AND every later one (a shot's watchdog fired:
   *  nothing of that shot may run past its deadline); the browser lives on. */
  abort(owner: object, why: string) {
    this.aborted.set(owner, why)
    for (const [id, p] of this.pending) if (p.owner === owner) { this.pending.delete(id); p.reject(new Error(`${p.method}: ${why}`)) }
  }


  /** Subscribe to CDP events (anything without an `id`); returns the unsubscribe. */
  on(l: (m: any) => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l) }

  /** End the pipe (Chrome exits on EOF within ~60ms), SIGKILL after 1s if it is still there,
   *  then the profile goes once the process has actually exited. Safe to call twice. */
  async close(): Promise<void> {
    try { this.out.end() } catch { /* already closed */ }
    const kill = setTimeout(() => { try { this.proc.kill('SIGKILL') } catch { /* gone */ } }, 1000)
    if (this.proc.exitCode == null && this.proc.signalCode == null) await this.exited
    clearTimeout(kill)
    this.fail('the browser was closed')
    await this.rmProfile()
  }

  private rm: Promise<void> | undefined
  private rmProfile(): Promise<void> {
    // one cleanup, awaited by whoever asks (the exit listener and close() both do)
    return this.rm ??= (async () => {
      // Chrome may still be flushing `Default/` when `exit` fires (seen as ENOTEMPTY); retry
      for (let i = 0; i < 3; i++) {
        try { rmSync(this.profile, { recursive: true, force: true }); return } catch { await new Promise((r) => setTimeout(r, 200)) }
      }
      try { rmSync(this.profile, { recursive: true, force: true }) } catch { /* temp cleanup only */ }
    })()
  }
}
