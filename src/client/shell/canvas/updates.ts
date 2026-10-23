/**
 * Calm updates, the shell's half (spec 26 Part 2): a node an edit made stale reloads through the
 * same boot queue a board uses (admission.ts) - at most four at a time, the one nearest the centre
 * of the view first - and only while it is on screen (or within half a screen of it) and not in use.
 * Further off it waits until it comes near; in use (interact, a drag, laser or comment on it) it waits for a safe point; while
 * the play stage covers the canvas, the canvas counts as off screen. A job checks all of that again
 * when its turn comes.
 */
import { admit, release } from './admission.ts'
import { canvasCtl } from './ctl.ts'
import { frameIsLeased, useStore, type Node } from '../store.ts'

const rect = (key: string) => document.querySelector(`[data-node="${CSS.escape(key)}"]`)?.getBoundingClientRect()
const view = () => document.querySelector('.sh-canvas')?.getBoundingClientRect()

/** On screen at any zoom - or within half a screen of it, so a small pan shows fresh frames and a
 *  camera still moving between two places does not starve the frames on its way. */
function onScreen(key: string): boolean {
  const r = rect(key), c = view()
  if (!r || !c) return false
  const mx = c.width / 2, my = c.height / 2
  return r.right > c.left - mx && r.left < c.right + mx && r.bottom > c.top - my && r.top < c.bottom + my
}
const rank = (key: string) => () => {
  const now = rect(key), c = view(), r = now && canvasCtl.landing(now)   // where it will be once a camera flight lands
  return r && c ? Math.hypot(r.x + r.width / 2 - c.x - c.width / 2, r.y + r.height / 2 - c.y - c.height / 2) : Infinity
}

const ready = (n: Node) => {
  const s = useStore.getState()
  // a document to replace (ready, or errored), never one still booting for the first time
  return !!n.stale && !n.missing && (n.status === 'ready' || n.status === 'error') && !s.play && !frameIsLeased(n.frame, s) && onScreen(n.key)
}

let ticker: ReturnType<typeof setInterval> | undefined

/** Give every stale node that may reload now a place in the queue. Stale nodes off screen are looked
 *  at again on a slow tick (a pan or a zoom brings them in), stopped once none is left. */
export function pumpUpdates(): void {
  const s = useStore.getState()
  const stale = s.nodes.filter((n) => n.stale && !n.missing)
  if (!stale.length) { clearInterval(ticker); ticker = undefined; return }
  ticker ??= setInterval(pumpUpdates, 400)
  for (const n of stale) {
    if (!ready(n)) continue
    admit({
      key: n.key,
      rank: rank(n.key),
      start: () => {
        const now = useStore.getState().nodes.find((x) => x.key === n.key)
        if (!now || !ready(now)) { release(n.key); return }   // scrolled away or taken in use while it queued
        useStore.getState().startReload(n.key)               // released when its document is ready (FrameNode)
      },
    })
  }
}
