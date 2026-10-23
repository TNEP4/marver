/**
 * Startup as one transaction (spec 28 A1.1): everything `marver dev` holds on its way up belongs to one
 * Startup, and goes back in reverse order on any way out - a failed start, a close, an exit, a signal.
 * Each thing is registered the moment it is taken, so whatever is held when a way out comes is given
 * back, and nothing else. Two kinds, because the ways out differ:
 * - claims: files (dev.lock, the slot file, dev.json, the preference file's stop). Released
 *   synchronously, so `exit` and a signal, which cannot wait, give them back too (a dying process frees its
 *   sockets with it); on a close, last - once everything that could still bind or serve has closed, a server a
 *   restart was making included (dev.ts) - so a starter never finds a slot free while a socket of this start
 *   is bound, or about to be.
 * - closers: what runs (Marver's watchers, sweeps and timers, the Vite server). Closed, awaited, on a
 *   failed start or a close; an exit or a signal ends them with the process.
 * A close says so first, before anything closes (`onClose`: the slot file rewritten as `closing`, dev.ts), since
 * its claims stay until the end and what it waits for can take long: no reader takes a canvas whose serving has
 * ended for one that serves. An exit or a signal gives the claims back at once, so it has nothing to say.
 * A Vite restart (an .env edit) is no way out: it replaces the server and keeps the start (dev.ts).
 */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

export class Startup {
  private claims: (() => void)[] = []
  private closers: (() => unknown)[] = []
  private closing: Promise<void> | null = null
  private hooked: { exit: () => void; signal: (sig: NodeJS.Signals) => void } | null = null
  private say: (() => void) | null = null
  private marks: (() => void)[] = []

  /** What a signal says before it ends the process (dev.ts: once the canvas serves, that it stopped). Synchronous. */
  onSignal(say: () => void): void { this.say = say }
  /** What a close says first, as it is asked for and before anything closes (dev.ts: the slot file, `closing`).
   *  Synchronous; each runs once, and a failure to say it never holds the close. */
  onClose(mark: () => void): void { this.marks.push(mark) }

  /** A file held: given back on every way out. */
  claim(release: () => void): void { this.claims.push(release) }
  /** Something running: closed on a failed start or a close. The answer withdraws it, for what has closed on
   *  its own first - the Vite server a restart replaced, and the watchers that went with it. */
  defer(close: () => unknown): () => void {
    this.closers.push(close)
    return () => { const i = this.closers.indexOf(close); if (i >= 0) this.closers.splice(i, 1) }
  }

  /** Give back every claim, newest first. Synchronous; each runs once. */
  release(): void {
    for (const r of this.claims.splice(0).reverse()) { try { r() } catch { /* already gone */ } }
  }

  /** Say it is closing (synchronously, in this call), close what runs, newest first and awaited, then what `until`
   *  waits for (dev.ts: every restart's own server, to its last cleanup), and only then give back the claims.
   *  Idempotent: Vite's own SIGTERM path and an embedding caller's `server.close()` can both reach it - the first
   *  close's `until` is the one. */
  close(until?: () => Promise<unknown>): Promise<void> {
    this.closing ??= (async () => {
      for (const m of this.marks.splice(0)) { try { m() } catch { /* saying it never holds the close */ } }
      for (const c of this.closers.splice(0).reverse()) { try { await c() } catch { /* closing what failed */ } }
      if (until) { try { await until() } catch { /* closing what failed */ } }
      this.release()
      this.unhook()
    })()
    return this.closing
  }

  /** From the first step: an exit gives the claims back; SIGINT, SIGTERM and SIGHUP give them back and
   *  raise the signal again, so the process still ends the way it was told to. */
  hookProcess(): void {
    if (this.hooked) return
    const exit = () => this.release()
    const signal = (sig: NodeJS.Signals) => {
      try { this.say?.() } catch { /* saying it never holds the way out */ }
      this.release(); this.unhook(); process.kill(process.pid, sig)
    }
    process.once('exit', exit)
    for (const s of SIGNALS) process.once(s, signal)
    this.hooked = { exit, signal }
  }

  private unhook(): void {
    if (!this.hooked) return
    process.off('exit', this.hooked.exit)
    for (const s of SIGNALS) process.off(s, this.hooked.signal)
    this.hooked = null
  }
}
