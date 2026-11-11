/**
 * The strip (spec 28 A2.2, A2.4, A2.13, A2.14 #19, #26; spec 32 Part A, B; frames mac-app/01-06, 11, tab-strip/06):
 * Home, the tab list, `»` and the one pill, over main's cover. Served as marver-app://strip/. It draws what main sends -
 * `tabs`, `pill`, `window`, `page:focus`, `tab-menu` - and says what was chosen; it holds no state of its own beyond
 * focus, what fits and the menu it shows.
 *
 * - **A tab list** (A2.13): `role="tablist"` "Canvases", Home and every open tab as `role="tab"` with
 *   `aria-selected`, named for what the eye reads ("TMS broker, stopped"), `aria-keyshortcuts` its key. One tab holds
 *   `tabindex="0"`; Left and Right move focus (wrapping), Home and End to the ends - arrows never switch; Return and
 *   Space activate, Delete and Backspace close, the context-menu key and ⇧F10 open its menu.
 * - **Option D** (spec 32 A1-A11, "Concentric glass"): a tab holds its width only; its `.face`, a 32 px pill, carries
 *   the fill, the hairline, the lift and the lit rim: `.tab > .face > [.slot][.name][.end > (.mk?)(kbd.key?)]`. The 24 px
 *   round logo sits 4 px from the face's left and the 18 px badge 7 px from its right, concentric with its end caps.
 * - **Fitting** (A3, A4): every tab one width (`--tw`, 84-176 px), the active one wider (`--aw`, up to 260) only when its
 *   name is cut; under 104 px a tab is `.compact` (no name, its logo and badge where they were). What does not fit at
 *   84 px goes behind `»`. The pill takes its room first and shows its short form below 960 px. A resize of the height
 *   alone (a menu growing the view, B1) refits nothing. At least 40 px of empty strip always stays before the pill (or
 *   the right padding), right of the last tab or `»`: the window's drag area (A3 amendment, Nic 11 Nov).
 * - **The Marver menu** (B3-B14): a right-click, ⇧F10 or the context-menu key on a tab, or `»`, asks main (`tab:menu`,
 *   `tabs:more` with `MenuAsk`); main answers with the rows (`tab-menu`) and grows the view to the window, and the strip
 *   shows src/pages/menu.ts there once it has grown, then says so (`tab:menu-shown`); a pick or a close with no pick
 *   goes back as `tab:menu-pick`. `body.menu-open` keeps the grown view from being a drag region, from the ask until
 *   the view is 44 px again.
 * - **The look**: the active tab's own (`TabView.dark`), else the app's theme.
 * - **Names**: an unverified tab by its address, never a name it has not proved ("localhost:4808, not a Marver
 *   canvas", A2.13; frame mac-app/05).
 * - **Announcements**: a polite live region says a tab shown in the strip that stopped or crashed, at most once per
 *   tab per minute, and each new pill - nothing for what was found at launch: the first `tabs` snapshot, and the
 *   pill main sends with it at `app:ready` (null when none; a pill within a second of that first snapshot counts as
 *   found at launch when main sent no null). Words that arrive together are said together.
 * - **Marks** (A4, A4.6 #19; spec 32 A7, A11; `TabView.marks`): the end slot - an orange count of what needs you (99+),
 *   else a blue dot for new frames (no number: spec 31 B.7), else a light sweeping the face while an agent works (a
 *   still wash under Reduce Motion) - and a teal dot on the logo's corner while a Jam session runs. A stream that has
 *   been down draws the mark dimmed. On Home the strip hides them all. The tab's name says them ("Pilot, 2 need you,
 *   Jam session on"); the live region says "<name> needs you" when its count rises, at most once per tab per minute,
 *   never for the first marks the strip sees of a tab - a tab that has none is forgotten, so marks coming back are
 *   first marks again (needs.ts).
 */
import type { MenuAsk, PillView, TabMenuView, TabsSnapshot, TabView, WindowView } from '../../src/shared/channels.ts'
import { cmdButton, fill, h, hostOf, icon, ICON_NAMES, logo, pageApi, say, setLook, shown, type IconName } from '../../src/pages/dom.ts'
import { openMenu, type MenuHandle, type MenuRow } from '../../src/pages/menu.ts'
import { markSlot, needsRisen, needsSeen } from './needs.ts'

const api = pageApi('strip')
const stripEl = document.getElementById('strip') as HTMLElement
const tabsEl = document.getElementById('tabs') as HTMLElement
const moreEl = document.getElementById('more') as HTMLButtonElement
const pillEl = document.getElementById('pill') as HTMLElement
const live = document.getElementById('live') as HTMLElement

/** A3: the gap between tabs, the floor, compact below it, the shared width's most and the active tab's */
const GAP = 4
const MIN = 84
const COMPACT = 104
const SHARE_MAX = 176
const ACTIVE_MAX = 260
/** A3 (amendment, Nic 11 Nov): the empty, draggable strip always kept before the pill (or the right padding), right of
 *  the last tab or `»` - the strip body is the window's only drag region; and the strip's own flex gap, part of it */
const DRAG_GAP = 40
const STRIP_GAP = 8
/** A3.1: Home's own width plus its margin (6) and the gap after it (4) */
const HOME_ALLOWANCE = 10
const NARROW = 960
const ANNOUNCE_EVERY = 60_000
/** the strip's own height: the view grown past it holds a menu (B1, B3.3) */
const STRIP_H = 44
/** B3.1: an ask with no answer (a send main dropped) gives up its marks after this */
const ASK_FALLBACK_MS = 1000

let snap: TabsSnapshot | null = null
let pill: PillView | null = null
let hiddenIds: string[] = []
let focusId: string | null = null
const els = new Map<string, HTMLElement>()
const lastState = new Map<string, string>()
const announcedAt = new Map<string, number>()
const needs = needsSeen()
let tabsBaseline = true
let pillBaseline = true
/** after the first `tabs` snapshot, how long a pill with no null before it still counts as found at launch */
const LAUNCH_PILL_MS = 1000

const WORDS: Partial<Record<TabView['state'], string>> = {
  gone: 'stopped', unverified: 'not a Marver canvas', starting: 'starting', unreachable: 'can\'t be reached', crashed: 'crashed',
  unloaded: 'unloaded',
}
/** What the eye reads on a tab: an unverified one by its address (A2.13), never a name it has not proved. */
const shownName = (t: TabView) => (t.state === 'unverified' ? hostOf(t.link) ?? t.name : t.name)
/** What a tab's marks say (A4.6 #19): its needs, else its new frames; an agent at work, a session, and a stream that is down. */
function marksWords(t: TabView): string[] {
  const m = t.marks
  if (!m) return []
  const out: string[] = []
  if (m.needs > 0) out.push(`${m.needs} ${m.needs === 1 ? 'needs' : 'need'} you`)
  else if (m.unseen > 0) out.push('new since you looked')
  else if (m.working) out.push('agent working')
  if (m.session) out.push('Jam session on')
  if (m.stale) out.push('may be out of date')
  return out
}
/** a shared canvas says so: "<host>, shared canvas" (A4.6 #39); a local tab adds its marks (#19) */
const nameOf = (t: TabView) => {
  if (t.kind === 'home') return 'Home'
  const name = t.kind === 'remote' ? `${t.name}, shared canvas` : shownName(t)
  return [WORDS[t.state] ? `${name}, ${WORDS[t.state]}` : name, ...marksWords(t)].join(', ')
}
const shownTabs = (): TabView[] => (snap?.tabs ?? []).filter((t) => t.kind === 'home' || t.open !== false)
const visibleEls = (): HTMLElement[] => shownTabs().map((t) => els.get(t.id)).filter((e): e is HTMLElement => !!e && !e.hidden)
const idOf = (el: Element | null) => (el as HTMLElement | null)?.dataset?.id ?? null

/** A9: the 24 px round slot - a filled gear on a plate for Settings (spec 33 B), the spinner while starting, a warning for a canvas not proven, else the
 *  logo (A8: trimmed, on a white plate at 91%, a full-bleed mark covering the circle; initials on its hue) */
function slotFor(t: TabView): HTMLElement {
  const slot = h('span', { class: 'slot', 'aria-hidden': 'true' })
  // spec 33 B: Settings' filled gear on a round plate that follows the strip's look
  if (t.kind === 'settings') { slot.classList.add('plate'); slot.append(icon('gear-fill', 17)) }
  else if (t.state === 'starting') slot.append(h('i', { class: 'spin' }))
  else if (t.state === 'unverified') slot.append(icon('warning', 16, 'warn'))   // never a logo for a canvas not proven
  else slot.append(logo(t, 24, { round: true, plate: 0.91 }))
  if (t.marks?.session) slot.append(h('i', { class: 'sess' }))   // a Jam session: whatever the end slot shows
  return slot
}

/** The one mark (A4.6 #19, A7): needs you (orange, its count, 99+), else new frames (a blue dot - spec 31 B.7). */
function markOf(t: TabView): HTMLElement | null {
  const k = markSlot(t.marks)
  if (!k) return null
  return 'text' in k ? h('span', { class: k.cls, 'aria-hidden': 'true' }, k.text) : h('span', { class: k.cls, 'aria-hidden': 'true' })
}

function paintTab(el: HTMLElement, t: TabView, active: boolean): void {
  el.dataset.id = t.id
  el.setAttribute('role', 'tab')
  el.setAttribute('aria-selected', String(active))
  el.setAttribute('aria-label', nameOf(t))
  const open = el.classList.contains('menu-open')   // A5.5: the menu's opener keeps its look through a repaint
  if (t.kind === 'home') {
    el.className = `home${active ? ' on' : ''}`
    el.setAttribute('aria-keyshortcuts', 'Meta+T')
    el.title = 'Home ⌘T'
    fill(el, icon('house', 15))
    return
  }
  const m = t.marks
  const compact = el.classList.contains('compact')   // fit() owns it; a repaint keeps it until fit() runs
  el.className = ['tab', active && 'on', t.state !== 'live' && t.state !== 'hidden' && t.state !== 'none' && `is-${t.state}`,
    m && !m.needs && !m.unseen && m.working && 'working', m?.stale && 'stale', compact && 'compact', open && 'menu-open'].filter(Boolean).join(' ')
  if (t.key) el.setAttribute('aria-keyshortcuts', `Meta+${t.key}`)
  else el.removeAttribute('aria-keyshortcuts')
  el.removeAttribute('title')
  // A6: the key cap only for a tab that has a key; the badge and the key share one end cell
  const end = h('span', { class: 'end', 'aria-hidden': 'true' }, markOf(t), t.key ? h('kbd', { class: 'key' }, `⌘${t.key}`) : null)
  fill(el, h('span', { class: 'face' }, slotFor(t), h('span', { class: 'name' }, shownName(t)), end))
}

function renderTabs(): void {
  if (!snap) return
  const focused = idOf(document.activeElement)
  const want = shownTabs()
  const keep = new Set(want.map((t) => t.id))
  for (const [id, el] of els) if (!keep.has(id)) { el.remove(); els.delete(id) }
  let prev: HTMLElement | null = null
  for (const t of want) {
    let el = els.get(t.id)
    if (!el) { el = h('div'); els.set(t.id, el) }
    paintTab(el, t, t.id === snap.active)
    const at: ChildNode | null = prev ? prev.nextSibling : tabsEl.firstChild
    if (at !== el) tabsEl.insertBefore(el, at)
    prev = el
  }
  if (focused && els.has(focused) && document.activeElement !== els.get(focused)) els.get(focused)!.focus()
  const active = snap.tabs.find((t) => t.id === snap!.active)
  setLook(active?.kind === 'local' ? active.dark : undefined)
  document.body.classList.toggle('home-on', active?.kind === 'home')   // A11
  fit()
}

/** A3.3: a tab's natural width, measured with no transition running and `.compact` off (mid-transition reads wrong). */
function naturalWidth(el: HTMLElement): number {
  el.classList.remove('compact')
  el.style.setProperty('transition', 'none')
  el.style.setProperty('width', 'max-content')
  const w = Math.ceil(el.getBoundingClientRect().width) + 1
  el.style.removeProperty('width')
  void el.offsetWidth   // the restored width laid out before the transition comes back: nothing animates from max-content
  el.style.removeProperty('transition')
  return w
}

/** #tabs's width, floored: clientWidth rounds, so a list 0.5 px narrower than it reads would overflow into the drag gap */
const listWidth = () => Math.floor(tabsEl.getBoundingClientRect().width)

/**
 * What fits (A3, A4): every canvas tab (and Settings) one width, `--tw`, at most 176 and at least 84; the active one
 * `--aw`, wider only when its name is cut, up to 260; under 104 a tab is `.compact`. When they do not fit at 84, `»`
 * shows and `m` stay: the active tab and the first `m - 1` others, or the first `m` while Home is showing.
 */
function fit(): void {
  if (!snap) return
  const tabs = shownTabs().filter((t) => t.kind !== 'home')
  const tabEls = tabs.map((t) => els.get(t.id)!)
  for (const e of tabEls) e.hidden = false
  moreEl.hidden = true
  // the drag gap (A3 amendment): a margin on whatever stands last before the pill - #tabs, or `»` once it shows - so
  // #tabs's own width is the room left; the strip's 8 px flex gap before a shown pill counts toward it
  const tail = `${pillEl.hidden ? DRAG_GAP : DRAG_GAP - STRIP_GAP}px`
  tabsEl.style.marginRight = tail
  moreEl.style.removeProperty('margin-right')
  const homeEl = els.get(shownTabs().find((t) => t.kind === 'home')?.id ?? '')
  const homeW = homeEl ? homeEl.offsetWidth + HOME_ALLOWANCE : 0
  const n = tabs.length
  hiddenIds = []
  let shownEls = tabEls
  if (n && n * MIN + (n - 1) * GAP > listWidth() - homeW) {
    moreEl.hidden = false   // a sibling of #tabs: the list is narrower now (its 30 px and the strip's gap); read it again
    tabsEl.style.removeProperty('margin-right')
    moreEl.style.marginRight = tail
    const m = Math.max(1, Math.floor((listWidth() - homeW + GAP) / (MIN + GAP)))
    const ai = tabs.findIndex((t) => t.id === snap!.active)
    const keep = new Set<number>()
    if (ai >= 0) keep.add(ai)
    for (let i = 0; i < n && keep.size < m; i++) keep.add(i)
    tabs.forEach((t, i) => { if (!keep.has(i)) { tabEls[i].hidden = true; hiddenIds.push(t.id) } })
    shownEls = tabEls.filter((_, i) => keep.has(i))
  }
  if (hiddenIds.length) {
    const allCanvases = hiddenIds.every((id) => { const k = snap!.tabs.find((t) => t.id === id)?.kind; return k === 'local' || k === 'remote' })
    const c = hiddenIds.length
    const what = allCanvases ? (c === 1 ? 'canvas' : 'canvases') : (c === 1 ? 'tab' : 'tabs')
    fill(moreEl, '»', h('span', { 'aria-hidden': 'true' }, String(c)))
    moreEl.setAttribute('aria-label', `${c} more ${what}`)
  } else if (!moreEl.hidden) { moreEl.hidden = true; moreEl.style.removeProperty('margin-right'); tabsEl.style.marginRight = tail }
  const k = shownEls.length
  if (k) {
    const W = listWidth()
    const room = W - homeW - GAP * (k - 1)
    const share = Math.min(SHARE_MAX, Math.max(MIN, room / k))
    const on = shownEls.find((e) => e.dataset.id === snap!.active) ?? null
    let aw = share
    if (on) {
      const natural = naturalWidth(on)
      if (natural > share) aw = Math.min(ACTIVE_MAX, natural, room - (k - 1) * MIN)
    }
    const tw = k > 1 ? Math.min(SHARE_MAX, Math.max(MIN, (room - aw) / (k - 1))) : share
    const awOut = Math.max(aw, tw)
    tabsEl.style.setProperty('--tw', `${tw}px`)
    tabsEl.style.setProperty('--aw', `${awOut}px`)
    for (const e of shownEls) e.classList.toggle('compact', (e === on ? awOut : tw) < COMPACT)
  }
  rove()
}

/** One tab holds tabindex 0: the focused one while focus is in the list, else the active one. */
function rove(): void {
  const vis = visibleEls()
  const target = focusId && vis.some((e) => e.dataset.id === focusId) ? focusId : snap?.active
  let any = false
  for (const e of vis) { const on = e.dataset.id === target; e.tabIndex = on ? 0 : -1; any ||= on }
  if (!any && vis[0]) vis[0].tabIndex = 0
  for (const id of hiddenIds) els.get(id)!.tabIndex = -1
}

function announceTabs(): void {
  if (!snap) return
  const now = Date.now()
  // only what a sighted person would notice: a tab the strip shows (a closed one is Home's, and says nothing here)
  const shownNow = shownTabs()
  const ids = new Set(shownNow.map((t) => t.id))
  for (const id of [...lastState.keys()]) if (!ids.has(id)) lastState.delete(id)
  for (const t of shownNow) {
    const before = lastState.get(t.id)
    lastState.set(t.id, t.state)
    if (tabsBaseline || before === undefined || before === t.state) continue
    const words = t.state === 'gone' ? `${shownName(t)} stopped` : t.state === 'crashed' ? `${shownName(t)} crashed` : null
    if (!words || now - (announcedAt.get(t.id) ?? -Infinity) < ANNOUNCE_EVERY) continue
    announcedAt.set(t.id, now)
    say(live, words)
  }
  announceNeeds(shownNow, now)
  tabsBaseline = false
}

/** "<name> needs you" when a tab's count rises (A4.6 #19, A2.13): never for the first marks seen of a tab, once a minute at most. */
function announceNeeds(shownNow: TabView[], now: number): void {
  for (const t of needsRisen(needs, shownNow, now, tabsBaseline, ANNOUNCE_EVERY)) say(live, `${shownName(t)} needs you`)
}

function renderPill(): void {
  if (!pill) { pillEl.hidden = true; fill(pillEl); pillEl.removeAttribute('aria-label'); fit(); return }
  const p = pill
  const narrow = window.innerWidth < NARROW
  const words = narrow ? p.short : [p.lead, p.text].filter(Boolean).join(' ')
  pillEl.hidden = false
  pillEl.className = ['pill', p.kind, p.button?.style === 'accent' && 'accent', (p.button || p.dismissible) && 'has-btn'].filter(Boolean).join(' ')
  pillEl.setAttribute('aria-label', words)
  if (p.tooltip) pillEl.title = p.tooltip
  else pillEl.removeAttribute('title')
  const txt = narrow
    ? h('span', { class: 'pill-txt' }, h('b', {}, p.short))
    : h('span', { class: 'pill-txt' }, p.lead ? h('b', {}, p.lead) : null, p.text ? ` ${p.text}` : null)
  const act = () => api?.pillAction({ rev: p.rev, act: 'button' })
  let btn: HTMLElement | null = null
  if (p.button) {
    // the cmd pill is the active tab's own (A2.2 tier 1): named for it (A2.13). A send main may refuse for an old
    // rev, so it never says "Copied"
    const active = snap?.tabs.find((t) => t.id === snap!.active)
    const cmdLabel = active?.kind === 'local' ? `Copy the start command for ${shownName(active)}` : 'Copy the start command'
    btn = p.button.style === 'cmd'
      ? cmdButton(p.button.label, cmdLabel, () => { act(); return false })
      : h('button', { class: 'pill-btn', type: 'button', onclick: act }, p.button.label)
  }
  const x = p.dismissible
    ? h('button', { class: 'pill-x', type: 'button', 'aria-label': 'Not now', title: 'Not now', onclick: () => api?.pillAction({ rev: p.rev, act: 'dismiss' }) }, icon('x', 11))
    : null
  fill(pillEl, p.icon === 'check' ? icon('check', 12) : null, txt, btn, x)
  fit()
}

pillEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pill?.dismissible) { e.preventDefault(); api?.pillAction({ rev: pill.rev, act: 'dismiss', via: 'key' }) }
})

// ---- the Marver menu (spec 32 B3-B14) ------------------------------------------------------------------------------

/** an ask sent (B3.1), no view or refusal back yet */
type Ask = { opener: HTMLElement; key: boolean; hadFocus: boolean; timer: ReturnType<typeof setTimeout> }
/** every ask still unanswered, oldest first: main answers each in turn, with a view or a refusal (B2), so each answer
 *  takes the oldest; a later answer still opens by how its own ask was made (B3.4, B14.1) */
const asks: Ask[] = []
/** an unanswered ask was made from `el` */
const askedBy = (el: HTMLElement | null): boolean => !!el && asks.some((a) => a.opener === el)
/** the oldest ask, answered now (a view or a refusal): its timer goes */
function answered(): Ask | undefined {
  const a = asks.shift()
  if (a) clearTimeout(a.timer)
  return a
}
/** the menu main sent: its rev, the handle, who opened it and how; `waiting` until the view has grown and it shows */
let menu: { rev: number; handle: MenuHandle; opener: HTMLElement | null; key: boolean; hadFocus: boolean; waiting: boolean } | null = null
/** a menu closed while the view is still grown: `body.menu-open` stays until the view is 44 px again (B11) */
let closing = false
/** B3.1: did the strip hold keyboard focus before this press moved it? Read in the capture phase of each pointerdown */
let pressHadFocus = false
/** where the last secondary press landed: B11's hand-back opens that tab's menu where it was made */
let lastSecondary: { x: number; y: number } | null = null

document.addEventListener('pointerdown', (e) => {
  // the strip holds focus while its menu is open (its rows live in the body, beside #strip)
  pressHadFocus = !!menu || (document.hasFocus() && stripEl.contains(document.activeElement))
  if (e.button === 2 || (e.button === 0 && e.ctrlKey)) lastSecondary = { x: e.clientX, y: e.clientY }
}, true)

const openers = (): HTMLElement[] => [moreEl, ...els.values()]
/** every mark of an open menu gone: no `body.menu-open`, no opener's look (a refusal, a dropped send, a shrink) */
function dropMarks(): void {
  document.body.classList.remove('menu-open')
  for (const e of openers()) e.classList.remove('menu-open')
}

/** B3.1: the strip draws as open from the ask (no drag, the opener's look, A5.5), and gives up after 1 s unanswered */
function marked(opener: HTMLElement, how: MenuAsk): void {
  closing = false
  document.body.classList.add('menu-open')
  opener.classList.add('menu-open')
  const a: Ask = {
    opener, key: how.key, hadFocus: how.hadFocus,
    timer: setTimeout(() => {
      const i = asks.indexOf(a)
      if (i < 0) return
      asks.splice(i, 1)   // a send main dropped (a strip not ready, B1.2): no view and no refusal came
      if (!menu && !asks.length) dropMarks()
      else opener.classList.toggle('menu-open', opener === menu?.opener || askedBy(opener))
    }, ASK_FALLBACK_MS),
  }
  asks.push(a)
}
function askTab(el: HTMLElement, x: number, y: number, how: MenuAsk): void {
  const id = el.dataset.id
  if (!id || !el.classList.contains('tab')) return   // Home has no menu: never asked for (B3.1, B4)
  marked(el, how)
  api?.tabMenu(id, Math.round(x), Math.round(y), how)
}
function askMore(how: MenuAsk): void {
  if (moreEl.hidden || !hiddenIds.length) return
  marked(moreEl, how)
  const r = moreEl.getBoundingClientRect()
  api?.more({ ids: [...hiddenIds], x: Math.round(r.left), y: Math.round(r.bottom), ...how })
}

/** the rows as the component draws them: an icon only by a name dom.ts knows (never a path) */
const rowsOf = (v: TabMenuView): MenuRow[] => (Array.isArray(v.rows) ? v.rows : []).map((r): MenuRow => (r.kind === 'sep' ? { kind: 'sep' } : {
  kind: 'item', id: String(r.id), label: String(r.label), enabled: r.enabled === true,
  ...(r.icon && (ICON_NAMES as string[]).includes(r.icon) ? { icon: r.icon as IconName } : {}),
  ...(typeof r.checked === 'boolean' ? { checked: r.checked } : {}),
}))

/** where a view the strip never asked for opened (a test hook calls main's handler directly, B15): », or the tab at x */
function openerAt(v: TabMenuView): HTMLElement | null {
  if (v.kind === 'more') return moreEl
  return visibleEls().find((e) => { const r = e.getBoundingClientRect(); return e.classList.contains('tab') && v.x >= r.left - 0.5 && v.x <= r.right + 0.5 }) ?? null
}

function showMenu(v: TabMenuView): void {
  const was = menu
  const by = answered()
  const opener = by?.opener ?? openerAt(v)
  // a newer view replaces the menu with no null pick and no shrink between (B3.2, B11)
  if (was) { menu = null; was.handle.close(); if (was.opener && was.opener !== opener && !askedBy(was.opener)) was.opener.classList.remove('menu-open') }
  closing = false
  document.body.classList.add('menu-open')   // also for a view it never asked for (B11)
  opener?.classList.add('menu-open')
  const rev = v.rev
  const key = by?.key ?? false
  const hadFocus = by?.hadFocus ?? false
  const handle = openMenu(document.body, {
    rows: rowsOf(v), at: { x: Number(v.x) || 0, y: Number(v.y) || 0 }, top: STRIP_H, solid: true, focusFirst: key, defer: true,
    opener, openers: '.tab, #more',
    onPick: (id) => { ended(rev); api?.menuPick({ rev, id }) },
    onClose: () => { ended(rev); api?.menuPick({ rev, id: null }) },
    // B11: a right-click on another tab, or on », through the catcher: its own menu replaces this one, no null pick
    onSecondary: (el) => {
      if (el === moreEl) { askMore({ key: false, hadFocus: true }); return }
      const r = el.getBoundingClientRect()
      askTab(el as HTMLElement, lastSecondary?.x ?? r.left, lastSecondary?.y ?? r.bottom, { key: false, hadFocus: true })
    },
  })
  menu = { rev, handle, opener, key, hadFocus, waiting: true }
  if (window.innerHeight > STRIP_H) void reveal()   // already grown (a replace: main does not shrink between, B3.3)
}

/** B3.3: shown only in a grown view, one frame after it grew (rAF or 50 ms); then said (B3.5) */
async function reveal(): Promise<void> {
  const m = menu
  if (!m || !m.waiting) return
  m.waiting = false
  await m.handle.show()
  if (menu === m && m.handle.open) api?.menuShown({ rev: m.rev })
}

/** B12, B14: the menu of `rev` closed (a pick, Escape, Tab, an outside press, or main) */
function ended(rev: number): void {
  const m = menu
  if (!m || m.rev !== rev) return
  menu = null
  // the opener's look lasts until the pick (A5.5); no drag lasts until the view is 44 px again (B11)
  if (m.opener && !askedBy(m.opener)) m.opener.classList.remove('menu-open')
  if (!asks.length) {
    if (window.innerHeight > STRIP_H) closing = true
    else document.body.classList.remove('menu-open')
  }
  // B14.1, B14.2: opened by key, or while the strip held focus, its opener takes focus back; otherwise main gives it
  // back to what had it (focusShown) and the strip keeps none
  if ((m.key || m.hadFocus) && m.opener?.isConnected && !m.opener.hidden) m.opener.focus({ preventScroll: true })
}

function onMenuView(v: TabMenuView | null): void {
  if (v) { showMenu(v); return }
  if (menu) {
    // main closed it (B12), or refused a replacement asked through the catcher (B2, B11): the oldest ask still pending
    // is answered by this null too, so its opener's look and its timer go now; no drag stays until the view is 44 px
    const a = answered()
    if (a && a.opener !== menu.opener && !askedBy(a.opener)) a.opener.classList.remove('menu-open')
    // hidden at once, then the null pick that lets main shrink the view
    const { rev, handle } = menu
    handle.close()
    ended(rev)
    api?.menuPick({ rev, id: null })
    return
  }
  // main's close crossing a local one (B11, B12): the menu was shown and the view is still grown, so no drag stays
  // until the ResizeObserver reads 44 px (`closing` is never set while an ask is pending: marked() clears it)
  if (closing && window.innerHeight > STRIP_H) return
  // main refused the ask (B2): nothing was shown, so the marks go at once; an ask still pending behind it keeps its own
  const a = answered()
  if (a && asks.length) { a.opener.classList.toggle('menu-open', askedBy(a.opener)); return }
  closing = false
  dropMarks()
}

// ---- the keyboard model (A2.13, A14) -------------------------------------------------------------------------------

tabsEl.addEventListener('focusin', (e) => { focusId = idOf(e.target as Element); rove() })
tabsEl.addEventListener('focusout', (e) => {
  if (!tabsEl.contains(e.relatedTarget as Node | null)) { focusId = null; rove() }
})

/** ContextMenu and ⇧F10 (A14): the tab's menu at its left and bottom, by key (the strip has focus) */
function menuAt(el: HTMLElement): void {
  const r = el.getBoundingClientRect()
  askTab(el, r.left, r.bottom, { key: true, hadFocus: true })
}

tabsEl.addEventListener('keydown', (e) => {
  const vis = visibleEls()
  const cur = (e.target as HTMLElement).closest('[role="tab"]') as HTMLElement | null
  if (!cur || !vis.length) return
  const i = vis.indexOf(cur)
  const id = cur.dataset.id!
  const tab = snap?.tabs.find((t) => t.id === id)
  let go: HTMLElement | undefined
  switch (e.key) {
    case 'ArrowRight': go = vis[(i + 1) % vis.length]; break
    case 'ArrowLeft': go = vis[(i - 1 + vis.length) % vis.length]; break
    case 'Home': go = vis[0]; break
    case 'End': go = vis[vis.length - 1]; break
    case 'Enter': case ' ': api?.activate(id, 'key'); break
    case 'Delete': case 'Backspace': if (tab && tab.kind !== 'home') api?.close(id); break
    case 'ContextMenu': menuAt(cur); break
    case 'F10': if (e.shiftKey) { menuAt(cur); break } return
    default: return
  }
  e.preventDefault()
  if (go) { focusId = go.dataset.id ?? null; rove(); go.focus() }
})

tabsEl.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('[role="tab"]') as HTMLElement | null
  if (el?.dataset.id) api?.activate(el.dataset.id)
})
tabsEl.addEventListener('contextmenu', (e) => {
  const el = (e.target as HTMLElement).closest('[role="tab"]') as HTMLElement | null
  e.preventDefault()
  // B3.1: Home has no menu; the focus reading is the one taken before the press moved focus
  if (el && !el.classList.contains('home')) askTab(el, e.clientX, e.clientY, { key: false, hadFocus: pressHadFocus })
})
// » (A4, B5): a click (by key, Enter or Space, a click with no pointer: detail 0) and a right-click open its menu
moreEl.addEventListener('click', (e) => { askMore(e.detail === 0 ? { key: true, hadFocus: true } : { key: false, hadFocus: pressHadFocus }) })
moreEl.addEventListener('contextmenu', (e) => { e.preventDefault(); askMore({ key: false, hadFocus: pressHadFocus }) })

/** A3: the width alone refits; a change of height (a menu's grow and shrink, B1) shows or retires the menu only */
let lastWidth = -1
new ResizeObserver(() => {
  const tall = window.innerHeight > STRIP_H
  if (tall && menu?.waiting) void reveal()
  if (!tall && closing && !menu) { closing = false; if (!asks.length) document.body.classList.remove('menu-open') }
  // B7.1-B7.3: a shown menu is placed again for the new size (a window resized or made full screen while it is open),
  // so it stays clamped 14 px inside both edges and capped by the room it has
  else if (tall && menu && !menu.waiting) menu.handle.place()
  if (window.innerWidth === lastWidth) return
  lastWidth = window.innerWidth
  if (pill) renderPill(); else fit()
}).observe(document.body)

// ---- what main sends ---------------------------------------------------------------------------------------------

setLook(undefined)
shown()
if (api) {
  let firstTabsAt: number | null = null
  api.onTabs((s) => {
    const before = snap
    snap = s
    firstTabsAt ??= Date.now()
    renderTabs()
    announceTabs()
    // the active tab's name in the pill's button
    if (pill?.button?.style === 'cmd' && before?.active !== s.active) renderPill()
  })
  api.onPill((p) => {
    const fresh = !!p && (!pill || p.rev !== pill.rev) && [p.lead, p.text].join(' ') !== [pill?.lead, pill?.text].join(' ')
    // found at launch: the first pill message (main sends one, null when none, at app:ready), or one that comes
    // within a second of the first tabs snapshot without a null before it
    const launch = pillBaseline && (p === null || firstTabsAt === null || Date.now() - firstTabsAt < LAUNCH_PILL_MS)
    pill = p
    renderPill()
    if (fresh && !launch) say(live, [p!.lead, p!.text].filter(Boolean).join(' '))
    pillBaseline = false
  })
  api.onWindow((w: WindowView) => {
    document.body.classList.toggle('inactive', !w.focused)
    document.body.classList.toggle('fullscreen', w.fullScreen)
    document.body.classList.toggle('dots', w.dots === true)   // app 0.1's cover covers: its still dots, until S15 (A3.8 #3)
    document.body.classList.toggle('immersive', w.immersive === true)   // spec 32 C10: no drag, then the strip runs out
    document.body.classList.toggle('band', w.band === true)   // C9 amendment: the 16 px band - no controls, the body drags
  })
  api.onPageFocus((f) => {
    if (f.target !== 'active-tab' || !snap) return
    if (menu || asks.length) return   // B14: the menu holds focus while it is open
    focusId = null
    rove()
    els.get(snap.active)?.focus()
  })
  api.onTabMenu(onMenuView)
  api.ready()
}
