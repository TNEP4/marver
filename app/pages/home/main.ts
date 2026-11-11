/**
 * Home v2 (spec 32 Part D; design scenes home-v2/). Served as marver-app://home/. It draws `tabs`, `recent`, `shared`
 * and `home:info`, and asks main for everything else by name: a card activates its tab, a menu row names an action
 * and a card id (`home:action`), the link field sends what was typed (`link:open`) and draws the answer. Home names
 * which command or which card, never a path or a command's text.
 *
 * - **The page** (D1-D7): the brand, the link field, View (Grid or Board, kept in `localStorage['mv.home.view']`,
 *   Board first) and Help; the grid's three sections or the board's five columns and its shared chips. What each card
 *   is and says is model.ts's (D6).
 * - **Menus** (D8): the shared Marver menu (src/pages/menu.ts) in Home's glass, in one top layer `#hm-layer` that the
 *   render never touches, one at a time: a card's more button (below it, right-aligned), a right-click at the pointer,
 *   a chip's right-click (upward), the View menu; Help is a card in the same layer. Escape, window blur, an outside
 *   press, a tab switch and a scroll the person made close them; Home's own scrolls (a restore, a deep-linked card
 *   scrolled into view, a focus) never do (`ownScroll`), nor does a window resize: every open menu re-anchors.
 * - **UI state outside the DOM** (D11): the view, the open menu (its card id and anchor), the View menu, Help and the
 *   focus key live in `ui`; every render rebuilds the body, then rebuilds an open card menu from the card as it is now
 *   (closed when the card is gone), re-anchors it, restores focus by `data-key`, the scroll offsets by `data-scroll`,
 *   and puts the one link field (made once) back into its slot with its focus, selection and draft.
 * - **The link field** (D3): Return opens (`link:open`, one at a time), Escape goes back to the tab ⌘L came from, a
 *   `marver:` link reads "↩ opens <folder>" and goes to main's deep-link handler.
 * - **The empty state is the welcome** (D10): no local canvas, no recent, no shared canvas.
 */
import type { HomeInfo, HomeKeys, LinkOpenAnswer, RecentView, SharedLink, TabsSnapshot, TabView } from '../../src/shared/channels.ts'
import { parseLink } from '../../src/shared/links.ts'
import { ago, appMark, fill, h, icon, logo, pageApi, portOf, say, setLook, shown } from '../../src/pages/dom.ts'
import { frame, openMenu, type MenuAt, type MenuHandle, type MenuPick, type MenuRow } from '../../src/pages/menu.ts'
import { COLS, COPY_ROWS, deepFolder, homeModel, lineText, menuRows, viewOf, type CardModel, type HomeModel, type RowId } from './model.ts'

const api = pageApi('home')
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const rootEl = $('hm-root')
const layer = $('hm-layer')
const live = $('live')

let snap: TabsSnapshot | null = null
let recent: RecentView[] = []
let shared: SharedLink[] = []
let info: HomeInfo = { welcome: false, writable: true }
let model: HomeModel = homeModel({ snap, recent, shared, now: Date.now(), ago })
let back: string | undefined
/** the answer to the last Return, while the field still holds what was sent; `host` a shared canvas's */
let answer: { why: Exclude<LinkOpenAnswer, { ok: true }>['why']; sent: string; port: number | null; host: string | null } | null = null

const VIEW_KEY = 'mv.home.view'
const readView = (): 'grid' | 'board' => { try { return viewOf(localStorage.getItem(VIEW_KEY)) } catch { return 'board' } }
const writeView = (v: 'grid' | 'board') => { try { localStorage.setItem(VIEW_KEY, v) } catch { /* kept for this run only */ } }

/** Where an open card menu is anchored: its card's more button, or the pointer (a right-click), upward for a chip. */
type Anchor = { kind: 'more' } | { kind: 'pointer'; at: MenuAt }
interface OpenCardMenu { id: string; anchor: Anchor; handle: MenuHandle; byKey: boolean; chip: boolean; copying: boolean; opener: string | null }
/** D11: Home's UI state, kept outside the DOM the render rebuilds. */
const ui: { view: 'grid' | 'board'; menu: OpenCardMenu | null; viewMenu: MenuHandle | null; viewByKey: boolean; help: boolean; highlight: string | null } = {
  view: readView(), menu: null, viewMenu: null, viewByKey: false, help: false, highlight: null,
}
/** the current deep-link focus request (D8.7): any dismissal (closeAll, an Escape, a press) makes a pending one stale */
let focusGen = 0
/** a deep-linked card's menu is waiting for its scroll to land (D8.7) */
let focusPending = false

// ---- Home's own scrolls (D8.6) ----------------------------------------------------------------------------------

/** set while Home itself scrolls (a restore, a deep-linked card scrolled into view, a focus); cleared two frames later */
let ownScrolls = 0
/** the offsets Home itself set, by scroller: the next scroll event that finds them unchanged is Home's own too. Each
 *  is used once - matched or not, the scroller's next scroll event drops it - so a person who scrolls away and back
 *  to an offset Home once set is still the person scrolling. */
const ownAt = new WeakMap<Element, [number, number]>()
const SCROLLERS = '.hm-body, .hm-col-list, .hm-shared, .hm-empty'
function noteOwn(): void { for (const el of rootEl.querySelectorAll(SCROLLERS)) ownAt.set(el, [el.scrollTop, el.scrollLeft]) }
/** Runs `fn` (which scrolls) as Home's own scroll; `after` once the flag clears, and every open menu re-anchors then. */
function ownScroll(fn: () => void, after?: () => void): void {
  ownScrolls += 1
  try { fn() } finally { noteOwn() }
  void frame().then(frame).then(() => {
    ownScrolls -= 1
    reanchor()
    after?.()
  })
}

// ---- the link field: one node for the page's life (D11.3) -----------------------------------------------------------

const input = h('input', {
  id: 'link', type: 'text', maxlength: '2048', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
  placeholder: 'Open a canvas link', 'aria-label': 'Open a canvas link', 'aria-describedby': 'hint',
})
const kbd = h('span', { class: 'hm-kbd', 'aria-hidden': 'true' }, '⌘L')
const hintEl = h('span', { id: 'hint', class: 'hm-hint-text' })
const backEl = h('span', { class: 'hm-back' })
const field = h('div', { class: 'hm-field' },
  h('label', { class: 'hm-link' }, icon('link', 14), input, kbd),
  h('div', { class: 'hm-hint' }, hintEl, backEl))

// ---- reading the tabs ---------------------------------------------------------------------------------------------

const canvases = (): TabView[] => (snap?.tabs ?? []).filter((t) => t.kind === 'local')
const remotes = (): TabView[] => (snap?.tabs ?? []).filter((t) => t.kind === 'remote')
const originOf = (u?: string): string | null => { try { return u ? new URL(u).origin : null } catch { return null } }
const remoteOn = (url: string): TabView | undefined => remotes().find((t) => originOf(t.link) === originOf(url))
const nameOf = (t: TabView): string => (t.state === 'unverified' ? (t.link ? new URL(t.link).host : t.name) : t.name)
const backTab = (): TabView | undefined => (back ? snap?.tabs.find((t) => t.id === back && t.open !== false) : undefined)
const tabOnPort = (port: number) => canvases().find((t) => portOf(t.link) === port && t.state !== 'gone')
  ?? canvases().find((t) => portOf(t.link) === port)
const possessive = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`)
/** Home is on screen: the snapshot's active tab is Home (a strip click or ⌘1-9 switches away, D8.6). */
const homeActive = (): boolean => { const a = snap?.tabs.find((t) => t.id === snap!.active); return !a || a.kind === 'home' }

// ---- the cards ----------------------------------------------------------------------------------------------------

const keysOf = (how?: MenuPick): { via: 'key'; keys?: HomeKeys } | Record<string, never> => (how?.via === 'key' ? { via: 'key', ...(how.keys ? { keys: how.keys } : {}) } : {})

/** A card's own activation (D8.2, D8.8): its tab shown, or a past shared link opened again; by key with its key. */
function activateCard(c: CardModel, how?: MenuPick): void {
  if (c.kind === 'past') { if (c.url) void open(c.url, how?.via === 'key' ? { via: 'key', keys: how.keys ?? 'Enter' } : { via: 'click' }); return }
  if (how?.via === 'key') api?.activate(c.id, 'key', how.keys ? { keys: how.keys } : undefined)
  else api?.activate(c.id)
}

/** A card's click (D8.2): a running or shared card opens, a not-running card opens its menu at its more button. */
function cardClick(c: CardModel): void {
  if (c.opens) activateCard(c)
  else openCardMenu(c.id, { kind: 'more' }, false)
}

function cardKey(e: KeyboardEvent, c: CardModel): void {
  if (e.target !== e.currentTarget) return
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    if (c.opens) activateCard(c, { via: 'key', keys: e.key === 'Enter' ? 'Enter' : 'Space' })
    else openCardMenu(c.id, { kind: 'more' }, true)
  } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
    e.preventDefault()
    openCardMenu(c.id, c.col === 'shared' && ui.view === 'board' ? chipKeyAnchor(c.id) : { kind: 'more' }, true)
  }
}

function logoOf(c: CardModel, size: number): HTMLElement {
  if (c.warn) {
    const w = h('span', { class: 'hm-warn', 'aria-hidden': 'true' }, icon('warning', Math.round(size * 0.6)))
    w.style.width = w.style.height = `${size}px`
    return w
  }
  return logo(c.logo, size, { round: true, plate: 0.88 })
}

function lineEl(c: CardModel): HTMLElement {
  const l = c.line
  return h('div', { class: 'hm-line' },
    !l.num && l.dot && c.col !== 'shared' ? h('i', { class: `hm-dot ${l.dot}`, 'aria-hidden': 'true' }) : null,
    h('span', { class: 'hm-ell' }, l.num ? h('b', { class: `hm-num ${l.num.tone}` }, String(l.num.n)) : null, l.text))
}

/** A card (D5): `div role=button` named "<name>, <line>", its more button a real button. */
function cardEl(c: CardModel, board: boolean): HTMLElement {
  const open = ui.menu?.id === c.id
  const label = `${c.name}, ${lineText(c.line)}`
  const cls = `hm-card${c.off && !(board && c.col === 'shared') ? ' hm-off' : ''}${open || ui.highlight === c.id ? ' hov' : ''}${open ? ' menu-open' : ''}`
  return h('div', {
    class: cls, role: 'button', tabindex: '0', 'aria-label': label, 'data-key': `card:${c.id}`, 'data-card': c.id,
    onclick: () => cardClick(c),
    oncontextmenu: (e: Event) => cardContext(e as MouseEvent, c.id),
    onkeydown: (e: Event) => cardKey(e as KeyboardEvent, c),
  },
  h('div', { class: 'hm-row' },
    logoOf(c, board ? 30 : 36),
    h('div', { class: 'hm-txt' },
      h('div', { class: 'hm-top' },
        h('div', { class: 'hm-name' }, c.name),
        h('div', { class: 'hm-end' },
          h('button', {
            class: `hm-more-btn${open ? ' on' : ''}`, type: 'button', title: 'More', 'aria-label': `More for ${c.name}`,
            'aria-haspopup': 'menu', 'aria-expanded': String(open), 'data-key': `more:${c.id}`, 'data-more': c.id,
            onclick: (e: Event) => moreClick(e as MouseEvent, c.id),
          }, icon('dots-vertical', 16)))),
      lineEl(c))))
}

/** A shared canvas on the board's foot (D7.5): a chip; its click does what its card would. */
function chipEl(c: CardModel): HTMLElement {
  const open = ui.menu?.id === c.id
  const label = `${c.name}, ${lineText(c.line)}`
  return h('span', {
    class: `hm-chip${open ? ' menu-open' : ''}`, role: 'button', tabindex: '0', 'aria-label': label, 'data-key': `chip:${c.id}`, 'data-card': c.id,
    onclick: () => cardClick(c),
    oncontextmenu: (e: Event) => chipContext(e as MouseEvent, c.id),
    onkeydown: (e: Event) => cardKey(e as KeyboardEvent, c),
  }, logo(c.logo, 26, { round: true, plate: 0.88 }), h('span', { class: 'hm-chip-name' }, c.name))
}

function cardContext(e: MouseEvent, id: string): void {
  e.preventDefault()
  e.stopPropagation()
  openCardMenu(id, { kind: 'pointer', at: { x: e.clientX, y: e.clientY + 2, origin: 'top left' } }, false)
}
function chipContext(e: MouseEvent, id: string): void {
  e.preventDefault()
  e.stopPropagation()
  openCardMenu(id, { kind: 'pointer', at: { x: e.clientX, y: e.clientY - 2, up: true, origin: 'top left' } }, false)
}
/** a chip's menu by key: upward from its left, as a right-click there would */
function chipKeyAnchor(id: string): Anchor {
  const el = rootEl.querySelector(`[data-card="${CSS.escape(id)}"]`)
  const r = el?.getBoundingClientRect()
  return { kind: 'pointer', at: { x: r?.left ?? 14, y: (r?.top ?? 0) - 2, up: true, origin: 'top left' } }
}
function moreClick(e: MouseEvent, id: string): void {
  e.stopPropagation()
  if (ui.menu?.id === id) { closeCardMenu(); return }
  // Enter or Space on the button is a click with no pointer (detail 0): a key-opened menu
  openCardMenu(id, { kind: 'more' }, e.detail === 0)
}

// ---- the card menu (D8) -------------------------------------------------------------------------------------------

const cardNode = (id: string) => rootEl.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`)
const moreNode = (id: string) => rootEl.querySelector<HTMLElement>(`[data-more="${CSS.escape(id)}"]`)

/**
 * Where an anchored menu opens now: under its more button, right-aligned 8 px in, top at the card's bottom - 4 - both
 * measured from the card's padding box, as the frame draws it (home-v2/_home.tsx: `right: 8, top: calc(100% - 4px)`
 * inside the card's 1 px border, so 9 px in from its outer edge and 5 above its outer bottom; H2's proof).
 */
function anchorAt(a: Anchor, id: string): MenuAt | null {
  if (a.kind === 'pointer') return a.at
  const card = (moreNode(id)?.closest('.hm-card') ?? cardNode(id)) as HTMLElement | null
  if (!card) return null
  const r = card.getBoundingClientRect()
  const b = card.clientTop
  return { x: r.right - b - 8, y: r.bottom - b - 4, origin: 'top right' }
}

function openCardMenu(id: string, anchor: Anchor, byKey: boolean): void {
  closeAll()
  const c = model.byId.get(id)
  const at = c ? anchorAt(anchor, id) : null
  if (!c || !at) return
  const node = cardNode(id)
  const chip = !!node?.classList.contains('hm-chip')
  const opener = byKey ? (anchor.kind === 'more' && !chip ? `more:${id}` : node?.dataset.key ?? null) : null
  const handle = openMenu(layer, {
    rows: menuRows(c), at, top: 44, focusFirst: byKey, opener: node,
    onPick: (row, how) => pickRow(row as RowId, how),
    onClose: () => menuClosed(),
  })
  ui.menu = { id, anchor, handle, byKey, chip, copying: false, opener }
  markMenu()
}

/** The card wears its hover look and `menu-open`, its more button `.on`, while its menu is open (D5). */
function markMenu(): void {
  // `.hov` is Home's own (an open menu's card, a deep-linked card): every one cleared, then the current ones put back
  for (const el of rootEl.querySelectorAll('.menu-open, .hov')) el.classList.remove('menu-open', 'hov')
  for (const el of rootEl.querySelectorAll('.hm-more-btn.on')) { el.classList.remove('on'); el.setAttribute('aria-expanded', 'false') }
  if (ui.highlight) cardNode(ui.highlight)?.classList.add('hov')
  const m = ui.menu
  if (!m) return
  const el = cardNode(m.id)
  el?.classList.add('menu-open')
  if (el?.classList.contains('hm-card')) el.classList.add('hov')
  const b = moreNode(m.id)
  b?.classList.add('on')
  b?.setAttribute('aria-expanded', 'true')
}

/** Escape, Tab or an outside press closed it (menu.ts tore it down): a key-opened one gives focus back. */
function menuClosed(): void {
  const m = ui.menu
  ui.menu = null
  if (m && ui.highlight === m.id) ui.highlight = null
  markMenu()
  if (m?.byKey && m.opener) refocus(m.opener)
}
function closeCardMenu(): void {
  const m = ui.menu
  if (!m) return
  ui.menu = null
  m.handle.close()
  if (ui.highlight === m.id) ui.highlight = null
  markMenu()
}
function refocus(key: string): void {
  const el = rootEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
  if (el) ownScroll(() => el.focus())
}

/**
 * A row picked (D8.3, D8.8). Open does what the card's activation does (never a `home:action`); Reveal closes at once;
 * a copy row asks main and answers in place: "Copied" with a check in the done colours for 900 ms, then closes - or
 * closes and says "Not found" when main had nothing to copy.
 */
function pickRow(row: RowId, how: MenuPick): void | 'keep' {
  const m = ui.menu
  if (!m) return
  if (m.copying) return 'keep'
  const c = model.byId.get(m.id)
  if (!c) { ui.menu = null; markMenu(); return }
  if (row === 'open') { ui.menu = null; markMenu(); activateCard(c, how); return }
  const via = keysOf(how)
  if (row === 'reveal') { ui.menu = null; markMenu(); void api?.action({ action: 'reveal', id: c.id, ...via }).catch(() => {}); return }
  if (!COPY_ROWS.includes(row)) return 'keep'
  m.copying = true
  const ask = row === 'copy-update' ? api?.action({ action: 'copy-update', id: c.id, ...via })
    : row === 'copy-start' ? api?.action({ action: 'copy-start', id: c.id, ...via })
      : row === 'copy-link' ? api?.action({ action: 'copy-link', id: c.id, ...via })
        : api?.action({ action: 'copy-path', id: c.id, ...via })
  void (ask ?? Promise.resolve({ ok: false })).then((a) => a, () => ({ ok: false })).then((a) => {
    if (ui.menu !== m) return
    if (!a?.ok) { closeCardMenu(); say(live, 'Not found'); return }
    const rows = currentRows(m).map((r): MenuRow => (r.kind === 'item' && r.id === row ? { ...r, label: 'Copied', icon: 'check', done: true } : r))
    m.handle.update(rows)
    setTimeout(() => { if (ui.menu === m) { closeCardMenu(); if (m.byKey && m.opener) refocus(m.opener) } }, 900)
  })
  return 'keep'
}
const currentRows = (m: OpenCardMenu): MenuRow[] => { const c = model.byId.get(m.id); return c ? menuRows(c) : [] }

/** D11.1: after a render, the open card menu from the card as it is now - rebuilt, re-anchored, or closed. */
function syncMenu(): void {
  const m = ui.menu
  if (!m) return
  const c = model.byId.get(m.id)
  if (!c || !cardNode(m.id)) { closeCardMenu(); return }
  if (!m.copying) m.handle.update(menuRows(c))
  markMenu()
  reanchor()
}
/** Every open menu at its anchor's rect now (a render, a scroll Home made, a window resize): an anchored one moves
 *  with its button, a right-click's stays at its pointer and is clamped again into the window as it is now (B7). */
function reanchor(): void {
  const m = ui.menu
  if (m && m.anchor.kind === 'more') { const at = anchorAt(m.anchor, m.id); if (at) m.handle.place(at) }
  else if (m) m.handle.place()
  if (ui.viewMenu) { const at = viewAt(); if (at) ui.viewMenu.place(at) }
}

// ---- the View menu and Help (D8.5, D9) ----------------------------------------------------------------------------

function viewAt(): MenuAt | null {
  const b = rootEl.querySelector<HTMLElement>('[data-key="view"]')
  if (!b) return null
  const r = b.getBoundingClientRect()
  return { x: r.right, y: r.top + 42, origin: 'top right' }
}
function viewClick(e: MouseEvent): void {
  if (ui.viewMenu) { closeViewMenu(); return }
  closeAll()
  const at = viewAt()
  if (!at) return
  ui.viewByKey = e.detail === 0
  const rows: MenuRow[] = [
    { kind: 'header', label: 'View' },
    { kind: 'item', id: 'grid', label: 'Grid', icon: 'grid', enabled: true, checked: ui.view === 'grid' },
    { kind: 'item', id: 'board', label: 'Board', icon: 'board', enabled: true, checked: ui.view === 'board' },
  ]
  ui.viewMenu = openMenu(layer, {
    rows, at, top: 44, focusFirst: ui.viewByKey, opener: e.currentTarget as Element,
    onPick: (id) => { ui.viewMenu = null; setView(id === 'grid' ? 'grid' : 'board'); markView(); if (ui.viewByKey) refocus('view') },
    onClose: () => { ui.viewMenu = null; markView(); if (ui.viewByKey) refocus('view') },
  })
  markView()
}
function closeViewMenu(): void { const m = ui.viewMenu; ui.viewMenu = null; m?.close(); markView() }
function markView(): void {
  const b = rootEl.querySelector('[data-key="view"]')
  b?.classList.toggle('on', !!ui.viewMenu)
  b?.setAttribute('aria-expanded', String(!!ui.viewMenu))
}
function setView(v: 'grid' | 'board'): void {
  if (ui.view === v) return
  ui.view = v
  writeView(v)
  renderBody()
}

const helpCopy = (id: 'dev' | 'init' | 'update', lines: string[]): HTMLElement => {
  const btn = h('button', {
    type: 'button', title: 'Copy', 'aria-label': 'Copy',
    onclick: () => { void copyFixed(id).then((ok) => { if (ok) done(btn, 2000, 'Copied') }) },
  }, h('i', { class: 'hm-cp-a' }, icon('copy', 14)), h('i', { class: 'hm-cp-b' }, icon('check', 14)))
  return h('div', { class: `hm-cmd2${lines.length > 1 ? ' two' : ''}` }, h('code', {}, ...lines.map((l) => h('span', {}, l))), btn)
}
let helpEl: HTMLElement | null = null
function helpCard(): HTMLElement {
  const sec = (title: string, why: string, cmd: HTMLElement) => h('section', { class: 'hm-hs' }, h('div', { class: 'hm-hs-body' }, h('h5', {}, title), h('p', {}, why), cmd))
  return h('div', { class: `hm-pop hm-help2${model.empty ? ' up' : ''}`, role: 'dialog', 'aria-label': 'How Marver runs' },
    h('header', {}, h('h4', {}, 'How Marver runs'), h('p', {}, 'Every canvas lives in its repo; this app opens them.')),
    h('div', { class: 'hm-help-in' },
      sec('Open a canvas', 'Start it in its repo. It shows up here a second later, in its own tab.', helpCopy('dev', ['npx marver dev'])),
      sec('Add Marver to a repo', 'Your agent gives the canvas its name and logo as it starts.', helpCopy('init', ['npm i -D @marver-design/marver &&', 'npx marver init'])),
      sec('Update a canvas', 'Its card says when a newer Marver is out. Canvases on 0.26 or older show here once updated.', helpCopy('update', ['npm i -D @marver-design/marver@latest'])),
      h('footer', {},
        h('div', { class: 'hm-hs-body' }, h('h5', {}, 'Settings and agent notes'),
          info.writable ? h('p', {}, '~/.marver/') : h('p', { class: 'unwritable' }, '~/.marver can\'t be written · nothing is kept')),
        h('button', { class: 'hm-foot-btn', type: 'button', onclick: () => { api?.action({ action: 'show-files' }).catch(() => {}) } }, 'Show the files'))))
}
function helpClick(): void {
  if (ui.help) { closeHelp(); return }
  closeAll()
  ui.help = true
  helpEl = helpCard()
  layer.append(helpEl)
  markHelp()
}
function closeHelp(): void { ui.help = false; helpEl?.remove(); helpEl = null; markHelp() }
function markHelp(): void {
  for (const b of rootEl.querySelectorAll('.hm-q')) { b.classList.toggle('on', ui.help); b.setAttribute('aria-expanded', String(ui.help)) }
}
/** One open at a time (D8.6): a card menu, the View menu, Help - and a deep-linked card's menu still waiting for its
 *  scroll to land (D8.7) is cancelled with them, so a blur or a tab switch in between never finds it opening later. */
function closeAll(): void { closeCardMenu(); closeViewMenu(); if (ui.help) closeHelp(); cancelFocus() }

const copyFixed = async (id: 'dev' | 'init' | 'update'): Promise<boolean> => { try { return (await api?.action({ action: 'copy', id }))?.ok === true } catch { return false } }
/** A copy button's answered look (`.done`) for `ms`, then back. Its own name and title are kept once, when no answer
 *  is showing, so a second copy inside the `ms` still goes back to them (not to the answer's). */
function done(el: HTMLElement, ms: number, label?: string): void {
  el.classList.add('done')
  const t = Number(el.dataset.t ?? 0)
  if (t) clearTimeout(t)
  else {
    delete el.dataset.wasLabel
    delete el.dataset.wasTitle
    if (el.hasAttribute('aria-label')) el.dataset.wasLabel = el.getAttribute('aria-label')!
    if (el.hasAttribute('title')) el.dataset.wasTitle = el.getAttribute('title')!
  }
  if (label) { el.setAttribute('aria-label', label); el.title = label }
  el.dataset.t = String(setTimeout(() => {
    el.classList.remove('done')
    if (label) {
      const { wasLabel, wasTitle } = el.dataset
      if (wasLabel === undefined) el.removeAttribute('aria-label'); else el.setAttribute('aria-label', wasLabel)
      if (wasTitle === undefined) el.removeAttribute('title'); else el.title = wasTitle
    }
    delete el.dataset.t
    delete el.dataset.wasLabel
    delete el.dataset.wasTitle
  }, ms))
}

// ---- the page (D2-D7, D10) ----------------------------------------------------------------------------------------

const qButton = (float: boolean): HTMLElement => h('button', {
  class: `hm-icon hm-q${float ? ' hm-float' : ''}${ui.help ? ' on' : ''}`, type: 'button', title: 'How Marver runs',
  'aria-label': 'How Marver runs', 'aria-expanded': String(ui.help), 'data-key': float ? 'help-float' : 'help', onclick: () => helpClick(),
}, '?')

function head(board: boolean): HTMLElement {
  return h('div', { class: `hm-head${board ? ' on-board' : ''}` },
    h('h1', { class: 'hm-brand' }, appMark(28), 'Marver'),
    h('span', { class: 'hm-sp' }),
    h('div', { class: 'hm-slot', 'data-slot': 'link' }),
    h('button', {
      class: `hm-icon${ui.viewMenu ? ' on' : ''}`, type: 'button', title: 'View', 'aria-label': 'View', 'aria-haspopup': 'menu',
      'aria-expanded': String(!!ui.viewMenu), 'data-key': 'view', onclick: (e: Event) => viewClick(e as MouseEvent),
    }, icon('sliders', 16)),
    qButton(false))
}

function gridView(): HTMLElement[] {
  const sec = (title: string, n: number | null, cards: CardModel[]) => cards.length
    ? [h('h2', { class: 'hm-sec' }, title, n === null ? null : h('b', {}, String(n))), h('div', { class: 'hm-grid' }, ...cards.map((c) => cardEl(c, false)))]
    : []
  return [
    ...sec('Running', model.running.length, model.running),
    ...sec('Not running', model.notRunning.length, model.notRunning),
    ...sec('Shared with you', null, model.shared),
  ]
}

function boardView(): HTMLElement[] {
  const board = h('div', { class: 'hm-board' }, ...COLS.map((col) => {
    const cards = model.columns[col.key]
    return h('section', { class: 'hm-col', 'data-col': col.key, 'aria-label': col.title },
      h('div', { class: 'hm-col-h' }, h('i', { class: `hm-dot ${col.dot}`, 'aria-hidden': 'true' }), col.title, h('small', {}, String(cards.length))),
      h('div', { class: 'hm-col-list', 'data-scroll': `col:${col.key}` },
        ...cards.map((c) => cardEl(c, true)),
        !cards.length && col.empty ? h('div', { class: 'hm-col-empty' }, col.empty) : null))
  }))
  if (!model.shared.length) return [board]
  return [board, h('div', { class: 'hm-shared', 'data-scroll': 'shared' }, h('h2', { class: 'hm-sec' }, 'Shared with you'), ...model.shared.map(chipEl))]
}

function cpLabel(id: 'dev' | 'init'): HTMLElement {
  const b = h('button', {
    class: 'hm-cplabel', type: 'button', 'aria-label': 'Copy', 'data-key': `cp:${id}`,
    onclick: () => { void copyFixed(id).then((ok) => { if (ok) done(b, 2000, 'Copied') }) },
  }, h('span', { class: 'a' }, 'Copy'), h('span', { class: 'b' }, icon('check', 11), 'Copied'))
  return b
}

function emptyView(): HTMLElement[] {
  const step = (name: string, ...rest: (Node | null)[]) => h('div', { class: 'hm-card hm-step' }, h('div', { class: 'hm-txt' }, h('div', { class: 'hm-name' }, name), ...rest))
  return [
    h('div', { class: 'hm-empty', 'data-scroll': 'empty' }, h('div', { class: 'hm-empty-in' },
      appMark(64),
      h('h2', {}, 'No canvas running yet'),
      h('p', {}, 'Start one from its repo and it opens here, in its own tab.'),
      h('div', { class: 'hm-empty-steps' },
        step('In a repo with Marver', h('div', { class: 'hm-cmd' }, h('span', {}, 'npx marver dev'), cpLabel('dev'))),
        step('A repo without Marver yet', h('div', { class: 'hm-cmd' }, h('span', {}, 'npm i -D @marver-design/marver && npx marver init'), cpLabel('init'))),
        h('div', { class: 'hm-card hm-step hm-empty-link' }, h('div', { class: 'hm-txt' }, h('div', { class: 'hm-name' }, 'A canvas someone shared with you'), h('div', { class: 'hm-slot', 'data-slot': 'link' })))))),
    qButton(true),
  ]
}

/** D11: what a render must keep - focus (by data-key), the field's focus and selection, every scroll offset. */
function capture() {
  const a = document.activeElement as HTMLElement | null
  const fieldFocus = a === input ? { s: input.selectionStart, e: input.selectionEnd, d: input.selectionDirection, x: input.scrollLeft } : null
  const key = a && rootEl.contains(a) && a !== input ? a.dataset.key ?? null : null
  const scroll = [...rootEl.querySelectorAll<HTMLElement>('[data-scroll]')].map((el) => [el.dataset.scroll!, el.scrollTop, el.scrollLeft] as const)
  return { fieldFocus, key, scroll }
}

function renderBody(): void {
  const keep = capture()
  model = homeModel({ snap, recent, shared, now: Date.now(), ago })
  const board = ui.view === 'board'
  if (model.empty) fill(rootEl, ...emptyView())
  else fill(rootEl, h('div', { class: `hm-body ${board ? 'board' : 'grid'}`, 'data-scroll': 'body' }, head(board), ...(board ? boardView() : gridView())))
  rootEl.querySelector('[data-slot="link"]')?.append(field)
  ownScroll(() => {
    for (const [k, top, left] of keep.scroll) {
      const el = rootEl.querySelector<HTMLElement>(`[data-scroll="${CSS.escape(k)}"]`)
      if (el) { el.scrollTop = top; el.scrollLeft = left }
    }
    if (keep.fieldFocus) {
      const f = keep.fieldFocus
      input.focus({ preventScroll: true })
      try { input.setSelectionRange(f.s, f.e, f.d ?? undefined) } catch { /* a field with no selection */ }
      input.scrollLeft = f.x
    } else if (keep.key) {
      rootEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(keep.key)}"]`)?.focus({ preventScroll: true })
    }
  })
  helpEl?.classList.toggle('up', model.empty)
  markView()
  markHelp()
  syncMenu()
  renderHint()
}

// ---- the link field (D3) --------------------------------------------------------------------------------------------

function badWords(text: string): string {
  const p = parseLink(text)
  return p.kind === 'bad' && p.why === 'page' ? 'Not a canvas link: only a canvas\'s own page opens in its tab' : 'Not a canvas link'
}

function hintFor(text: string): (Node | string)[] {
  if (answer && answer.sent === text) {
    const t = answer.port ? tabOnPort(answer.port) : undefined
    switch (answer.why) {
      case 'refused': return [`Not opened: ${answer.host ? possessive(answer.host) : t ? possessive(nameOf(t)) : 'the canvas\'s'} page stays as it was`]
      case 'nothing': return [`Nothing is running on localhost:${answer.port ?? ''}`]
      case 'not-canvas': return [`Something else answers on localhost:${answer.port ?? ''}: not a Marver canvas`]
      case 'bad': return [badWords(text)]
    }
  }
  if (!text.trim()) return []
  const p = parseLink(text)
  if (p.kind === 'bad') return [badWords(text)]
  // a `marver:` link (D3): the folder it names - the page cannot know whether that canvas runs; main says on Return
  if (p.kind === 'deep') return [h('kbd', { 'aria-hidden': 'true' }, '↩'), ' opens ', h('b', {}, deepFolder(p.ws))]
  if (p.kind === 'https') {
    const r = remoteOn(p.url)
    return r ? [h('kbd', { 'aria-hidden': 'true' }, '↩'), ' opens in ', h('b', {}, possessive(r.name)), ' tab']
      : [h('kbd', { 'aria-hidden': 'true' }, '↩'), ' opens ', h('b', {}, p.host), ' in a new tab']
  }
  const t = tabOnPort(p.port)
  if (!t) return [`Nothing is running on localhost:${p.port}`]
  if (t.state === 'unverified') return [`Something else answers on localhost:${p.port}: not a Marver canvas`]
  return [h('kbd', { 'aria-hidden': 'true' }, '↩'), ' opens in ', h('b', {}, possessive(t.name)), ` tab${p.board ? ', on that board' : ''}`]
}

function renderHint(): void {
  fill(hintEl, ...hintFor(input.value))
  hintEl.classList.toggle('refused', !!answer && answer.sent === input.value)
  const b = backTab()
  fill(backEl, ...(b ? [h('kbd', { 'aria-hidden': 'true' }, 'esc'), ` back to ${b.kind === 'home' ? 'Home' : nameOf(b)}`] : []))
  kbd.textContent = input.value ? '↵' : '⌘L'
}

/** a Return still waiting for main's answer: another is ignored until it lands */
let submitting = false

/**
 * Asks main to open a link: what the field holds (Return), or a past shared canvas's (its card, by click or key). A
 * refusal keeps the link in the field, selected, with its line - a card's link is put there first.
 */
async function open(sent: string, from: 'field' | { via: 'click' } | { via: 'key'; keys: HomeKeys }): Promise<void> {
  if (!sent.trim() || !api || submitting) return
  const p = parseLink(sent)
  submitting = true
  let a: LinkOpenAnswer
  try {
    a = await (from === 'field' ? api.openLink(sent) : from.via === 'key' ? api.openLink(sent, 'key', from.keys) : api.openLink(sent, 'click'))
  } catch { a = { ok: false, why: 'bad' } } finally { submitting = false }
  if (a.ok) {
    if (input.value === sent) input.value = ''
    answer = null
  } else {
    answer = { why: a.why, sent, port: p.kind === 'local' ? p.port : p.kind === 'bad' ? p.port ?? null : null, host: p.kind === 'https' ? p.host : null }
    if (from !== 'field') input.value = sent
    if (input.value === sent) input.select()
  }
  renderHint()
  if (!a.ok) say(live, hintEl.textContent ?? '')
}

input.addEventListener('input', () => renderHint())
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); void open(input.value, 'field') }
  else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    // a menu or Help first (D8.6), and a deep-linked card's menu still waiting for its scroll (D8.7)
    if (ui.menu || ui.viewMenu || ui.help || focusPending) { closeAll(); return }
    // back to the tab ⌘L came from, whatever the field holds; if that tab has closed, stay on Home - said to main all
    // the same, as Home itself, for the record (spec 30's link-cancel, noop no-tab): main does nothing with it
    const b = backTab()
    // spec 32 D8.8: the field's Escape says so (`cancel`), through Home's own activate
    api?.activate(b ? b.id : 'home', 'key', { cancel: true })
  }
})

// ---- what closes a menu or Help (D8.6, D9.7) ------------------------------------------------------------------------

// Escape anywhere closes Help (a menu's own Escape is menu.ts's), and drops a deep-linked card's menu still waiting
// for its scroll (D8.6, D8.7): it never opens after the person said no
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (focusPending) cancelFocus()
  if (!e.defaultPrevented && ui.help) { e.preventDefault(); closeHelp() }
})
// an outside press closes Help (a menu's catcher closes the menus); the "?" toggles it itself. Any press drops a
// deep-linked card's pending menu (no menu or catcher is up yet to take it)
document.addEventListener('pointerdown', (e) => {
  if (focusPending) cancelFocus()
  if (!ui.help || !helpEl) return
  const t = e.target as Element | null
  if (t && (helpEl.contains(t) || t.closest('.hm-q'))) return
  closeHelp()
}, true)
window.addEventListener('blur', () => closeAll())
// a window resize moves the cards and the header: every open menu goes back to its anchor, clamped into the window
// as it is now (B7, D8.4); main repaints nothing on a resize, so Home does it itself
window.addEventListener('resize', () => reanchor())
// a scroll the person made moves the anchors: the card or chip menu and the View menu close, Help stays (it sits on
// the window); Home's own scrolls re-anchor instead
document.addEventListener('scroll', (e) => {
  const t = e.target
  if (!(t instanceof Element) || !t.matches(SCROLLERS)) return
  const own = ownAt.get(t)
  ownAt.delete(t)
  if (ownScrolls > 0 || (own && own[0] === t.scrollTop && own[1] === t.scrollLeft)) { reanchor(); return }
  closeCardMenu()
  closeViewMenu()
}, true)
// the menus' catcher covers the window (menu.ts, B11), so a wheel over the content lands on it and scrolls nothing:
// Home hands the wheel to the scroller under the pointer that can move that way, and that scroll, the person's, then
// closes the menus as above. Nothing scrollable there: nothing moves and the menu stays. A wheel over a menu's own
// rows is the menu's (B7.3).
document.addEventListener('wheel', (e) => {
  const t = e.target
  if (!(t instanceof Element) || !t.classList.contains('mv-catcher')) return
  const under = document.elementsFromPoint(e.clientX, e.clientY).find((x) => !x.closest('#hm-layer'))
  const sc = wheelScroller(under, e.deltaX, e.deltaY)
  if (sc) sc.scrollBy({ left: e.deltaX, top: e.deltaY })
}, { capture: true, passive: true })
function wheelScroller(el: Element | undefined, dx: number, dy: number): Element | null {
  for (let n = el?.closest(SCROLLERS) ?? null; n; n = n.parentElement?.closest(SCROLLERS) ?? null) {
    const cs = getComputedStyle(n)
    if (dy !== 0 && /auto|scroll/.test(cs.overflowY) && n.scrollHeight > n.clientHeight) return n
    if (dx !== 0 && /auto|scroll/.test(cs.overflowX) && n.scrollWidth > n.clientWidth) return n
  }
  return null
}

/** D8.7: a `marver://` link's card - highlighted, scrolled into view, its menu at its more button with its first row
 *  (Copy start command) focused once the scroll has landed. */
function focusCard(id: string): void {
  closeAll()
  const gen = focusGen
  ui.highlight = id
  renderBody()
  const el = cardNode(id)
  if (!el) { ui.highlight = null; return }
  focusPending = true
  ownScroll(() => el.scrollIntoView({ block: 'nearest' }), () => {
    // dismissed in between (closeAll: a blur, a tab switch, another menu or Help; an Escape, a press): nothing opens
    if (gen !== focusGen || !homeActive()) { if (gen === focusGen) cancelFocus(); return }
    focusPending = false
    if (ui.highlight === id && model.byId.has(id) && !ui.menu) openCardMenu(id, { kind: 'more' }, true)
    if (ui.menu?.id === id) ui.highlight = id
    markMenu()
  })
}
/** A pending deep-link focus is dropped: its highlight goes, unless its menu is the one open. */
function cancelFocus(): void {
  focusGen += 1
  focusPending = false
  if (ui.highlight && ui.menu?.id !== ui.highlight) { ui.highlight = null; markMenu() }
}

// ---- what main sends ------------------------------------------------------------------------------------------------

setLook(undefined)
renderBody()
shown()
// the minutes of a working agent and every "Ran <ago>": the same render path as a push (D6.2, D11)
setInterval(() => renderBody(), 60_000)

if (api) {
  api.onTabs((s) => {
    snap = s
    if (!homeActive()) closeAll()
    renderBody()
  })
  api.onRecent((r) => { recent = Array.isArray(r) ? r : []; renderBody() })
  api.onShared((l) => { shared = Array.isArray(l) ? l : []; renderBody() })
  api.onHomeInfo((i) => { info = i; renderBody() })
  api.onHomeFocus((f) => {
    if (f.field === 'recent') { focusCard(f.id); return }
    if (f.field !== 'link') return
    back = f.back
    closeAll()
    input.focus()
    input.select()
    renderHint()
  })
  api.ready()
}
