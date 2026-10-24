/**
 * The navigation adapter (spec 28 A2.14 #8): Electron 45's navigation events carry no navigation id, so main
 * keeps its own correlation per canvas webContents - a generation bumped at `did-start-navigation` (main
 * frame, cross-document), one attempt per generation, commits attributed to the current generation only.
 * Owner: the trust stream (proof.ts feeds it responses; tabs.ts reads its commits).
 *
 * - **Attempts.** A generation's attempt holds its URL without the hash (moved by `did-redirect-navigation`) and
 *   the outcome of its final response, `proved { url, instance }` or `failed { why }`, which the proof dispatcher
 *   reports with the generation it stamped on the request: an outcome whose generation is no longer current is
 *   dropped. A request seen before any start is stamped none and never counts.
 * - **Commits.** `did-navigate` is attributed when the current attempt proved this URL (no hash), under an
 *   instance that is still the tab's current, live one (proof.ts answers that), every proof since the last commit
 *   named that one instance, and that proof served no earlier commit (one proof, one commit). Anything else
 *   commits unattributed: untrusted, and the tab reloads it (A2.14 #8, v1.12 r1 #3). A back-forward cache restore
 *   made no request, so it has no proof and is never attributed.
 * - **Failures.** `did-fail-load` (main frame, not `ERR_ABORTED`) for the current attempt's URL ends it as failed,
 *   its `why` the proof's (`unverified`, `elsewhere`, `gone`) or else `unreachable`; whatever is committed loses
 *   trust (Chromium may have kept it). One for another URL changes nothing.
 * - **Aborts.** `did-fail-provisional-load` with `ERR_ABORTED`, or `did-stop-loading` with the attempt neither
 *   committed nor failed: the attempt ends with no commit, and the committed document keeps its trust - trust
 *   belongs to the committed document (#8), so a link the policy denies takes nothing from the page.
 *
 * Trust itself is `proof.isTrusted(wcId)`: the committed document attributed, not lost since, and its instance
 * still the tab's current, live registry instance.
 */
import type { WebContents } from 'electron'
import { note } from './testing/index.ts'

/** Why an attempt failed, and the tab page it leads to (A2.11): unverified, stopped (elsewhere, gone), unreachable. */
export type FailWhy = 'unverified' | 'elsewhere' | 'gone' | 'unreachable'

/** A final response's outcome, kept only while its stamped generation is current. */
export type Outcome = { kind: 'proved'; url: string; instance: string } | { kind: 'failed'; why: FailWhy }

export interface Attempt {
  gen: number
  /** without the hash; moved by did-redirect-navigation */
  url: string
  outcome?: Outcome
}

export type NavEvent =
  | { kind: 'start'; gen: number; url: string }
  | { kind: 'redirect'; gen: number; url: string }
  | { kind: 'response'; gen: number; outcome: Outcome }
  /** `attributed`: the current attempt proved this URL under the tab's live instance, its proof unused */
  | { kind: 'commit'; gen: number; url: string; attributed: boolean; instance?: string }
  | { kind: 'fail'; gen: number; url: string; why: FailWhy; code: number }
  | { kind: 'abort'; gen: number }

/** The committed document as the adapter knows it. `lost`: a failure since, so whatever shows is no longer trusted. */
export interface Committed { gen: number; url: string; attributed: boolean; instance?: string; lost: boolean }

/** The main frame that committed last (`did-frame-navigate`'s ids): where `mv:admit` goes. */
export interface FrameIds { processId: number; routingId: number }

export interface NavAdapter {
  gen(): number
  attempt(): Attempt | undefined
  /** the dispatcher's stamp for a main-frame request (`none` before any start: never counts) */
  stamp(): number | null
  response(gen: number, outcome: Outcome): void
  on(fn: (e: NavEvent) => void): () => void
  dispose(): void
  /** the committed document (added by the trust stream) */
  committed(): Committed | undefined
  /** the main frame of the last commit */
  frame(): FrameIds | undefined
  /** main-frame commits and failures seen, and renderers gone: the guard's `commit` binding (v1.13 r2 #2) */
  commits(): number
}

export const ERR_ABORTED = -3
export const ERR_BLOCKED_BY_CLIENT = -20

/** A URL without its fragment: a request URL never carries one, `did-navigate`'s does. */
export function noHash(url: string): string {
  const i = url.indexOf('#')
  return i < 0 ? url : url.slice(0, i)
}

interface Live extends Attempt { used: boolean; committed: boolean; failed: boolean; aborted: boolean }

/**
 * The adapter's logic, without Electron: each method is one Electron event, in the order Electron sends them.
 * `live(instance)` says whether an instance is still the tab's current, live one (proof.ts).
 */
export class NavCore {
  private g = 0
  private a: Live | undefined
  private c: Committed | undefined
  private fr: FrameIds | undefined
  private count = 0
  /** instances that proved a response since the last commit - two mean a rebind in the middle: unattributed */
  private proved = new Set<string>()

  constructor(private readonly live: (instance: string) => boolean, private readonly emit: (e: NavEvent) => void) {}

  gen(): number { return this.g }
  attempt(): Attempt | undefined { return this.a ? { gen: this.a.gen, url: this.a.url, outcome: this.a.outcome } : undefined }
  stamp(): number | null { return this.g > 0 ? this.g : null }
  committed(): Committed | undefined { return this.c ? { ...this.c } : undefined }
  frame(): FrameIds | undefined { return this.fr ? { ...this.fr } : undefined }
  commits(): number { return this.count }

  start(url: string, isMainFrame: boolean, isSameDocument: boolean): void {
    if (!isMainFrame || isSameDocument) return
    this.g += 1
    this.a = { gen: this.g, url: noHash(url), used: false, committed: false, failed: false, aborted: false }
    this.emit({ kind: 'start', gen: this.g, url: this.a.url })
  }

  redirect(url: string, isMainFrame: boolean, isSameDocument: boolean): void {
    if (!isMainFrame || isSameDocument || !this.a || this.a.gen !== this.g) return
    this.a.url = noHash(url)
    this.emit({ kind: 'redirect', gen: this.g, url: this.a.url })
  }

  response(gen: number, outcome: Outcome): void {
    if (outcome.kind === 'proved') this.proved.add(outcome.instance)
    if (!this.a || gen !== this.g || this.a.gen !== gen) return   // a generation no longer current: dropped
    this.a.outcome = outcome
    this.emit({ kind: 'response', gen, outcome })
  }

  frameNavigate(isMainFrame: boolean, processId: number, routingId: number): void {
    if (isMainFrame) this.fr = { processId, routingId }
  }

  navigate(url: string): void {
    this.count += 1
    const u = noHash(url)
    const a = this.a
    const o = a?.outcome
    let instance: string | undefined
    if (a && a.gen === this.g && o?.kind === 'proved' && !a.used && o.url === u && this.proved.size === 1 && this.proved.has(o.instance) && this.live(o.instance)) {
      instance = o.instance
      a.used = true
    }
    if (a && a.gen === this.g) a.committed = true
    this.proved.clear()
    this.c = { gen: this.g, url: u, attributed: instance !== undefined, instance, lost: false }
    this.emit({ kind: 'commit', gen: this.g, url: u, attributed: instance !== undefined, ...(instance ? { instance } : {}) })
  }

  failLoad(code: number, url: string, isMainFrame: boolean): void {
    if (!isMainFrame || code === ERR_ABORTED) return
    const a = this.a
    if (!a || a.gen !== this.g || noHash(url) !== a.url) return   // another URL: logged by the caller, nothing changes
    this.count += 1
    const why: FailWhy = a.outcome?.kind === 'failed' ? a.outcome.why : code === ERR_BLOCKED_BY_CLIENT ? 'unverified' : 'unreachable'
    a.failed = true
    if (this.c) this.c.lost = true
    this.emit({ kind: 'fail', gen: this.g, url: a.url, why, code })
  }

  failProvisional(code: number, isMainFrame: boolean): void {
    if (isMainFrame && code === ERR_ABORTED) this.abort()
  }

  stopLoading(): void { this.abort() }

  /** the renderer went: no document, no attempt */
  rendererGone(): void {
    this.count += 1
    this.c = undefined
    this.a = undefined
    this.fr = undefined
    this.proved.clear()
  }

  private abort(): void {
    const a = this.a
    if (!a || a.gen !== this.g || a.committed || a.failed || a.aborted) return
    a.aborted = true
    this.emit({ kind: 'abort', gen: a.gen })
  }
}

const adapters = new Map<number, NavAdapter>()
/** The adapter of a webContents, when it has one. */
export const adapterFor = (webContentsId: number): NavAdapter | undefined => adapters.get(webContentsId)

let liveResolver: (webContentsId: number, instance: string) => boolean = () => false
/** proof.ts says which instance is a tab's current, live one; until it does, nothing is attributed. */
export function setLiveResolver(fn: (webContentsId: number, instance: string) => boolean): void { liveResolver = fn }

/** The adapter of a canvas webContents: one per webContents, made on the first call, gone with the webContents. */
export function attachNav(wc: WebContents): NavAdapter {
  const had = adapters.get(wc.id)
  if (had) return had
  const id = wc.id
  const listeners = new Set<(e: NavEvent) => void>()
  const trace = (event: string, data: Record<string, unknown>) => { if (__MV_TEST__) note('nav', { wc: id, event, ...data }) }
  const core = new NavCore((instance) => liveResolver(id, instance), (e) => {
    trace(`adapter:${e.kind}`, e as unknown as Record<string, unknown>)
    for (const fn of [...listeners]) {
      try { fn(e) } catch (err) { process.stderr.write(`marver-app: a navigation listener threw: ${(err as Error).message}\n`) }
    }
  })
  const on = {
    start: (d: { url: string; isMainFrame: boolean; isSameDocument: boolean }) => {
      trace('did-start-navigation', { url: d.url, main: d.isMainFrame, same: d.isSameDocument })
      core.start(d.url, d.isMainFrame, d.isSameDocument)
    },
    redirect: (d: { url: string; isMainFrame: boolean; isSameDocument: boolean }) => {
      trace('did-redirect-navigation', { url: d.url, main: d.isMainFrame })
      core.redirect(d.url, d.isMainFrame, d.isSameDocument)
    },
    frame: (_e: unknown, url: string, code: number, _t: string, isMain: boolean, pid: number, rid: number) => {
      trace('did-frame-navigate', { url, code, main: isMain })
      core.frameNavigate(isMain, pid, rid)
    },
    navigate: (_e: unknown, url: string, code: number) => { trace('did-navigate', { url, code }); core.navigate(url) },
    inPage: (_e: unknown, url: string, isMain: boolean) => { if (isMain) trace('did-navigate-in-page', { url }) },
    failLoad: (_e: unknown, code: number, _d: string, url: string, isMain: boolean) => {
      trace('did-fail-load', { code, url, main: isMain })
      const a = core.attempt()
      if (isMain && code !== ERR_ABORTED && (!a || noHash(url) !== a.url)) process.stderr.write(`marver-app: a load failed (${code}) for a URL no current navigation names\n`)
      core.failLoad(code, url, isMain)
    },
    failProvisional: (_e: unknown, code: number, _d: string, url: string, isMain: boolean) => {
      trace('did-fail-provisional-load', { code, url, main: isMain })
      core.failProvisional(code, isMain)
    },
    stop: () => { trace('did-stop-loading', {}); core.stopLoading() },
    gone: (_e: unknown, d: { reason: string }) => { trace('render-process-gone', { reason: d.reason }); core.rendererGone() },
  }
  wc.on('did-start-navigation', on.start)
  wc.on('did-redirect-navigation', on.redirect)
  wc.on('did-frame-navigate', on.frame)
  wc.on('did-navigate', on.navigate)
  wc.on('did-navigate-in-page', on.inPage)
  wc.on('did-fail-load', on.failLoad)
  wc.on('did-fail-provisional-load', on.failProvisional)
  wc.on('did-stop-loading', on.stop)
  wc.on('render-process-gone', on.gone)
  let disposed = false
  const adapter: NavAdapter = {
    gen: () => core.gen(),
    attempt: () => core.attempt(),
    stamp: () => core.stamp(),
    response: (gen, outcome) => { trace('response', { gen, outcome }); core.response(gen, outcome) },
    on(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
    committed: () => core.committed(),
    frame: () => core.frame(),
    commits: () => core.commits(),
    dispose() {
      if (disposed) return
      disposed = true
      adapters.delete(id)
      listeners.clear()
      if (wc.isDestroyed()) return
      wc.off('did-start-navigation', on.start)
      wc.off('did-redirect-navigation', on.redirect)
      wc.off('did-frame-navigate', on.frame)
      wc.off('did-navigate', on.navigate)
      wc.off('did-navigate-in-page', on.inPage)
      wc.off('did-fail-load', on.failLoad)
      wc.off('did-fail-provisional-load', on.failProvisional)
      wc.off('did-stop-loading', on.stop)
      wc.off('render-process-gone', on.gone)
    },
  }
  adapters.set(id, adapter)
  wc.once('destroyed', () => adapter.dispose())
  return adapter
}
