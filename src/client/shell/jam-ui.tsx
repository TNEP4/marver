/**
 * Jam V2 in the shell (spec 27): the state glyphs and the status icon by a tag's time.
 *
 * A thread shows where work stands as one icon right of the message's time - on a tag (the last of
 * joined tags) - only while there is something to wait for or act on: queued, working, asks or
 * failed. Hovering it shows the detail in the inverse theme (the house Tip); clicking it keeps that
 * open with the card's one move - Drop while queued, Retry when failed. Replied, answered, done or
 * dropped: no icon - Marver's reply under it says it.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Tip } from './Tip.tsx'
import { cardForEvent, useJamQueue, type JamCardState } from './jam-queue.ts'
import { statusLines } from './jam-lines.ts'

const GRAY = 'var(--glass-ink-3)'
const RED = '#e5484d'              // board-icons.tsx RED - errors and failures only
const TEAL = '#00c3d0'             // recording: Apple system teal - red is for errors
const BLUE = 'var(--mv-blue, #0088ff)'
const ASK = 'var(--mk-ask)'
const NEW = 'var(--mk-new)'
const GREEN = 'var(--status-done, #34c759)'

export type JamGlyph = JamCardState | 'capturing'

/** One glyph per state, spec 25's icons: ◷ queued · ◐ working · ? asks · ◉ to review (a blue disc
 *  with an eye - a ring and dot read as a recorder) · ✓ done · – kept · ✕ failed. */
export function JamStateIcon({ state, size = 14 }: { state: JamGlyph; size?: number }) {
  const ring = (c: string, dash?: string, op?: number) => <circle cx="7" cy="7" r="5.8" fill="none" stroke={c} strokeWidth="1.5" strokeDasharray={dash} opacity={op} />
  const line = { fill: 'none', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const
  const cut = `jm-st-${useId().replace(/[^\w-]/g, '')}`
  /** a filled disc with `mark` cut out of it */
  const disc = (c: string, mark: ReactNode) => (<>
    <mask id={cut}><rect width="14" height="14" fill="#fff" /><g stroke="#000" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{mark}</g></mask>
    <circle cx="7" cy="7" r="6.5" fill={c} mask={`url(#${cut})`} />
  </>)
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden data-jam-state={state} className={`jm-st jm-st-${state}`}>
      {state === 'capturing' && disc(TEAL, <path d="M4.7 6 V8 M7 4.4 V9.6 M9.3 6 V8" />)}
      {state === 'draft' && (<>{ring(ASK)}<circle cx="7" cy="7" r="1.9" fill={ASK} /></>)}
      {state === 'confirming' && (<>{ring(BLUE, undefined, .28)}<path d="M7 1.2 A5.8 5.8 0 0 1 12.8 7" stroke={BLUE} {...line} strokeWidth={1.5} className="jm-spin" /></>)}
      {state === 'queued' && (<>{ring(GRAY)}<path d="M7 4.1 V7 L9 8.3" stroke={GRAY} {...line} strokeWidth={1.3} /></>)}
      {state === 'working' && (<>{ring(BLUE, undefined, .28)}<path d="M7 1.2 A5.8 5.8 0 1 1 1.2 7" stroke={BLUE} {...line} strokeWidth={1.5} className="jm-spin" /></>)}
      {state === 'asks' && disc(ASK, <><path d="M5.3 5.5 A1.75 1.75 0 1 1 7.6 7.1 C7.15 7.3 7 7.6 7 8.05" /><path d="M7 10.05 V10.1" strokeWidth="1.9" /></>)}
      {state === 'review' && disc(NEW, <><path d="M3.4 7 C4.5 5.15 5.7 4.35 7 4.35 C8.3 4.35 9.5 5.15 10.6 7 C9.5 8.85 8.3 9.65 7 9.65 C5.7 9.65 4.5 8.85 3.4 7 Z" /><circle cx="7" cy="7" r="0.9" /></>)}
      {state === 'done' && disc(GREEN, <path d="M4.3 7.2 L6.2 9.1 L9.8 5.2" />)}
      {state === 'kept' && disc(GRAY, <path d="M4.6 7 H9.4" />)}
      {state === 'failed' && disc(RED, <path d="M5 5 L9 9 M9 5 L5 9" />)}
      {state === 'dropped' && (<>{ring(GRAY, '1.3 1.75')}<path d="M4.4 9.6 L9.6 4.4" stroke={GRAY} {...line} strokeWidth={1.3} /></>)}
    </svg>
  )
}

/** The status icon right of a tag message's time. Nothing when the message carries no pending card
 *  (or this canvas has no queue - opened elsewhere, published). */
export function TagStatus({ board, eventId, harness }: { board?: string; eventId?: string; harness: Record<string, string> }) {
  const card = useJamQueue((s) => cardForEvent(s.cards, board, eventId))
  const agent = useJamQueue((s) => s.agent)
  const [open, setOpen] = useState(false)
  const [, tick] = useState(0)
  const ref = useRef<HTMLSpanElement>(null)
  // the working clock moves while it shows
  useEffect(() => {
    if (card?.state !== 'working') return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [card?.state])
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [open])
  useEffect(() => { if (!card) setOpen(false) }, [card])
  // the open detail stays on screen: it sits under the icon and slides left at the viewport's edge
  const popRef = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = popRef.current
    if (!el) return
    el.style.marginLeft = '0px'
    const over = el.getBoundingClientRect().right - (window.innerWidth - 8)
    if (over > 0) el.style.marginLeft = `${-over}px`
  }, [open, card?.state, card?.note])
  if (!card) return null
  const { head, detail } = statusLines(card, agent, harness)
  const move = card.state === 'queued' ? 'drop' : card.state === 'failed' ? 'retry' : null
  const lines = <span className="sh-tip-lines"><b>{head}</b>{detail && <small>{detail}</small>}</span>
  return (
    <span className={`cm-tstat${open ? ' on' : ''}`} ref={ref} data-jam-card={card.id} data-jam-state={card.state}>
      {open ? (
        <button className="cm-tstat-btn" aria-expanded aria-label={head} onClick={() => setOpen(false)}><JamStateIcon state={card.state} size={13} /></button>
      ) : (
        <Tip side="top" label={lines}>
          <button className="cm-tstat-btn" aria-label={head} onClick={() => setOpen(true)}><JamStateIcon state={card.state} size={13} /></button>
        </Tip>
      )}
      {open && (
        <span className="cm-tstat-pop" role="dialog" aria-label={head} ref={popRef}>
          {lines}
          {move && <button className="cm-tstat-act" onClick={() => { void useJamQueue.getState().act(card, move); setOpen(false) }}>{move === 'drop' ? 'Drop' : 'Retry'}</button>}
        </span>
      )}
    </span>
  )
}
