/**
 * Sleep - a frame at rest, in place (spec 16).
 *
 * A resting frame is its own LIVE document. Nothing is copied, pictured or swapped, so the moment
 * the human interacts, comments or lasers, they are already looking at the thing itself: no line
 * break, no spacing, no pixel can move. Sleep changes PAINT only:
 *
 *   - CSS animations pause (`animation-play-state: paused`);
 *   - every `backdrop-filter` element - the one effect that reads back what is behind it on every
 *     composited frame, and the reason a glass design checkerboards at scale - gets the compositor's
 *     own filtered backdrop as a static texture under its own background layers, computed and
 *     certified by the dev server in headless Chrome (src/server/bake.ts); the rule itself is
 *     src/shared/sleep-rule.ts, the same one the compiler certified.
 *
 * A frame with no such element - markdown, images, slides, lo-fi - never talks to the server:
 * its sleep is the animation pause. Frames are asked in one batch per tick; the server answers from
 * its disk cache (keyed by frame, theme, size and source generation) or compiles. Textures are
 * decoded BEFORE the override is installed, so sleep is one paint. Without textures - no compiler
 * (a published canvas), a compile that failed, a texture that does not decode - the frame sleeps
 * with the pause alone and its glass stays live: never an effect layer without its texture.
 *
 * Safety: the override is all or nothing - every target's selector must resolve to an element whose
 * border box is the one the server measured (half a pixel) and whose filter is still the one baked, or
 * the frame stays live. Wake restores the live effects under `transition: none` (an authored
 * transition on backdrop-filter, filter or background must not animate out of the sleep, nor into
 * it), then removes the <style> and the attributes.
 */
import { ROUTE } from '../../const.ts'
import { BAKES, PUBLISHED } from '../store.ts'
import { api } from '../api.ts'
import { PERF_RUN } from '../perf-run.ts'
import { readOwn, sleepRule } from '../../../shared/sleep-rule.ts'
import type { BakeWork } from '../../../shared/perf-run.ts'

/** `doc`: the revision the document shows (spec 26) - the compiler refuses a document behind its frame */
export interface SleepKey { frame: string; theme: string; w: number; h: number; doc?: string }
interface Target { sel: string; rect: { x: number; y: number; w: number; h: number }; filter: string; level: number; texture: string; verified: boolean }
type Answer = { ok: true; targets: Target[] } | { ok: false; error: string }

const STYLE_ID = 'mv-sleep'
/** How far (CSS px) any EDGE of an element's border box may sit from the one the compiler measured.
 *  Headless and headed Chrome shape text a few hundredths of a pixel apart (a 784 px pill measures
 *  784.09 in a window, 784.125 in the compiler), which is invisible under a texture stretched to
 *  the box; a different wrap, size or place is a whole line or more and still refuses the frame. */
const TOL = 0.5
/** `?awake=1` keeps every frame live - the diagnostic switch the identity probes compare against. */
const AWAKE = new URLSearchParams(location.search).get('awake') === '1'
const PAUSE = `*,*::before,*::after{animation-play-state:paused!important}`
const csrf = () => document.cookie.match(/(?:^|; )mv_c=([^;]+)/)?.[1] ?? ''
const keyOf = (k: SleepKey) => `${k.frame}|${k.theme}|${Math.round(k.w)}|${Math.round(k.h)}${k.doc ? `|${k.doc}` : ''}`

/** What a node's DOCUMENT is asleep under, published only once its override is INSTALLED. */
const asleep = new Map<string, { key: string; doc: Document }>()
/** How many frames are asleep now (the recorder's weight of a settled load, spec 28 A1.7). */
export const sleepingCount = (): number => asleep.size
/**
 * The page's own bake work (spec 28 A3.8 #18): four counts of their own - `pending` below is the current request
 * per node and survives a successful sleep, so it says nothing about idleness. `scheduled`: FrameNode's 250 ms
 * timer and both retry timers, every one through `scheduleSleep()`; `running`: a sleep from its entry to its
 * `finally` (fonts, the ask, the decode, the texture installed); `queued`: asks batched and not sent yet;
 * `inflight`: the bake POST on its way. A headless perf run measures only once all four are zero and the server's
 * own jobs for the run are too (bake.ts `jobsOf`).
 */
let scheduled = 0, running = 0, inflight = 0
export const bakeWork = (): BakeWork => ({ scheduled, running, queued: queue.length, inflight })
/** All four at zero. Not the run's bake-idle: the driver adds the server's `jobsOf(run)`. */
export const bakeIdle = (): boolean => { const w = bakeWork(); return !w.scheduled && !w.running && !w.queued && !w.inflight }
/** A sleep to try in `ms` (FrameNode's settle, a compile still running, one retry of a failed compile), counted while
 *  it waits; the cancel stops it and its count. */
export function scheduleSleep(fn: () => void, ms: number): () => void {
  scheduled++
  let done = false
  const t = setTimeout(() => { if (done) return; done = true; scheduled--; fn() }, ms)
  return () => { if (done) return; done = true; scheduled--; clearTimeout(t) }
}
/** The node's current request, so a stale answer (a newer sleep, a wake in between) is dropped. */
const pending = new Map<string, number>()
let seq = 0
/** Nodes with a retry of a failed compile in flight - or, in a headless perf run, spent: a run's frame retries once
 *  until it wakes, so the run can reach bake-idle; every other canvas retries every 4 s for as long as the frame
 *  rests, as before 0.27.2, so a frame recovers when the server does. */
const retried = new Set<string>()
const RETRY_MS = 4000
/** The server's answer for a compile still running (src/server/bake.ts COMPILING), and how many times a
 *  node looks again for it before settling for the pause alone. */
const COMPILING = 'compiling - ask again'
const COMPILING_TRIES = 15
/** Looks so far, per node, for the sleep key they were for: a new key (an edit, a theme, a size)
 *  or a wake starts the count again. */
const compiling = new Map<string, { key: string; n: number }>()

/** Does this document have anything to compile? Cheap: one computed style per element. */
export function hasEffects(doc: Document): boolean {
  for (const el of doc.querySelectorAll('*')) {
    const cs = doc.defaultView!.getComputedStyle(el)
    const bf = cs.backdropFilter || (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter
    if (bf && bf !== 'none') return true
  }
  return false
}

/** A published canvas has no compiler: its textures were compiled at build time against the very
 *  document it serves, and ship as one static index (publish-bakes.ts), read once. */
let published: Promise<Record<string, Answer>> | undefined
const staticAnswers = () => (published ??= (BAKES ? fetch(`${ROUTE}/bakes/${BAKES}/index.json`).then((r) => (r.ok ? r.json() : {})) : Promise.resolve({}))
  .then((j: { gen?: number; answers?: Record<string, Answer> }) => (j.gen === BAKES && j.answers) || {}).catch((): Record<string, Answer> => ({})))

// ---- one batch per tick: every frame that decides to sleep in the same moment shares a browser
const queue: { key: SleepKey; resolve: (a: Answer) => void }[] = []
let flush: ReturnType<typeof setTimeout> | undefined
function ask(key: SleepKey): Promise<Answer> {
  return new Promise((resolve) => {
    queue.push({ key, resolve })
    clearTimeout(flush)
    flush = setTimeout(async () => {
      const batch = queue.splice(0)
      // one ask per key; every waiter for that key gets the same answer
      const byKey = new Map<string, { key: SleepKey; waiters: ((a: Answer) => void)[] }>()
      for (const q of batch) { const kk = keyOf(q.key); const e = byKey.get(kk); if (e) e.waiters.push(q.resolve); else byKey.set(kk, { key: q.key, waiters: [q.resolve] }) }
      const asks = [...byKey.values()].map((e) => ({ frame: e.key.frame, theme: e.key.theme, w: Math.round(e.key.w), h: Math.round(e.key.h), ...(e.key.doc ? { doc: e.key.doc } : {}) }))
      let data: { answers?: (Answer & SleepKey)[] } | null = null
      inflight++
      try {
        const index = PUBLISHED ? await staticAnswers() : null
        if (!index) {
          try {
            const r = await api('bakes', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf() }, body: JSON.stringify({ asks }) })
            data = r.ok ? await r.json() : null
          } catch { data = null }
        }
        answerAll(byKey, index, data)
      } finally { inflight-- }
    }, 40)
  })
}
/** Every waiter of a batch, its key's answer - before the POST stops counting, so the page is never idle between. */
function answerAll(byKey: Map<string, { key: SleepKey; waiters: ((a: Answer) => void)[] }>, index: Record<string, Answer> | null, data: { answers?: (Answer & SleepKey)[] } | null): void {
  for (const e of byKey.values()) {
    const a = index ? index[keyOf(e.key)] : data?.answers?.find((x) => keyOf(x) === keyOf(e.key))
    const answer: Answer = a ? (a.ok ? { ok: true, targets: a.targets } : { ok: false, error: a.error }) : { ok: false, error: 'no answer' }
    for (const w of e.waiters) w(answer)
  }
}

/** Put a node's live document to sleep under `key`. Resolves once the override is installed (or
 *  the document was found to have no effects, or the compile failed and the frame stays live).
 *  A wake or a newer sleep in the meantime supersedes it. */
export async function sleep(nodeKey: string, iframe: HTMLIFrameElement, key: SleepKey): Promise<'asleep' | 'live'> {
  if (AWAKE) return 'live'
  running++
  try { return await sleepNow(nodeKey, iframe, key) } finally { running-- }
}

async function sleepNow(nodeKey: string, iframe: HTMLIFrameElement, key: SleepKey): Promise<'asleep' | 'live'> {
  const k = keyOf(key)
  const doc = iframe.contentDocument
  if (!doc?.body) return 'live'
  const have = asleep.get(nodeKey)
  if (have && have.key === k && have.doc === doc && doc.getElementById(STYLE_ID)) return 'asleep'
  const mine = ++seq
  pending.set(nodeKey, mine)
  const current = () => pending.get(nodeKey) === mine && iframe.contentDocument === doc
  // the compiler measured after the frame's fonts; so does the gate below
  if (doc.fonts) { await doc.fonts.ready; if (!current()) return 'live' }
  if (!hasEffects(doc)) {
    // nothing to compile: the pause alone is this frame's sleep
    if (!current()) return 'live'
    install(doc, [])
    asleep.set(nodeKey, { key: k, doc })
    return 'asleep'
  }
  const answer = await ask(key)
  if (!current()) return 'live'
  // still compiling (issue #23): the server answered in seconds and carries on by itself. The frame
  // stays LIVE meanwhile - pausing now would freeze a finite animation midway, under a texture of its
  // end - and looks again, a bounded number of times; past that, the pause alone below
  if (!PUBLISHED && !answer.ok && answer.error === COMPILING) {
    const was = compiling.get(nodeKey)
    const n = (was && was.key === k ? was.n : 0) + 1
    compiling.set(nodeKey, { key: k, n })
    if (n <= COMPILING_TRIES) { scheduleSleep(() => { if (current()) void sleep(nodeKey, iframe, key) }, RETRY_MS); return 'live' }
  }
  // no compiler (a published canvas, a compile that failed): the pause alone, the glass live -
  // never an effect layer without its texture
  let targets = answer.ok ? answer.targets.filter((t) => t.verified && t.texture) : []
  // decode every texture BEFORE the paint that installs them - one commit, no pop-in; one that
  // fails to decode (pruned, missing, corrupt) leaves the glass live
  const decoded = await Promise.all(targets.map((t) => { const im = new Image(); im.src = t.texture; return im.decode().then(() => true, () => false) }))
  if (!current()) return 'live'
  if (decoded.some((ok) => !ok)) targets = []
  // a published document names the generation it was built with: textures dress that build only
  if (PUBLISHED && targets.length && doc.querySelector('meta[name="mv-bakes"]')?.getAttribute('content') !== String(BAKES)) targets = []
  if (!install(doc, targets)) return 'live'
  // a certified sleep is remembered; the pause-only fallback is not, so the next lifecycle event
  // asks again (a compile the source outran, a server hiccup), and a retry is scheduled now. A canvas retries
  // every 4 s while the frame rests: the retry clears its own mark, so a failure after a failure asks again and
  // the glass sleeps once the server recovers. A headless perf run's retry keeps its mark until the node wakes -
  // one retry, then nothing more, or a frame the compiler refuses would keep the run from ever being bake-idle
  if (targets.length) { asleep.set(nodeKey, { key: k, doc }); compiling.delete(nodeKey); retried.delete(nodeKey) }
  else if (answer.ok === false && answer.error === COMPILING) { /* out of looks: the pause alone, final */ }
  else if (!PUBLISHED && !retried.has(nodeKey)) { retried.add(nodeKey); scheduleSleep(() => { if (!PERF_RUN) retried.delete(nodeKey); if (current()) void sleep(nodeKey, iframe, key) }, RETRY_MS) }   // a static miss is final
  return 'asleep'
}

/** Wake: paint goes back to the live effects. The document is otherwise untouched. */
export function wake(nodeKey: string, iframe: HTMLIFrameElement | null): void {
  pending.delete(nodeKey)
  asleep.delete(nodeKey)
  compiling.delete(nodeKey)
  retried.delete(nodeKey)
  const doc = iframe?.contentDocument
  const st = doc?.getElementById(STYLE_ID)
  if (!doc || !st) return
  const els = [...doc.querySelectorAll<HTMLElement>('[data-mv-sleep]')]
  still(doc, els, () => st.remove())
  for (const el of els) el.removeAttribute('data-mv-sleep')
}

/** Run `change` with no transition able to start on `els`: an INLINE important
 *  `transition-property: none` (it outranks an authored important transition), the change, one
 *  forced style recalc - a style change event with nothing to animate - then the authored longhand
 *  back. Only the longhand is touched: an inline `transition-duration` alone does not serialize
 *  through the shorthand, and a shorthand round trip would have deleted it. */
function still(doc: Document, els: HTMLElement[], change: () => void): void {
  const authored = els.map((el) => [el.style.getPropertyValue('transition-property'), el.style.getPropertyPriority('transition-property')] as const)
  for (const el of els) el.style.setProperty('transition-property', 'none', 'important')
  change()
  void doc.documentElement.offsetWidth
  els.forEach((el, i) => { const [v, p] = authored[i]; if (v) el.style.setProperty('transition-property', v, p); else el.style.removeProperty('transition-property') })
}

/** Install the override for the targets. All or nothing: a target whose element is not exactly the
 *  one the server measured leaves the whole document live. Returns whether it was installed. */
function install(doc: Document, targets: Target[]): boolean {
  doc.querySelectorAll('[data-mv-sleep]').forEach((el) => el.removeAttribute('data-mv-sleep'))
  const rules: string[] = [PAUSE]
  const els: HTMLElement[] = []
  for (const [i, t] of targets.entries()) {
    let el: HTMLElement | null = null
    try { el = doc.querySelector<HTMLElement>(t.sel) } catch { /* a selector from another document shape */ }
    if (!el) return false
    const r = el.getBoundingClientRect()
    if (Math.abs(r.x - t.rect.x) > TOL || Math.abs(r.y - t.rect.y) > TOL || Math.abs(r.right - t.rect.x - t.rect.w) > TOL || Math.abs(r.bottom - t.rect.y - t.rect.h) > TOL) return false
    const cs = doc.defaultView!.getComputedStyle(el)
    if ((cs.backdropFilter || (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter || 'none') !== t.filter) return false
    rules.push(sleepRule(`[data-mv-sleep="${i}"]`, readOwn(cs), t.texture))
    els.push(el)
  }
  let st = doc.getElementById(STYLE_ID)
  if (!st) { st = doc.createElement('style'); st.id = STYLE_ID; (doc.head ?? doc.documentElement).appendChild(st) }
  const style = st
  // one paint, and no authored transition (`transition: all` is common on a pill) may animate the
  // effect out or the texture in
  still(doc, els, () => { els.forEach((el, i) => el.setAttribute('data-mv-sleep', String(i))); style.textContent = rules.join('\n') })
  return true
}
