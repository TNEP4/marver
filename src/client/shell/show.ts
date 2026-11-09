/**
 * Showing the human a place (spec 31 D1, D3): `marver show`'s `sh:show { seq, board, n?, f?, s?, c? }` from the dev
 * server, and in the Mac app the same command over the bridge (`onShow`) for a `marver://` link into a tab already
 * open. One rule for both:
 *
 * - the command is checked again (shared/deep-link.ts `checkShowTarget`) - the hash's own targets, never a raw hash;
 * - a tab holding unsent words (a comment draft, a Jam edit: api.ts `typedUnsent`) or a capture recording does not move:
 *   it puts up "Your agent wants to show you <title> · Go", and Go moves it when the human chooses;
 * - else it switches board, selects (node keys stay node keys - one copy of a frame, never every copy), opens the
 *   thread, and fits - even when it is already there: a repeat refits;
 * - a newer command supersedes an older one still on its way (a board read, a fit), and a server seq it already took is
 *   never taken twice;
 * - in the app, a server show then asks the main process (`front()`, a trusted bridge call bound to the admitted
 *   document) to activate its tab and bring the window forward; a bridge show was activated by main already;
 * - a server show is answered (`POST show/ack { seq, page, outcome }`), so `marver show` can say "shown in 2 tabs".
 */
import { create } from 'zustand'
import { checkShowTarget, type ShowTarget } from '../../shared/deep-link.ts'
import { api, typedUnsent } from './api.ts'
import { canvasCtl } from './canvas/Canvas.tsx'
import { parkThread, revealThread } from './Comments.tsx'
import { isLatest, navigated, revealFrame, switchFor } from './goto.ts'
import { linkTargets } from './hash.ts'
import { useJamCapture } from './jam-capture.ts'
import { APP } from './marver-app.ts'
import { PAGE_ID } from './recorder.ts'
import { boardLabel, sceneLabel, useStore } from './store.ts'

export type ShowFrom = 'server' | 'app'
export type ShowResult = 'shown' | 'notice' | 'stale' | 'missing' | 'bad'

/** The notice a tab holding unsent words puts up instead of moving: its words, and the target Go opens. */
export interface ShowNotice { title: string; target: ShowTarget; at: number }
export const useShowNotice = create<{ notice: ShowNotice | null }>(() => ({ notice: null }))

/** Words a move would lose, or a capture it would cut: the same reasons a notice's click reads (open-item.ts). */
const holdsWords = (): boolean => typedUnsent() || !!useJamCapture.getState().current

/** The newest command's number: an older one still on its way stops at its next step. */
let current = 0
/** The last server seq this page took: the same one again (a reconnect's replay) is never taken twice. */
let lastSeq = 0

/** What the notice calls the place: one frame by its title, one scene by its label, else the board. */
export function titleOf(t: ShowTarget): string {
  const s = useStore.getState()
  const frames = t.f ?? []
  if (frames.length === 1 && !t.s?.length && !t.n?.length) {
    const f = s.manifest?.frames.find((x) => x.id === frames[0])
    return f?.title || frames[0]!
  }
  if (t.s?.length === 1 && !frames.length && !t.n?.length) return sceneLabel(t.s[0]!)
  return boardLabel(t.board)
}

/** Move to the target now: board, selection, thread, camera - each step only while this command is the newest. */
async function go(t: ShowTarget, n: number): Promise<ShowResult> {
  const nav = navigated()
  const alive = () => n === current && isLatest(nav)
  let s = useStore.getState()
  if (s.play) s.setPlay(null)   // a stale overlay never survives a show
  if (t.board !== s.board) {
    if (!await switchFor(t.board, nav, alive)) return alive() ? 'missing' : 'stale'
    s = useStore.getState()
  }
  if (!alive()) return 'stale'
  const keys = linkTargets(t, s.nodes)
  useStore.setState({ selection: keys })
  s.look(keys)
  if (t.c && !revealThread(t.c)) parkThread(t.c)
  if (!keys.length && t.f?.length) void revealFrame(t.f[0]!, nav)   // not on this board's nodes: where it lives
  // the refit, even when the place is already on screen - unless a newer navigation has the camera by then
  else setTimeout(() => { if (alive()) (keys.length ? canvasCtl.fitNodes(keys) : canvasCtl.fitAll()) }, 60)
  return 'shown'
}

const ack = (seq: number, outcome: 'shown' | 'notice') => {
  const c = /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
  void api('show/ack', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': c }, body: JSON.stringify({ seq, page: PAGE_ID, outcome }) }).catch(() => {})
}

/** The tab to the front of the app's window (a server show): main checks the asking document and acts. */
const front = () => { try { APP?.front?.() } catch { /* the app went away under the page */ } }

/** A show command, from the dev server (`seq`) or the app's bridge. */
export async function showTarget(raw: unknown, from: ShowFrom): Promise<ShowResult> {
  const seq = from === 'server' ? (raw as { seq?: unknown } | null)?.seq : undefined
  if (from === 'server' && (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1)) return 'bad'
  const t = checkShowTarget(raw)
  if (!t) return 'bad'
  if (typeof seq === 'number') {
    if (seq <= lastSeq) return 'stale'
    lastSeq = seq
  }
  const n = ++current
  if (holdsWords()) {
    useShowNotice.setState({ notice: { title: titleOf(t), target: t, at: Date.now() } })
    if (typeof seq === 'number') ack(seq, 'notice')
    if (from === 'server') front()
    return 'notice'
  }
  useShowNotice.setState({ notice: null })
  if (from === 'server') front()
  const r = await go(t, n)
  // answered once it is on screen: a board that went, or a newer show that took over, is no "shown"
  if (typeof seq === 'number' && r === 'shown') ack(seq, 'shown')
  return r
}

/** The notice's Go: the human chose to move, words or not. */
export function goNow(): Promise<ShowResult> {
  const notice = useShowNotice.getState().notice
  useShowNotice.setState({ notice: null })
  if (!notice) return Promise.resolve('stale')
  return go(notice.target, ++current)
}
export const dismissShow = (): void => { useShowNotice.setState({ notice: null }) }

/** A server seq the page knows (tests read where it stands). */
export const showState = () => ({ current, lastSeq })

// dev-only inspection hook for tests (never installed in published builds)
if (typeof window !== 'undefined' && import.meta.env.DEV) (window as unknown as { __mvShow: unknown }).__mvShow = { showTarget, goNow, dismissShow, state: showState, notice: () => useShowNotice.getState().notice }
