import { useState, type KeyboardEvent } from 'react'
import { StatusIcon } from './board-icons.tsx'
import { STATUS_LABEL, type Status } from '../../shared/status.ts'
import type { StatusWord } from '../../shared/board-types.ts'
import type { BoardMeta } from './store.ts'

/**
 * A board's status, from its right-click menu - Linear's picker, on Marver's rule (spec 20): a
 * person decides only what the evidence cannot. With `context/` that is Blocked (with a reason),
 * Paused and Archived, and "Back to the evidence" undoes the decision - plus In progress and Building
 * where an open plan names the capability (they write the plan's `stage`, the evidence itself);
 * without it, Backlog, To do, In progress and Building as well. Done is never offered - it comes from
 * the shipped record. The status the evidence gives shows read-only at the top, with where it came from.
 *
 * Type to filter, arrows and Enter, or a number. Blocked asks why before it writes.
 */
type Opt = { key: string; status: StatusWord | null; label: string; icon: Status | 'clear' }

export function StatusPicker({ meta, onPick }: { meta: BoardMeta; onPick: (status: StatusWord | null, reason?: string) => void }) {
  const settable = meta.settable ?? []
  const current = meta.status
  const hasContext = !settable.includes('todo')
  const decided = !!current && (current.row ?? 9) <= 3                 // rows 1-3: a decision on the board
  const opts: Opt[] = [
    ...settable.map((s) => ({ key: s, status: s, label: s === 'blocked' ? 'Blocked…' : STATUS_LABEL[s], icon: s })),
    ...(hasContext && decided ? [{ key: 'clear', status: null, label: 'Back to the evidence', icon: 'clear' as const }] : []),
  ]
  const [q, setQ] = useState('')
  const shown = opts.map((o, i) => ({ ...o, n: i + 1 })).filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()))
  const [hi, setHi] = useState(0)
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState(current?.status === 'blocked' ? current.reason ?? '' : '')

  const choose = (o: Opt | undefined) => {
    if (!o) return
    if (o.status === 'blocked') { setAsking(true); return }
    onPick(o.status)
  }
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, shown.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(shown[hi]) }
    else if (/^[1-9]$/.test(e.key) && !q) { e.preventDefault(); choose(opts[Number(e.key) - 1]) }
  }

  if (asking) {
    const ok = !!reason.trim()
    return (
      <div className="sh-status-picker" data-status-picker="reason">
        <div className="sp-head"><StatusIcon status="blocked" /><b>Blocked - why?</b></div>
        <input autoFocus className="sp-input" value={reason} maxLength={300} placeholder="Waiting on…"
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && ok) { e.preventDefault(); onPick('blocked', reason.trim()) } }} />
        <div className="sp-foot">{ok ? 'Enter to save' : 'A blocked board says why'} · Esc to close</div>
      </div>
    )
  }

  // what the evidence says, when no decision hides it: the status and the line that decided it
  const evidence = !decided && current && hasContext ? current.evidence?.[0] : undefined
  return (
    <div className="sh-status-picker" data-status-picker="list">
      <input autoFocus className="sp-input" value={q} placeholder="Change status…"
        onChange={(e) => { setQ(e.target.value); setHi(0) }} onKeyDown={keys} />
      {current && evidence && (
        <div className="sp-now" title={current.evidence?.join('\n')}>
          <StatusIcon status={current.status} fill={current.fill} />
          <span>{STATUS_LABEL[current.status]}</span>
          <small>{evidence.replace(/:\s.*$/, '').replace(/^context\//, '')}</small>
        </div>
      )}
      <div className="sp-list">
        {shown.map((o, i) => {
          // with context/, In progress and Building are the plan's - current when the evidence says so
          const fromPlan = o.status === 'in-progress' || o.status === 'building'
          const isCurrent = o.status !== null && o.status === current?.status && (decided || !hasContext || fromPlan)
          return (
            <button key={o.key} data-status-option={o.key} className={i === hi ? 'hi' : undefined}
              onMouseEnter={() => setHi(i)} onClick={() => choose(o)}>
              {o.icon === 'clear'
                ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3.2 6.2 A4.2 4.2 0 1 1 4.4 10.4 M3.2 3.4 V6.2 H6" /></svg>
                : <StatusIcon status={o.icon} />}
              <span>{o.label}</span>
              {isCurrent && <svg className="sp-chk" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2.5 6.3 L5 8.6 L9.6 3.6" /></svg>}
              <kbd>{o.n}</kbd>
            </button>
          )
        })}
        {!shown.length && <div className="sp-empty">No status matches</div>}
      </div>
      <div className="sp-foot">{!hasContext
        ? 'Done needs a record - context/shipped.md'
        : settable.includes('building')
          ? 'Building and In progress write the plan’s stage · Done needs a record'
          : 'Building needs an open plan - context/plans/'}</div>
    </div>
  )
}
