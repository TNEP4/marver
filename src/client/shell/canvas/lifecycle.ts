/**
 * SPEC-M6 §4 + §5 — the Passive-Artifact Lifecycle coordinator (pool mode). Owns, per node, the
 * decision "should this frame mount a live document right now, and why", enforced through the
 * Live-Lease Arbiter (arbiter.ts) so the live-doc cap can never be exceeded.
 *
 * A passive frame does NOT mount the live app. It shows a crisp DOM snapshot (the M5 lean) once
 * compiled, or a deterministic placeholder before that. The live app is mounted only:
 *   - `active`       - the frame is interacted (the real app, shown on top), or
 *   - `incompatible` - the serializer can't snapshot it, so it stays live while visible, or
 *   - `compile`      - a one-at-a-time background boot, hidden behind the placeholder, JUST to
 *                      serialize the snapshot, then released.
 *
 * Robustness (codex FIX-FIRST review): compile is a WATCHDOGGED, generation-scoped operation that
 * always finishes-or-aborts (a culled / stuck / navigated compile never wedges the single compiler),
 * demotion is TWO-PHASE (the live iframe is never unmounted until a replacement snapshot is admitted,
 * so interact-leave can't leave a blank), and every non-`shown` frame without a ready snapshot shows
 * a placeholder (never blank), with incompatible frames retried when capacity frees.
 */
import { requestLease, releaseLease, touchLease } from './arbiter.ts'

/** M6 pool mode is OFF by default (the working board is untouched). Opt in per-session with
 *  `?pool` in the URL or `localStorage.mvPool='1'` while it's built + dogfooded. */
export const POOL = (() => {
  try { return typeof location !== 'undefined' && (/[?&]pool\b/.test(location.search) || localStorage.getItem('mvPool') === '1') }
  catch { return false }
})()

export type Artifact = 'missing' | 'compiling' | 'ready' | 'incompatible' | 'error'
export type LiveMode = 'shown' | 'hidden' | null   // shown = live is the view; hidden = compile boot; null = snapshot/placeholder

interface LC {
  key: string
  visible: boolean
  interact: boolean
  artifact: Artifact
  leaseId: number | null
  live: LiveMode
  phase: 'idle' | 'compiling' | 'demoting'
  attempts: number       // compile attempts (retry-with-backoff, then give up -> incompatible)
  watchdog: number       // compile timeout handle
  notify: () => void
}

const COMPILE_TIMEOUT = 8000   // a compile boot that never admits within this is presumed stuck -> abort
const MAX_ATTEMPTS = 2         // after this many stuck/failed compiles, treat the frame as incompatible (stays live)

const nodes = new Map<string, LC>()
let compiling: string | null = null   // exactly ONE background compiler at a time (§4.2; the spike proved collisions fail)
let timer: (ms: number, fn: () => void) => number = (ms, fn) => (typeof setTimeout !== 'undefined' ? setTimeout(fn, ms) as unknown as number : 0)
let clearT: (h: number) => void = (h) => { if (typeof clearTimeout !== 'undefined') clearTimeout(h as unknown as ReturnType<typeof setTimeout>) }
/** tests inject a controllable timer */
export function __setTimers(set: typeof timer, clr: typeof clearT): void { timer = set; clearT = clr }

export function registerLC(key: string, notify: () => void): void {
  const lc = nodes.get(key)
  if (lc) { lc.notify = notify; return }
  nodes.set(key, { key, visible: false, interact: false, artifact: 'missing', leaseId: null, live: null, phase: 'idle', attempts: 0, watchdog: 0, notify })
}
export function unregisterLC(key: string): void {
  const lc = nodes.get(key); if (!lc) return
  clearT(lc.watchdog)
  if (lc.leaseId != null) releaseLease(lc.leaseId)
  if (compiling === key) compiling = null              // free the single-compiler slot
  nodes.delete(key)                                    // remove BEFORE pumping so it can't re-pick this node
  pumpCompiler(); reconcileWaiting()
}

export const liveMode = (key: string): LiveMode => nodes.get(key)?.live ?? null
export const artifactState = (key: string): Artifact => nodes.get(key)?.artifact ?? 'missing'
/** placeholder shows when there is no usable snapshot AND the live app isn't the view. Includes
 *  incompatible-without-a-live-slot so a starved incompatible frame is never blank. */
export const showPlaceholder = (key: string): boolean => {
  const lc = nodes.get(key); if (!lc) return false
  if (lc.live === 'shown') return false
  return lc.artifact !== 'ready'   // missing | compiling | error | incompatible(no live) -> placeholder
}

export function setVisible(key: string, on: boolean): void {
  const lc = nodes.get(key); if (!lc || lc.visible === on) return
  lc.visible = on
  if (!on && lc.phase === 'compiling') abortCompile(lc, 'missing')   // culled mid-compile -> requeue, don't wedge
  reconcile(lc); pumpCompiler(); reconcileWaiting()
}
export function setInteractLC(key: string, on: boolean): void {
  const lc = nodes.get(key); if (!lc || lc.interact === on) return
  lc.interact = on
  if (!on && lc.live === 'shown' && lc.leaseId != null) beginDemote(key)   // two-phase: hold live until recapture admits
  else reconcile(lc)
  pumpCompiler(); reconcileWaiting()
}

function set(lc: LC, live: LiveMode): void { if (lc.live === live) return; lc.live = live; lc.notify() }
function release(lc: LC): void { if (lc.leaseId != null) { releaseLease(lc.leaseId); lc.leaseId = null } }

/** Recompute one node's SHOWN live intent (interact + incompatible). Compile ('hidden') and demote
 *  are owned by their own machinery and left alone here. */
function reconcile(lc: LC): void {
  if (lc.phase === 'compiling' || lc.phase === 'demoting') return   // don't disturb an in-flight transaction
  if (lc.interact) {                                  // the real app, shown
    if (lc.leaseId == null) lc.leaseId = requestLease(lc.key, 'active', () => onEvicted(lc))
    else touchLease(lc.leaseId)
    set(lc, lc.leaseId != null ? 'shown' : null)
    return
  }
  if (lc.artifact === 'incompatible' && lc.visible) { // can't snapshot -> stay live while visible
    if (lc.leaseId == null) lc.leaseId = requestLease(lc.key, 'incompatible', () => onEvicted(lc))
    set(lc, lc.leaseId != null ? 'shown' : null)      // denied -> placeholder (showPlaceholder covers it)
    return
  }
  release(lc); set(lc, null)                          // passive: snapshot or placeholder, no live doc
}

/** Give incompatible/visible frames without a live slot another chance whenever capacity frees. */
function reconcileWaiting(): void {
  for (const lc of nodes.values())
    if (!lc.interact && lc.phase === 'idle' && lc.artifact === 'incompatible' && lc.visible && lc.leaseId == null && lc.live !== 'shown')
      reconcile(lc)
}

/** Keep exactly one background compiler running over visible, cold, un-leased frames. */
function pumpCompiler(): void {
  if (compiling != null) return
  let next: LC | null = null
  for (const lc of nodes.values())
    if (lc.visible && lc.artifact === 'missing' && lc.phase === 'idle' && !lc.interact && lc.leaseId == null) { next = lc; break }
  if (!next) return
  const id = requestLease(next.key, 'compile', () => onEvicted(next!))
  if (id == null) return                              // no slot free right now; retried on the next release/admit
  next.leaseId = id; compiling = next.key; next.artifact = 'compiling'; next.phase = 'compiling'
  clearT(next.watchdog)
  next.watchdog = timer(COMPILE_TIMEOUT, () => { if (compiling === next!.key) abortCompile(next!, 'retry') })
  set(next, 'hidden')                                 // FrameNode mounts .sh-live hidden -> boots -> serializes
}

/** End a compile that will never admit (culled / stuck / navigated). Frees the single-compiler slot
 *  and the lease, and picks an outcome: 'missing' requeues; 'retry' backs off then -> incompatible. */
function abortCompile(lc: LC, mode: 'missing' | 'retry'): void {
  clearT(lc.watchdog); lc.watchdog = 0
  if (compiling === lc.key) compiling = null
  release(lc)
  lc.phase = 'idle'
  if (mode === 'retry') { lc.attempts++; lc.artifact = lc.attempts >= MAX_ATTEMPTS ? 'incompatible' : 'missing' }
  else lc.artifact = 'missing'
  set(lc, null)
  reconcile(lc)                                       // an incompatible outcome may now want a live lease
  pumpCompiler(); reconcileWaiting()                  // requeue: restart the compiler on the next cold frame
}

function onEvicted(lc: LC): void {                     // the arbiter reclaimed our slot
  clearT(lc.watchdog); lc.watchdog = 0
  lc.leaseId = null
  if (compiling === lc.key) { compiling = null; if (lc.artifact === 'compiling') { lc.artifact = 'missing'; lc.phase = 'idle' } }
  if (lc.phase === 'demoting') lc.phase = 'idle'      // a demote lost its slot; the snapshot (if any) shows
  set(lc, null)
  pumpCompiler(); reconcileWaiting()
}

/** FrameNode reports the outcome of a compile boot OR a demotion recapture (snapshot admitted / degraded).
 *  Robust to any phase - a late admit after an abort just records the outcome, it never wedges. */
export function onSnapshotAdmitted(key: string, ok: boolean): void {
  const lc = nodes.get(key); if (!lc) return
  clearT(lc.watchdog); lc.watchdog = 0
  lc.artifact = ok ? 'ready' : 'incompatible'
  if (compiling === key) compiling = null
  const wasHidden = lc.live === 'hidden'
  const wasDemoting = lc.phase === 'demoting'
  lc.phase = 'idle'
  if (wasHidden || wasDemoting) {                     // a compile boot or a demote finished: drop the live doc
    if (!lc.interact) { release(lc); set(lc, null) }
    if (!ok) reconcile(lc)                            // incompatible -> take a counted live lease instead
  }
  pumpCompiler(); reconcileWaiting()
}

/** Begin a two-phase demotion (interact leaving). Keep the live doc mounted+shown as a low-priority
 *  handoff until a fresh snapshot is admitted (onSnapshotAdmitted) - never a blank. FrameNode fires
 *  the recapture from the still-mounted live iframe. */
export function beginDemote(key: string): void {
  const lc = nodes.get(key); if (!lc) return
  if (lc.leaseId == null || lc.live !== 'shown') { reconcile(lc); return }   // nothing live to demote from
  lc.phase = 'demoting'
  // downgrade the lease so a higher need can still reclaim it, and arm a watchdog: if the recapture
  // never admits, fall back to keeping it live (incompatible) rather than blanking.
  lc.leaseId = requestLease(lc.key, 'handoff-out', () => onEvicted(lc)) ?? lc.leaseId
  clearT(lc.watchdog)
  lc.watchdog = timer(COMPILE_TIMEOUT, () => { if (lc.phase === 'demoting') { lc.phase = 'idle'; lc.artifact = 'incompatible'; reconcile(lc) } })
}

/** Test/HMR reset. */
export function __resetLifecycle(): void {
  for (const lc of nodes.values()) { clearT(lc.watchdog); if (lc.leaseId != null) releaseLease(lc.leaseId) }
  nodes.clear(); compiling = null
}
