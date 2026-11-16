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
/** `gen`: the server's source generation the answer holds for (a dev canvas); `kept`: a refusal the server keeps for it */
type Answer = ({ ok: true; targets: Target[] } | { ok: false; error: string; kept?: boolean }) & { gen?: number }

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
/** Is this node's document asleep now (the recorder's `invalidated`, `ready`: spec 30 #13, #14)? */
export const isAsleep = (key: string): boolean => asleep.has(key)
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
 *  until it wakes, so the run can reach bake-idle; every other canvas retries a failure that may pass (not a settled
 *  answer: `parked` below) every 4 s for as long as the frame rests, as before 0.27.2, so a frame recovers when the
 *  server does. */
const retried = new Set<string>()
const RETRY_MS = 4000
/** The server's answer for a compile still running (src/server/bake.ts COMPILING), and how many times a
 *  node looks again for it before settling for the pause alone. */
const COMPILING = 'compiling - ask again'
const COMPILING_TRIES = 15
/** Looks so far, per node, for the sleep key they were for: a new key (an edit, a theme, a size)
 *  or a wake starts the count again. */
const compiling = new Map<string, { key: string; n: number }>()
/**
 * Nodes resting on a SETTLED answer - one the server gives again, word for word, while it retains it: a refusal it keeps
 * for the source generation (`kept`: the frame loops, never stops changing, has too many effects...) or a compile none
 * of whose textures certified (its disk cache). Asking again every 4 s, forever, changed nothing but cost a POST, a
 * computed-style walk, a style rewrite and a forced layout per frame. A parked node asks again through the normal sleep:
 *  - when it learns of a generation DIFFERENT from its answer's - a push (`sh:bake-gen`, every source change), or any
 *    bake answer over HTTP (the shell's own socket may stay closed: api.ts). Equality only: a replacement server may
 *    count from anywhere, so no generation is "newer";
 *  - when the server would now answer otherwise with the generation unchanged (its retained answer evicted, deleted,
 *    replaced): the BACKSTOP, one batched ask for every parked node each `backstopMs` (30 s: 2 POSTs a minute for
 *    the whole board where the retries made 76), which touches no document - only a node whose answer changed goes
 *    back through the sleep;
 *  - on a reconnect (perhaps a new server), and when it wakes (a new document, theme or size: a new key).
 * No sleep timer, so a parked node is bake-idle; a headless perf run has no backstop (it goes idle and stays so).
 */
interface Parked { key: SleepKey; gen: number | undefined; sig: string; retry: () => void }
const parked = new Map<string, Parked>()
/** What an answer says, for "did it change": the kind, the refusal word for word, whether any texture certifies. */
const sigOf = (a: Answer): string => (a.ok ? `ok:${a.targets.some((t) => t.verified && t.texture) ? 1 : 0}` : `${a.kept ? 'kept' : 'no'}:${a.error}`)
/** Pushes heard, and the last one's generation: an ask a push overtook asks once more. */
let pushes = 0, pushGen: number | undefined
/** When each node was last released for a generation it heard of: a second such release within RETRY_MS waits
 *  RETRY_MS - two servers alternating their generations cost no more than the old 4 s retry did. */
const genReleased = new Map<string, number>()
function release(nodeKey: string, forGen = false): void {
  const p = parked.get(nodeKey)
  if (!p) return
  parked.delete(nodeKey)
  let ms = 250   // every node released in the same moment shares one batch
  if (forGen) {
    const now = Date.now(), was = genReleased.get(nodeKey)
    if (was !== undefined && now - was < RETRY_MS) ms = RETRY_MS
    genReleased.set(nodeKey, now)
  }
  scheduleSleep(p.retry, ms)
}
/** A generation heard of: every node parked under a DIFFERENT one asks again. `undefined`: perhaps a new server - all do. */
function heard(gen: number | undefined): void {
  for (const [nodeKey, p] of [...parked]) if (gen === undefined || (p.gen !== undefined && p.gen !== gen)) release(nodeKey, true)
}
function pushed(gen: number | undefined): void { pushes++; pushGen = gen; heard(gen) }
function park(nodeKey: string, key: SleepKey, answer: Answer, pushesAtAsk: number, retry: () => void): void {
  parked.set(nodeKey, { key, gen: answer.gen, sig: sigOf(answer), retry })
  // a push arrived while the ask was out and named another generation than the answer: once more, now (one re-ask per
  // push heard - never a loop)
  if (pushes !== pushesAtAsk && pushGen !== answer.gen) release(nodeKey, true)
  backstopSoon()
}
/** The backstop's period: 30 s (a test sets another through the dev hook below). */
let backstopMs = 30_000
let backstop: ReturnType<typeof setTimeout> | undefined, looking = false
function backstopSoon(): void {
  if (backstop !== undefined || looking || !parked.size || PERF_RUN || PUBLISHED) return
  backstop = setTimeout(() => { backstop = undefined; looking = true; void lookAgain().finally(() => { looking = false; backstopSoon() }) }, backstopMs)
}
/** The backstop: what would the server answer every parked node now? Over HTTP, no document touched. */
async function lookAgain(): Promise<void> {
  const all = [...parked]
  for (let i = 0; i < all.length; i += ASKS_MAX) {
    // only nodes still parked on this very answer (a board switch during an earlier chunk sends nothing for them)
    const part = all.slice(i, i + ASKS_MAX).filter(([nodeKey, p]) => parked.get(nodeKey) === p)
    if (!part.length) continue
    const keys = new Map<string, SleepKey>()
    for (const [, p] of part) keys.set(keyOf(p.key), p.key)
    inflight++
    try {
      const data = await post([...keys.values()])
      if (!data) continue   // no answer (the server is away): nothing learned, the next look asks again
      const gen = typeof data.gen === 'number' ? data.gen : undefined
      if (gen !== undefined) heard(gen)
      for (const [nodeKey, p] of part) {
        if (parked.get(nodeKey) !== p) continue   // woke, released or parked anew meanwhile
        const a = toAnswer(data.answers?.find((x) => keyOf(x) === keyOf(p.key)), gen)
        if (a.ok === false && a.error === 'no answer') continue
        if (sigOf(a) !== p.sig) release(nodeKey)
      }
    } finally { inflight-- }
  }
}
if (import.meta.hot) {
  import.meta.hot.on('sh:bake-gen', (m: { gen?: unknown }) => pushed(typeof m?.gen === 'number' ? m.gen : undefined))
  import.meta.hot.on('vite:ws:connect', () => heard(undefined))
}
// dev-only inspection hook for tests (never in a published build): what a node is parked on, and a push as the socket
// would deliver it
if (import.meta.env.DEV) (window as unknown as { __mvSleep: unknown }).__mvSleep = {
  parkedOn: (k: string) => { const p = parked.get(k); return p ? { gen: p.gen, sig: p.sig } : null },
  pushed,
  bakeWork: () => bakeWork(),
  backstopEvery: (ms: number) => { backstopMs = ms; clearTimeout(backstop); backstop = undefined; backstopSoon() },
}

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
      inflight++
      try {
        const index = PUBLISHED ? await staticAnswers() : null
        if (index) answerAll(byKey, index, null)
        else {
          // the server takes at most ASKS_MAX a request: a bigger batch (a generation releasing hundreds of parked
          // frames at once) goes in several, each answering its own waiters
          const all = [...byKey]
          for (let i = 0; i < all.length; i += ASKS_MAX) {
            const part = new Map(all.slice(i, i + ASKS_MAX))
            answerAll(part, null, await post([...part.values()].map((e) => e.key)))
          }
        }
      } finally { inflight-- }
    }, 40)
  })
}
type Answers = { gen?: number; answers?: (Answer & SleepKey)[] }
/** The server's asks limit (api.ts: 1-200 a request). */
const ASKS_MAX = 200
/** One POST of the bake asks; null when there is no answer (a network failure, a refusal of the request). */
async function post(keys: SleepKey[]): Promise<Answers | null> {
  const asks = keys.map((k) => ({ frame: k.frame, theme: k.theme, w: Math.round(k.w), h: Math.round(k.h), ...(k.doc ? { doc: k.doc } : {}) }))
  try {
    const r = await api('bakes', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf() }, body: JSON.stringify({ asks }) })
    return r.ok ? await r.json() : null
  } catch { return null }
}
const toAnswer = (a: (Answer & SleepKey) | Answer | undefined, gen: number | undefined): Answer =>
  a ? (a.ok ? { ok: true, targets: a.targets, gen } : { ok: false, error: a.error, ...(a.kept === true ? { kept: true } : {}), gen }) : { ok: false, error: 'no answer' }
/** Every waiter of a batch, its key's answer - before the POST stops counting, so the page is never idle between. */
function answerAll(byKey: Map<string, { key: SleepKey; waiters: ((a: Answer) => void)[] }>, index: Record<string, Answer> | null, data: Answers | null): void {
  const gen = typeof data?.gen === 'number' ? data.gen : undefined
  if (gen !== undefined) heard(gen)
  for (const e of byKey.values()) {
    const answer = toAnswer(index ? index[keyOf(e.key)] : data?.answers?.find((x) => keyOf(x) === keyOf(e.key)), gen)
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
  const pushesAtAsk = pushes
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
  const undecoded = decoded.some((ok) => !ok)
  if (undecoded) targets = []
  // a published document names the generation it was built with: textures dress that build only
  if (PUBLISHED && targets.length && doc.querySelector('meta[name="mv-bakes"]')?.getAttribute('content') !== String(BAKES)) targets = []
  if (!install(doc, targets)) return 'live'
  // a certified sleep is remembered; the pause-only fallback is not, so the next lifecycle event
  // asks again. A SETTLED answer (a kept refusal, a compile none of whose textures certified) parks the node
  // until the source generation moves (`park`). Anything else - a compile the source outran, a server hiccup, a
  // texture that did not decode - schedules a retry now. A canvas retries every 4 s while the frame rests: the
  // retry clears its own mark, so a failure after a failure asks again and the glass sleeps once the server
  // recovers. A headless perf run's retry keeps its mark until the node wakes - one retry, then nothing more
  if (targets.length) { asleep.set(nodeKey, { key: k, doc }); compiling.delete(nodeKey); retried.delete(nodeKey) }
  else if (answer.ok === false && answer.error === COMPILING) { /* out of looks: the pause alone, final */ }
  else if (!PUBLISHED && !undecoded && (answer.ok || answer.kept)) park(nodeKey, key, answer, pushesAtAsk, () => { if (current()) void sleep(nodeKey, iframe, key) })   // settled until the generation moves
  else if (!PUBLISHED && !retried.has(nodeKey)) { retried.add(nodeKey); scheduleSleep(() => { if (!PERF_RUN) retried.delete(nodeKey); if (current()) void sleep(nodeKey, iframe, key) }, RETRY_MS) }   // a static miss is final
  return 'asleep'
}

/** Wake: paint goes back to the live effects. The document is otherwise untouched. */
export function wake(nodeKey: string, iframe: HTMLIFrameElement | null): void {
  pending.delete(nodeKey)
  asleep.delete(nodeKey)
  compiling.delete(nodeKey)
  retried.delete(nodeKey)
  parked.delete(nodeKey)
  genReleased.delete(nodeKey)
  const doc = iframe?.contentDocument
  if (doc) resumeSmil(doc)
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
  pauseSmil(doc)
  return true
}

/** The SVG time containers this sleep holds, per sleeping document. */
const smilHeld = new WeakMap<Document, Set<SVGSVGElement>>()
const SMIL = 'animate,animateTransform,animateMotion,set'
const SVG_NS = 'http://www.w3.org/2000/svg'
const SHADOWED = ['pauseAnimations', 'unpauseAnimations', 'animationsPaused'] as const
/** The native timeline methods, taken once from the shell's own realm: a platform method works on an element of any
 *  realm, so a hold is undone whatever document the element is in by then, with or without a window. */
const NATIVE = typeof SVGSVGElement === 'function'
  ? { pause: SVGSVGElement.prototype.pauseAnimations, unpause: SVGSVGElement.prototype.unpauseAnimations, paused: SVGSVGElement.prototype.animationsPaused }
  : null
/** A held <svg>: what its author last asked for, and the own properties it had under our shadows (restored at wake). */
interface Hold { paused: boolean; saved: (readonly [string, PropertyDescriptor | undefined])[] }
const holds = new WeakMap<SVGSVGElement, Hold>()
/** The shadows, one of each for every held <svg>: they honour `this` - a call on an element not held (another <svg>,
 *  or this one after its wake) goes to the native method. */
const SHADOWS: Record<(typeof SHADOWED)[number], (this: SVGSVGElement) => unknown> = {
  pauseAnimations() { const h = holds.get(this); if (h) h.paused = true; else NATIVE!.pause.call(this) },
  unpauseAnimations() { const h = holds.get(this); if (h) h.paused = false; else NATIVE!.unpause.call(this) },
  animationsPaused() { const h = holds.get(this); return h ? h.paused : NATIVE!.paused.call(this) },
}
/**
 * SVG's own animations (SMIL: `<animate>`, `<animateTransform>`, ...) are no CSS animation: `animation-play-state` never
 * reaches them, and one running in any document - a rotating gradient - repaints and commits the WHOLE page every
 * frame. They pause with the CSS ones, by their time container (the outermost <svg>; every <svg> on the way is held
 * too, whichever one an engine keys the timeline on). While asleep the timeline holds still whatever the author calls
 * - as the CSS pause is !important: on each held <svg>, own `pauseAnimations`/`unpauseAnimations` only record what
 * they ask, and `animationsPaused()` answers it (their code sees the state it asked for, as if awake). Wake restores
 * the element's own properties as they were and runs the timeline only if the author's last word is "running" -
 * paused before the sleep and never unpaused, or paused during it, it stays paused. A paused timeline resumes where it
 * stood: nothing jumps, a finished animation does not restart.
 *
 * A hold is all or nothing: an <svg> whose own properties cannot be shadowed (an authored non-configurable one, a
 * non-extensible element) is left unheld - it animates on, as before sleep paused SMIL at all - and sleep never fails
 * for an SVG. Idempotent: a sleep installed again holds nothing twice.
 *
 * Accepted, not handled - each needs code written against the sleep itself; content that drives its SVG the ordinary
 * way (declarative SMIL, or direct method calls on the element) behaves as without sleep:
 *  - code that captured the native method before the sleep (a bound `svg.pauseAnimations`, or
 *    `SVGSVGElement.prototype.pauseAnimations.call(svg)`) bypasses the record: its pause during a sleep is undone at wake;
 *  - an <svg> adopted into another document while its own frame sleeps stays held until that frame wakes;
 *  - Gecko's nested <svg> query differs while held: an inner svg's `animationsPaused()` answers its own recorded
 *    intent, not its outer container's;
 *  - an <svg> mounted after the frame fell asleep is not held (it animates).
 */
function hold(s: SVGSVGElement): boolean {
  const saved = SHADOWED.map((k) => [k, Object.getOwnPropertyDescriptor(s, k)] as const)
  if (saved.some(([, d]) => d && !d.configurable)) return false
  const h: Hold = { paused: NATIVE!.paused.call(s), saved }
  holds.set(s, h)
  try {
    for (const k of SHADOWED) Object.defineProperty(s, k, { configurable: true, writable: true, value: SHADOWS[k] })
  } catch {
    holds.delete(s)
    unshadow(s, h)
    return false
  }
  if (!h.paused) NATIVE!.pause.call(s)   // last: nothing above can leave it paused unrecorded
  return true
}
/** The element's own properties back as they were before the hold. */
function unshadow(s: SVGSVGElement, h: Hold): void {
  for (const [k, d] of h.saved) {
    try { if (d) Object.defineProperty(s, k, d); else delete (s as unknown as Record<string, unknown>)[k] } catch { /* as it is */ }
  }
}
function pauseSmil(doc: Document): void {
  if (!NATIVE) return
  const anims = doc.querySelectorAll(SMIL)
  if (!anims.length) return
  let held = smilHeld.get(doc)
  for (const a of anims) {
    if (a.namespaceURI !== SVG_NS) continue
    for (let s = (a as SVGElement).ownerSVGElement; s; s = s.ownerSVGElement) {
      if (holds.has(s) || !hold(s)) continue
      if (!held) smilHeld.set(doc, held = new Set())
      held.add(s)
    }
  }
}
function resumeSmil(doc: Document): void {
  const held = smilHeld.get(doc)
  if (!held || !NATIVE) return
  smilHeld.delete(doc)
  for (const s of held) {
    const h = holds.get(s)
    if (!h) continue
    holds.delete(s)
    unshadow(s, h)
    if (!h.paused) NATIVE.unpause.call(s)
  }
}
