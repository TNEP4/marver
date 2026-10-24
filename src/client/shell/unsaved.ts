/**
 * What this page holds that is not on the server yet, and what it is busy with (spec 28 A2.9, A2.14 #18): one
 * registry of reasons, read by one `beforeunload` - so Chrome asks before a reload or a close loses any of them, not
 * only a capture being recorded - and, in the Mac app, by the shell's `mv:busy` (app-bridge.ts), which the app's guard
 * trusts before it closes, reloads or replaces the page.
 *
 * Beside A1's `holdsReload` (api.ts), which keeps meaning "this page may not reload itself now" and drives the
 * stopped banner: the two ask much the same questions, and each keeps its own job.
 *
 * The reasons are the contract's (`src/shared/app-api.ts`): unsaved - `capture-recording`, `capture-unsent` (sealed,
 * not taken by the server yet, memory-only ones included), `board-unsaved` (a dirty board: a save in flight or
 * failed keeps it dirty), `heights`, `typing` (words typed and not sent); busy but not unsaved - `jam-session`,
 * `microphone`, `agent`. A drag is not work: it becomes `board-unsaved` on drop.
 *
 * No imports but the contract's types: a unit test drives it without a page.
 */
import { UNSAVED_WHY, WHY, type Why } from '../../shared/app-api.ts'

export type UnsavedWhy = (typeof UNSAVED_WHY)[number]
export type BusyWhy = Exclude<Why, UnsavedWhy>

const reasons = new Map<Why, Set<() => boolean>>()
/** A check that throws holds: what it guards is not known to be safe. */
const holds = (fn: () => boolean): boolean => { try { return !!fn() } catch { return true } }
const on = (why: Why): boolean => [...(reasons.get(why) ?? [])].some(holds)
export const isUnsaved = (why: Why): why is UnsavedWhy => (UNSAVED_WHY as readonly Why[]).includes(why)

function register(why: Why, fn: () => boolean): () => void {
  let set = reasons.get(why)
  if (!set) reasons.set(why, set = new Set())
  set.add(fn)
  workChanged()
  return () => { set!.delete(fn); workChanged() }
}
/** Unsaved work of this kind while `fn` answers true. Returns the unregister. */
export const unsavedWhen = (why: UnsavedWhy, fn: () => boolean) => register(why, fn)
/** Busy (not unsaved) while `fn` answers true: a Jam session, the microphone, an agent at work. */
export const busyWhen = (why: BusyWhy, fn: () => boolean) => register(why, fn)

/** Every reason that holds now, in the contract's order. */
export const busyWhy = (): Why[] => WHY.filter(on)
/** The unsaved reasons that hold now. */
export const unsavedWhy = (): UnsavedWhy[] => UNSAVED_WHY.filter(on)
/** Does this page hold anything not on the server yet? */
export const hasUnsavedWork = (): boolean => UNSAVED_WHY.some(on)

const listeners = new Set<() => void>()
let queued = false
/** A reason may have changed: every listener hears it once, a microtask later (a burst of changes is one). */
export function workChanged(): void {
  if (queued || !listeners.size) return
  queued = true
  queueMicrotask(() => { queued = false; for (const fn of [...listeners]) { try { fn() } catch { /* the rest still hear */ } } })
}
export const onWorkChange = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

// ---- leaving --------------------------------------------------------------------------------------------

let leaving = false
let rearm: ReturnType<typeof setTimeout> | undefined
/** The page's own reload - A1's resume, once its canvas is back and what it held is saved - goes without asking
 *  itself. Should the reload not happen after all (a frame refused it), the guard is back a second later. */
export function leaveNow(go: () => void): void {
  leaving = true
  clearTimeout(rearm)
  rearm = setTimeout(() => { leaving = false }, 1000)
  go()
}

/** Would the guard ask before this page goes? */
export const asksBeforeLeaving = (): boolean => !leaving && hasUnsavedWork()

/** The one `beforeunload` (it replaces the store's stopped-and-dirty one and the capture's recording one). Chrome shows
 *  its question only on a page that had a gesture since it loaded; the Mac app does not rely on it (A2.14 #16). */
export function guardLeaving(target: EventTarget): void {
  target.addEventListener('beforeunload', (e) => {
    if (!asksBeforeLeaving()) return
    e.preventDefault()
    try { (e as BeforeUnloadEvent).returnValue = '' } catch { /* not every engine has it */ }
  })
}
