/**
 * The strip (spec 28 A2.2, A2.4, A2.13, A2.14 #19, #26; frames mac-app/01-06, 11): Home, the tab list, `»` and the
 * one pill, over main's cover. Served as marver-app://strip/. It draws what main sends - `tabs`, `pill`, `window`,
 * `page:focus` - and says what was chosen; it holds no state of its own beyond focus and what fits.
 *
 * - **A tab list** (A2.13): `role="tablist"` "Canvases", Home and every open tab as `role="tab"` with
 *   `aria-selected`, named for what the eye reads ("TMS broker, stopped"), `aria-keyshortcuts` its key. One tab holds
 *   `tabindex="0"`; Left and Right move focus (wrapping), Home and End to the ends - arrows never switch; Return and
 *   Space activate, Delete and Backspace close, the context-menu key and ⇧F10 open its menu.
 * - **Fitting** (A2.2, A2.14 #19): the strip fits the tabs itself, 58-176 px, the active one always whole; what does
 *   not fit goes behind `»` (`tabs:more` with the ids, main pops a native menu). The pill takes its room first and
 *   shows its short form below 960 px.
 * - **The look**: the active tab's own (`TabView.dark`), else the app's theme.
 * - **Names**: an unverified tab by its address, never a name it has not proved ("localhost:4808, not a Marver
 *   canvas", A2.13; frame mac-app/05).
 * - **Announcements**: a polite live region says a tab shown in the strip that stopped or crashed, at most once per
 *   tab per minute, and each new pill - nothing for what was found at launch: the first `tabs` snapshot, and the
 *   pill main sends with it at `app:ready` (null when none; a pill within a second of that first snapshot counts as
 *   found at launch when main sent no null). Words that arrive together are said together.
 */
import type { PillView, TabsSnapshot, TabView, WindowView } from '../../src/shared/channels.ts'
import { cmdButton, fill, h, hostOf, icon, logo, pageApi, say, setLook, shown } from '../../src/pages/dom.ts'

const api = pageApi('strip')
const tabsEl = document.getElementById('tabs') as HTMLElement
const moreEl = document.getElementById('more') as HTMLButtonElement
const pillEl = document.getElementById('pill') as HTMLElement
const live = document.getElementById('live') as HTMLElement

const GAP = 8
const MIN_TAB = 58
const NARROW = 960
const ANNOUNCE_EVERY = 60_000

let snap: TabsSnapshot | null = null
let pill: PillView | null = null
let hiddenIds: string[] = []
let focusId: string | null = null
const els = new Map<string, HTMLElement>()
const lastState = new Map<string, string>()
const announcedAt = new Map<string, number>()
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
const nameOf = (t: TabView) => (t.kind === 'home' ? 'Home' : WORDS[t.state] ? `${shownName(t)}, ${WORDS[t.state]}` : shownName(t))
const shownTabs = (): TabView[] => (snap?.tabs ?? []).filter((t) => t.kind === 'home' || t.open !== false)
const visibleEls = (): HTMLElement[] => shownTabs().map((t) => els.get(t.id)).filter((e): e is HTMLElement => !!e && !e.hidden)
const idOf = (el: Element | null) => (el as HTMLElement | null)?.dataset?.id ?? null

function slotFor(t: TabView): HTMLElement {
  const slot = h('span', { class: 'slot', 'aria-hidden': 'true' })
  if (t.kind === 'settings') slot.append(icon('gear', 15, 'gear'))
  else if (t.state === 'starting') slot.append(h('i', { class: 'spin' }))
  else if (t.state === 'unverified') slot.append(icon('warning', 16, 'warn'))   // never a logo for a canvas not proven
  else slot.append(logo(t, 18))
  return slot
}

function paintTab(el: HTMLElement, t: TabView, active: boolean): void {
  el.dataset.id = t.id
  el.setAttribute('role', 'tab')
  el.setAttribute('aria-selected', String(active))
  el.setAttribute('aria-label', nameOf(t))
  if (t.kind === 'home') {
    el.className = `home${active ? ' on' : ''}`
    el.setAttribute('aria-keyshortcuts', 'Meta+T')
    el.title = 'Home ⌘T'
    fill(el, icon('house', 15))
    return
  }
  el.className = ['tab', active && 'on', t.state !== 'live' && t.state !== 'hidden' && t.state !== 'none' && `is-${t.state}`].filter(Boolean).join(' ')
  if (t.key) el.setAttribute('aria-keyshortcuts', `Meta+${t.key}`)
  else el.removeAttribute('aria-keyshortcuts')
  el.removeAttribute('title')
  fill(el, slotFor(t), h('span', { class: 'name' }, shownName(t)), t.key ? h('kbd', { class: 'key', 'aria-hidden': 'true' }, `⌘${t.key}`) : null)
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
  fit()
}

/** What fits (A2.14 #19): every tab at its own width, else the active one whole, others from 58 px, the rest behind `»`. */
function fit(): void {
  if (!snap) return
  const tabs = shownTabs().filter((t) => t.kind !== 'home')
  const tabEls = tabs.map((t) => els.get(t.id)!)
  for (const e of tabEls) e.hidden = false
  moreEl.hidden = true
  tabsEl.classList.add('measure')
  const natural = tabEls.map((e) => e.getBoundingClientRect().width)
  tabsEl.classList.remove('measure')
  const homeEl = els.get(shownTabs().find((t) => t.kind === 'home')?.id ?? '')
  const homeW = homeEl ? homeEl.getBoundingClientRect().width + GAP : 0
  const avail = tabsEl.getBoundingClientRect().width - homeW
  const sum = natural.reduce((a, w) => a + w, 0) + Math.max(0, natural.length - 1) * GAP
  hiddenIds = []
  if (sum > avail && tabs.length) {
    moreEl.hidden = false
    fill(moreEl, '»', h('span', {}, '0'))
    const room = tabsEl.getBoundingClientRect().width - homeW   // less now that » shows
    const ai = tabs.findIndex((t) => t.id === snap!.active)
    // each other tab costs at least 58 px and a gap; the active one its whole width
    const k = Math.max(0, ai >= 0 ? Math.floor((room - natural[ai]) / (MIN_TAB + GAP)) : Math.floor((room + GAP) / (MIN_TAB + GAP)))
    let shownOthers = 0
    tabs.forEach((t, i) => {
      if (i === ai) return
      if (shownOthers < k) shownOthers++
      else { tabEls[i].hidden = true; hiddenIds.push(t.id) }
    })
    if (!hiddenIds.length) moreEl.hidden = true
  }
  if (hiddenIds.length) {
    const allCanvases = hiddenIds.every((id) => snap!.tabs.find((t) => t.id === id)?.kind === 'local')
    const n = hiddenIds.length
    const what = allCanvases ? (n === 1 ? 'canvas' : 'canvases') : (n === 1 ? 'tab' : 'tabs')
    fill(moreEl, '»', h('span', { 'aria-hidden': 'true' }, String(n)))
    moreEl.setAttribute('aria-label', `${n} more ${what}`)
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
  tabsBaseline = false
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
  if (e.key === 'Escape' && pill?.dismissible) { e.preventDefault(); api?.pillAction({ rev: pill.rev, act: 'dismiss' }) }
})

// ---- the keyboard model (A2.13) ----------------------------------------------------------------------------------

tabsEl.addEventListener('focusin', (e) => { focusId = idOf(e.target as Element); rove() })
tabsEl.addEventListener('focusout', (e) => {
  if (!tabsEl.contains(e.relatedTarget as Node | null)) { focusId = null; rove() }
})

function menuAt(el: HTMLElement): void {
  const r = el.getBoundingClientRect()
  const id = el.dataset.id
  if (id) api?.tabMenu(id, Math.round(r.left), Math.round(r.bottom))
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
    case 'Enter': case ' ': api?.activate(id); break
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
  if (el?.dataset.id) api?.tabMenu(el.dataset.id, Math.round(e.clientX), Math.round(e.clientY))
})
moreEl.addEventListener('click', () => {
  const r = moreEl.getBoundingClientRect()
  api?.more({ ids: [...hiddenIds], x: Math.round(r.left), y: Math.round(r.bottom) })
})

new ResizeObserver(() => { if (pill) renderPill(); else fit() }).observe(document.body)

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
  })
  api.onPageFocus((f) => {
    if (f.target !== 'active-tab' || !snap) return
    focusId = null
    rove()
    els.get(snap.active)?.focus()
  })
  api.ready()
}
