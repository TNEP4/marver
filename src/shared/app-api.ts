/**
 * The contract between a canvas's shell and the Mac app (spec 28 A2.9, A2.14 #9, #18, #19, v1.12 r1 #1):
 * the one place both sides read. The shell feature-detects `window.marverApp`; the app's canvas preload
 * exposes it and its `bridge.ts` checks every payload against these bounds. Types and constants only - no
 * imports - so the app's main bundle and the shell both take it as it is.
 *
 * DRAFT, frozen before the streams split (A2.14 #32). The admission (v1.12 r1 #1) is the preload's and the
 * bridge's alone: the shell never sees `doc` - `window.marverApp` is the same before and after admission, and
 * A2.9's order (hello first, then theme, busy and menu) is all the shell owes.
 */

export const APP_API_VERSION = 1

/** Reasons a page is busy (A2.14 #18). The first five are unsaved work; the last three are busy, not unsaved. */
export const UNSAVED_WHY = ['capture-recording', 'capture-unsent', 'board-unsaved', 'heights', 'typing'] as const
export const BUSY_ONLY_WHY = ['jam-session', 'microphone', 'agent'] as const
export type Why = (typeof UNSAVED_WHY)[number] | (typeof BUSY_ONLY_WHY)[number]
export const WHY: readonly Why[] = [...UNSAVED_WHY, ...BUSY_ONLY_WHY]

/** `mv:hello` - sent first. `page` the shell's PAGE_ID, `version` from sh-config. (`inset` joins at A3.) */
export interface Hello { version: string; board: string | null; page: string }
/** `mv:busy` - `busy` is any reason, `unsaved` any of UNSAVED_WHY; main refuses a message where they disagree. */
export interface Busy { busy: boolean; unsaved: boolean; why: Why[] }
/** `mv:theme` - the shell's `play || slides || viewTheme === 'dark'` (A2.14 #26). */
export interface Theme { dark: boolean }
/** `mv:menu` - at most 40, no separators in 0.1 (A2.7). */
export interface MenuItem { id: string; group: 'view' | 'jam'; label: string; hint?: string; checked?: boolean }
/** `mv:app-state` (main to canvas). `untrusted`: stop every microphone track (A2.14 #13). `open-next` is A4's. */
export type AppState = 'shown' | 'hidden' | 'untrusted'
/** `mv:doc` - the preload's one synchronous call at document start, answered while untrusted (A2.14 #9). */
export interface DocAnswer { reopen: boolean }
/** `mv:admit` (main to canvas) - the document admitted at its trusted commit (v1.12 r1 #1). */
export interface Admit { doc: string }
/** `mv:menu-click` (main to canvas). */
export interface MenuClick { id: string }
/**
 * The ids main sends of its own, never in the page's `mv:menu`: the tab's right-click Mark All as Seen (A2.4's
 * channels table: "Mark all as seen sends `mv:menu-click mark-all-seen` to the canvas"). A shell that does not know
 * one does nothing with it.
 */
export const APP_MENU_IDS = ['mark-all-seen'] as const

/** The canvas channels. `mv:inset`, `mv:present` and `mv:presented` are A3's; `mv:perf` A3's; needs-you and capture A4's. */
export const CANVAS_CHANNELS = {
  doc: 'mv:doc',
  admit: 'mv:admit',
  hello: 'mv:hello',
  theme: 'mv:theme',
  busy: 'mv:busy',
  menu: 'mv:menu',
  appState: 'mv:app-state',
  menuClick: 'mv:menu-click',
} as const

/** Bounds main checks again (A2.14 #19): unknown fields are stripped, a known one of the wrong type or past its bound refuses the message. */
export const BOUNDS = {
  version: 32,
  versionChars: /^[0-9A-Za-z.+-]+$/,
  board: 128,
  page: /^[A-Za-z0-9_-]{8,64}$/,
  doc: /^[A-Za-z0-9_-]{16,64}$/,
  menuItems: 40,
  menuId: /^[a-z][a-z0-9-]{0,31}$/,
  label: 48,
  hint: 8,
} as const

/** `window.marverApp`, exposed by the canvas preload to verified local canvases. Typed methods only: a page never names a channel. */
export interface MarverAppV1 {
  readonly v: 1
  /** 0 in app 0.1; 0 or 44 from A3 (the one ground) */
  readonly topInset: 0
  /** the app reloaded this tab after a crash: restore the saved camera even when the link names a selection (A2.9) */
  readonly reopen: boolean
  hello(p: Hello): void
  theme(p: Theme): void
  busy(p: Busy): void
  menu(items: MenuItem[]): void
  onAppState(fn: (s: AppState) => void): () => void
  onMenuClick(fn: (p: MenuClick) => void): () => void
}

/** Main's words for a reason (the hang sheet, the unsaved pill); `heights` is never named (A2.14 #18). */
export const WHY_WORDS: Record<Why, string | null> = {
  'capture-recording': 'a capture being recorded',
  'capture-unsent': 'a capture not yet sent',
  'board-unsaved': 'edits not yet saved',
  heights: null,
  typing: 'words not yet sent',
  'jam-session': 'a Jam session',
  microphone: 'the microphone',
  agent: 'an agent at work',
}
