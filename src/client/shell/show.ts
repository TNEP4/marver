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
import { bootLanded } from './canvas/ctl.ts'
import { openThreadAt } from './jam-keys.ts'
import { isLatest, navigated, navNow, revealFrame, switchFor } from './goto.ts'
import { linkTargets } from './hash.ts'
import { useJamCapture } from './jam-capture.ts'
import { APP } from './marver-app.ts'
import { PAGE_ID } from './recorder.ts'
import { boardLabel, landingBoard, sceneLabel, useStore } from './store.ts'

export type ShowFrom = 'server' | 'app'
export type ShowResult = 'shown' | 'notice' | 'stale' | 'missing' | 'bad'

/** The notice a tab holding unsent words puts up instead of moving: its words, and the target Go opens. */
export interface ShowNotice { title: string; target: ShowTarget | 'landing'; at: number }
export const useShowNotice = create<{ notice: ShowNotice | null }>(() => ({ notice: null }))

/** Words a move would lose, or a capture it would cut: the same reasons a notice's click reads (open-item.ts). */
const holdsWords = (): boolean => typedUnsent() || !!useJamCapture.getState().current

/** The shell's boot - the board and its camera restored from the URL (App.tsx) - is done: shows go from now. A show
 *  that comes earlier (the app delivers a link's place after the page's hello, before its first render) waits for it,
 *  so the boot's own navigation never lands over it, and it never resolves against a board not loaded yet. */
let bootDone: () => void = () => {}
const booted = new Promise<void>((r) => { bootDone = r })
export function showsMayGo(): void { bootDone() }

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

/** The words the notice says for the canvas's own board (a link that named no place it understands). */
const LANDING = 'the board this canvas opens on'

/**
 * Move to the target now - board, selection, thread, camera - each step only while this command is the newest and,
 * unless the person chose it (`force`: the notice's Go), while no words wait unsent: words typed while the board loads
 * stop it before anything moves (`blocked`, which the caller turns into the notice). `shown` only once the camera has
 * landed for this command: a newer show, or a board that went, is never counted shown.
 */
async function go(t: ShowTarget | 'landing', n: number, force: boolean): Promise<ShowResult | 'blocked'> {
  const nav = navigated()
  const owned = () => n === current && isLatest(nav)
  const words = () => !force && holdsWords()
  const alive = () => owned() && !words()
  const ended = (): 'blocked' | 'stale' => (owned() && words() ? 'blocked' : 'stale')
  if (!alive()) return ended()
  let target: ShowTarget
  if (t === 'landing') {
    const board = await landingBoard()
    if (!alive()) return ended()
    target = { board }
  } else target = t
  let s = useStore.getState()
  if (s.play) s.setPlay(null)   // a stale overlay never survives a show
  if (target.board !== s.board) {
    if (!await switchFor(target.board, nav, alive)) return alive() ? 'missing' : ended()
    s = useStore.getState()
  }
  if (!alive()) return ended()
  const keys = linkTargets(target, s.nodes)
  useStore.setState({ selection: keys })
  s.look(keys)
  if (target.c) {
    // the thread where it can be seen - pins turned on, a resolved one in its panel - under the same request, and
    // waited for: a thread that never shows is no "shown"
    if (!await openThreadAt(target.board, target.c, { alive })) return alive() ? 'missing' : ended()
    return (await fitOwn(alive)) ? 'shown' : ended()
  }
  if (!keys.length && target.f?.length) {
    // not on this board's nodes: where it lives, under the same request - shown once it is selected there and the
    // camera has landed, for this command
    const f = target.f[0]!
    await revealFrame(f, nav, alive)
    for (let i = 0; i < 40 && alive(); i++) {
      const now = useStore.getState()
      if (now.selection.some((k) => now.nodes.find((x) => x.key === k)?.frame === f)) return (await fitOwn(alive)) ? 'shown' : ended()
      await new Promise((r) => setTimeout(r, 50))
    }
    return alive() ? 'missing' : ended()
  }
  // the refit, even when the place is already on screen - unless a newer navigation has the camera by then (a frame's
  // worth for the selection to draw; none in a background tab, whose timers run once a second)
  if (document.visibilityState !== 'hidden') await new Promise((r) => setTimeout(r, 60))
  if (!alive()) return ended()
  if (keys.length) canvasCtl.fitNodes(keys); else canvasCtl.fitAll()
  return (await cameraLanded(alive)) ? 'shown' : ended()
}

/** The show's own fit to what the helper selected (revealFrame's and revealThread's fits run on their timers, which a
 *  newer show may cancel): this command's camera, then its landing - in a background tab at once. */
async function fitOwn(alive: () => boolean): Promise<boolean> {
  if (!alive()) return false
  const sel = useStore.getState().selection
  if (sel.length) canvasCtl.fitNodes([...sel])
  return cameraLanded(alive)
}

/** The camera came to rest (the commands' own rule, commands.ts `cameraDone`: it flew and stopped, or rested 250 ms),
 *  while `alive` held throughout - a newer navigation or words typed meanwhile is no landing. A tab in the background
 *  lands its camera at once (Canvas.tsx `fly`), and is timed here without frames. 2 s at most, so `marver show`'s 3 s
 *  hear every tab; a camera still flying then has not landed - no "shown". */
async function cameraLanded(alive: () => boolean): Promise<boolean> {
  const since = performance.now()
  let saw = false
  // a background tab's fit landed synchronously (Canvas.tsx fly): verified now, no polling its throttled timers
  if (document.visibilityState === 'hidden') return alive() && !canvasCtl.cameraBusy()
  for (let n = 1; performance.now() - since < 2000; n++) {
    // a frame, or 50 ms where none come (a tab in the background)
    await new Promise((r) => { const late = setTimeout(r, 50); requestAnimationFrame(() => { clearTimeout(late); r(null) }) })
    if (!alive()) return false
    const busy = canvasCtl.cameraBusy()
    if (busy) saw = true
    if (!busy && (saw || performance.now() - since > 250) && n >= 2) return true
  }
  return false
}

const ack = (seq: number, outcome: 'shown' | 'notice') => {
  const c = /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
  void api('show/ack', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': c }, body: JSON.stringify({ seq, page: PAGE_ID, outcome }) }).catch(() => {})
}

/** The tab to the front of the app's window (a server show): main checks the asking document and acts. */
const front = () => { try { APP?.front?.() } catch { /* the app went away under the page */ } }

/**
 * A show command, from the dev server (`seq`) or the app's bridge. The app's `null` is a link that named no place this
 * shell takes: the canvas's own board, by the same rule (moved to, or the notice over unsent words).
 */
export async function showTarget(raw: unknown, from: ShowFrom): Promise<ShowResult> {
  const seq = from === 'server' ? (raw as { seq?: unknown } | null)?.seq : undefined
  if (from === 'server' && (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1)) return 'bad'
  const t: ShowTarget | 'landing' | null = from === 'app' && raw === null ? 'landing' : checkShowTarget(raw)
  if (!t) return 'bad'
  if (typeof seq === 'number') {
    if (seq <= lastSeq) return 'stale'
    lastSeq = seq
  }
  const n = ++current
  const notice = (): ShowResult => {
    useShowNotice.setState({ notice: { title: t === 'landing' ? LANDING : titleOf(t), target: t, at: Date.now() } })
    if (typeof seq === 'number') ack(seq, 'notice')
    if (from === 'server') front()
    return 'notice'
  }
  await booted
  // the boot's own navigation is done; a person's from here on is newer than this show
  const before = navNow()
  // the board's first camera applied (Canvas.tsx), so the boot never lands over the show - a board with no nodes has
  // none to wait for, and a second at most whatever happens
  if (useStore.getState().nodes.length) await Promise.race([bootLanded, new Promise((r) => setTimeout(r, 1500))])
  if (n !== current || !isLatest(before)) return 'stale'
  if (holdsWords()) return notice()
  useShowNotice.setState({ notice: null })
  const r = await go(t, n, false)
  // words typed while it was on its way: the notice instead, nothing moved
  if (r === 'blocked') return n === current ? notice() : 'stale'
  // answered, and the window brought forward, once it is on screen: a newer show or a board that went is no "shown"
  if (r === 'shown') {
    if (typeof seq === 'number') ack(seq, 'shown')
    if (from === 'server') front()
  }
  return r
}

/** The notice's Go: the human chose to move, words or not. */
export async function goNow(): Promise<ShowResult> {
  const notice = useShowNotice.getState().notice
  useShowNotice.setState({ notice: null })
  if (!notice) return 'stale'
  const r = await go(notice.target, ++current, true)
  return r === 'blocked' ? 'stale' : r
}
export const dismissShow = (): void => { useShowNotice.setState({ notice: null }) }

/** A server seq the page knows (tests read where it stands). */
export const showState = () => ({ current, lastSeq })

// dev-only inspection hook for tests (never installed in published builds)
if (typeof window !== 'undefined' && import.meta.env.DEV) (window as unknown as { __mvShow: unknown }).__mvShow = { showTarget, goNow, dismissShow, state: showState, notice: () => useShowNotice.getState().notice }
