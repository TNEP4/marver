/**
 * Startup as one transaction (spec 28 A1.1): everything `marver dev` holds on its way up belongs to one
 * Startup, and goes back in reverse order on any way out - a failed start, a close, an exit, a signal.
 * Each thing is registered the moment it is taken, so whatever is held when a way out comes is given
 * back, and nothing else. Two kinds, because the ways out differ:
 * - claims: files (dev.lock, the slot file, dev.json, the preference file's stop). Released
 *   synchronously, so `exit` and a signal, which cannot wait, give them back too; on a close, after the
 *   socket has closed, so a starter never finds a slot free while its port is still bound.
 * - closers: what runs (Marver's watchers, sweeps and timers, the Vite server). Closed, awaited, on a
 *   failed start or a close; an exit or a signal ends them with the process.
 */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

export class Startup {
  private claims: (() => void)[] = []
  private closers: (() => unknown)[] = []
  private closing: Promise<void> | null = null
  private hooked: { exit: () => void; signal: (sig: NodeJS.Signals) => void } | null = null

  /** A file held: given back on every way out. */
  claim(release: () => void): void { this.claims.push(release) }
  /** Something running: closed on a failed start or a close. */
  defer(close: () => unknown): void { this.closers.push(close) }

  /** Give back every claim, newest first. Synchronous; each runs once. */
  release(): void {
    for (const r of this.claims.splice(0).reverse()) { try { r() } catch { /* already gone */ } }
  }

  /** Close what runs, newest first and awaited, then give back the claims. Idempotent: Vite's own SIGTERM
   *  path and an embedding caller's `server.close()` can both reach it. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      for (const c of this.closers.splice(0).reverse()) { try { await c() } catch { /* closing what failed */ } }
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
    const signal = (sig: NodeJS.Signals) => { this.release(); this.unhook(); process.kill(process.pid, sig) }
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
