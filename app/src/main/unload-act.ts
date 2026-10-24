/**
 * The unload's act on a canvas's webContents (spec 28 A2.6, A3.8 #39, #42, #44, r1 #2). Owner: the unloading stream.
 * views.ts calls it for `act(t, { kind: 'unload' })`; it is apart from views.ts, with no Electron import, so its
 * states run on a fake webContents in unit tests (test/unit/unload-act.test.ts).
 *
 * `close({ waitForBeforeUnload: true })`, owning the tab until `destroyed` (the tab unloaded: views.ts's forgetCanvas,
 * registered first, runs onUnloaded) or the page's refusal (`will-prevent-unload`, never prevented: the page is kept).
 * Past `unloadActMs` with neither, `unsure`: main ends the close with a plain `close()` - what Chromium does to a page
 * that does not answer its beforeunload in time (A3.8 #40's veto) - and from then on only `destroyed` ends it; a
 * refusal after that is journaled and changes nothing. A `render-process-gone` while it closes is ours and ends it the
 * same way. No timer releases the tab while the close can still end by itself: Electron cannot cancel a close (r1 #2).
 *
 * The backstop: Electron 45's plain `close()` destroys the webContents on a posted task, so `destroyed` follows it.
 * If it has not come `unloadActMs` after main's own close, the unload is stuck: main closes once more and takes the
 * view out itself (views.ts's forgetCanvas, as `destroyed` would), so the tab ends unloaded and every waiter - the
 * tab's queued actions, memory.ts's soft unload, a quit's `guardAll` - goes on. Never `forcefullyCrashRenderer()`:
 * a renderer shared with another tab lives on, and a close ends only this tab's frames.
 */
import type { GuardAction, GuardAnswer, Tab } from './tabs.ts'
import { T } from './timings.ts'

/** What the act uses of a webContents: Electron's, or a test's. */
export interface ActWc {
  on(event: string, fn: (...args: unknown[]) => void): unknown
  once(event: string, fn: (...args: unknown[]) => void): unknown
  off(event: string, fn: (...args: unknown[]) => void): unknown
  close(opts?: { waitForBeforeUnload: boolean }): void
  isDestroyed(): boolean
}

export type UnloadAction = Extract<GuardAction, { kind: 'unload' }>

/** What the act needs of views.ts. */
export interface ActPorts {
  /** a journal line (test builds) */
  log(topic: string, data: Record<string, unknown>): void
  /** the unload is unsure: its `unload { phase: 'unsure' }` record */
  unsure(t: Tab, a: UnloadAction): void
  /** stuck: the view taken out and the tab unloaded as at `destroyed` (views.ts's forgetCanvas) */
  forget(t: Tab): void
}

/** One unload's close under way. */
export interface UnloadActState {
  /** its renderer, for its own `gone` */
  pid?: number
  born?: number
  /** main has ended the close itself (a plain close): only `destroyed` ends the unload now */
  plain: boolean
  /** the renderer's own render-process-gone came while it closed: that is its `gone` */
  gone: boolean
}

interface Act extends UnloadActState { tab: Tab; wc: ActWc; ports: ActPorts; stuck?: ReturnType<typeof setTimeout>; onStuck(): void }

const acts = new Map<string, Act>()

/** forgetCanvas at `destroyed`: the tab's unload act, taken (its renderer, whether main ended it, whether that renderer's own gone came). */
export function takeAct(tabId: string): UnloadActState | undefined {
  const st = acts.get(tabId)
  acts.delete(tabId)
  if (st?.stuck) clearTimeout(st.stuck)
  return st ? { plain: st.plain, gone: st.gone, ...(st.pid ? { pid: st.pid } : {}), ...(st.born !== undefined ? { born: st.born } : {}) } : undefined
}

/** Test seam: every act forgotten. */
export function resetActs(): void {
  for (const st of acts.values()) if (st.stuck) clearTimeout(st.stuck)
  acts.clear()
}

/** `act(t, { kind: 'unload' })`: answers 'done' at `destroyed` (or the backstop), 'refused' at the page's refusal. */
export function actUnload(t: Tab, wc: ActWc, a: UnloadAction, ports: ActPorts, proc: { pid?: number; born?: number } = {}): Promise<GuardAnswer> {
  ports.log('act', { tab: t.id, action: a.kind, reason: a.reason, pid: proc.pid ?? null })
  return new Promise<GuardAnswer>((resolve) => {
    let settled = false
    const done = (r: GuardAnswer, why: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (st.stuck) clearTimeout(st.stuck)
      // every listener this act added goes with it: a kept page's webContents, asked again by its later documents,
      // never gathers them (one per refused document otherwise)
      if (!wc.isDestroyed()) { wc.off('will-prevent-unload', onPrevent); wc.off('destroyed', onDestroyed) }
      if (acts.get(t.id) === st) acts.delete(t.id)   // at destroyed forgetCanvas has taken it already
      ports.log('act', { tab: t.id, action: a.kind, answer: r, why })
      resolve(r)
    }
    const st: Act = {
      tab: t, wc, ports, plain: false, gone: false,
      ...(proc.pid ? { pid: proc.pid } : {}), ...(proc.born !== undefined ? { born: proc.born } : {}),
      // destroyed never came after main's own close: once more, then the view out by hand, as destroyed would
      onStuck: () => {
        if (settled) return
        ports.log('unload', { tab: t.id, stuck: true, destroyed: wc.isDestroyed() })
        if (!wc.isDestroyed()) wc.close()
        ports.forget(t)
        done('done', 'stuck')
      },
    }
    acts.set(t.id, st)
    const onPrevent = () => {
      if (st.plain) { ports.log('unload', { tab: t.id, lateRefusal: true }); return }
      done('refused', 'will-prevent-unload')
    }
    // forgetCanvas (registered first, in wireCanvas) has made the tab unloaded by the time this runs
    const onDestroyed = () => done('done', 'destroyed')
    wc.on('will-prevent-unload', onPrevent)
    wc.once('destroyed', onDestroyed)
    const timer = setTimeout(() => {
      if (settled) return
      if (t.unload?.phase === 'closing') t.unload.phase = 'unsure'
      ports.log('unload', { tab: t.id, phase: 'unsure' })
      ports.unsure(t, a)
      endClose(t.id, 'unsure')
    }, T.unloadActMs)
    wc.close({ waitForBeforeUnload: true })
  })
}

/**
 * Main ends an unload's close itself, asking nothing (unsure, or its renderer gone): Electron 45's plain `close()`
 * destroys the webContents on a posted task. Journaled (`unload { endClose }`) before the close, so a case reads its
 * order against `destroyed`; the backstop starts here.
 */
function endClose(tabId: string, why: 'unsure' | 'gone'): void {
  const st = acts.get(tabId)
  if (!st) return
  st.plain = true
  if (st.wc.isDestroyed()) return
  st.ports.log('unload', { tab: tabId, endClose: why })
  st.wc.close()
  if (!st.stuck) {
    st.stuck = setTimeout(() => st.onStuck(), T.unloadActMs)
    ;(st.stuck as { unref?: () => void }).unref?.()
  }
}

/**
 * A `render-process-gone` while an unload closes the tab (A3.8 #39, #44): ours - the document is gone either way and
 * reopens when shown - counting nothing; the close is finished without asking, a task later (out of the event's
 * turn), and `destroyed` ends the unload. True when it was one: views.ts then hands the gone to the recorder as ours,
 * and forgetCanvas writes no `gone` of its own for it.
 */
export function unloadGone(t: Tab): boolean {
  const u = t.unload
  const st = acts.get(t.id)
  if (!u || (u.phase !== 'closing' && u.phase !== 'unsure') || !st) return false
  st.gone = true
  st.plain = true   // nothing left to ask: a refusal can no longer come
  setImmediate(() => endClose(t.id, 'gone'))
  return true
}
