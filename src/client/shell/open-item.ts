/**
 * A notice's click, in the shell (spec 28 A4.6 #29, #30; r1 #1-#3, r2 #1, #2, r3, r4 #1). Main hands `mv:open` the item
 * as the live stream named it, once this document is admitted; the shell reads afresh what it resolves against - never
 * the click's copy - compares the occurrence, its state and its counter, and opens the target through the helpers
 * every other path uses (jam-keys.ts). Its answer: `handled` - the item is on screen; `stale` - its target stands in
 * another state, or the same state with another counter, and opens as it stands (never another item); `missing` - the
 * target is gone, and only its board opens; `busy` - a capture records or words wait unsent, and nothing moved;
 * `dropped` - a read failed, the deadline passed, or a later click, a hidden tab or a revoked trust took its place.
 *
 * One request at a time, under one deadline over everything: `alive()` holds while the request is the current one,
 * before its deadline, with no capture recording and no words typed and unsent. The helpers read it before every step
 * that moves the UI - a board change, comments turned on, a thread made active, a panel or a menu opened, Play left -
 * so words typed during the reads or a wait are seen at the next step, and once it fails nothing more moves. Opening
 * a question never marks it answered.
 */
import { LIVE_KINDS, type OpenItem, type OpenResult } from '../../shared/app-api.ts'
import { typedUnsent } from './api.ts'
import { useComments } from './comments-store.ts'
import { useJamCapture } from './jam-capture.ts'
import { openRunControls, openThreadAt, openTile, type Alive } from './jam-keys.ts'
import { useJamQueue } from './jam-queue.ts'
import { resolveItem, type Target } from './open-resolve.ts'
import { fetchBoardNames, useStore } from './store.ts'

/** One deadline over a request: the manifest, the reads, the helpers' waits. */
export const OPEN_MS = 10_000
let current = 0

/** The request in hand ends - `mv:app-state` hidden or untrusted: nothing of it moves after this. */
export function endOpen(): void { current++ }

/** Nothing may move: a capture records, or a field holds words typed and not sent (a move would lose them). */
const busy = () => !!useJamCapture.getState().current || typedUnsent()

/** Open the live item a notice named, and say what was found (A4.6 #30). Registered by startAppBridge as `onOpen`. */
export async function openLiveItem(p: OpenItem): Promise<OpenResult> {
  const n = ++current
  const until = performance.now() + OPEN_MS
  const alive: Alive = () => n === current && performance.now() < until && !busy()
  /** once it fails: busy if a capture records or words wait, else dropped */
  const gaveUp = (): OpenResult => (busy() ? 'busy' : 'dropped')
  if (!p || typeof p.board !== 'string' || !(LIVE_KINDS as readonly string[]).includes(p.kind)) return 'dropped'
  if (busy()) return 'busy'
  /** a promise, or undefined at the deadline */
  const inTime = <T>(pr: Promise<T>) => Promise.race([pr.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), Math.max(0, until - performance.now())))])
  // the board's manifest first
  while (!useStore.getState().manifest) {
    if (!alive()) return gaveUp()
    await new Promise((r) => setTimeout(r, 50))
  }
  // then what it resolves against, read afresh - only a read that succeeds counts
  const needsQueue = p.kind !== 'ask' || !!p.cards?.length
  const [comments, queue] = await Promise.all([inTime(useComments.getState().refresh(p.board)), needsQueue ? inTime(useJamQueue.getState().load()) : Promise.resolve(false)])
  if (!alive() || comments !== true) return gaveUp()
  // the occurrence against what was just read (open-resolve.ts): an ask with cards opens through its thread alone when
  // the queue could not be read; review, failed and stalled stand on it
  const found = resolveItem(p, useComments.getState().threads, queue === true ? useJamQueue.getState().cards ?? [] : null)
  if (found === 'unread') return gaveUp()
  if (found === 'missing') {
    // only its board opens, when it exists
    const exists = p.board === useStore.getState().board || !!(await inTime(fetchBoardNames()))?.includes(p.board)
    if (exists && p.board !== useStore.getState().board) {
      if (!alive()) return gaveUp()
      location.hash = `#/b/${encodeURIComponent(p.board)}`
    }
    return 'missing'
  }
  return (await openTarget(p.board, found.target, alive)) ? found.result : gaveUp()
}

/** Open a target through the one helper of its kind (jam-keys.ts), each reading `alive` before every move. */
function openTarget(board: string, t: Target, alive: Alive): Promise<boolean> {
  if ('thread' in t) return openThreadAt(board, t.thread, { alive })
  if ('tile' in t) return openTile(t.tile, { alive })
  return openRunControls(t.controls, { alive })
}

// dev-only inspection hook for tests (never installed in published builds)
if (typeof window !== 'undefined' && import.meta.env.DEV) (window as unknown as { __mvOpen: unknown }).__mvOpen = { openLiveItem, endOpen }
