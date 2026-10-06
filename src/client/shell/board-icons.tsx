import type { ReactNode } from 'react'
import type { BoardType } from '../../shared/board-types.ts'
import type { Phase, Status } from '../../shared/status.ts'

/**
 * Spec 20's glyphs, custom in a 14-unit space so they sit on the sidebar's 14px rows: one per
 * board type (stroked in currentColor, so a row's colour - accent when current - carries over),
 * and Linear-style status rings (their own colours: a status reads the same in every theme).
 */

const TYPE_PATHS: Record<Exclude<BoardType, 'plain'>, ReactNode> = {
  start: <path d="M2.5 6.6 L7 2.8 L11.5 6.6 V11.5 H8.4 V8.6 H5.6 V11.5 H2.5 Z" />,
  feature: <path d="M7 1.9 L11.8 4.6 V9.4 L7 12.1 L2.2 9.4 V4.6 Z M2.2 4.6 L7 7.3 L11.8 4.6 M7 7.3 V12.1" />,
  surface: <><rect x="2" y="2.8" width="10" height="8.4" rx="1.4" /><path d="M2 5.4 H12" /></>,
  project: <><rect x="2" y="4.4" width="10" height="7" rx="1.2" /><path d="M5 4.4 V3 H9 V4.4 M2 7.4 H12" /></>,
  feedback: <path d="M2.4 3.2 H11.6 V9.2 H6.2 L3.8 11.2 V9.2 H2.4 Z" />,
  context: <path d="M2 8 L3.6 3 H10.4 L12 8 V11.2 H2 Z M2 8 H5 L5.8 9.3 H8.2 L9 8 H12" />,
  deck: <><rect x="2" y="2.4" width="10" height="6.6" rx="1" /><path d="M7 9 V11.6 M5 11.6 H9" /></>,
  archive: <><rect x="1.8" y="3" width="10.4" height="3" rx=".8" /><path d="M2.8 6 V11.2 H11.2 V6 M5.8 8.2 H8.2" /></>,
}

/** A board type's glyph; `plain` is null - the caller keeps its own board icon. */
export function TypeIcon({ type, size = 14 }: { type: BoardType; size?: number }) {
  if (type === 'plain') return null
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" aria-hidden data-type-icon={type}>
      {TYPE_PATHS[type]}
    </svg>
  )
}

const GRAY = 'var(--glass-ink-3)'
const YELLOW = '#e2b203'
const RED = '#e5484d'
// done is the content palette's green (Apple's systemGreen, per theme - styles.css), the green Marver
// keeps for done alone; archived is Apple's systemGray, the same in both themes
const GREEN = 'var(--status-done, #34c759)'
const ARCHIVED = '#8e8e93'

/** A pie wedge of the ring's interior, `f` of the way round from twelve o'clock. */
const pie = (f: number, r = 3.4) => {
  const a = f * 2 * Math.PI
  const x = 7 + r * Math.sin(a), y = 7 - r * Math.cos(a)
  return `M7 7 L7 ${7 - r} A${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`
}

/** A status glyph, on one rule: a status still open is an outline in its colour (a ring - In progress
 *  fills it by phase: a quarter at spec, half at lo-fi, three quarters at hi-fi); a settled one is
 *  filled - Done a green disc, Archived a solid archive box (no ring: it is out of the flow, not a
 *  step in it). Done, reported stays an outline: a written claim is not settled until confirmed. */
export function StatusIcon({ status, fill, size = 14 }: { status: Status; fill?: Phase; size?: number }) {
  const ring = (c: string, dash?: string) => <circle cx="7" cy="7" r="5.8" fill="none" stroke={c} strokeWidth="1.5" strokeDasharray={dash} />
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden data-status-icon={status}>
      {status === 'backlog' && ring(GRAY, '1.3 1.75')}
      {status === 'todo' && ring(GRAY)}
      {status === 'in-progress' && (<>{ring(YELLOW)}{fill && <path d={pie(fill / 4)} fill={YELLOW} />}</>)}
      {status === 'blocked' && (<>{ring(RED)}<circle cx="7" cy="7" r="3.2" fill={RED} /></>)}
      {status === 'done' && (<><circle cx="7" cy="7" r="6.5" fill={GREEN} /><path d="M4.3 7.2 L6.2 9.1 L9.8 5.2" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></>)}
      {status === 'done-reported' && (<>{ring(GREEN)}<path d="M4.4 7.2 L6.2 9 L9.7 5.3" fill="none" stroke={GREEN} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></>)}
      {status === 'unknown' && (<>{ring(GRAY)}<path d="M5.4 5.6 A1.7 1.7 0 1 1 7.6 7.2 C7.1 7.4 7 7.7 7 8.2" fill="none" stroke={GRAY} strokeWidth="1.3" strokeLinecap="round" /><circle cx="7" cy="10" r=".8" fill={GRAY} /></>)}
      {status === 'paused' && (<>{ring(GRAY)}<rect x="4.9" y="4.4" width="1.4" height="5.2" rx=".5" fill={GRAY} /><rect x="7.7" y="4.4" width="1.4" height="5.2" rx=".5" fill={GRAY} /></>)}
      {status === 'archived' && (<>
        <rect x="1.6" y="2.6" width="10.8" height="3.2" rx=".9" fill={ARCHIVED} />
        <path fillRule="evenodd" fill={ARCHIVED} d="M2.6 6.6 H11.4 V10.5 Q11.4 11.6 10.3 11.6 H3.7 Q2.6 11.6 2.6 10.5 Z M5.95 8.1 H8.05 A.65 .65 0 0 1 8.05 9.4 H5.95 A.65 .65 0 0 1 5.95 8.1 Z" />
      </>)}
    </svg>
  )
}
