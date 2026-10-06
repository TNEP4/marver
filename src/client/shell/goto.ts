/**
 * `goto:` navigation, one path for every caller: a frame's data-goto (sh:go from the bridge)
 * and a sticky note's link (shell DOM, spec 18). On this board: select and fit. Elsewhere: follow
 * the frame home (below). Never edits a board unless no board pins the target.
 */
import { boardFrames, fetchBoardNames, useStore } from './store.ts'
import { canvasCtl } from './canvas/ctl.ts'

/** Navigate to a frame id. `carry` keeps interact mode across the hop (a link inside an
 *  interacting frame walks a flow - it must not eject you to design mode). */
export function goTo(target: string, carry = false): void {
  const s = useStore.getState()
  const existing = s.nodes.find((n) => n.frame === target && !n.missing)
  if (existing) {
    gotoSeq++                                  // a local goto supersedes any cross-board one in flight
    s.select(existing.key)
    if (carry) s.setInteract(existing.key)
    setTimeout(() => canvasCtl.fitNode(existing.key), 50)
  } else void gotoAcrossBoards(target, carry)
}

/** A data-goto whose target frame is not on the current board follows the frame HOME:
 *  the first curated board (switcher rank) that pins it is switched to and the frame
 *  focused there - a link is navigation, and navigation never edits a board. Only a
 *  frame NO board pins spawns onto the current board (the original prototype behavior
 *  for unpinned targets); an id the manifest doesn't know stays a toast. Every goto
 *  bumps `gotoSeq` so a slow older resolution can never override newer navigation. */
let gotoSeq = 0
async function gotoAcrossBoards(target: string, carry: boolean) {
  const s = useStore.getState()
  // an id the manifest doesn't know resolves NOWHERE - a tombstone pin on some board
  // must not send us on a trip that ends in a silent timeout
  if (!s.manifest?.frames.some((f) => f.id === target)) return s.toast(`unknown goto target "${target}"`)
  const seq = ++gotoSeq
  let home: string | null = null
  try {
    const names = (await fetchBoardNames()).filter((n) => n !== s.board && n !== 'all-scenes')
    for (const name of names) {
      if ((await boardFrames(name)).includes(target)) { home = name; break }
    }
  } catch {
    // a transport failure is NOT proof the frame is unpinned - spawning here would
    // recreate the board mutation this function exists to prevent
    return useStore.getState().toast(`goto: could not read the boards - try again`)
  }
  if (seq !== gotoSeq) return                        // superseded by newer navigation
  if (!home) {
    // no curated board pins it - the original prototype behavior: spawn beside you
    const st = useStore.getState()
    const node = st.spawn(target)
    if (!node) return st.toast(`unknown goto target "${target}"`)
    st.select(node.key)
    if (carry) st.setInteract(node.key)
    setTimeout(() => canvasCtl.fitNode(node.key), 50)
    return
  }
  await landOn(home, target, carry, seq)
}

/** Switch to `home` and select + fit `target` there once the board commits. */
async function landOn(home: string, target: string, carry: boolean, seq: number) {
  await useStore.getState().switchBoard(home)
  for (let i = 0; i < 12; i++) {                     // the board commits async - retry like viewNote
    if (seq !== gotoSeq) return
    const st = useStore.getState()
    if (st.board === home) {                         // a cancelled/failed switch must not select here
      const node = st.nodes.find((n) => n.frame === target && !n.missing)
      if (node) {
        st.select(node.key)
        if (carry) st.setInteract(node.key)
        setTimeout(() => canvasCtl.fitNode(node.key), 50)
        return
      }
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** Show a frame where it lives, for a LINK (a pasted canvas link naming a frame the board does
 *  not show, the way back from a focus link): this board, else the first curated board that pins
 *  it, else the auto board that holds every frame. Unlike a goto it never spawns - opening a link
 *  must not edit a board. */
export async function revealFrame(target: string): Promise<void> {
  const s = useStore.getState()
  const here = s.nodes.find((n) => n.frame === target && !n.missing)
  if (here) {
    gotoSeq++
    s.select(here.key)
    setTimeout(() => canvasCtl.fitNode(here.key), 50)
    return
  }
  if (!s.manifest?.frames.some((f) => f.id === target)) return s.toast(`no frame "${target}" on this canvas`)
  const seq = ++gotoSeq
  let home: string | null = null
  try {
    const all = await fetchBoardNames()
    for (const name of all.filter((n) => n !== s.board && n !== 'all-scenes')) {
      if ((await boardFrames(name)).includes(target)) { home = name; break }
    }
    if (!home && all.includes('all-scenes')) home = 'all-scenes'
  } catch {
    return useStore.getState().toast(`could not read the boards - try again`)
  }
  if (seq !== gotoSeq) return
  if (!home) return useStore.getState().toast(`"${target}" is not on any board`)
  await landOn(home, target, false, seq)
}
