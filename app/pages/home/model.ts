/**
 * Home v2's model (spec 32 D4-D8, D10), pure: no DOM, no main. What each card is, says, where it goes and which menu it
 * has, from `tabs`, `recent` and `shared` as main sent them. main.ts draws it; the unit test reads it directly.
 *
 * - **One card per tab** (D6), as the strip shows them; a recent is one card per workspace, shown only while no tab of
 *   it is open (main leaves those out: `recentViews(running, exclude)`); a past shared link one card per origin, hidden
 *   while a remote tab of that origin is open.
 * - **Its column** (D6's precedence): a state that blocks the canvas beats its marks - unverified; gone ("Stopped
 *   unexpectedly" in Needs you while main holds an unacknowledged stop, else Not running "Stopped"); starting;
 *   unreachable, crashed, unloaded; `hung`; then `marks.top`, `marks.working`, `marks.unseen` (stale marks count for
 *   nothing); then Running.
 * - **Its line** leads with a count only for questions (orange) and new frames (blue), else a dot of its column.
 * - **Its menu** (D8.1) by what it is now: a running local canvas, an unverified one, a canvas not running, a shared
 *   one. Rows name actions by id; main resolves every value from its own records.
 */
import type { RecentView, SharedLink, TabsSnapshot, TabView } from '../../src/shared/channels.ts'
import { hueOf } from '../../src/shared/hue.ts'
import type { MenuRow } from '../../src/pages/menu.ts'

/** The board's columns, in order (D6, D7.4). */
export type Col = 'ask' | 'work' | 'review' | 'live' | 'off'
export type Dot = 'ask' | 'work' | 'new' | 'live' | 'off'
export const COLS: readonly { key: Col; title: string; dot: Dot; empty: string }[] = [
  { key: 'ask', title: 'Needs you', dot: 'ask', empty: 'Nothing waits on you.' },
  { key: 'work', title: 'Agent working', dot: 'work', empty: 'No agent at work.' },
  { key: 'review', title: 'Ready to review', dot: 'new', empty: 'Nothing new since you looked.' },
  { key: 'live', title: 'Running', dot: 'live', empty: '' },
  { key: 'off', title: 'Not running', dot: 'off', empty: '' },
]
const RANK: Record<Col, number> = { ask: 0, work: 1, review: 2, live: 3, off: 4 }

/** What a card's line says: a count in its colour first (questions, new frames), or a dot of its kind. */
export interface Line { col: Col; text: string; num?: { n: number; tone: 'ask' | 'new' }; dot?: Dot }

/** One card (grid and board) or chip (the board's shared row). */
export interface CardModel {
  /** a tab id, a recent's `r_<ws>`, or a past shared link's `s_<hash>` (main's ids) */
  id: string
  kind: 'local' | 'recent' | 'remote' | 'past'
  /** 'shared' for remote tabs and past links: the grid's third section and the board's chips */
  col: Col | 'shared'
  name: string
  line: Line
  /** greyed (`.hm-off`): not running, and a past shared link in the grid (02-grid) */
  off: boolean
  /** a click opens it (D8.2): running local, remote and past shared; a not-running card opens its menu */
  opens: boolean
  /** an unverified canvas: the warning icon in the logo slot */
  warn?: boolean
  logo: { name: string; logo?: string; hue?: number }
  /** a running canvas's newer Marver (Update to) */
  update?: string
  /** a past shared link's url (its click and Open send `link:open`) */
  url?: string
  /** the strip's order, for sorting inside a column */
  order: number
  /** the canvas a `marver://` link named (spec 31 D1) */
  linked?: boolean
  /** the menu's shape (D8.1) */
  menu: 'running' | 'unverified' | 'stopped' | 'shared'
}

export interface HomeModel {
  /** no local canvas tab, no recent and no shared canvas (open or past): the empty state (D10) */
  empty: boolean
  /** the grid's sections (D4), each in its own order (D6.3) */
  running: CardModel[]
  notRunning: CardModel[]
  shared: CardModel[]
  /** the board's columns (D7), and the cards by id */
  columns: Record<Col, CardModel[]>
  byId: Map<string, CardModel>
}

/** "Starting…", "Running"...: the plain state words a closed tab's line adds " · tab closed" to (D6). */
const PLAIN = new Set(['Running', 'Starting…', 'Not responding', 'Can\'t reach', 'Crashed', 'Unloaded', 'Stopped'])

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** "4 min", "2 h" (D6.2): at least a minute; from 60 minutes, whole hours. */
export function workTime(since: number, now: number): string {
  const min = Math.max(1, Math.floor((now - since) / 60_000))
  return min >= 60 ? `${Math.floor(min / 60)} h` : `${min} min`
}

/** The Agent working line (D6.2): its board and minutes when the canvas says them (0.32), else "Agent working". */
export function workLine(work: { board?: string; since: number } | undefined, now: number): string {
  if (!work) return 'Agent working'
  return `Agent working${work.board ? ` on ${work.board}` : ''} · ${workTime(work.since, now)}`
}

/** The host a link names, for an unverified tab (A2.13): never a name it has not proved. */
export function hostOfLink(link?: string): string | null {
  try { return link ? new URL(link).host : null } catch { return null }
}

/**
 * A local tab's column and line (D6's precedence and table), pure: `now` for the working minutes. Stale marks count
 * for nothing; a stop main holds reads Needs you whatever the stream says.
 */
export function columnOf(t: TabView, now: number): Line {
  const m = t.marks
  const closed = (l: Line): Line => (t.open === false && PLAIN.has(l.text) ? { ...l, text: `${l.text} · tab closed` } : l)
  if (t.state === 'unverified') return { col: 'live', text: 'Not a Marver canvas' }
  if (t.state === 'gone') return m?.stopped ? { col: 'ask', text: 'Stopped unexpectedly', dot: 'ask' } : { col: 'off', text: 'Stopped', dot: 'off' }
  if (t.state === 'starting') return closed({ col: 'live', text: 'Starting…', dot: 'live' })
  if (t.state === 'unreachable') return closed({ col: 'live', text: 'Can\'t reach', dot: 'live' })
  if (t.state === 'crashed') return closed({ col: 'live', text: 'Crashed', dot: 'live' })
  if (t.state === 'unloaded') return closed({ col: 'live', text: 'Unloaded', dot: 'live' })
  if (t.hung) return closed({ col: 'live', text: 'Not responding', dot: 'live' })
  if (m && !m.stale) {
    const top = m.top && m.top.kind !== 'stopped' ? m.top : undefined
    if (top) {
      const on = top.board ? ` on ${top.board}` : ''
      if (top.kind === 'ask') {
        const n = m.kinds?.ask ?? m.needs
        return { col: 'ask', num: { n, tone: 'ask' }, text: ` ${plural(n, 'question', 'questions')}${on}` }
      }
      const words = ({ failed: 'Agent run failed', stalled: 'Agent stalled', review: 'Agent run to review', stopped: 'Stopped unexpectedly' } as const)[top.kind]
      return { col: 'ask', text: `${words}${on}`, dot: 'ask' }
    }
    if (m.working) return { col: 'work', text: workLine(m.work, now), dot: 'work' }
    if (m.unseen > 0) return { col: 'review', num: { n: m.unseen, tone: 'new' }, text: ` ${plural(m.unseen, 'new frame', 'new frames')} to look at` }
  }
  return closed({ col: 'live', text: 'Running', dot: 'live' })
}

/** A line as one string: the count and its words ("2 questions on Vault feed"). */
export const lineText = (l: Line): string => `${l.num ? l.num.n : ''}${l.text}`

const originOf = (u?: string): string | null => { try { return u ? new URL(u).origin : null } catch { return null } }

/**
 * Home's whole model (pure): `ago` words a past time ("Ran 19 hours ago"); `now` the working minutes. Remote tabs
 * read their site's name and logo from the shared link of their origin (spec 31 E3).
 */
export function homeModel(o: { snap: TabsSnapshot | null; recent: RecentView[]; shared: SharedLink[]; now: number; ago: (t: number) => string }): HomeModel {
  const tabs = o.snap?.tabs ?? []
  const locals = tabs.filter((t) => t.kind === 'local')
  const remotes = tabs.filter((t) => t.kind === 'remote')
  const siteOf = (url?: string) => { const g = originOf(url); return g ? o.shared.find((l) => originOf(l.url) === g) : undefined }
  const cards: CardModel[] = []

  tabs.forEach((t, order) => {
    if (t.kind === 'local') {
      const line = columnOf(t, o.now)
      const unverified = t.state === 'unverified'
      const gone = t.state === 'gone'
      cards.push({
        id: t.id, kind: 'local', col: line.col, name: unverified ? hostOfLink(t.link) ?? t.name : t.name, line,
        off: line.col === 'off', opens: !gone, ...(unverified ? { warn: true } : {}),
        logo: { name: t.name, ...(t.logo ? { logo: t.logo } : {}), ...(t.hue !== undefined ? { hue: t.hue } : {}) },
        ...(t.update && !unverified && !gone ? { update: t.update } : {}),
        order, menu: unverified ? 'unverified' : gone ? 'stopped' : 'running',
      })
    } else if (t.kind === 'remote') {
      const site = siteOf(t.link)
      const text = t.state === 'starting' ? 'Opening…' : t.state === 'unreachable' ? 'Can\'t reach' : t.state === 'crashed' ? 'Crashed' : 'Open'
      const name = site?.name ?? t.name
      cards.push({
        id: t.id, kind: 'remote', col: 'shared', name, line: { col: 'live', text }, off: false, opens: true,
        logo: { name, ...(t.logo ?? site?.logo ? { logo: t.logo ?? site?.logo } : {}), ...(t.hue !== undefined ? { hue: t.hue } : {}) },
        order, menu: 'shared',
      })
    }
  })
  const base = tabs.length
  o.recent.forEach((r, i) => {
    cards.push({
      id: r.id, kind: 'recent', col: 'off', name: r.name,
      line: { col: 'off', text: r.lastSeen > 0 ? `Ran ${o.ago(r.lastSeen)}` : 'Not running', dot: 'off' },
      off: true, opens: false, logo: { name: r.name, ...(r.logo ? { logo: r.logo } : {}), ...(r.hue !== undefined ? { hue: r.hue } : {}) },
      order: base + i, ...(r.linked ? { linked: true } : {}), menu: 'stopped',
    })
  })
  // the links opened before, newest first, one per origin, but not one whose origin has a tab open now (its tab's card)
  const seen = new Set<string>()
  const past = o.shared.filter((l) => {
    const g = originOf(l.url)
    if (!g || seen.has(g) || remotes.some((t) => originOf(t.link) === g)) return false
    seen.add(g)
    return true
  }).slice(0, 12)
  past.forEach((l, i) => {
    const name = l.name ?? l.host
    cards.push({
      id: l.id ?? `s_${i}`, kind: 'past', col: 'shared', name, line: { col: 'off', text: `Opened ${o.ago(l.lastSeen)}` },
      off: true, opens: true, logo: { name, ...(l.logo ? { logo: l.logo } : {}), hue: hueOf(l.host) }, url: l.url,
      order: base + o.recent.length + i, menu: 'shared',
    })
  })

  // D6.3: column priority, then strip order; Not running: the linked recent, then gone tabs, then recents newest first
  const offRank = (c: CardModel) => (c.linked ? 0 : c.kind === 'local' ? 1 : 2)
  const sorted = (list: CardModel[]) => [...list].sort((a, b) => RANK[a.col as Col] - RANK[b.col as Col] || (a.col === 'off' ? offRank(a) - offRank(b) : 0) || a.order - b.order)
  const columns = Object.fromEntries(COLS.map((c) => [c.key, sorted(cards.filter((x) => x.col === c.key))])) as Record<Col, CardModel[]>
  const sharedCards = [...cards.filter((c) => c.kind === 'remote'), ...cards.filter((c) => c.kind === 'past')]
  return {
    empty: locals.length === 0 && o.recent.length === 0 && sharedCards.length === 0 && o.shared.length === 0,
    running: sorted(cards.filter((c) => c.col !== 'off' && c.col !== 'shared')),
    notRunning: columns.off,
    shared: sharedCards,
    columns,
    byId: new Map(cards.map((c) => [c.id, c])),
  }
}

/** A card's menu row ids (D8.1); `open` is the card's own activation, the others name a `home:action`. */
export type RowId = 'open' | 'copy-update' | 'copy-start' | 'copy-link' | 'copy-path' | 'reveal'
/** The copy rows, which answer "Copied" in place (D8.3). */
export const COPY_ROWS: readonly RowId[] = ['copy-update', 'copy-start', 'copy-link', 'copy-path']

/** A card's menu (D8.1, HT:104-115), from the card as it is now. */
export function menuRows(c: CardModel): MenuRow[] {
  const item = (id: RowId, label: string, icon: NonNullable<Extract<MenuRow, { kind: 'item' }>['icon']>, more: { update?: boolean } = {}): MenuRow => ({ kind: 'item', id, label, icon, enabled: true, ...more })
  const sep: MenuRow = { kind: 'sep' }
  switch (c.menu) {
    case 'running': return [
      item('open', 'Open', 'arrow-right'),
      ...(c.update ? [item('copy-update', `Update to ${c.update}`, 'arrow-up', { update: true })] : []),
      sep, item('copy-link', 'Copy link', 'link'), item('copy-path', 'Copy path', 'signpost'), item('reveal', 'Reveal in Finder', 'folder-open'),
    ]
    case 'unverified': return [item('open', 'Open', 'arrow-right')]
    case 'stopped': return [
      item('copy-start', 'Copy start command', 'copy'), sep,
      item('copy-link', 'Copy link', 'link'), item('copy-path', 'Copy path', 'signpost'), item('reveal', 'Reveal in Finder', 'folder-open'),
    ]
    case 'shared': return [item('open', 'Open', 'arrow-right'), sep, item('copy-link', 'Copy link', 'link')]
  }
}

/** The view kept in `localStorage['mv.home.view']` (D8.5): Board on first launch, and for anything else read back. */
export const viewOf = (v: unknown): 'grid' | 'board' => (v === 'grid' ? 'grid' : 'board')

/** Spec 32 D3: the link field's line for a `marver:` link - "↩ opens <folder>", the last segment of its `ws`. */
export const deepFolder = (ws: string): string => ws.replace(/\/+$/, '').split('/').pop() || ws
