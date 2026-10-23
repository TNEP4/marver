/**
 * The strip's one pill (spec 28 A2.2, A2.14 #19, #24, #33; frames mac-app/06, 11-moments). Owner: the window
 * stream. Main chooses at most one and sends `pill { rev, ... }`, keeping a record of what that `rev` is about
 * (its tab and that tab's document, or the condition); `pill:action { rev, act }` acts on that record alone, so a
 * click that lands after a tab switch can never act on another canvas, and an old `rev` is refused.
 *
 * Highest first, the next one showing when it clears:
 *   1. the active tab's own state while its page is kept - "Unsaved work here" (the guard refused), "Stopped"
 *      (its start command the button that copies it), "Not responding" (Reload, which asks first);
 *   2. a confirmation, 4 s on screen - "Reloaded after a crash" in A2 (Flash marked A3, a missed notice A4);
 *   3. the files: "Settings not applied", "Files not saved" (A2.12, A2.14 #24);
 *   4. a dismissible offer (A4's notices; a test-only kind in A2); 5. the update (A5).
 * Lifetimes: a confirmation's 4 s count only while it is on screen and the window shown; one pushed off keeps
 * what it has left; one not shown within 30 s is dropped (its record - the crash - stays); one of each kind waits,
 * a newer replaces it. The unsaved pill lasts while the page's own `unsaved` is true (10 s for a record that is not
 * fresh) and its tab is active. Every pill has a `short` form, which the strip shows below 960 px of window.
 *
 * Pure (no Electron import): the ports send, copy and act.
 */
import type { PillView } from '../shared/channels.ts'
import { startCommandShown } from '../shared/command.ts'
import { T } from './timings.ts'
import { activeTab, fresh, getTab, liveDoc, tabName, type Tab } from './tabs.ts'

type Kind = PillView['kind']
/** What a pill is about; `about` names it for "the same pill" (no new rev for the same thing). */
interface Rec {
  kind: Kind
  about: string
  tab?: string
  commit?: number
  sub?: string
  lead?: string
  text: string
  short: string
  icon?: 'check'
  button?: PillView['button']
  tooltip?: string
  dismissible?: boolean
}

export interface PillPorts {
  now(): number
  home: string
  /** the window is shown and not minimised: a confirmation counts down only then */
  visible(): boolean
  send(v: PillView | null): void
  /** the "Stopped" pill's button: the tab's start command onto the clipboard (main's own text) */
  copyStart(t: Tab): void
  /** the "Not responding" pill's Reload: asks first (A2.11) */
  notResponding(t: Tab): void
  log?(topic: string, data: unknown): void
}

let ports: PillPorts | null = null
export function setPillPorts(p: PillPorts): void { ports = p; recompute() }

interface Waiting { rec: Rec; left: number; created: number; since?: number }
/** confirmations waiting, at most one per sub-kind (FIFO by creation) */
const confirms = new Map<string, Waiting>()
/** tiers 3 and 4 */
const conds = new Map<'files' | 'test', Rec>()
const dismissed = new Set<string>()

let rev = 0
let shown: Rec | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let wasVisible = true

/** Test seam. */
export function resetPill(): void {
  confirms.clear(); conds.clear(); dismissed.clear(); rev = 0; shown = null; wasVisible = true
  if (timer) clearTimeout(timer)
  timer = undefined
}

export const currentPill = (): (PillView & { tab?: string }) | null => shown ? { ...toView(shown, rev), ...(shown.tab ? { tab: shown.tab } : {}) } : null

/** Tier 1: the active tab's own state while its page is kept. */
function tier1(t: Tab | undefined, now: number): Rec | null {
  if (!t || t.kind !== 'local') return null
  if (t.held && liveDoc(t)) {
    // while the page says unsaved (a clean report clears the hold); else - no bridge, not yet heard, no longer
    // heard, or a page that refused though its last report said clean - 10 s
    const lasts = (fresh(t) && t.reports.busy?.unsaved === true) || now - t.held.at < T.unsavedPillMs
    if (lasts) {
      return { kind: 'unsaved', about: `unsaved:${t.id}:${t.held.at}`, tab: t.id, commit: t.doc?.commits, lead: 'Unsaved work here',
        text: t.held.action === 'update' ? 'the update waits' : '', short: 'Unsaved work' }
    }
  }
  if (t.reg?.state === 'gone' && liveDoc(t) && !t.fail) {
    const cmd = t.root ? startCommandShown({ root: t.root, port: t.reg.slot == null ? t.reg.port : null }, ports!.home) : null
    return { kind: 'stopped', about: `stopped:${t.id}:${t.doc?.commits}`, tab: t.id, commit: t.doc?.commits, lead: 'Stopped', text: '', short: 'Stopped',
      button: { label: 'npx marver dev', style: 'cmd' }, ...(cmd ? { tooltip: cmd.slice(0, 199) } : {}) }
  }
  if (t.hung && t.view === 'live') {
    return { kind: 'not-responding', about: `hung:${t.id}:${t.doc?.commits}`, tab: t.id, commit: t.doc?.commits, lead: 'Not responding', text: '', short: 'Not responding',
      button: { label: 'Reload', style: 'plain' } }
  }
  return null
}

function toView(r: Rec, n: number): PillView {
  return {
    rev: n, kind: r.kind, text: r.text, short: r.short,
    ...(r.lead ? { lead: r.lead } : {}), ...(r.icon ? { icon: r.icon } : {}), ...(r.button ? { button: r.button } : {}),
    ...(r.tooltip ? { tooltip: r.tooltip } : {}), ...(r.dismissible ? { dismissible: true } : {}),
  }
}

/** Account for the time the shown confirmation spent on screen. */
function settle(now: number): void {
  if (!shown || shown.kind !== 'confirmation') return
  const w = confirms.get(shown.sub!)
  if (!w || w.rec !== shown || w.since === undefined) return
  w.left -= now - w.since
  w.since = undefined
}

/** Choose the pill again (after any change: a tab, a report, a switch, the window shown or hidden, a timer). */
export function recompute(): void {
  const p = ports
  if (!p) return
  const now = p.now()
  const visible = p.visible()
  settle(now)
  for (const [k, w] of confirms) {
    if (w.left <= 0) confirms.delete(k)                                                   // shown its full 4 s
    else if (w.left === T.pillConfirmMs && now - w.created >= T.pillDropMs) { confirms.delete(k); p.log?.('pill', { dropped: k }) }   // never shown in 30 s
  }
  const oldest = [...confirms.values()].sort((a, b) => a.created - b.created)[0]
  const next = tier1(activeTab(), now) ?? oldest?.rec ?? conds.get('files') ?? conds.get('test') ?? null
  if (next?.kind === 'confirmation' && visible) confirms.get(next.sub!)!.since = now
  if (!(next && shown && next.about === shown.about)) {
    shown = next
    rev += 1
    p.send(shown ? toView(shown, rev) : null)
    p.log?.('pill', shown ? { rev, kind: shown.kind, about: shown.about, short: shown.short } : { rev, none: true })
  }
  wasVisible = visible
  arm(now)
}

/** One timer for whatever ends next: the shown confirmation's time, a waiting one's drop, the unsaved pill's 10 s. */
function arm(now: number): void {
  if (timer) clearTimeout(timer)
  timer = undefined
  const p = ports!
  const ends: number[] = []
  if (shown?.kind === 'confirmation' && wasVisible) { const w = confirms.get(shown.sub!); if (w) ends.push(w.left) }
  for (const w of confirms.values()) if (w.left === T.pillConfirmMs && w.rec !== shown) ends.push(w.created + T.pillDropMs - now)
  const t = activeTab()
  if (t?.held && !(fresh(t) && t.reports.busy?.unsaved)) ends.push(t.held.at + T.unsavedPillMs - now)
  const soonest = Math.min(...ends.filter((x) => x > -1000))
  if (Number.isFinite(soonest)) { timer = setTimeout(() => { timer = undefined; recompute() }, Math.max(0, soonest) + 5); (timer as { unref?: () => void }).unref?.() }
  void p
}

/** A confirmation (tier 2): "Reloaded after a crash" in A2. One of each kind waits; a newer replaces it. */
export function confirm(sub: 'crash-reloaded' | 'flash' | 'notice-missed', o: { tab?: string; lead?: string; text: string; short: string }): void {
  const now = ports?.now() ?? Date.now()
  const rec: Rec = { kind: 'confirmation', about: `confirm:${sub}:${now}`, sub, icon: 'check', ...o }
  confirms.set(sub, { rec, left: T.pillConfirmMs, created: now })
  recompute()
}

/** The crash's confirmation (A2.11). */
export const crashReloaded = (t: Tab): void => confirm('crash-reloaded', { tab: t.id, text: 'Reloaded after a crash', short: 'Reloaded' })

/**
 * Tier 3, the files (A2.12, A2.14 #24): "Settings not applied" or "Files not saved", or null when the cause is
 * gone. The home stream's config.ts calls it. `test`: a dismissible kind for A2's tests (A4's notices offer).
 */
export function setCondition(kind: 'files' | 'test', c: { text: string; short: string; lead?: string; tooltip?: string; dismissible?: boolean } | null): void {
  if (!c) conds.delete(kind)
  else {
    const about = `${kind}:${c.lead ?? ''}:${c.text}`
    if (dismissed.has(about)) return
    conds.set(kind, { kind, about, ...c, ...(c.tooltip ? { tooltip: c.tooltip.slice(0, 199) } : {}) })
  }
  recompute()
}

/** The window was shown or hidden (minimised): a confirmation counts down only while it is seen. */
export function onVisibility(): void { recompute() }

/** `pill:action { rev, act }` from the strip: main acts on its own record of that rev; an old rev is refused. */
export function onPillAction(r: number, act: 'button' | 'dismiss'): boolean {
  const p = ports
  if (!p || !shown || r !== rev) { p?.log?.('pill', { refused: r, current: rev }); return false }
  const rec = shown
  const t = rec.tab ? getTab(rec.tab) : undefined
  if (act === 'dismiss') {
    if (!rec.dismissible) return false
    dismissed.add(rec.about)
    for (const [k, c] of conds) if (c === rec) conds.delete(k)
    recompute()
    return true
  }
  if (!rec.button) return false
  // the record's own tab and document, or nothing
  if (rec.tab && (!t || t.doc?.commits !== rec.commit)) { p.log?.('pill', { stale: rec.about }); recompute(); return false }
  switch (rec.kind) {
    case 'stopped': if (t) p.copyStart(t); return true
    case 'not-responding': if (t?.hung) p.notResponding(t); return true
    default: return false
  }
}

/** For the tab page and the live region: the words of the pill now, by tab (none when the pill is not that tab's). */
export const pillNameOf = (t: Tab): string => tabName(t)
