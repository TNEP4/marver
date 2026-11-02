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

/** What the live fake's next `checkForUpdates()` finds (A5.1 #34): nothing, an error, or an update it downloads. */
export type FakeAnswer = { kind: 'current' } | { kind: 'error'; message: string } | { kind: 'offer'; version: string; notes?: string }
/** How the live fake's restart ends (S4's three outcomes): the new version, a preparation `error`, or nothing at all. */
export type FakeRestart = 'ok' | 'error' | 'silent'

/**
 * The dev flavour's updater behind `MARVER_APP_FAKE_UPDATER=1` (A5.1 #4, #34, #35): the same fake, made to act as
 * Electron 45 does when the app runs it (S4). Electron-free still: updater.ts hands it the window's close and the quit.
 *
 * - `checkForUpdates()` answers `next` a macrotask later, as Squirrel would: `checking-for-update`, then
 *   `update-not-available`, an `error`, or `update-available` and `update-downloaded` with the feed's name. With no
 *   `next`, nothing: a case emits the events itself.
 * - `quitAndInstall()` in S4's order: `before-quit-for-update`; every window closed (close-to-hide must let it, the
 *   coordinator having set `quitting`); `before-quit-for-update` again, as Electron's last-window observer sends it;
 *   then, by `restart`: an ordinary quit (`ok`, the relaunch is not the fake's), an `error` with Squirrel's words, the
 *   app left running with no window (`error`), or nothing (`silent`, #17's wait).
 */
export class LiveFakeUpdater extends FakeUpdater {
  next: FakeAnswer | null = null
  restart: FakeRestart = 'ok'
  constructor(private readonly live: { closeWindows(): Promise<void>; quit(): void; later(fn: () => void): void }) { super() }

  override checkForUpdates(): void {
    super.checkForUpdates()
    const a = this.next
    if (!a) return
    this.live.later(() => {
      this.emit('checking-for-update')
      if (a.kind === 'current') { this.emit('update-not-available'); return }
      if (a.kind === 'error') { this.fail(a.message); return }
      this.emit('update-available')
      this.live.later(() => this.downloaded(a.version, a.notes ?? ''))
    })
  }

  override quitAndInstall(): void {
    this.calls.push('quitAndInstall')
    this.emit('before-quit-for-update')
    void this.live.closeWindows().then(() => {
      this.calls.push('windows-closed')
      this.emit('before-quit-for-update')
      if (this.restart === 'ok') this.live.quit()
      else if (this.restart === 'error') this.fail('Could not write update request')
    })
  }
}
