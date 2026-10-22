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
/** `shown`: the "This canvas stopped" banner is up. */
export const useLink = create<{ link: Link; shown: boolean }>(() => ({ link: 'live', shown: false }))
/** Nothing leaves the page: its canvas is gone from here, or not known to be back yet. */
export const canvasStopped = () => { const l = useLink.getState().link; return l === 'checking' || l === 'down' || l === 'elsewhere' }
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
  })
}
/** A request under /__mv/api/: `api('boards/main', { method: 'PUT', ... })`. */
export const api = (path: string, init?: RequestInit) => mvFetch(`${ROUTE}/api/${path}`, init)

// ---- the link: losing the canvas, and getting it back --------------------------------------------------

/** What must happen before a resumed page reloads (the board save, the heights; no capture recording).
 *  Each answers true when the page may reload now. */
const flushers = new Set<() => Promise<boolean>>()
export const beforeResume = (fn: () => Promise<boolean>) => { flushers.add(fn); return () => { flushers.delete(fn) } }
/** Told when a resumed page stays (a flusher said no): the store's toast, registered by store.ts. */
let say: (text: string) => void = () => {}
export const onLinkNotice = (fn: (text: string) => void) => { say = fn }

let hmrLost = false
let probeTimer: ReturnType<typeof setTimeout> | null = null

function lost(why: 'down' | 'elsewhere') {
  if (why === 'elsewhere') useLink.setState({ link: 'elsewhere', shown: true })
  else if (!canvasStopped()) useLink.setState({ link: 'checking' })
  probeTimer ??= setTimeout(probe, 0)
}

/** Once a second while stopped: is this canvas back on this address? */
async function probe() {
  let r: Response | null = null
  try { r = await fetch(`${ROUTE}/api/hello`, { headers: { 'x-mv-ws': WS }, cache: 'no-store' }) } catch { r = null }
  const ours = !!r?.ok && (await r.json().catch(() => null))?.ws === WS
  probeTimer = null
  if (ours) return void resume()
  // another canvas answers, or nothing does, or something that is not a canvas of this one (an older
  // marver says 404): the banner - and keep asking
  useLink.setState({ link: r?.status === 409 && r.headers.get('x-mv-elsewhere') === '1' ? 'elsewhere' : 'down', shown: true })
  probeTimer = setTimeout(probe, 1000)
}

async function resume() {
  useLink.setState({ link: 'resuming' })        // requests flow again: the flushers use them
  let ok = true
  for (const fn of flushers) ok = (await fn().catch(() => false)) && ok
  if (useLink.getState().link !== 'resuming') return   // lost again while saving: the probe goes on
  // a fresh document on the canvas that answered: live updates again (Vite's own reload, a moment later)
  if (hmrLost && ok) return void location.reload()
  useLink.setState({ link: 'live', shown: false })
  if (hmrLost) say('marver dev is back - reload this page when you are ready')
}

// Vite's client awaits every `vite:ws:disconnect` listener before it pings the server and reloads the
// page (vite/dist/client/client.mjs, Vite 8). This one never settles: the canvas page is never reloaded by
// Vite - not into another project that took the port, and not into this one's next run before it has
// saved what it holds - and its socket stays closed, so no other project's broadcast reaches it. It
// reloads itself in resume(). Frames keep Vite's own reload: their URLs name the workspace.
if (WS && import.meta.hot) import.meta.hot.on('vite:ws:disconnect', () => { hmrLost = true; lost('down'); return new Promise<never>(() => {}) })

// dev-only inspection hook for tests (never installed in published builds)
if (WS && import.meta.env.DEV) (window as unknown as { __mvLink: unknown }).__mvLink = useLink
