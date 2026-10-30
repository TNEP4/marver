/**
 * Live pictures (spec 28 A4.6 #31-#38): in the Mac app, a capture's picture of the play stage is the owner's screen as
 * they see it - an open menu, typed text, the pins on it - in place of the server's render. One logical picture per shot
 * (#33): the live one when the shot is eligible and it lands, else the render, as without the app (jam-capture.ts
 * `shoot`). Everywhere else - Chrome, a published canvas, an app without `capture` - nothing here runs.
 *
 * Eligible (#34), decided synchronously at the trigger, never cropped to fit: the app offers `capture`; the shot's frame
 * is the one playing; the stage document has shown it for `STAGE_SETTLE_MS` (its `__mvStage` record, past a slide's
 * tempo); the stage's whole rect is on screen below the scroll edge (`onScreen`, unchanged), at least `RING` px inside
 * the view (the Jam ring), and a 3 x 3 grid of `elementFromPoint` over it finds only the stage - its frame and its own
 * pins and cards, never a lane, a panel, the notes card or a menu. So fill and doc presets, edge to edge, take the
 * render; a device preset or a slide fitted to the window takes a live one.
 *
 * The ask binds what it was decided for - the frame, the theme, the rect, the view's size, the stage's `boot` and
 * `seq` - and the answer is checked against all of it again (#35): a reload, A -> B -> A, a resize or an overlay
 * opened meanwhile drops the bytes. Then the upload (`POST jam/picture/live`, the raw PNG), all under the caller's one
 * deadline.
 */
import { APP } from './marver-app.ts'
import { onScreen } from './inset.ts'
import { useStore } from './store.ts'
import { api } from './api.ts'
import type { StageRecord } from '../stage/main.tsx'

/** The stage has shown the frame this long: past the slide tempo (350 ms), so a transition is never pictured. */
export const STAGE_SETTLE_MS = 1000
/** The capture call and the upload together, at most; then the render (#36). */
export const LIVE_PICTURE_MS = 5000
/** The Jam ring's width at the view's edge (styles.css `.jm-edge`): the stage lies inside it. */
const RING = 6

const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''

/** What a live picture was decided for: the answer must find all of it as it was. */
export interface LiveAsk {
  frame: string
  theme: string
  /** the stage in view CSS px */
  rect: { x: number; y: number; width: number; height: number }
  view: { w: number; h: number }
  boot: string
  seq: number
}

const stageRecord = (stage: Element): StageRecord | null => {
  try {
    const r = (stage.querySelector('iframe')?.contentWindow as { __mvStage?: StageRecord } | null)?.__mvStage
    return r && typeof r.boot === 'string' && typeof r.seq === 'number' ? r : null
  } catch { return null }
}

/** Only the stage under a 3 x 3 grid over it: its frame, its own pins and cards. */
function clear(stage: Element, r: DOMRect): boolean {
  for (const fy of [1 / 6, 1 / 2, 5 / 6]) for (const fx of [1 / 6, 1 / 2, 5 / 6]) {
    const el = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy)
    if (!el || !stage.contains(el)) return false
  }
  return true
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.01

/** The ask for a live picture of `frame` now, or null: the shot takes the server's render (#34). */
export function liveAsk(frame: string): LiveAsk | null {
  if (typeof APP?.capture !== 'function') return null
  const play = useStore.getState().play
  if (!play || play.at !== frame) return null
  const stage = document.querySelector('.sh-play-stage')
  const dev = stage?.querySelector('.dev')
  if (!stage || !dev) return null
  const rec = stageRecord(stage)
  if (!rec || rec.at !== frame || Date.now() - rec.t < STAGE_SETTLE_MS) return null
  const r = dev.getBoundingClientRect()
  // its whole rect on screen, below the strip and its scroll edge: none of it cut
  const on = onScreen(r)
  if (!on || !near(on.left, r.left) || !near(on.top, r.top) || !near(on.right, r.right) || !near(on.bottom, r.bottom)) return null
  if (r.left < RING || r.top < RING || r.right > innerWidth - RING || r.bottom > innerHeight - RING) return null
  if (!clear(stage, r)) return null
  return { frame, theme: play.theme, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, view: { w: innerWidth, h: innerHeight }, boot: rec.boot, seq: rec.seq }
}

/** Is everything the ask was decided for still so? The same frame, theme, rect and view, the same stage document and
 *  showing, and the grid clear again (#35). */
export function stillHolds(a: LiveAsk): boolean {
  const b = liveAsk(a.frame)
  return !!b && b.theme === a.theme && b.boot === a.boot && b.seq === a.seq && b.view.w === a.view.w && b.view.h === a.view.h
    && near(b.rect.x, a.rect.x) && near(b.rect.y, a.rect.y) && near(b.rect.width, a.rect.width) && near(b.rect.height, a.rect.height)
}

/** `p`, or null once `signal` aborts (a capture call cannot be cancelled: its late answer is dropped). */
const until = <T>(p: Promise<T>, signal: AbortSignal): Promise<T | null> => new Promise((done) => {
  if (signal.aborted) return done(null)
  signal.addEventListener('abort', () => done(null), { once: true })
  p.then(done, () => done(null))
})

/**
 * The live picture for a shot of `capture`: the app's readback of the stage, checked again against the ask, then
 * uploaded - its picture id, or null and the shot takes the render. `open()`: the capture is still unsealed. Every step
 * stops at `signal` (the caller's one deadline over the call and the upload).
 */
export async function takeLive(a: LiveAsk, capture: string, open: () => boolean, signal: AbortSignal): Promise<string | null> {
  try {
    const app = APP
    if (!app?.capture) return null
    const answer = await until(app.capture({ rect: a.rect }), signal)
    if (!answer || !answer.ok || !(answer.png instanceof Uint8Array) || !answer.png.length) return null
    if (signal.aborted || !open() || !stillHolds(a)) return null
    const r = await api(`jam/picture/live?capture=${encodeURIComponent(capture)}&frame=${encodeURIComponent(a.frame)}`, {
      method: 'POST', signal, headers: { 'content-type': 'image/png', 'x-mv-c': csrf() }, body: answer.png as Uint8Array<ArrayBuffer>,
    })
    if (!r.ok || signal.aborted) return null
    const id = ((await r.json()) as { id?: unknown })?.id
    return typeof id === 'string' && /^p-[0-9a-f]{16}$/.test(id) && !signal.aborted ? id : null
  } catch { return null }
}
