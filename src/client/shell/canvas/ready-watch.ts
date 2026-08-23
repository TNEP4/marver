// Readiness-watchdog policy, kept pure so it can be unit-tested apart from the browser-coupled
// store (which imports Vite virtual modules and can't load under vitest).
//
// The frame host posts sh:ready SYNCHRONOUSLY after it renders, so a frame that misses the
// deadline has not failed - its dev-server module fetches just haven't settled (Vite re-optimizing
// dependencies, or the box saturated by parallel Live Jam agents). A genuine failure takes the
// separate immediate sh:error path. So a silent deadline earns exactly ONE automatic re-navigation
// on a fresh revision; a second silence stays 'loading' forever (never a red failure card).

export interface ReadyNode {
  status: 'loading' | 'ready' | 'error'
  readyRetried?: boolean
  missing?: boolean
}

/** Arm the 10s watchdog only for a present, still-loading, not-yet-retried frame. A missing or
 *  absent frame must NOT spend the one-shot allowance - it has no live iframe booting, and would
 *  otherwise burn its retry before its file even arrives. */
export function shouldArmReadyWatch(node: ReadyNode, hasFrame: boolean): boolean {
  return node.status === 'loading' && !node.readyRetried && hasFrame && !node.missing
}

/** Whether an automatic (watchdog-driven) reload still applies: one shot, and only while the frame
 *  is still silently loading. A frame that already went ready/error, or already spent its retry,
 *  is left alone. */
export function canAutoReload(node: ReadyNode): boolean {
  return node.status === 'loading' && !node.readyRetried
}
