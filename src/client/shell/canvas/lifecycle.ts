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
 * FrameNode registers a listener + reports (visible / interact); it reads `liveMode(key)` to decide
 * whether/how to render its `.sh-live` iframe, and calls `onLiveReady`/`onSnapshotAdmitted` back.
 * Imperative (like snapshots.ts): a pan/zoom triggers zero React work here.
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
  notify: () => void
}

const nodes = new Map<string, LC>()
let compiling: string | null = null   // exactly ONE background compiler at a time (§4.2; the spike proved collisions fail)

export function registerLC(key: string, notify: () => void): void {
  const lc = nodes.get(key)
  if (lc) { lc.notify = notify; return }
  nodes.set(key, { key, visible: false, interact: false, artifact: 'missing', leaseId: null, live: null, notify })
}
export function unregisterLC(key: string): void {
  const lc = nodes.get(key); if (!lc) return
  if (lc.leaseId != null) releaseLease(lc.leaseId)
  if (compiling === key) { compiling = null }
  nodes.delete(key)
  pumpCompiler()
}

export const liveMode = (key: string): LiveMode => nodes.get(key)?.live ?? null
export const artifactState = (key: string): Artifact => nodes.get(key)?.artifact ?? 'missing'
/** placeholder shows when there is no usable snapshot yet AND the live app isn't the view. */
export const showPlaceholder = (key: string): boolean => {
  const lc = nodes.get(key); if (!lc) return false
  return lc.live !== 'shown' && (lc.artifact === 'missing' || lc.artifact === 'compiling' || lc.artifact === 'error')
}

export function setVisible(key: string, on: boolean): void { const lc = nodes.get(key); if (!lc || lc.visible === on) return; lc.visible = on; reconcile(lc); pumpCompiler() }
export function setInteractLC(key: string, on: boolean): void { const lc = nodes.get(key); if (!lc || lc.interact === on) return; lc.interact = on; reconcile(lc); pumpCompiler() }

function set(lc: LC, live: LiveMode): void { if (lc.live === live) return; lc.live = live; lc.notify() }
function release(lc: LC): void { if (lc.leaseId != null) { releaseLease(lc.leaseId); lc.leaseId = null } }

/** Recompute one node's live intent (interact + incompatible only; compile is scheduled globally). */
function reconcile(lc: LC): void {
  if (lc.interact) {                                  // the real app, shown
    if (lc.leaseId == null) lc.leaseId = requestLease(lc.key, 'active', () => onEvicted(lc))
    else touchLease(lc.leaseId)
    set(lc, lc.leaseId != null ? 'shown' : null)      // denied -> stays snapshot (rare, logged by caller)
    return
  }
  if (lc.artifact === 'incompatible' && lc.visible) { // can't snapshot -> stay live while visible
    if (lc.leaseId == null) lc.leaseId = requestLease(lc.key, 'incompatible', () => onEvicted(lc))
    set(lc, lc.leaseId != null ? 'shown' : null)
    return
  }
  // no interact / not incompatible: not a `shown` frame. Drop any active/incompatible lease.
  if (lc.live !== 'hidden') { release(lc); set(lc, null) }   // 'hidden' (compiling) is owned by the compiler
}

/** Global: keep exactly one background compiler running over visible, cold, un-leased frames. */
function pumpCompiler(): void {
  if (compiling != null) return
  let next: LC | null = null
  for (const lc of nodes.values())
    if (lc.visible && lc.artifact === 'missing' && !lc.interact && lc.leaseId == null) { next = lc; break }
  if (!next) return
  const id = requestLease(next.key, 'compile', () => onEvicted(next!))
  if (id == null) return                              // no slot free right now; retried on the next release/admit
  next.leaseId = id; compiling = next.key; next.artifact = 'compiling'
  set(next, 'hidden')                                 // FrameNode mounts .sh-live hidden -> boots -> serializes
}

function onEvicted(lc: LC): void {                     // the arbiter reclaimed our slot
  lc.leaseId = null
  if (compiling === lc.key) { compiling = null; if (lc.artifact === 'compiling') lc.artifact = 'missing' }
  set(lc, null)
  pumpCompiler()
}

/** FrameNode reports the outcome of a compile boot's serialization (or an interact-leave recapture). */
export function onSnapshotAdmitted(key: string, ok: boolean): void {
  const lc = nodes.get(key); if (!lc) return
  lc.artifact = ok ? 'ready' : 'incompatible'
  if (compiling === key) compiling = null
  if (lc.live === 'hidden') {                          // a compile boot finished: release the live doc, show snapshot
    release(lc); set(lc, null)
    if (!ok) reconcile(lc)                             // incompatible -> may need a counted live lease
  }
  pumpCompiler()
}

/** Test/HMR reset. */
export function __resetLifecycle(): void { for (const lc of nodes.values()) if (lc.leaseId != null) releaseLease(lc.leaseId); nodes.clear(); compiling = null }
