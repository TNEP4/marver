/**
 * Main's immersive gate (spec 32 C8), pure: no Electron, no tabs, unit-tested on its own (immersive-gate.test.ts).
 *
 * The shell only wishes (`mv:immersive {on, n}`, C1, C2); main is the authority. After every compose views.ts reads, for
 * each canvas tab, the document's latest wish, its grant (`TabReports.immersiveGrant`, absent reading `none`), the last
 * `n` it answered and the gate (`gateOf`), and `step` says what the grant becomes, what to answer and whether the strip
 * shows. The rule is level-triggered: each compose looks at the state as it is, never only at a change, so no answer
 * depends on a report that was already consumed. "Answer" means: send, then set `answered = n` (views.ts does both, and
 * sets `answered` only when the bridge sent it, so a send that could not go out is made again by the next compose);
 * "if unanswered" means only when `answered !== n`.
 *
 * | Grant   | Wish | Gate   | step                                                           |
 * |---------|------|--------|----------------------------------------------------------------|
 * | `on`    | off  | (any)  | grant `none`; answer `{on: false}`, no `end`; strip shown       |
 * | `on`    | on   | fails  | grant `ended`; answer `{on: false, end: true}`; strip shown     |
 * | `on`    | on   | passes | answer `{on: true}` if unanswered; strip hidden                 |
 * | `ended` | off  | (any)  | grant `none`; answer `{on: false}` if unanswered; strip shown    |
 * | `ended` | on   | (any)  | answer `{on: false}` if unanswered (refused, no `end`)           |
 * | `none`  | on   | passes | grant `on`; answer `{on: true}` (even when `n` was answered)     |
 * | `none`  | on   | fails  | answer `{on: false}` if unanswered (refused)                     |
 * | `none`  | off  | (any)  | answer `{on: false}` if unanswered                               |
 *
 * A new document starts at `none` with nothing answered: every commit replaces the tab's reports (tabs.ts), which hold
 * the grant and `answered`.
 */
import type { Layout } from './tabs.ts'

export type Grant = 'none' | 'on' | 'ended'

/** The wish as the document last reported it (`TabReports.immersive`); absent reads off. */
export interface Wish { on: boolean; n: number }

/** What the gate reads, from plain fields (window.ts's view facts and the tab's own record, views.ts). */
export interface GateFacts {
  /** the tab is the active one */
  active: boolean
  /** a local canvas (a shared canvas never goes immersive, C8) */
  local: boolean
  /** it has its content view */
  view: boolean
  /** its tab page shows over it */
  page: boolean
  /** layout.ts `placed()` */
  placed?: Layout
  /** layout.ts `seeThrough()` */
  seeThrough: boolean
  /** a main-frame navigation under way (`t.geo.pending`) */
  pending: boolean
  /** HTML fullscreen (`t.geo.htmlFullscreen`) */
  htmlFullscreen: boolean
  /** the document is trusted (`doc.trusted`) */
  trusted: boolean
  /** Chromium's hang monitor says it does not respond (`t.hung`) */
  hung: boolean
  /** its registry entry is gone (or there is none) */
  gone: boolean
  /** the document's report says `immersive.on === true` */
  wish: boolean
  /** main takes it away on its own (F6 or ⇧F6 pressed while immersive, C8.1) */
  mainEnds?: boolean
}

/** What window.ts knows of a tab's views at a compose (the rest comes from the tab's own record, views.ts). */
export type ViewFacts = Pick<GateFacts, 'active' | 'view' | 'page' | 'placed' | 'seeThrough'>

/** C8's first paragraph: every condition, in one place. */
export function gateOf(f: GateFacts): boolean {
  return f.active && f.local && f.view && !f.page && f.placed === 'full' && f.seeThrough && !f.pending && !f.htmlFullscreen
    && f.trusted && !f.hung && !f.gone && f.wish && !f.mainEnds
}

export interface StepIn {
  grant: Grant
  /** the document's latest wish; absent reads off (and there is nothing to answer) */
  wish?: Wish
  /** the last `n` main answered for this document */
  answered?: number
  gate: boolean
}

export interface StepOut {
  grant: Grant
  /** what to send on `mv:immersive-state`, stamped by the caller with the document and the wish's `n` */
  answer?: { on: boolean; end?: true }
  /** false: the strip and the lights hide for this tab (C9) */
  stripShown: boolean
}

/** C8's table, row by row (the module header). */
export function step(i: StepIn): StepOut {
  const on = i.wish?.on === true
  const has = i.wish !== undefined
  const unanswered = has && i.answered !== i.wish!.n
  const off = (grant: Grant, always: boolean): StepOut => ({ grant, ...((always ? has : unanswered) ? { answer: { on: false } } : {}), stripShown: true })
  switch (i.grant) {
    case 'on':
      if (!on) return off('none', true)                                                           // row 1: the shell's own off
      if (!i.gate) return { grant: 'ended', answer: { on: false, end: true }, stripShown: true }      // row 2: main's cause
      return { grant: 'on', ...(unanswered ? { answer: { on: true } } : {}), stripShown: false }     // row 3
    case 'ended':
      if (!on) return off('none', false)                                                          // row 4
      return off('ended', false)                                                                  // row 5: refused, no end
    default:
      if (on && i.gate) return { grant: 'on', answer: { on: true }, stripShown: false }             // row 6
      return off('none', false)                                                                   // rows 7, 8
  }
}
