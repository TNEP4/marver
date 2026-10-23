/**
 * Every request this page makes to its dev server names the canvas it belongs to (spec 28 A1.11), so a
 * page left open after its canvas stopped can never write into another project that took its port. The
 * server refuses a request naming another workspace before reading anything (server/guard.ts); this
 * side keeps what the page holds, says the canvas stopped, and sends nothing more until its own canvas
 * answers on this address again - then it saves and reloads. A published canvas has no workspace to
 * name: its requests go out as before.
 */
import { create } from 'zustand'
import { ROUTE } from '../const.ts'
import { guardLeaving, leaveNow, unsavedWhen, workChanged } from './unsaved.ts'
// @ts-expect-error virtual module provided by the plugin
import shConfig from 'virtual:sh-config'
// @ts-expect-error virtual module: null in dev; a published build inlines manifest+boards
import shData from 'virtual:sh-data'

/** This page's workspace in dev; '' on a published canvas (or a harness that names none). */
export const WS: string = shData === null && typeof shConfig?.workspace === 'string' ? shConfig.workspace : ''

/** A per-viewer preference kept per canvas (A1.6): `<key>:<workspace>` in dev, the bare key when published. */
export const scoped = (key: string) => (WS ? `${key}:${WS}` : key)
/** A URL a document or an <img> loads, naming the workspace (frames, the stage, Jam pictures). */
export const withWs = (url: string) => (WS ? `${url}${url.includes('?') ? '&' : '?'}ws=${WS}` : url)

/** live; checking (the live socket dropped, the first answer not in); down (nothing, or not this canvas,
 *  answers); elsewhere (another canvas answers here); resuming (this canvas answered: saving, then reload). */
export type Link = 'live' | 'checking' | 'down' | 'elsewhere' | 'resuming'
/** `shown`: the "This canvas stopped" banner is up. `unsaved`: this tab holds something only it has (an edit not
 *  saved, a capture, words not sent) - the banner says so only then. */
export const useLink = create<{ link: Link; shown: boolean; unsaved: boolean }>(() => ({ link: 'live', shown: false, unsaved: false }))
export const stoppedLink = (l: Link) => l === 'checking' || l === 'down' || l === 'elsewhere'
/** Nothing leaves the page: its canvas is gone from here, or not known to be back yet. */
export const canvasStopped = () => stoppedLink(useLink.getState().link)
/** canvasStopped(), for a component: the tools that need the server (comments, Jam) go quiet while it holds. */
export const useStopped = () => useLink((s) => stoppedLink(s.link))
/** The way back, said by each tool that needs the server while the canvas is stopped: its toast, its tooltip. */
export const STOPPED_WAY = 'npx marver dev brings it back'
export const STOPPED_TIP = 'The canvas stopped - run npx marver dev to bring it back'
/** The answer a stopped page gives itself (or gets from the server, translated): never a 409 a caller reads. */
export const isStopped = (r: Response) => r.headers.get('x-mv-stopped') === '1'
const stoppedAnswer = () => new Response('{"error":"this canvas stopped"}', { status: 503, headers: { 'content-type': 'application/json', 'x-mv-stopped': '1' } })

/** Any request to this page's dev server. `fetch` is looked up at call time (tests patch window.fetch)
 *  and called before any await, so a `keepalive` request made in `pagehide` still goes out. Callers pass
 *  plain-object headers; a GET keeps its init without a method. */
export function mvFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (WS && canvasStopped()) return Promise.resolve(stoppedAnswer())
  const sent = fetch(url, WS ? { ...init, headers: { ...(init.headers as Record<string, string> | undefined), 'x-mv-ws': WS } } : init)
  if (!WS) return sent
  // the server's refusal is told apart here, before any caller's own 409 (a board conflict, a stale tree)
  return sent.then((r) => {
    if (r.status !== 409 || r.headers.get('x-mv-elsewhere') !== '1') return r
    lost('elsewhere')
    return stoppedAnswer()
  }, (e: unknown) => {
    // the live socket is gone, so nothing else would say so: a request that reaches nothing stops the page
    if (hmrLost && (e as Error)?.name !== 'AbortError') lost('down')
    throw e
  })
}
/** A request under /__mv/api/: `api('boards/main', { method: 'PUT', ... })`. */
export const api = (path: string, init?: RequestInit) => mvFetch(`${ROUTE}/api/${path}`, init)

// ---- the link: losing the canvas, and getting it back --------------------------------------------------

/** What must be done before a resumed page reloads (the board save, the heights). Each answers true when
 *  the page may reload now; asked again each second while a reload is owed, so each is cheap when there is
 *  nothing to do. */
const flushers = new Set<() => Promise<boolean>>()
export const beforeResume = (fn: () => Promise<boolean>) => { flushers.add(fn); return () => { flushers.delete(fn) } }
/** What holds a reload while it answers true: an edit not saved, a capture recording, words typed and not
 *  sent. Synchronous, and asked right before the reload, after every flusher has finished - so what a person
 *  does while the flushers wait on the server holds it as surely as what was there before they began. */
const holds = new Set<() => boolean>()
export const holdsReload = (fn: () => boolean) => { holds.add(fn); return () => { holds.delete(fn) } }
const held = () => [...holds].some((h) => { try { return h() } catch { return true } })
/** Asks again whether this tab holds anything only it has (the banner's "unsaved edits"): at a stop, once a
 *  second while stopped, and whenever an edit or a word changes it. */
export function noteUnsaved() {
  if (!WS) return
  const u = held()
  if (u !== useLink.getState().unsaved) useLink.setState({ unsaved: u })
}
/** Told when a resumed page stays (a flusher said no): the store's toast, registered by store.ts. */
let say: (text: string) => void = () => {}
export const onLinkNotice = (fn: (text: string) => void) => { say = fn }

let hmrLost = false
let probeTimer: ReturnType<typeof setTimeout> | null = null

function lost(why: 'down' | 'elsewhere') {
  noteUnsaved()
  if (why === 'elsewhere') useLink.setState({ link: 'elsewhere', shown: true })
  else if (!canvasStopped()) useLink.setState({ link: 'checking' })
  probeTimer ??= setTimeout(probe, 0)
}

/** Once a second while stopped, and while a reload is owed: is this canvas (still) on this address? */
async function probe() {
  let r: Response | null = null
  // a server that takes the connection and never answers (half up, hung, paused) is no answer: a miss
  try { r = await fetch(`${ROUTE}/api/hello`, { headers: { 'x-mv-ws': WS }, cache: 'no-store', signal: AbortSignal.timeout(2000) }) } catch { r = null }
  const ours = !!r?.ok && (await r.json().catch(() => null))?.ws === WS
  probeTimer = null
  if (ours) return void resume()
  // another canvas answers, or nothing does, or something that is not a canvas of this one (an older
  // marver says 404): the banner - and keep asking
  noteUnsaved()
  useLink.setState({ link: r?.status === 409 && r.headers.get('x-mv-elsewhere') === '1' ? 'elsewhere' : 'down', shown: true })
  probeTimer = setTimeout(probe, 1000)
}

async function resume() {
  const back = useLink.getState().link !== 'live'      // from a stop; 'live' is a page that owes a reload
  if (back) useLink.setState({ link: 'resuming' })     // requests flow again: the flushers use them
  let ok = true
  flushing = true
  try { for (const fn of flushers) ok = (await fn().catch(() => false)) && ok } finally { flushing = false }
  const now = useLink.getState().link
  if (now !== 'resuming' && now !== 'live') return     // lost again while saving: the probe goes on
  // asked here, with nothing awaited between the answer and the reload: words typed or an edit made while a
  // flusher waited on the server hold it too
  if (ok && held()) ok = false
  // a fresh document on the canvas that answered: live updates again - and the next page says what the resumes came to,
  // this one's and those this reload waited after (a draft, a capture), whose toasts go with this page
  // its own guard lets this reload through: what it held is saved, and nothing holds it (A2.14 #17)
  if (hmrLost && ok) { keepOverReload(lostOnResume ?? (savedOnResume ? 'saved' : null)); return void leaveNow(() => location.reload()) }
  if (back || useLink.getState().shown) useLink.setState({ link: 'live', shown: false })
  // no reload owed (Vite's socket held): the page goes on as it is, and what this resume came to was said on it
  if (!hmrLost) { lostOnResume = null; savedOnResume = false; return }
  // Vite's socket never comes back (its client waits on the listener below), so this page owes a reload:
  // until nothing holds it (a capture recording, words not sent) it works as live, keeps asking - a stop
  // is seen again - and reloads the moment it may
  if (back) { say('marver dev is back - this page reloads once nothing is in progress'); unstrand() }
  probeTimer ??= setTimeout(probe, 1000)
}

/** Frames another project answered while this canvas was away show its "another canvas" page, which runs no
 *  script - no Vite client to bring them back. A page that stays reloads them in place, on its own canvas. */
function unstrand() {
  for (const f of document.querySelectorAll('iframe')) if (stranded(f)) f.contentWindow?.location.reload()
}
/** Does this frame show another project's "another canvas" page (server/guard.ts)? The shell draws its own quiet
 *  placeholder over it: the banner says what happened, once. */
export function stranded(f: HTMLIFrameElement | null): boolean {
  try { return !!f?.contentDocument?.querySelector('meta[name="mv-elsewhere"]') } catch { return false /* not ours to read */ }
}

// ---- over the resume's own reload: where the person was looking, and what its save came to --------------------

/** What the resume's save came to, said by the page after its reload: 'saved' - the board edits only this tab held
 *  reached the disk; 'disk' - the board's file changed on disk meanwhile and won, the tab's board edits dropped; 'gone' - the board
 *  was renamed or removed meanwhile and is not created again; null - there was nothing to save. */
export type ResumeOutcome = 'saved' | 'disk' | 'gone' | null
let flushing = false
/** What the resumes came to - the board save's own word, lost or saved - kept until the reload that carries it: a
 *  resume whose reload is held (a draft, a capture) is not the last one, and the one that reloads at last may have
 *  nothing left to save. Each later resume only adds to it - the first loss stays, and a loss outranks a save. A resume
 *  that owes no reload (Vite's socket held) ends it. */
let lostOnResume: 'disk' | 'gone' | null = null
let savedOnResume = false
/** The board save, while the resume's flushers run: what this tab held did not reach the disk (store.ts) - the page
 *  after the reload says what happened instead, never that the edits were saved. */
export function lostInResume(why: 'disk' | 'gone') { if (flushing) lostOnResume ??= why }
/** The board save, while the resume's flushers run: what this tab held reached the disk (store.ts). */
export function savedInResume() { if (flushing) savedOnResume = true }

const RESUMED = 'mv-resumed'
const keepers = new Set<() => Record<string, unknown>>()
/** What a resumed page carries over its own reload, read back by the next page (the canvas keeps its camera). */
export const keepOverResume = (fn: () => Record<string, unknown>) => { keepers.add(fn); return () => { keepers.delete(fn) } }
function keepOverReload(outcome: ResumeOutcome) {
  const rec: Record<string, unknown> = { at: Date.now(), outcome }
  for (const fn of keepers) { try { Object.assign(rec, fn()) } catch { /* the rest still goes */ } }
  try { sessionStorage.setItem(scoped(RESUMED), JSON.stringify(rec)) } catch { /* storage off: the page boots as any other */ }
}
const OUTCOMES: readonly ResumeOutcome[] = ['saved', 'disk', 'gone', null]
/** What the page before this one left when it reloaded itself on its canvas's return - this tab only, read once
 *  at load, and only a fresh one (a reload by hand later on boots as any other). `outcome`: what its save came to;
 *  the page says so. */
export const resumed: { outcome: ResumeOutcome; board?: string; camera?: { x: number; y: number; scale: number } } | null = (() => {
  if (!WS) return null
  try {
    const raw = sessionStorage.getItem(scoped(RESUMED))
    if (raw === null) return null
    sessionStorage.removeItem(scoped(RESUMED))
    const r = JSON.parse(raw)
    return r && typeof r.at === 'number' && Date.now() - r.at < 30_000 ? { ...r, outcome: OUTCOMES.includes(r.outcome) ? r.outcome : null } : null
  } catch { return null }
})()

// words a person typed into the page and has not sent (a comment, a Jam edit, a name): a reload would drop them
const typed = new WeakSet<EventTarget>()
const TEXT_FIELDS = 'textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=password]'
if (WS) {
  document.addEventListener('input', (e) => { if (e.target) typed.add(e.target); if (canvasStopped()) noteUnsaved(); workChanged() }, true)
  const typedWords = () => [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(TEXT_FIELDS)].some((el) => typed.has(el) && el.value.trim() !== '')
  holdsReload(typedWords)
  // and leaving the page asks first (spec 28 A2.9): the words are only here
  unsavedWhen('typing', typedWords)
}

// one question before this page goes, whatever it holds that the server does not have (unsaved.ts): a capture, a
// board edit, heights, words - in every browser, and the Mac app reads the same reasons
if (typeof window !== 'undefined') guardLeaving(window)

// Vite's client awaits every `vite:ws:disconnect` listener before it pings the server and reloads the
// page (vite/dist/client/client.mjs, Vite 8). This one never settles: the canvas page is never reloaded by
// Vite - not into another project that took the port, and not into this one's next run before it has
// saved what it holds - and its socket stays closed, so no other project's broadcast reaches it. It
// reloads itself in resume(). Frames keep Vite's own reload: their URLs name the workspace.
if (WS && import.meta.hot) import.meta.hot.on('vite:ws:disconnect', () => { hmrLost = true; lost('down'); return new Promise<never>(() => {}) })

// dev-only inspection hook for tests (never installed in published builds)
if (WS && import.meta.env.DEV) (window as unknown as { __mvLink: unknown }).__mvLink = useLink
