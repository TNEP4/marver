/**
 * The app's own keys (spec 28 A2.4, A2.7, A2.13, A2.14 #25): one table, matched in `before-input-event` on the
 * strip, every canvas view and every app page (Home, Settings, the tab page), and shown by the menu as each item's
 * accelerator. Owner: the window stream.
 *
 * - keyDown only, `isAutoRepeat` ignored: a held ⌘2 switches once.
 * - A letter with ⌘ alone matches by `input.key`, so ⌘Q follows the layout; anything with ⌥ (macOS changes
 *   `key` under ⌥), the shifted brackets (`key` is `{`) and the digits (AZERTY's are shifted) by `input.code`.
 * - The matcher's caller calls `preventDefault()`: the page never sees the key and, in Electron, the menu's key
 *   equivalent does not fire either - each key fires once, whatever the page does with keys. A menu click runs the
 *   same command.
 * - The Edit keys (⌘C, ⌘V, ⌘X, ⌘Z, ⇧⌘Z, ⌘A) are not the app's: they reach the page, with the menu's roles behind.
 * - ⌃⌥F (Mark a Flash) is A3's: not caught in A2, so the page keeps it until then.
 *
 * Pure: no Electron import (unit-tested without it). The names match the home stream's `commands.ts` draft.
 */
import type { Input, WebContents } from 'electron'

export type AppCommand =
  | 'home' | 'open-link' | 'close-tab' | 'close-window' | 'reload' | 'force-reload' | 'settings' | 'quit'
  | 'hide' | 'hide-others' | 'minimize' | 'prev-tab' | 'next-tab' | 'devtools' | 'fullscreen'
  | 'focus-strip' | 'focus-strip-back'
  | 'tab-1' | 'tab-2' | 'tab-3' | 'tab-4' | 'tab-5' | 'tab-6' | 'tab-7' | 'tab-8' | 'tab-last'

/** Each command's accelerator as the menu shows it (a real key equivalent on macOS; before-input-event wins). */
export const ACCELERATORS: Partial<Record<AppCommand, string>> = {
  home: 'Cmd+T', 'open-link': 'Cmd+L', 'close-tab': 'Cmd+W', 'close-window': 'Shift+Cmd+W',
  reload: 'Cmd+R', 'force-reload': 'Shift+Cmd+R', settings: 'Cmd+,', quit: 'Cmd+Q',
  hide: 'Cmd+H', 'hide-others': 'Alt+Cmd+H', minimize: 'Cmd+M',
  'next-tab': 'Ctrl+Tab', 'prev-tab': 'Ctrl+Shift+Tab', devtools: 'Alt+Cmd+I', fullscreen: 'Ctrl+Cmd+F',
  'tab-1': 'Cmd+1', 'tab-2': 'Cmd+2', 'tab-3': 'Cmd+3', 'tab-4': 'Cmd+4', 'tab-5': 'Cmd+5', 'tab-6': 'Cmd+6',
  'tab-7': 'Cmd+7', 'tab-8': 'Cmd+8', 'tab-last': 'Cmd+9',
}

/** `aria-keyshortcuts` of the n-th canvas key (1-8, 9 the last). */
export const ariaKey = (n: number): string => `Meta+${n}`

const BY_KEY: Record<string, AppCommand> = { t: 'home', w: 'close-tab', l: 'open-link', r: 'reload', ',': 'settings', q: 'quit', h: 'hide', m: 'minimize' }
const BY_KEY_SHIFT: Record<string, AppCommand> = { w: 'close-window', r: 'force-reload' }

type KeyInput = Pick<Input, 'type' | 'key' | 'code' | 'isAutoRepeat' | 'shift' | 'control' | 'alt' | 'meta'>

/** The app's command for one input, or null: the page gets it. */
export function matchKey(i: KeyInput): AppCommand | null {
  if ((i.type !== 'keyDown' && i.type !== 'rawKeyDown') || i.isAutoRepeat) return null
  const { meta, control: ctrl, alt, shift } = i
  if (!meta && !ctrl && !alt) return i.code === 'F6' ? (shift ? 'focus-strip-back' : 'focus-strip') : null
  if (meta && !ctrl && !alt) {
    const d = /^Digit([1-9])$/.exec(i.code)
    if (d) return shift ? null : d[1] === '9' ? 'tab-last' : (`tab-${d[1]}` as AppCommand)
    if (shift && i.code === 'BracketLeft') return 'prev-tab'
    if (shift && i.code === 'BracketRight') return 'next-tab'
    const k = (i.key ?? '').toLowerCase()
    return (shift ? BY_KEY_SHIFT[k] : BY_KEY[k]) ?? null
  }
  if (meta && alt && !ctrl && !shift) return i.code === 'KeyH' ? 'hide-others' : i.code === 'KeyI' ? 'devtools' : null
  if (meta && ctrl && !alt && !shift) return i.code === 'KeyF' ? 'fullscreen' : null
  if (ctrl && !meta && !alt && i.code === 'Tab') return shift ? 'prev-tab' : 'next-tab'
  return null
}

/** The n-th canvas key's command (1-8; 9 is the last canvas). */
export const digitOf = (c: AppCommand): number | null => c === 'tab-last' ? 9 : /^tab-([1-8])$/.test(c) ? Number(c.slice(4)) : null

/**
 * Wire one webContents: its app keys never reach its page, and run once - a held key's repeats are swallowed too
 * (the page never sees the app's keys, and the menu's key equivalent never fires for them).
 */
export function attachKeys(wc: WebContents, run: (c: AppCommand, from: WebContents) => void, o: { prevent?: boolean } = {}): void {
  const prevent = o.prevent !== false   // false only for the key harness's control case (test builds)
  wc.on('before-input-event', (e, input) => {
    const c = matchKey(input.isAutoRepeat ? { ...input, isAutoRepeat: false } : input)
    if (!c) return
    if (prevent) e.preventDefault()
    if (!input.isAutoRepeat) run(c, wc)
  })
}
