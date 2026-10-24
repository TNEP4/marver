/**
 * The menu bar (spec 28 A2.7, A2.14 #24, #25; frames mac-app/07-menu-bar, 08-menus). Owner: the window stream.
 *
 * Three kinds of item (v1.10 r1 #3):
 * - the app's own keys (keys.ts) carry their accelerators and are handled in `before-input-event`, whose
 *   `preventDefault()` also stops the menu's key equivalent: a key fires once; a click runs the same command;
 * - the Edit roles keep their native accelerators and reach the page first, as text fields need;
 * - a canvas item (its `mv:menu`) carries no accelerator: its hint is in its name ("Fit All (⇧1)"), so the key
 *   stays the page's. Every way of choosing it sends `mv:menu-click` once; a checkbox's own toggle is never kept -
 *   right after any canvas item's click, accepted or stale, the menu is built again from the page's last items.
 * Stale callbacks (v1.10 r1 #10): each canvas item and tab item records its tab, that tab's document (its commit
 * count) and its trust when the menu is built; a click acts only if all three still hold.
 *
 * The native-only commands (hide, hide others, minimize, full screen) keep their roles in the menu: their key
 * equivalents never fire while a page has focus, since before-input-event ran the same command first.
 *
 * Pure (no Electron import): `menuTemplate(model, acts)` is unit-tested; `views.ts` builds and applies it,
 * rebuilt (debounced 100 ms) when the active tab, its items or a tab's state change. A2's items: all of A2.7 but
 * the performance report and Check for Updates (A5); A3 adds Mark a Flash (⌃⌥F) to Help.
 */
import type { MenuItemConstructorOptions } from 'electron'
import type { MenuItem } from '../../../src/shared/app-api.ts'
import { ACCELERATORS, type AppCommand } from './keys.ts'
import { T } from './timings.ts'

/** What a click must still find (v1.10 r1 #10). */
export interface MenuToken { tab: string; commit: number; trusted: boolean }

export interface MenuModel {
  active: {
    id: string
    kind: 'home' | 'settings' | 'local'
    name: string
    token: MenuToken
    trusted: boolean
    canClose: boolean
    canReload: boolean
  }
  /** the active canvas's own items, while it is trusted */
  canvas: { token: MenuToken; items: MenuItem[] } | null
  /** Home, then each canvas with its key, then Settings: every tab, even past » */
  tabs: { id: string; name: string; word?: string; key?: number; active: boolean; token: MenuToken }[]
  /** macOS 14 and later draw `header` items; before, a disabled item stands in (A2.14 #24) */
  header: boolean
}

export interface MenuActs {
  run(cmd: AppCommand): void
  holds(t: MenuToken): boolean
  canvasClick(t: MenuToken, id: string): void
  tab(t: MenuToken, what: 'activate' | 'open-browser' | 'reveal' | 'copy-link' | 'reload' | 'force-reload'): void
  help(): void
  perfFiles(): void
  /** build the menu again now (after any canvas item's click: the mark shows the page's state) */
  rebuild(): void
}

export const HELP_URL = 'https://github.com/TNEP4/marver#readme'

const sep: MenuItemConstructorOptions = { type: 'separator' }

export function menuTemplate(m: MenuModel, acts: MenuActs): MenuItemConstructorOptions[] {
  const cmd = (c: AppCommand, label: string, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions =>
    ({ label, ...(ACCELERATORS[c] ? { accelerator: ACCELERATORS[c] } : {}), click: () => acts.run(c), ...extra })
  const guarded = (t: MenuToken, fn: () => void) => () => { if (acts.holds(t)) fn() }
  const header = (label: string): MenuItemConstructorOptions => m.header ? { type: 'header', label } : { label, enabled: false }
  const canvasItem = (it: MenuItem): MenuItemConstructorOptions => {
    const t = m.canvas!.token
    return {
      id: `cv:${it.id}`,
      label: it.hint ? `${it.label} (${it.hint})` : it.label,   // never an accelerator: the key stays the page's
      ...(it.checked === undefined ? {} : { type: 'checkbox' as const, checked: it.checked }),
      click: () => { guarded(t, () => acts.canvasClick(t, it.id))(); acts.rebuild() },
    }
  }
  const items = (g: 'view' | 'jam') => (m.canvas?.items ?? []).filter((i) => i.group === g)
  const viewItems = items('view')
  const jamItems = items('jam')
  const a = m.active
  const local = a.kind === 'local'

  return [
    { label: 'Marver', submenu: [
      { role: 'about' }, sep,
      cmd('settings', 'Settings…'), sep,
      { role: 'services' }, sep,
      { role: 'hide', accelerator: 'Cmd+H' }, { role: 'hideOthers', accelerator: 'Alt+Cmd+H' }, { role: 'unhide' }, sep,
      cmd('quit', 'Quit Marver'),                              // never role quit: the guarded quit (A2.2)
    ] },
    { label: 'File', submenu: [
      cmd('home', 'Home'), cmd('open-link', 'Open Link…'), sep,
      cmd('close-tab', 'Close Tab', { enabled: a.canClose }), cmd('close-window', 'Close Window'),
      ...(local ? [sep, header(a.name),
        { label: 'Open in Browser', enabled: a.trusted, click: guarded(a.token, () => acts.tab(a.token, 'open-browser')) },
        { label: 'Reveal in Finder', click: guarded(a.token, () => acts.tab(a.token, 'reveal')) },
        { label: 'Copy Local Link', enabled: a.trusted, click: guarded(a.token, () => acts.tab(a.token, 'copy-link')) },
      ] : []),
    ] },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, sep, { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' },
    ] },
    { label: 'View', submenu: [
      ...(viewItems.length ? [header(a.name), ...viewItems.map(canvasItem), sep] : []),
      // tab items (v1.10 r1 #10): a click reloads the tab the menu was built for, only while its document and
      // trust still hold - never whichever tab is active by then. The keys are the app's (keys.ts: the active tab)
      cmd('reload', 'Reload Canvas', { id: 'reload', enabled: a.canReload, click: guarded(a.token, () => acts.tab(a.token, 'reload')) }),
      cmd('force-reload', 'Force Reload', { id: 'force-reload', enabled: a.canReload, click: guarded(a.token, () => acts.tab(a.token, 'force-reload')) }), sep,
      { role: 'togglefullscreen', accelerator: 'Ctrl+Cmd+F' },
      cmd('devtools', 'Developer Tools'),
    ] },
    ...(jamItems.length ? [{ label: 'Jam', submenu: jamItems.map(canvasItem) }] : []),
    { label: 'Window', submenu: [
      { role: 'minimize', accelerator: 'Cmd+M' }, { role: 'zoom' }, sep,
      cmd('next-tab', 'Next Tab'), cmd('prev-tab', 'Previous Tab'), sep,
      ...m.tabs.map((t): MenuItemConstructorOptions => ({
        id: `tab:${t.id}`, type: 'checkbox', checked: t.active,
        label: t.word ? `${t.name} - ${t.word}` : t.name,
        accessibilityLabel: t.word ? `${t.name}, ${t.word}` : t.name,
        ...(t.key ? { accelerator: `Cmd+${t.key}` } : {}),
        click: () => { guarded(t.token, () => acts.tab(t.token, 'activate'))(); acts.rebuild() },
      })),
      sep, { role: 'front' },
    ] },
    { role: 'help', submenu: [
      { label: 'Marver Help', click: () => acts.help() }, sep,
      cmd('mark-flash', 'Mark a Flash'),
      { label: 'Show Performance Files', click: () => acts.perfFiles() },
    ] },
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// The rebuild: debounced 100 ms

export interface MenuPorts { model(): MenuModel; acts: MenuActs; apply(t: MenuItemConstructorOptions[]): void }
let ports: MenuPorts | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let lastKey = ''

export function startMenu(p: MenuPorts): void { ports = p; buildNow() }

/** Build and apply now; skipped when nothing the menu shows changed. */
export function buildNow(force = false): void {
  if (timer) { clearTimeout(timer); timer = undefined }
  if (!ports) return
  const m = ports.model()
  const key = JSON.stringify(m)
  if (!force && key === lastKey) return
  lastKey = key
  ports.apply(menuTemplate(m, ports.acts))
}

/** The menu shows what changed within 100 ms (A2.7). */
export function invalidateMenu(): void {
  if (!ports || timer) return
  timer = setTimeout(() => { timer = undefined; buildNow() }, T.menuDebounceMs)
  ;(timer as { unref?: () => void }).unref?.()
}

/** Kept for main.ts's first call before the ports exist: the native roles only. */
export function buildMenu(): void { /* views.ts calls startMenu() at ready */ }
