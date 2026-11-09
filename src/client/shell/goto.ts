/**
 * `goto:` navigation, one path for every caller: a frame's data-goto (sh:go from the bridge)
 * and a sticky note's link (shell DOM, spec 18). On this board: select and fit. Elsewhere: follow
 * the frame home (below). Never edits a board unless no board pins the target.
 */
import { fetchMembership, useStore } from './store.ts'
import { UNPLACED } from './hash.ts'
import { canvasCtl } from './canvas/ctl.ts'
import { endOnCamera, endOnLoad, type CmdHandle } from './commands.ts'

/** Navigate to a frame id. `carry` keeps interact mode across the hop (a link inside an
 *  interacting frame walks a flow - it must not eject you to design mode). */
export function goTo(target: string, carry = false, h?: CmdHandle): void {
  const s = useStore.getState()
  const existing = s.nodes.find((n) => n.frame === target && !n.missing)
  if (existing) {
    const seq = navigated()                    // a local goto supersedes any cross-board one in flight
    s.select(existing.key)
    if (carry) s.setInteract(existing.key)
    fitLater(existing.key, seq)
    if (h) endOnCamera(h)                      // the recorder's (spec 30): the camera lands
  } else void gotoAcrossBoards(target, carry, h)
}

/** A data-goto whose target frame is not on the current board follows the frame HOME:
 *  the first curated board (switcher rank) that pins it is switched to and the frame
 *  focused there - a link is navigation, and navigation never edits a board. Only a
 *  frame NO board pins spawns onto the current board (the original prototype behavior
 *  for unpinned targets); an id the manifest doesn't know stays a toast. Every goto
 *  bumps `gotoSeq` so a slow older resolution can never override newer navigation. */
let gotoSeq = 0
async function gotoAcrossBoards(target: string, carry: boolean, h?: CmdHandle) {
  const s = useStore.getState()
  const from = s.board
  // an id the manifest doesn't know resolves NOWHERE - a tombstone pin on some board
  // must not send us on a trip that ends in a silent timeout
  if (!s.manifest?.frames.some((f) => f.id === target)) { h?.fail('no-target'); return s.toast(`unknown goto target "${target}"`) }
  const seq = navigated()
  let home: string | null = null
  try {
    home = (await fetchMembership()).boards.find((b) => b.name !== s.board && b.frames.includes(target))?.name ?? null
  } catch {
    // a transport failure is NOT proof the frame is unpinned - spawning here would
    // recreate the board mutation this function exists to prevent
    h?.fail('no-target')
    return useStore.getState().toast(`goto: could not read the boards - try again`)
  }
  if (seq !== gotoSeq) { h?.cancel('superseded'); return }   // superseded by newer navigation
  if (!home) {
    // no curated board pins it - the original prototype behavior: spawn beside you
    const st = useStore.getState()
    const node = st.spawn(target)
    if (!node) { h?.fail('no-target'); return st.toast(`unknown goto target "${target}"`) }
    st.select(node.key)
    if (carry) st.setInteract(node.key)
    fitLater(node.key, seq)
    if (h) endOnCamera(h)
    return
  }
  if (h) endOnLoad(h, home, 'visible')               // the recorder's (spec 30): the target board's `visible`
  await landOn(home, target, carry, seq, from)
}

/** Navigation supersedes any goto or reveal still on its way - its board lookup (gotoSeq) AND a board
 *  switch it already started (a switch to the board on screen cancels any pending one: store.ts) - so
 *  a slow lookup can never yank the view away from where the human has gone since. Every entry point
 *  calls it, the published shell's too: a pasted link, back/forward, a goto, a reveal, a board picked in
 *  the sidebar or the play pill, a notification's View - and switches boards only through switchFor. */
export function navigated(): number {
  const s = useStore.getState()
  if (s.board) void s.switchBoard(s.board)
  return ++gotoSeq
}
/**
 * A person acted on the canvas or its camera themselves - a frame, a badge or a comment stack clicked, ⌘A, Escape, a pan,
 * a zoom, a fit or zoom key, the zoom menu, a notification's View (spec 31 D3): a `marver show` or an app link still on
 * its way gives way, its board never committed over what they did (show.ts reads `handNow`). Its own counter, apart
 * from the navigation number: nothing the person started themselves - a board switch, its fit - is cancelled by it.
 * Programmatic selection and fits (the show's own) never call it, so a show never cancels itself.
 *
 * Accepted limits for this release: a click or Escape inside a frame the person is interacting with arrives as a message
 * (`sh:frame-down`, `sh:exit-interact`) and is not counted - a show still loading then lands over it; and a frame's own
 * script that synthesizes keys is forwarded and counted like the person's - a show still loading then does not land,
 * and nothing else changes.
 */
let handSeq = 0
export function navigatedByHand(): void { ++handSeq }
export const handNow = (): number => handSeq

const TEXT = 'textarea, input, select, [contenteditable=""], [contenteditable="true"]'
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'])
/**
 * Every input the person makes in the shell counts (spec 31 D3) - a pointer pressed, a key, a wheel - so no handler can
 * be missed: a device preset, a Jam tile, Play and back, a toolbar button. Not words typed into a field (they make a
 * show the notice instead, show.ts) nor a modifier key alone; never a synthetic event (`isTrusted`). Input inside a
 * frame's own document never reaches here: its wheel is forwarded and counted by the canvas (Canvas.tsx beginGesture),
 * a click on its node by FrameNode, a key it forwards (`sh:key`, the stage's `sh:stage-key`) where the shell takes it;
 * the app menu's items replay their key untrusted and count at their relay (app-bridge.ts runMenuItem). Installed once
 * by App.tsx; answers what removes it.
 */
export function watchHands(target: Window = window): () => void {
  const inText = (e: Event) => { const t = e.target as Element | null; return !!t?.closest?.(TEXT) }
  const press = (e: PointerEvent) => { if (e.isTrusted && !inText(e)) navigatedByHand() }
  // a key held down repeats: one choice, counted once (a held Enter on the show notice's Go never cancels the Go)
  const key = (e: KeyboardEvent) => { if (e.isTrusted && !e.repeat && !MODIFIERS.has(e.key) && !inText(e)) navigatedByHand() }
  const wheel = (e: WheelEvent) => { if (e.isTrusted) navigatedByHand() }
  target.addEventListener('pointerdown', press, true)
  target.addEventListener('keydown', key, true)
  target.addEventListener('wheel', wheel, { capture: true, passive: true })
  return () => {
    target.removeEventListener('pointerdown', press, true)
    target.removeEventListener('keydown', key, true)
    target.removeEventListener('wheel', wheel, { capture: true })
  }
}
/** The navigation now, without starting one: a caller that waits (`marver show` for the boot) reads it first, and
 *  gives way if a person navigated meanwhile (`isLatest`). */
export const navNow = (): number => gotoSeq
/** Is this still the latest navigation - nothing newer since `navigated()` handed it out? */
export const isLatest = (seq: number): boolean => seq === gotoSeq
/** The one way a navigation changes boards - a link, a goto, a reveal, a board picked in the sidebar or the play pill, a
 *  notification's View: the switch is navigation `nav`'s (a new one, unless the caller took it at its own start, before
 *  a lookup), and true only once it landed with nothing newer since. What the caller does on the board - select, set a
 *  mode, enter play, move the camera - waits for true: a switch a newer navigation cancelled comes back too, and may
 *  find the board it asked for, the newer one's by then. `mayCommit`: the caller's own condition, read just before the
 *  board commits - false keeps the board shown (a notice's request, jam-keys.ts toBoard). */
export async function switchFor(board: string, nav: number = navigated(), mayCommit?: () => boolean): Promise<boolean> {
  await useStore.getState().switchBoard(board, mayCommit)
  return isLatest(nav) && useStore.getState().board === board
}
/** The camera to a node once it is drawn - unless a newer navigation has it by then. */
const fitLater = (key: string, seq: number, mayCommit?: () => boolean) => setTimeout(() => { if (isLatest(seq) && (!mayCommit || mayCommit())) canvasCtl.fitNode(key) }, 50)

/** Switch to `home` and select + fit `target` there once the board commits - unless the human has
 *  moved on: newer navigation, or a board they switched to themselves while the lookup ran. */
async function landOn(home: string, target: string, carry: boolean, seq: number, from: string, mayCommit?: () => boolean) {
  if (seq !== gotoSeq || useStore.getState().board !== from) return
  if (!await switchFor(home, seq, mayCommit)) return
  for (let i = 0; i < 12; i++) {                     // the board commits async - retry like viewNote
    if (seq !== gotoSeq || (mayCommit && !mayCommit())) return
    const st = useStore.getState()
    if (st.board === home) {                         // a cancelled/failed switch must not select here
      const node = st.nodes.find((n) => n.frame === target && !n.missing)
      if (node) {
        st.select(node.key)
        if (carry) st.setInteract(node.key)
        fitLater(node.key, seq, mayCommit)
        return
      }
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** Show a frame where it lives, for a LINK (a pasted canvas link naming a frame the board does
 *  not show, the way back from a focus link): this board, else the first board that shows it
 *  (archive boards last), else - a frame on no board - the Not on a board view. Unlike a goto it
 *  never spawns - opening a link must not edit a board. */
export async function revealFrame(target: string, nav?: number, mayCommit?: () => boolean): Promise<void> {   // `nav`: a caller's navigation, else its own; `mayCommit`: its own condition, read before the board commits and before it selects (`marver show`'s: no words typed meanwhile)
  const s = useStore.getState()
  if (mayCommit && !mayCommit()) return
  const here = s.nodes.find((n) => n.frame === target && !n.missing)
  if (here) {
    const seq = nav ?? navigated()
    s.select(here.key)
    fitLater(here.key, seq, mayCommit)
    return
  }
  if (!s.manifest?.frames.some((f) => f.id === target)) return s.toast(`no frame "${target}" on this canvas`)
  const seq = nav ?? navigated()
  const from = s.board
  let home: string | null = null
  try {
    const m = await fetchMembership()
    home = m.boards.find((b) => b.name !== s.board && b.frames.includes(target))?.name ?? (m.unplaced.includes(target) && s.board !== UNPLACED ? UNPLACED : null)
  } catch {
    return useStore.getState().toast(`could not read the boards - try again`)
  }
  if (seq !== gotoSeq || (mayCommit && !mayCommit())) return
  if (!home) return useStore.getState().toast(`"${target}" is not on any board`)
  await landOn(home, target, false, seq, from, mayCommit)
}
