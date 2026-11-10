/**
 * One Marver menu (spec 32 E2, B6-B11): the strip's tab and » menus (B) and every Home menu (D8) are this component,
 * styled by pages/shared/menu.css through its own `--mv-menu-*` interface (each page sets it from its own tokens).
 *
 *   const m = openMenu(document.body, { rows, at: { x, y }, top: 44, solid: true, focusFirst: key, defer: true,
 *     onPick: (id, how) => send({ rev, id }), onClose: () => send({ rev, id: null }) })
 *   await m.show()   // after the strip has grown: one frame, then placed, shown, focused
 *
 * It renders the rows (icons by name only, never a path), measures, places by B7 (the 14 px window inset both sides,
 * never above `top`, flipped upward near the foot, capped with its rows scrolling), runs the keyboard (B10) and the
 * pointer (B11: a full-window catcher, a mouseup that picks only after the pointer moved over the menu and 250 ms
 * after it showed, a secondary press on another opener handed back through `onSecondary`). No Electron or Node
 * imports: it is bundled into each page's IIFE. Every frame wait is "rAF or 50 ms, whichever first" (B16: rAF stalls
 * in an unfocused window). Its CSS is a file (the pages' CSP refuses inline style), its geometry set through CSSOM.
 */
import { h, icon, type IconName } from './dom.ts'

export type MenuRow =
  | {
    kind: 'item'; id: string; label: string; icon?: IconName; enabled: boolean
    /** a trailing check; a row that names it (true or false) is a `menuitemradio` (Home's View menu) */
    checked?: boolean
    /** Home's Update row: text and icon in `--mv-menu-update` */
    update?: boolean
    /** the copy rows' answered state (D8.3): the done colours */
    done?: boolean
  }
  | { kind: 'sep' }
  | { kind: 'header'; label: string }

export interface MenuPick { via: 'key' | 'click'; keys?: 'Enter' | 'Space' }

export interface MenuAt {
  /** the anchor, in window CSS px: the menu's `origin` corner sits here (with `up`, its bottom edge) */
  x: number; y: number
  /** prefer opening upward, the menu's bottom at `y` (Home's chip menu) */
  up?: boolean
  /** which corner is anchored, and the pop's origin; 'top right' right-aligns the menu at `x` */
  origin?: 'top left' | 'top right'
}

export interface MenuOptions {
  rows: MenuRow[]
  at: MenuAt
  /** the highest the menu may reach (44 everywhere: the strip's row, and Home under the strip view) */
  top: number
  /** the strip's opaque fill (it cannot blur) */
  solid?: boolean
  /** opened by key: the first enabled row takes focus; else the container does, no row highlighted (B3.4) */
  focusFirst?: boolean
  /** render hidden until `show()` (the strip waits for its view to grow, B3.3) */
  defer?: boolean
  /** the element that opened it: a secondary press on it closes as any outside press */
  opener?: Element | null
  /** what counts as another opener for `onSecondary` (a selector, e.g. '.tab, #more') */
  openers?: string
  /** a row picked (Enter or Space by key, a mouseup by pointer); answer 'keep' to keep the menu open */
  onPick(id: string, how: MenuPick): void | 'keep'
  /** a secondary press on another opener (B11): its `contextmenu` handed back with the element found at pointerdown */
  onSecondary?(el: Element): void
  /** closed by itself with no pick: Escape, Tab, an outside press, a secondary press with no contextmenu after it */
  onClose(why: 'escape' | 'tab' | 'outside'): void
}

export interface MenuHandle {
  el: HTMLElement
  /** placed, shown and focused after one frame (rAF or 50 ms); resolves once it is on screen */
  show(): Promise<void>
  /** replaces the rows when they differ; focus stays on the same id, else the first enabled row (key) or the menu */
  update(rows: MenuRow[]): void
  /** re-anchors (a moved anchor); keeps the side it opened on unless it no longer fits */
  place(at?: MenuAt): void
  /** the row element of an id */
  row(id: string): HTMLElement | null
  /** closes it with no callback (the caller closed it) */
  close(): void
  readonly open: boolean
}

/** The window inset a menu keeps on every side (Home's padding, H:201). */
export const MENU_INSET = 14
/** A mouseup this soon after the menu shows is the release of the press that opened it (B11). */
export const PICK_GUARD_MS = 250
/** A secondary press on another opener waits this long for its `contextmenu` (B11). */
export const SECONDARY_WAIT_MS = 300

/** One frame: requestAnimationFrame or 50 ms, whichever comes first (B16: rAF stalls in an unfocused window). */
export function frame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const go = () => { if (!done) { done = true; resolve() } }
    requestAnimationFrame(go)
    setTimeout(go, 50)
  })
}

/** Drops the separators that lead, trail or double (B9), and the headers left with nothing under them. */
export function normalRows(rows: MenuRow[]): MenuRow[] {
  const out: MenuRow[] = []
  for (const r of rows) {
    if (r.kind === 'sep' && (out.length === 0 || out[out.length - 1].kind !== 'item')) continue
    out.push(r)
  }
  while (out.length && out[out.length - 1].kind !== 'item') out.pop()
  return out
}

const sameRows = (a: MenuRow[], b: MenuRow[]): boolean => JSON.stringify(a) === JSON.stringify(b)

function rowEl(r: MenuRow): HTMLElement {
  if (r.kind === 'sep') return h('div', { class: 'mv-sep', role: 'separator' })
  if (r.kind === 'header') return h('div', { class: 'mv-menu-h', role: 'presentation' }, r.label)
  const radio = r.checked !== undefined
  const el = h('div', {
    class: `mv-row${r.update ? ' update' : ''}${r.done ? ' done' : ''}`,
    role: radio ? 'menuitemradio' : 'menuitem',
    tabindex: '-1',
    'data-id': r.id,
    'aria-disabled': r.enabled ? null : 'true',
    'aria-checked': radio ? String(r.checked) : null,
  })
  if (r.icon) el.append(icon(r.icon, 15, 'mv-ic'))
  el.append(h('span', { class: 'mv-label' }, r.label))
  if (r.checked) el.append(icon('check', 15, 'mv-check'))
  return el
}

/** Opens a menu in `layer` (the strip's body, Home's `#hm-layer`); one at a time is the caller's rule. */
export function openMenu(layer: HTMLElement, o: MenuOptions): MenuHandle {
  let rows = normalRows(o.rows)
  let at = o.at
  let open = true
  let shownAt = 0
  let moved = false
  let pendingSecondary: { el: Element; timer: ReturnType<typeof setTimeout> } | null = null

  const catcher = h('div', { class: 'mv-catcher', 'aria-hidden': 'true' })
  const list = h('div', { class: 'mv-menu-rows' })
  const el = h('div', { class: `mv-menu${o.solid ? ' solid' : ''}`, role: 'menu', tabindex: '-1' }, list)
  el.style.visibility = 'hidden'
  for (const r of rows) list.append(rowEl(r))
  layer.append(catcher, el)

  const enabledRows = () => [...list.querySelectorAll<HTMLElement>('.mv-row:not([aria-disabled])')]
  const focusRow = (r: HTMLElement | undefined) => {
    if (!r) return
    r.focus({ preventScroll: true })
    r.scrollIntoView({ block: 'nearest' })
  }
  const current = () => (document.activeElement instanceof HTMLElement && list.contains(document.activeElement) && document.activeElement.classList.contains('mv-row') ? document.activeElement : null)

  function place(next?: MenuAt): void {
    if (next) at = next
    const vw = window.innerWidth, vh = window.innerHeight
    el.style.maxHeight = ''
    el.style.left = '0px'
    el.style.top = '0px'
    // layout sizes, never the bounding rect: a re-place during the pop would read the scaled box
    const height = el.offsetHeight
    const width = el.offsetWidth
    // B7.2: the anchor raised to `top` first, so a menu opened from the strip's row starts at or below it
    const y = Math.max(at.y, o.top)
    const below = vh - MENU_INSET - y
    const above = y - MENU_INSET - o.top
    let s: 'down' | 'up'
    if (at.up) s = height <= above ? 'up' : height <= below ? 'down' : above >= below ? 'up' : 'down'
    else s = height <= below ? 'down' : height <= above ? 'up' : below >= above ? 'down' : 'up'
    const room = Math.max(0, s === 'down' ? below : above)
    const h2 = Math.min(height, room)
    if (height > room) el.style.maxHeight = `${room}px`
    // B7.1: the measured width, clamped into [14, innerWidth - width - 14]
    const right = at.origin === 'top right'
    const left0 = right ? at.x - width : at.x
    const left = Math.max(MENU_INSET, Math.min(left0, vw - width - MENU_INSET))
    let top = s === 'down' ? y : y - h2
    top = Math.max(o.top, Math.min(top, vh - MENU_INSET - h2))
    el.style.left = `${Math.round(left)}px`
    el.style.top = `${Math.round(top)}px`
    el.style.transformOrigin = `${s === 'down' ? 'top' : 'bottom'} ${right ? 'right' : 'left'}`
    el.dataset.side = s
  }

  function reveal(): void {
    place()
    el.style.visibility = ''
    el.classList.add('pop')
    shownAt = performance.now()
    if (o.focusFirst) focusRow(enabledRows()[0])
    else el.focus({ preventScroll: true })
  }

  function teardown(): void {
    if (!open) return
    open = false
    if (pendingSecondary) { clearTimeout(pendingSecondary.timer); pendingSecondary = null }
    document.removeEventListener('contextmenu', onContext, true)
    catcher.remove()
    el.remove()
  }
  const selfClose = (why: 'escape' | 'tab' | 'outside') => { if (!open) return; teardown(); o.onClose(why) }
  // a secondary press that closes is swallowed whole, as an NSMenu's is: the contextmenu after it opens nothing
  const swallowContext = () => {
    const eat = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); stop() }
    const stop = () => { clearTimeout(t); document.removeEventListener('contextmenu', eat, true) }
    const t = setTimeout(stop, SECONDARY_WAIT_MS)
    document.addEventListener('contextmenu', eat, true)
  }
  const pick = (r: HTMLElement, how: MenuPick) => {
    if (!open || r.hasAttribute('aria-disabled')) return
    const id = r.dataset.id
    if (!id) return
    const keep = o.onPick(id, how)
    if (keep !== 'keep') teardown()
  }

  el.addEventListener('keydown', (e) => {
    const all = enabledRows()
    const i = all.indexOf(current() as HTMLElement)
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusRow(all[i < 0 ? 0 : (i + 1) % all.length]); break
      case 'ArrowUp': e.preventDefault(); focusRow(all[i < 0 ? all.length - 1 : (i - 1 + all.length) % all.length]); break
      case 'Home': e.preventDefault(); focusRow(all[0]); break
      case 'End': e.preventDefault(); focusRow(all[all.length - 1]); break
      case 'Enter': case ' ': {
        e.preventDefault()
        const r = current()
        if (r) pick(r, { via: 'key', keys: e.key === 'Enter' ? 'Enter' : 'Space' })
        break
      }
      case 'Escape': e.preventDefault(); e.stopPropagation(); selfClose('escape'); break
      case 'Tab': e.preventDefault(); selfClose('tab'); break
    }
  })
  el.addEventListener('pointermove', (e) => {
    if (el.style.visibility === 'hidden') return
    moved = true
    const r = (e.target as Element | null)?.closest?.('.mv-row')
    if (r instanceof HTMLElement && list.contains(r) && !r.hasAttribute('aria-disabled') && document.activeElement !== r) r.focus({ preventScroll: true })
  })
  el.addEventListener('pointerup', (e) => {
    const r = (e.target as Element | null)?.closest?.('.mv-row')
    if (!(r instanceof HTMLElement) || !list.contains(r)) return
    if (!moved || performance.now() - shownAt < PICK_GUARD_MS) return
    pick(r, { via: 'click' })
  })
  el.addEventListener('contextmenu', (e) => e.preventDefault())
  // a press never moves focus (a disabled row included): the pointer's highlight is pointermove's
  el.addEventListener('mousedown', (e) => e.preventDefault())

  // B11: every press outside closes with no pick and is swallowed, but a secondary press on another opener waits
  // for its contextmenu (which lands on the catcher, not on the opener) and hands it back
  catcher.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    const secondary = e.button === 2 || (e.button === 0 && e.ctrlKey)
    if (secondary && o.onSecondary && o.openers) {
      const under = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x !== catcher && !el.contains(x))
      const target = under?.closest(o.openers) ?? null
      if (target && !(o.opener && (target === o.opener || o.opener.contains(target)))) {
        if (pendingSecondary) clearTimeout(pendingSecondary.timer)
        pendingSecondary = { el: target, timer: setTimeout(() => { pendingSecondary = null; selfClose('outside') }, SECONDARY_WAIT_MS) }
        return
      }
    }
    if (secondary) swallowContext()
    selfClose('outside')
  })
  const onContext = (e: Event) => {
    if (!open) return
    if (e.target === catcher || el.contains(e.target as Node)) e.preventDefault()
    if (e.target !== catcher || !pendingSecondary) return
    const target = pendingSecondary.el
    clearTimeout(pendingSecondary.timer)
    pendingSecondary = null
    o.onSecondary?.(target)
  }
  document.addEventListener('contextmenu', onContext, true)

  if (!o.defer) reveal()

  return {
    el,
    get open() { return open },
    show: async () => {
      if (!open || !o.defer || el.style.visibility !== 'hidden') return
      await frame()
      if (open) reveal()
    },
    update(next) {
      const n = normalRows(next)
      if (sameRows(n, rows)) return
      const had = current()?.dataset.id ?? null
      const wasFocused = el.contains(document.activeElement)
      rows = n
      list.replaceChildren(...rows.map(rowEl))
      if (el.style.visibility !== 'hidden') place()
      if (!wasFocused) return
      const same = had ? list.querySelector<HTMLElement>(`.mv-row[data-id="${CSS.escape(had)}"]:not([aria-disabled])`) : null
      if (same) focusRow(same)
      else if (o.focusFirst) focusRow(enabledRows()[0])
      else el.focus({ preventScroll: true })
    },
    place: (next) => { if (open) place(next) },
    row: (id) => list.querySelector<HTMLElement>(`.mv-row[data-id="${CSS.escape(id)}"]`),
    close: teardown,
  }
}

/** Which side a menu opened on, for a test or a re-anchor: 'down', 'up', or null before it is placed. */
export const menuSide = (m: MenuHandle): 'down' | 'up' | null => (m.el.dataset.side === 'down' || m.el.dataset.side === 'up' ? m.el.dataset.side : null)
