/**
 * The updater's fakes (spec 28 A5.1 #13, #32; S6): an adapter shaped like Electron 45's `autoUpdater` and a clock
 * whose time moves only when a case says. No Electron import, so unit cases use them as they are.
 *
 * The adapter emits nothing on its own: a case emits each event as Squirrel would, with Electron's arguments
 * (`update-downloaded` carries the feed's `name`, which is the version, #9). `duringFeed` and `duringCheck` run inside
 * `setFeedURL()` and `checkForUpdates()`, for what Electron does within the call: a throw, or an event before it
 * returns. `quitAndInstall()` emits `before-quit-for-update` twice while a window is open, as Electron 45 does (#16).
 */
import type { UpdateClock, UpdaterAdapter } from '../update-model.ts'

type Event = 'checking-for-update' | 'update-available' | 'update-not-available' | 'update-downloaded' | 'error' | 'before-quit-for-update'

export class FakeUpdater implements UpdaterAdapter {
  /** every call, in order: `on:<event>`, `setFeedURL`, `checkForUpdates`, `quitAndInstall` */
  calls: string[] = []
  feeds: { url: string; serverType?: 'json' | 'default' }[] = []
  duringFeed?: (u: FakeUpdater) => void
  duringCheck?: (u: FakeUpdater) => void
  windowOpen = true
  private listeners = new Map<Event, ((...args: never[]) => void)[]>()

  on(event: Event, listener: (...args: never[]) => void): this {
    this.calls.push(`on:${event}`)
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  setFeedURL(options: { url: string; serverType?: 'json' | 'default' }): void {
    this.calls.push('setFeedURL')
    this.feeds.push(options)
    this.duringFeed?.(this)
  }
  checkForUpdates(): void {
    this.calls.push('checkForUpdates')
    this.duringCheck?.(this)
  }
  quitAndInstall(): void {
    this.calls.push('quitAndInstall')
    this.emit('before-quit-for-update')
    if (this.windowOpen) this.emit('before-quit-for-update')
  }

  emit(event: Event, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args)
  }
  /** Squirrel's download done: Electron's arguments, the feed's `name` being the version */
  downloaded(version: string, notes = ''): void {
    this.emit('update-downloaded', {}, notes, version, new Date(0), `https://example.invalid/Marver-darwin-arm64-${version}.zip`)
  }
  fail(message: string): void { this.emit('error', new Error(message)) }
  count(call: string): number { return this.calls.filter((c) => c === call).length }
}

/** Time moves only by `advance`; `tick` runs the macrotasks queued (setImmediate's). */
export class FakeClock implements UpdateClock {
  t = 0
  private timers: { at: number; seq: number; fn: () => void }[] = []
  private immediates: (() => void)[] = []
  private seq = 0

  now(): number { return this.t }
  setTimeout(fn: () => void, ms: number): unknown {
    const h = { at: this.t + Math.max(0, ms), seq: ++this.seq, fn }
    this.timers.push(h)
    return h
  }
  clearTimeout(handle: unknown): void { this.timers = this.timers.filter((h) => h !== handle) }
  setImmediate(fn: () => void): void { this.immediates.push(fn) }

  tick(): void { for (const fn of this.immediates.splice(0)) fn() }
  /** Each timer due by then runs at its own time, in order; one a timer sets runs too if it is due. */
  advance(ms: number): void {
    this.tick()
    const end = this.t + ms
    for (;;) {
      const due = this.timers.filter((h) => h.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
      if (!due) break
      this.timers = this.timers.filter((h) => h !== due)
      this.t = due.at
      due.fn()
      this.tick()
    }
    this.t = end
  }
  pending(): number { return this.timers.length }
}
