/**
 * The banners on the toolbar's centre line (spec 28 A1.11, spec 36 §4): the free gap between the sidebar and the
 * toolbar - or play's brand and toolbar pills - placed again whenever what moves that gap moves. Its own module so
 * the locked stage shell (LockedApp.tsx) can carry the outbox banner without pulling in the canvas shell.
 */
import { useLayoutEffect, useRef } from 'react'
import { useComments } from './comments-store.ts'
import { useStore } from './store.ts'
import { cmd } from './commands.ts'
import { navigatedByHand } from './goto.ts'
import { revealThread } from './Comments.tsx'
import { TOP } from './inset.ts'

/** Signed out on a published canvas (spec 36 §4): said the moment the server says it - before a reviewer writes for
 *  half an hour into a session that is gone - with what waits, that it is kept, and the one way back in. Placed like
 *  the stopped banner, and like it, Hide UI leaves it up. */
export function OutboxBanner({ stage = false }: { stage?: boolean }) {
  const signedOut = useComments((s) => s.signedOut)
  const pending = useComments((s) => s.pending)
  const play = useStore((s) => !!s.play)
  const ref = useRef<HTMLDivElement>(null)
  const waiting = pending.length
  const refused = pending.filter((p) => p.refused)
  usePlacedBanner(ref, [signedOut, waiting, refused.length, play])
  // the thread a refused write belongs to - Show opens it, wherever it is on the canvas
  const threadOf = (p: (typeof pending)[number]) => {
    const e = p.events[0]
    const id = e?.type === 'reply' ? e.parentId : e?.commentId
    return useComments.getState().threads.find((t) => t.id === id || t.replies.some((r) => r.id === id))?.id ?? id
  }
  // a thread a card can open: there, and not resolved (a resolved thread has no card to show the choices in)
  const shown = (p: (typeof pending)[number]) => { const id = threadOf(p); return !!id && useComments.getState().threads.some((t) => t.id === id && !t.resolved) }
  const many = (n: number) => (n === 1 ? 'comment is' : `${n} comments are`)
  return signedOut ? (
    <div ref={ref} className={`sh-banner sh-stopped sh-signedout${play ? ' dark' : ''}`} role="status" data-signed-out={waiting}>
      You're signed out{waiting ? <> - your {many(waiting)} kept here</> : null}
      <button className="sh-banner-act" onClick={() => { cmd('identity-open', { via: 'click', in: 'shell' }); useComments.getState().signInAgain() }}>Sign in again</button>
    </div>
  ) : (
    <div ref={ref} className={`sh-banner sh-stopped sh-signedout${play ? ' dark' : ''}`} role="status" data-refused={refused.length}>
      {refused.length === 1 ? 'A comment could not be sent' : `${refused.length} comments could not be sent`}
      {/* its thread on the canvas, with the reason, Retry and Discard - or, when that thread is nowhere to be shown
          (its board unpublished, its thread gone) or on a locked stage with no canvas to open it on, the reason and both
          choices here */}
      {!stage && shown(refused[0])
        ? <button className="sh-banner-act" onClick={() => { cmd('thread-open', { via: 'click', in: 'shell' }); navigatedByHand(); revealThread(threadOf(refused[0])!) }}>Show</button>
        : <>
          <span className="kept"> - {refused[0].refused}</span>
          <button className="sh-banner-act" onClick={() => { cmd('comment-retry', { via: 'click', in: 'shell' }); useComments.getState().retry(refused[0].key) }}>Retry</button>
          <button className="sh-banner-act" onClick={() => { cmd('comment-discard', { via: 'click', in: 'shell' }); useComments.getState().discard(refused[0].key) }}>Discard</button>
        </>}
    </div>
  )
}

/** A banner on the toolbar's centre line, in the free gap between the sidebar and the toolbar - placed again whenever
 *  what moves that gap moves. */
export function usePlacedBanner(ref: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const place = () => { cancelAnimationFrame(raf); raf = 0; placeBanner(el) }
    const soon = () => { raf ||= requestAnimationFrame(place) }
    place()
    // what moves the gap: the window, the chrome around it opening, closing or changing size, play, Hide UI
    const seen = new Set<Element>()
    const ro = new ResizeObserver(soon)
    const watch = () => { for (const n of el.parentElement?.querySelectorAll(OBSTACLES) ?? []) if (!seen.has(n)) { seen.add(n); ro.observe(n) } }
    watch()
    const mo = new MutationObserver(() => { watch(); soon() })
    if (el.parentElement) mo.observe(el.parentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    window.addEventListener('resize', soon)
    return () => { cancelAnimationFrame(raf); ro.disconnect(); mo.disconnect(); window.removeEventListener('resize', soon) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

/** The chrome the stopped banner keeps clear of: the sidebar (or its button) on the left, the toolbar (or its
 *  button) on the right - the canvas's own, or play's brand and toolbar pills over it. */
const OBSTACLES = ':scope > .sh-panel, :scope > .sh-fab, :scope > nav.sh-pill, :scope > .sh-pill-fab, :scope > .sh-play > .sh-pill, :scope > .sh-play > .sh-pill-fab'
const BANNER_GAP = 12
function placeBanner(el: HTMLElement) {
  const app = el.parentElement
  if (!app) return
  const edge = parseFloat(getComputedStyle(app).getPropertyValue('--edge')) || 10
  // a box in the app's own coordinates, from layout - never the rect mid-morph (a closing panel scales down)
  const box = (n: HTMLElement) => {
    let x = 0, y = 0
    for (let e: HTMLElement | null = n; e && e !== app; e = e.offsetParent as HTMLElement | null) { x += e.offsetLeft; y += e.offsetTop }
    return { left: x, top: y, right: x + n.offsetWidth, bottom: y + n.offsetHeight }
  }
  const pick = (root: Element, sel: string) => {
    const n = root.querySelector<HTMLElement>(sel)
    return n && !n.matches('.closed, .hidden') && n.offsetWidth ? box(n) : null
  }
  let left: ReturnType<typeof box> | null = null, right: ReturnType<typeof box> | null = null
  if (!document.body.classList.contains('sh-hide-ui')) {
    const stage = app.querySelector(':scope > .sh-play')
    if (stage) {
      left = pick(stage, ':scope > .sh-play-brand')
      right = pick(stage, ':scope > .sh-play-pill:not(.sh-play-brand)') ?? pick(stage, ':scope > .sh-pill-fab')
    } else {
      left = pick(app, ':scope > .sh-panel') ?? pick(app, ':scope > .sh-fab')
      right = pick(app, ':scope > nav.sh-pill') ?? pick(app, ':scope > .sh-pill-fab')
    }
  }
  // the toolbar row: its centre line, and its foot - the sidebar runs down the page, so it is no part of the row
  const tall = !!left && left.bottom - left.top > 64
  const row = [right, tall ? null : left].filter((b): b is NonNullable<typeof b> => !!b)
  // with no row to measure: the toolbar's line, below the Mac app's strip when the shell took the inset
  const mid = row.length ? Math.max(...row.map((b) => (b.top + b.bottom) / 2)) : TOP + edge + 23
  const foot = Math.max(TOP + edge + 46, ...row.map((b) => b.bottom))
  const W = app.clientWidth
  const from = left ? left.right + BANNER_GAP : edge, to = right ? right.left - BANNER_GAP : W - edge
  const at = (where: 'row' | 'stack' | 'below', x0: number, x1: number, top?: number) => {
    el.dataset.at = where
    el.style.left = `${Math.round(x0 + Math.max(0, (x1 - x0 - el.offsetWidth) / 2))}px`
    el.style.top = `${Math.round(top ?? mid - el.offsetHeight / 2)}px`
  }
  el.style.transform = 'none'
  el.dataset.at = 'row'
  // one line in the gap
  el.style.whiteSpace = 'nowrap'
  el.style.maxWidth = 'none'
  const line = el.offsetHeight
  if (el.offsetWidth <= to - from) return at('row', from, to)
  // two lines in the gap: what happened, then the kept edits under it
  if (el.querySelector('.kept')) {
    el.dataset.at = 'stack'
    if (el.offsetWidth <= to - from) return at('stack', from, to)
    el.dataset.at = 'row'
  }
  // or wrapped in two, the box no wider than its longest line
  el.style.whiteSpace = 'normal'
  el.style.maxWidth = `${to - from}px`
  if (to - from >= 220 && el.offsetHeight <= line + 18) { hug(el); return at('row', from, to) }
  // too narrow: under the toolbar row, centred in what the sidebar leaves, the kept edits on a line of their own
  el.dataset.at = 'below'
  const lo = tall && left ? left.right + BANNER_GAP : edge, hi = W - edge
  el.style.maxWidth = `${Math.max(160, Math.min(680, hi - lo))}px`
  hug(el)
  at('below', lo, hi, row.length ? foot + 8 : edge)   // no row with the chrome hidden: the top edge
}
/** A wrapped banner's box shrinks to its longest line (a max-width box stays as wide as it may be). */
function hug(el: HTMLElement) {
  const r = document.createRange()
  r.selectNodeContents(el)
  const lines = [...r.getClientRects()]
  if (!lines.length) return
  const cs = getComputedStyle(el)
  const chrome = el.offsetWidth - el.clientWidth + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
  const need = Math.ceil(Math.max(...lines.map((l) => l.right)) - Math.min(...lines.map((l) => l.left)) + chrome) + 1
  const was = el.style.maxWidth, h = el.offsetHeight
  el.style.maxWidth = `${Math.min(need, el.offsetWidth)}px`
  if (el.offsetHeight > h) el.style.maxWidth = was   // never a line more than it had (a balanced wrap re-flows)
}

