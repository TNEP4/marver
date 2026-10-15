/**
 * Sidebar marks in the shell (spec 25, variant B - one slot). Colour on a row's icon and title
 * carries the state (blue new, orange needs you); the row's one right-hand slot holds what matters
 * most: a question's numbered bubble, then the row's own count or status, then a frame's dot.
 */
import { useEffect, type HTMLAttributes, type ReactNode } from 'react'
import { create } from 'zustand'
import { useStore, PUBLISHED, shownRev } from './store.ts'
import { useComments } from './comments-store.ts'
import { frameMark, isNew, questions, type Ask, type FrameMark } from '../../shared/marks.ts'

/** Every frame's mark, derived ONCE per change of marks, threads or manifest. Rows and headers read
 *  one string each, so a change re-renders only what it changes - never the whole shell. */
interface View { q: Map<string, Ask>; frame: Record<string, string>; fresh: Record<string, true> }
const useMarkView = create<View>(() => ({ q: new Map(), frame: {}, fresh: {} }))
const derive = () => {
  const { marks, manifest } = useStore.getState()
  // a published canvas shows no marks at all: no seen state there, and its threads are not yours
  const q = PUBLISHED ? new Map<string, Ask>() : questions(useComments.getState().threads)
  const frame: Record<string, string> = {}, fresh: Record<string, true> = {}
  for (const f of manifest?.frames ?? []) {
    const m = frameMark(marks, q, f.id)
    if (m) frame[f.id] = m.kind === 'new' ? 'new' : `${m.kind}:${m.n}`
    if (isNew(marks, f.id)) fresh[f.id] = true
  }
  useMarkView.setState({ q, frame, fresh })
}
useStore.subscribe((s, p) => { if (s.marks !== p.marks || s.manifest !== p.manifest) derive() })
useComments.subscribe((s, p) => { if (s.threads !== p.threads) derive() })

export const asksNow = (): Map<string, Ask> => useMarkView.getState().q
/** Open Marver questions per frame - for the board list, a light component that rolls up per board. */
export const useAsks = (): Map<string, Ask> => useMarkView((s) => s.q)

const parse = (k: string): FrameMark => {
  if (!k) return null
  if (k === 'new') return { kind: 'new' }
  const [kind, n] = k.split(':')
  return { kind: kind as 'ask' | 'answered', n: Number(n) }
}
export const useFrameMark = (id: string): FrameMark => parse(useMarkView((s) => s.frame[id] ?? ''))

/** A row standing for many frames: open questions and new frames among `ids`, as one primitive -
 *  the row re-renders only when the pair changes. */
export function useRollup(ids: readonly string[]): { asks: number; fresh: number } {
  const k = useMarkView((s) => {
    let asks = 0, fresh = 0
    for (const id of new Set(ids)) { const f = s.frame[id]; if (f?.startsWith('ask:')) asks += Number(f.slice(4)); if (s.fresh[id]) fresh++ }
    return `${asks}:${fresh}`
  })
  const [asks, fresh] = k.split(':').map(Number)
  return { asks, fresh }
}

/** The row's tone class: blue for new, orange for a question (answered or not). */
export const toneOf = (m: FrameMark): string => (!m ? '' : m.kind === 'new' ? ' mk-new' : ' mk-ask')

export const Bubble = ({ n, hollow }: { n: number; hollow?: boolean }) => (
  <i className={`mk-bubble${hollow ? ' hollow' : ''}`} data-mark={hollow ? 'answered' : 'ask'}
    aria-label={hollow ? `${n} answered, waiting on the agent` : `${n} waiting on you`}>{n}</i>
)

/** A frame row's slot: the bubble, or the blue dot. */
export function FrameSlot({ m }: { m: FrameMark }) {
  if (!m) return null
  if (m.kind === 'new') return <i className="mk-slot"><i className="mk-dot" data-mark="new" aria-label="new" /></i>
  return <i className="mk-slot"><Bubble n={m.n} hollow={m.kind === 'answered'} /></i>
}

/** A sidebar frame row that wears its frame's mark: the tone on the row, the slot at its end. */
export function MarkedRow({ frame, className, children, ...rest }: { frame: string; className: string; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  const m = useFrameMark(frame)
  return <div className={className + toneOf(m)} {...rest}>{children}<FrameSlot m={m} /></div>
}

/** Looking at a frame counts as seeing it (spec 25): any part of it in the window for two seconds,
 *  at a readable zoom (scale 0.5 or more) - for the revision its document shows (spec 26): a frame
 *  still loading, stale, or showing an older revision than its last edit is not showing that edit, and
 *  the clock starts again when a new revision is up. In focus or play the stage counts the same way,
 *  once an Update it holds is applied. Polls once a second, and only frames that are new. */
export function useSeenOnScreen() {
  useEffect(() => {
    if (PUBLISHED) return
    const since = new Map<string, number>()   // "where@changed:shown" -> when it came into view
    const tick = () => {
      const s = useStore.getState(), m = s.marks
      const now = Date.now()
      const shown = new Map<string, string>()   // clock key -> node key (or 'stage'); a newer change or document restarts the clock
      if (m && !document.hidden && s.play) {
        const st = s.stageShown, f = st?.at
        if (st && f && !s.playUpdateRevision && isNew(m, f)) {
          const [e, r] = st.shown.split(':')
          if (e === m.epoch && Number(r) >= (m.doc[f] ?? 0)) shown.set(`play:${f}@${m.changed[f] ?? 0}:${st.shown}`, 'stage')
        }
      } else if (m && !document.hidden && s.scale >= 0.5) {
        // in view: some of it inside the window and not all of that under the open sidebar
        const P = document.querySelector('.sh-panel:not(.closed)')?.getBoundingClientRect()
        const W = window.innerWidth, H = window.innerHeight
        for (const n of s.nodes) {
          if (n.status !== 'ready' || n.stale || !isNew(m, n.frame) || shownRev(n, m) < (m.doc[n.frame] ?? 0)) continue
          const r = document.querySelector<HTMLElement>(`.sh-node[data-node="${CSS.escape(n.key)}"]`)?.getBoundingClientRect()
          if (!r) continue
          const x0 = Math.max(r.left, 0), x1 = Math.min(r.right, W), y0 = Math.max(r.top, 0), y1 = Math.min(r.bottom, H)
          if (x0 >= x1 || y0 >= y1) continue
          if (P && x0 >= P.left && x1 <= P.right && y0 >= P.top && y1 <= P.bottom) continue
          shown.set(`${n.key}@${m.changed[n.frame] ?? 0}:${n.shown}`, n.key)
        }
      }
      for (const k of [...since.keys()]) if (!shown.has(k)) since.delete(k)
      const due: string[] = []
      for (const [k, where] of shown) { const t = since.get(k) ?? now; since.set(k, t); if (now - t >= 2000) due.push(where) }
      if (due.length) s.look(due)
    }
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])
}
