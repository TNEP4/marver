/**
 * In-place updates, what this document saw and no more (spec 30 #15). Vite's client imports `<acceptedPath>?t=<timestamp>`
 * only in a document whose module map holds the module, so a Resource Timing entry for that URL says this document
 * fetched the update; a document that did not writes nothing. Updates only the frame host's registry accepts are left
 * out: it accepts them without applying them (registry.ts), as main.tsx's `sh:hmr` filter does.
 *
 * What it cannot say, it does not: a fetch does not prove the update applied (Vite catches a failed import and still
 * reaches `afterUpdate`), and the next commit need not be the refresh's (Fast Refresh is debounced, an unrelated update
 * can commit first). So `applied` is never true: `'unknown'`, or `false` when Vite's own failure message for that path
 * reached this document's console during the update.
 *
 * Runs only with a hot module at the full level (main.tsx). An observer, not the timeline's buffer: a frame's modules can
 * fill the 250 entries Resource Timing keeps, and an observer still receives what the buffer refuses.
 */
import { RELOAD_BOUNDS } from '../../shared/perf-records.ts'
import type { InplaceMsg } from './messages.ts'

interface Update { type?: string; path?: string; acceptedPath?: string; timestamp?: number }
/** The fields only this module knows; main.tsx adds the frame and the document. */
export type InplaceReport = Omit<InplaceMsg, 'id' | 'boot'>

let waiters: ((at: number) => void)[] = []
/** The frame root committed (the Profiler in main.tsx). */
export function rootCommitted(): void {
  if (!waiters.length) return
  const at = performance.now()
  for (const w of waiters.splice(0)) w(at)
}
/** The next commit's time, or undefined past the wait. */
function nextCommit(ms: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const w = (at: number) => { clearTimeout(t); resolve(at) }
    const t = setTimeout(() => { waiters = waiters.filter((x) => x !== w); resolve(undefined) }, ms)
    waiters.push(w)
  })
}

const isRegistry = (u: Update) => (u.acceptedPath ?? u.path ?? '').includes('/frame-host/registry')
const pathOf = (u: Update) => (u.acceptedPath ?? u.path ?? '').split('?')[0]
/** The URL Vite's client imports (client.mjs `importUpdatedModule`): this update's path, this update's timestamp. */
function fetchedBy(u: Update, url: URL): boolean {
  return url.pathname.endsWith(pathOf(u)) && url.searchParams.get('t') === String(u.timestamp)
}

/** Vite's messages run one at a time (its client queues them), so one update round is open at most. It holds what its own
 *  updates left behind, no more - the observer sees every resource this document loads - and it ends by
 *  `vite:afterUpdate`, or with none (an accept callback threw, an import still pending) by the next update or
 *  `inplaceRoundMs`. Those last two write what was known by then, each update fetched so far, `noAfterUpdate`: an update
 *  that was seen is never lost silently. A `vite:afterUpdate` after that has no round, and writes nothing more. */
export function watchInplace(hot: { on(event: string, cb: (p: any) => void): void }, post: (m: InplaceReport) => void): void {
  interface Round { at: number; updates: Update[]; fetched: Set<Update>; take: () => void; failed: Set<string>; close: () => void }
  let round: Round | null = null
  const appliedOf = (r: Round, u: Update) => (r.failed.has(u.acceptedPath ?? u.path ?? '') ? false as const : 'unknown' as const)
  /** A round `afterUpdate` never came for: closed, and what it knew written now. */
  const giveUp = (r: Round) => {
    if (round === r) round = null
    r.take()
    r.close()
    const applyMs = Math.round(performance.now() - r.at)
    for (const u of r.updates) if (r.fetched.has(u)) post({ type: 'sh:inplace', hmrTs: u.timestamp!, applyMs, applied: appliedOf(r, u), noAfterUpdate: true })
  }

  hot.on('vite:beforeUpdate', (p: { updates?: Update[] }) => {
    try {
      if (round) giveUp(round)
      const updates = (p.updates ?? []).filter((u) => u.type === 'js-update' && !isRegistry(u) && typeof u.timestamp === 'number')
      if (!updates.length) return
      const fetched = new Set<Update>()
      const note = (entries: readonly PerformanceEntry[]) => {
        for (const e of entries) {
          let url: URL
          try { url = new URL(e.name) } catch { continue }
          for (const u of updates) if (fetchedBy(u, url)) fetched.add(u)
        }
      }
      const observer = new PerformanceObserver((list) => note(list.getEntries()))
      observer.observe({ type: 'resource' })
      const paths = new Set(updates.map((u) => u.acceptedPath ?? u.path ?? ''))
      const failed = new Set<string>()
      const original = console.error
      let open = true
      // only while an update is on its way, and the original always runs: Vite's own words for a failed import
      // (client.mjs `warnFailedUpdate`: `[vite] Failed to reload <acceptedPath>. …`), for this round's paths
      const watching = function (this: unknown, ...a: unknown[]) {
        original.apply(this, a)
        if (!open) return
        for (const x of a) {
          if (typeof x !== 'string' || !x.startsWith('Failed to reload ')) continue
          const path = x.slice('Failed to reload '.length).split('. ')[0]
          if (paths.has(path)) failed.add(path)
        }
      }
      console.error = watching
      const close = () => {
        open = false
        clearTimeout(timer)
        observer.disconnect()
        if (console.error === watching) console.error = original   // a frame's own replacement meanwhile stays
      }
      const r: Round = { at: performance.now(), updates, fetched, take: () => note(observer.takeRecords()), failed, close }
      const timer = setTimeout(() => { try { giveUp(r) } catch { /* the same */ } }, RELOAD_BOUNDS.inplaceRoundMs)
      round = r
    } catch { /* the recorder never stands in the way */ }
  })

  hot.on('vite:afterUpdate', () => {
    const r = round
    round = null
    if (!r) return
    try {
      const after = performance.now()
      r.take()
      r.close()
      for (const u of r.updates) {
        if (!r.fetched.has(u)) continue
        const applied = appliedOf(r, u)
        void nextCommit(RELOAD_BOUNDS.commitWaitMs).then((at) => post({
          type: 'sh:inplace', hmrTs: u.timestamp!, applyMs: Math.round(after - r.at), applied,
          ...(at !== undefined ? { nextObservedCommitMs: Math.round(at - after) } : {}),
        }))
      }
    } catch { /* the same */ }
  })
}
