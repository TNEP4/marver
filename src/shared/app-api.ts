/**
 * The contract between a canvas's shell and the Mac app (spec 28 A2.9, A2.14 #9, #18, #19, v1.12 r1 #1):
 * the one place both sides read. The shell feature-detects `window.marverApp`; the app's canvas preload
 * exposes it and its `bridge.ts` checks every payload against these bounds. Types and constants only - no
 * imports - so the app's main bundle and the shell both take it as it is.
 *
 * Frozen before the streams split (A2.14 #32; A3's additions by A3.8 #53). The admission (v1.12 r1 #1) is the
 * preload's and the bridge's alone: the shell never sees `doc` - `window.marverApp` is the same before and after
 * admission, and A2.9's order (hello first, then theme, busy and menu) is all the shell owes.
 *
 * A3 (app 0.2, marver 0.27.2) adds, all feature-detected and `v` still 1 (A3.8 #10, #26, #27): `mv:doc` answers
 * the document's `inset`; `mv:hello` says the inset the shell applied; `mv:present` / `mv:presented`, the
 * presentation epochs of the one ground; `mv:perf` / `mv:perf-ask`, the recorder's traffic. Every new method of
 * `MarverAppV1` is optional: a 0.27.2 shell inside app 0.1 still sees `marverApp` (marver-app.ts requires only the
 * six 0.1 methods), and a shell trusts the inset only with the whole presentation contract (inset.ts).
 */

export const APP_API_VERSION = 1

/** Reasons a page is busy (A2.14 #18). The first five are unsaved work; the last three are busy, not unsaved. */
export const UNSAVED_WHY = ['capture-recording', 'capture-unsent', 'board-unsaved', 'heights', 'typing'] as const
export const BUSY_ONLY_WHY = ['jam-session', 'microphone', 'agent'] as const
export type Why = (typeof UNSAVED_WHY)[number] | (typeof BUSY_ONLY_WHY)[number]
export const WHY: readonly Why[] = [...UNSAVED_WHY, ...BUSY_ONLY_WHY]

/** The strip's height: the top inset a shell applies under the Mac app's transparent strip (A2.9, A3.8 #31). */
export const TOP_INSET = 44
/** The scroll edge fades out over this many px below the inset (A2.9 v1.8 #8): `VISIBLE_TOP = TOP + EDGE_FADE`. */
export const EDGE_FADE = 16
/** What a document may apply: 44 only when main placed it full height (A3.8 #26). */
export type Inset = 0 | 44

/**
 * `mv:hello` - sent first. `page` the shell's PAGE_ID, `version` from sh-config. `inset` (0.27.2): what the shell
 * applied, 0 or 44; any other value refuses the message; absent (a 0.27.1 shell) reads 0 (A3.8 #26).
 */
export interface Hello { version: string; board: string | null; page: string; inset?: Inset }
/** `mv:busy` - `busy` is any reason, `unsaved` any of UNSAVED_WHY; main refuses a message where they disagree. */
export interface Busy { busy: boolean; unsaved: boolean; why: Why[] }
/** `mv:theme` - the shell's `play || slides || viewTheme === 'dark'` (A2.14 #26). */
export interface Theme { dark: boolean }
/** `mv:menu` - at most 40, no separators in 0.1 (A2.7). */
export interface MenuItem { id: string; group: 'view' | 'jam'; label: string; hint?: string; checked?: boolean }
/** `mv:app-state` (main to canvas). `untrusted`: stop every microphone track (A2.14 #13). `open-next` is A4's. */
export type AppState = 'shown' | 'hidden' | 'untrusted'
/**
 * `mv:doc` - the preload's one synchronous call at document start, answered at once on every path while untrusted,
 * granting and moving nothing (A2.14 #9). `reopen`: the crash reload's, and an unloaded tab's reopen (A3.8 #43).
 * `inset` (app 0.2, A3.8 #26): 44 when the document now committing is placed `full` (its pending layout, else the
 * committed one), else 0; app 0.1 answers none, read as 0. There is no `mv:inset`.
 */
export interface DocAnswer { reopen: boolean; inset?: Inset }
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

/**
 * `mv:present` (main to canvas; on the wire `{ doc, ...Present }`, stamped by main like `mv:app-state`): show the
 * latest state, then say so (A3.8 #27). `w`, `h`: the view's size in CSS px this request is about; `frames`: the
 * animation frames to wait once the viewport has that size (main's tunable, 1-8, 2 to start). The shell waits until
 * its viewport is `w x h` (500 ms at most), then `frames` animation frames, and answers; a newer request cancels an
 * older wait, which is never answered.
 */
export interface Present { epoch: number; w: number; h: number; frames: number }
/** `mv:presented` (canvas to main, stamped by the preload, never held): the request answered, at this viewport. */
export interface Presented { epoch: number; w: number; h: number }

/** A camera as the shell's probes read it: world offset and scale (canvasCtl.transform()). */
export interface PerfCam { x: number; y: number; s: number }
/** A viewport in CSS px. */
export interface PerfSize { w: number; h: number }

/**
 * `mv:perf` (canvas to main; on the wire `{ doc, p }`, stamped by the preload with the admitted `doc`, never held
 * or replayed: they are about now - A3.8 #10). `mem` and `shown` come from the preload by itself, so 0.27.0 and
 * 0.27.1 canvases answer too; `gesture`, `probes` and `board` from a 0.27.2 shell.
 * - `gesture`: perf.ts's begin and end (`on`), numbered (`seq`) - the white-out detector's window (A3.8 #15);
 * - `probes`: the shell's answer to a probes ask (A3.8 #16): `before` lists up to 32 points in client px, `after`
 *   says which of them are still valid (moved by less than their clearance between the two answers);
 * - `mem`: `process.getProcessMemoryInfo().private` and `getHeapStatistics()`, all in KB (A3.8 #5);
 * - `shown`: the second animation-frame callback after a `shown` ask (A3.8 #9: a frame produced, not presented);
 * - `board`: the board's frame count and how many sleep, at each commit (Copy Details, A3.8 #9).
 */
export type PerfMsg =
  | { kind: 'gesture'; on: boolean; seq: number; type?: 'pan' | 'zoom' | 'layout' }
  | { kind: 'probes'; tick: number; at: 'before'; points: [number, number][]; cam: PerfCam | null; view: PerfSize }
  | { kind: 'probes'; tick: number; at: 'after'; valid: boolean[]; cam: PerfCam | null; view: PerfSize }
  | { kind: 'mem'; tick: number; privateKB: number; heapUsedKB: number; heapTotalKB: number }
  | { kind: 'shown'; tick: number }
  | { kind: 'board'; frames: number; asleep: number }

/**
 * `mv:perf-ask` (main to canvas; on the wire `{ doc, ...PerfAsk }`). The preload answers `mem` and `shown` itself,
 * keeps `display`'s rate for `perfInfo()`, and hands `probes` to the shell's `onPerfAsk` listeners (only the shell
 * can answer them). An ask for another document is dropped.
 */
export type PerfAsk =
  | { kind: 'mem'; tick: number }
  | { kind: 'shown'; tick: number }
  | { kind: 'probes'; tick: number; at: 'before' | 'after' }
  | { kind: 'display'; hz: number }
/** What reaches the shell's `onPerfAsk`. */
export type PerfProbeAsk = Extract<PerfAsk, { kind: 'probes' }>

/** The canvas channels. `mv:inset` is gone (A3.8 #26: `mv:doc` answers it); needs-you and capture are A4's. */
export const CANVAS_CHANNELS = {
  doc: 'mv:doc',
  admit: 'mv:admit',
  hello: 'mv:hello',
  theme: 'mv:theme',
  busy: 'mv:busy',
  menu: 'mv:menu',
  appState: 'mv:app-state',
  menuClick: 'mv:menu-click',
  /** A3: the one ground's presentation epochs (A3.8 #27) */
  present: 'mv:present',
  presented: 'mv:presented',
  /** A3: the recorder (A3.8 #10) */
  perf: 'mv:perf',
  perfAsk: 'mv:perf-ask',
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
  /** A3.8 #27: an epoch is an integer 0..epoch; a presentation viewport's sides are 0..viewport CSS px; `frames` 1..frames */
  epoch: 2 ** 31 - 1,
  viewport: 20_000,
  frames: 8,
} as const

/**
 * `mv:perf`'s bounds, checked by the bridge (A3.8 #10): unknown fields are stripped and a value past its bound
 * refuses the message; past `perSecond` a second per webContents (a token bucket holding `burst`) a message is
 * dropped and counted. Main's asks keep the same bounds.
 */
export const PERF_BOUNDS = {
  /** tick and seq: integers 0..counter */
  counter: 2 ** 31 - 1,
  points: 32,
  coord: 20_000,
  kb: 1e9,
  frames: 1_000_000,
  hz: { min: 1, max: 1000 },
  perSecond: 30,
  burst: 64,
} as const

/**
 * `window.marverApp`, exposed by the canvas preload to verified local canvases. Typed methods only: a page never
 * names a channel. The six methods of 0.1 are required (marver-app.ts checks them); every A3 one is optional.
 */
export interface MarverAppV1 {
  readonly v: 1
  /**
   * 0 in app 0.1; 0 or 44 from app 0.2: the inset this document must apply, for its whole life (`mv:doc`'s
   * answer). A shell applies 44 only when `onPresent` and `presented` exist too (inset.ts, A3.8 #31).
   */
  readonly topInset: Inset
  /** the app reloaded this tab after a crash, or reopens it after an unload: restore the saved camera even when the link names a selection (A2.9, A3.8 #43) */
  readonly reopen: boolean
  hello(p: Hello): void
  theme(p: Theme): void
  busy(p: Busy): void
  menu(items: MenuItem[]): void
  onAppState(fn: (s: AppState) => void): () => void
  onMenuClick(fn: (p: MenuClick) => void): () => void
  /** A3 (app 0.2): main's presentation requests for this document */
  onPresent?(fn: (r: Present) => void): () => void
  /** A3 (app 0.2): the answer to a presentation request, sent at once */
  presented?(p: Presented): void
  /** A3 (app 0.2): a recorder message (gesture, probes, board); the preload sends mem and shown itself */
  perf?(p: PerfMsg): void
  /** A3 (app 0.2): main's probe asks (the white-out detector, A3.8 #16) */
  onPerfAsk?(fn: (a: PerfProbeAsk) => void): () => void
  /** A3 (app 0.2): the display's refresh rate from main's `display` ask, null until one came; the shell puts it on its gesture records */
  perfInfo?(): { hz: number | null }
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
