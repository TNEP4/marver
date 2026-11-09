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
 *
 * A4 (app 0.3, marver 0.29.0) adds, frozen before its streams split (A4.6 #56) and `v` still 1: the features a slot
 * file may list (`FEATURE`, A4.6 #2); the live stream's event and wire (`LiveEvent`, `LIVE_BOUNDS`, `LIVE_WIRE`,
 * A4.6 #11, #14), which the server writes and main reads - no page ever opens it; `mv:open` / `mv:opened`, a notice's
 * click handed to the shell (`OpenItem`, `OpenResult`, A4.6 #29, #30); `mv:capture`, a live picture of the
 * document's own view (`CaptureAsk`, `CaptureAnswer`, A4.6 #35). The new methods are optional, as A3's are.
 *
 * Spec 30 (app 1.0.1, marver 0.30.0) adds, frozen before its streams split and `v` still 1: `mv:perf`'s `watch`, the
 * three white-out windows a shell asks for (R8 #38), sent only when `perfInfo().watch` is true - app 1.0.0 would refuse
 * it and spend the tab's bucket; and `mv:menu-click`'s `in`, the menu a relayed item came from (#51), absent from 1.0.0
 * (the shell then records `in: 'app'`). Owners: app-store (`watch`, `perfInfo().watch`), commands (`in`).
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
/** `group: 'file'` (app 1.1, spec 31): an item for the File menu under the canvas's name - a shell offers one only to an
 *  app that has `exportPdf` (an older app refuses a menu naming a group it does not know). */
export interface MenuItem { id: string; group: 'view' | 'jam' | 'file'; label: string; hint?: string; checked?: boolean }
/** `mv:app-state` (main to canvas). `untrusted`: stop every microphone track (A2.14 #13). A4 adds `mv:open` and
 *  `mv:capture`; this stays these three (A4.6 #29). */
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
/** Spec 30 #51: the menu a relayed item came from - a View or Jam item, or the tab's right-click menu. */
export const MENU_IN = ['menu', 'tab-menu'] as const
export type MenuIn = (typeof MENU_IN)[number]
/** `mv:menu-click` (main to canvas). `in` (app 1.0.1): where the person chose it; absent from app 1.0.0. */
export interface MenuClick { id: string; in?: MenuIn }
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
 * - `board`: the board's frame count and how many sleep, at each commit (Copy Details, A3.8 #9);
 * - `watch` (spec 30 R8 #38, app 1.0.1): a white-out window the shell opens (`on`) and closes, numbered (`seq`) like a
 *   gesture's - `load` from the request to settled or cut, `theme` from a switch to its outcome, `reload` from an
 *   on-screen job's `startReload` to its ready. Main keeps one window per tab: a new reason extends it, and a window
 *   ends at 10 s whatever the shell says.
 */
export type PerfMsg =
  | { kind: 'gesture'; on: boolean; seq: number; type?: 'pan' | 'zoom' | 'layout' }
  | { kind: 'probes'; tick: number; at: 'before'; points: [number, number][]; cam: PerfCam | null; view: PerfSize; /** spec 30 #39: a play stage covers the canvas - no ground to probe, no capture taken */ stage?: true }
  | { kind: 'probes'; tick: number; at: 'after'; valid: boolean[]; cam: PerfCam | null; view: PerfSize }
  | { kind: 'mem'; tick: number; privateKB: number; heapUsedKB: number; heapTotalKB: number }
  | { kind: 'shown'; tick: number }
  | { kind: 'board'; frames: number; asleep: number }
  | { kind: 'watch'; on: boolean; seq: number; why: WatchWhy }

/** Spec 30 R8 #38: the windows a shell asks for; main's own are `gesture` and `shown` (app-perf.ts `WHITEOUT_WHY`). */
export const WATCH_WHY = ['load', 'theme', 'reload'] as const
export type WatchWhy = (typeof WATCH_WHY)[number]
/** #40: a non-gesture window's end, whatever the shell says. */
export const WATCH_MAX_MS = 10_000

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

/** The canvas channels. `mv:inset` is gone (A3.8 #26: `mv:doc` answers it). A4 adds `mv:open` and `mv:capture`;
 *  `mv:needs-you` is cut (A4.6 #15): main reads what needs you from the server's live stream. */
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
  /** A4: a notice's click (main to canvas) and the shell's answer (A4.6 #29) */
  open: 'mv:open',
  opened: 'mv:opened',
  /** A4: a live picture of the document's own view - an invoke (A4.6 #35) */
  capture: 'mv:capture',
  /** app 1.1 (spec 31): a finished deck PDF saved where the person says - an invoke carrying only the job id */
  exportPdf: 'mv:export-pdf',
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
  /** A4.6 #35, #37: a live picture's long side at most (main scales down to it; the server refuses past it), and
   *  main's deadline for one capture */
  captureLong: 4096,
  captureMs: 1500,
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

// ---- A4 (app 0.3, marver 0.29.0): frozen by A4.6 #56 ----------------------------------------------------------

/**
 * What a slot file's `features` say a canvas offers the Mac app (src/server/slots.ts `FEATURES`; the app reads each
 * registry entry's). A name is a version (A4.6 #2): a breaking change to its contract takes a new name (`live2`),
 * never a new meaning for this one, and `bridge` and `inset` imply none of the others. An app ignores a name it does
 * not know (A1.3), and asks nothing of a canvas that does not list one (A4.6 #3).
 */
export const FEATURE = {
  /** 0.27.1 (A2.9, A2.14 #15): the shell says hello, theme, menu and `mv:busy` with `unsaved` */
  bridge: 'bridge',
  /** 0.27.2 (A3.8 #31): the shell takes the top inset under the strip and answers presentation requests */
  inset: 'inset',
  /** 0.29.0 (A4.6 #5, #6, #11): the server answers `GET /__mv/app/live` (`LIVE_WIRE`) with `LiveEvent` v1 */
  live: 'live',
  /** 0.29.0 (A4.6 #29, #30): the shell handles `mv:open` and answers `mv:opened` */
  open: 'open',
  /** 0.29.0 (A4.6 #33-#37): the shell asks `mv:capture` for live pictures and the server takes `POST /api/jam/picture/live` */
  capture: 'capture',
  /** 0.31.0 (spec 31 Part A): the server makes deck PDFs (`/__mv/api/pdf`) and the shell asks `mv:export-pdf` to save one */
  pdf: 'pdf',
} as const
export type Feature = (typeof FEATURE)[keyof typeof FEATURE]

/** What waits on the owner, one item per need (A4.6 #8, #10). `stopped` is main's own item, never on the wire (#20). */
export const LIVE_KINDS = ['ask', 'review', 'failed', 'stalled'] as const
export type LiveKind = (typeof LIVE_KINDS)[number]

/**
 * One need (A4.6 #8-#11). Its `id` is `<kind>:` and the first 20 hex of a sha256 over the occurrence's persisted
 * parts (#9): the same need gives the same id across reconnects and restarts, a new occurrence a new id; the app
 * compares ids and never parses one. Every ref (`board`, `frame`, `thread`, `msg`, a card or batch id) is at most
 * `LIVE_BOUNDS.ref`; an item with a longer one is left out of `items` and still counted.
 */
export interface LiveItem {
  id: string
  kind: LiveKind
  board: string
  /** one line: whitespace collapsed, control characters removed, at most 140 UTF-16 units, never cut inside a pair */
  title: string
  /** failed: why, at most 140 */
  note?: string
  /** when it began waiting: order only, never identity */
  at: number
  frame?: string
  /** an ask's thread; a comment card's thread */
  thread?: string
  /** ask: the asking message's id - its occurrence */
  msg?: string
  /** the Jam cards it covers, at most 8 (MAX_MEMBERS) */
  cards?: string[]
  /** review, failed with a run, stalled */
  batch?: string
  /** stalled: the claim's generation */
  gen?: number
  /** the counter in its id (A4.6 #9, r1 #1): a review's `att`, a failed run's `failures` (a card that failed with no
   *  run: its `att`), a stalled run's `stalls`. A click compares it with the view as it is then (#30) */
  occ?: number
}

/** One snapshot of the live stream, whole every time (A4.6 #11, #12): no deltas. */
export interface LiveEvent {
  v: 1
  /** the slot file's; equals the response's `x-mv-instance` */
  instance: string
  /** per server process: rises across Vite restarts of one instance */
  seq: number
  /** off: no Jam view here (Jam off, or the repo's Jam lock held elsewhere) - its review, failed and stalled are then
   *  0 because nothing on this canvas can act on them, not because none wait (#12) */
  jam: 'on' | 'off'
  /** newest first by `at`, at most `LIVE_BOUNDS.items`, and only as many as fit `eventBytes` */
  items: LiveItem[]
  /** items the cap or the byte budget left out (the oldest); 0 when none. An item left out for a long ref is not here */
  cut: number
  /** exact, before the cap */
  counts: { ask: number; review: number; failed: number; stalled: number }
  /** frames new to the owner: a count only, never items, never a notice */
  unseen: number
  /** `marver work` holds a lease, or a Jam run is at work (not stalled, offered, waiting or stopping) (#8) */
  working: boolean
  /** a Jam session runs (`!!view.session`) */
  session: boolean
}

/**
 * The bounds both sides keep (A4.6 #11, #16): the server's selector and encoder write within them, and main checks
 * every field again, stripping unknown ones and dropping an item of an unknown kind (not the event). `eventBytes`:
 * the event as written (`event: live`, its `data:` line, the blank line) in UTF-8 bytes - the encoder drops the
 * oldest whole items until it fits, and main drops a connection whose event is longer.
 */
export const LIVE_BOUNDS = {
  items: 100,
  title: 140,
  note: 140,
  ref: 128,
  cards: 8,
  eventBytes: 65_536,
  id: /^(ask|review|failed|stalled):[0-9a-f]{20}$/,
} as const

/**
 * The live stream's wire (A4.6 #5, #6, #14). `GET <origin><path>` with `x-mv-ws`, a fresh `x-mv-nonce` and
 * `x-mv-app` = `appProof(key, port)`; the 200 is `text/event-stream` carrying `x-mv-instance` and `x-mv-proof` =
 * `liveProof(key, nonce, port)` (src/server/proof.ts). Each snapshot is `event: <event>`, one `data:` line of
 * `LiveEvent` JSON, then a blank line; `<heartbeat>` is a comment line every `heartbeatMs`. No `Last-Event-ID`, no
 * `retry:`. At most `clients` at once (one more ends the oldest); a client with more than `slowBytes` unsent is
 * dropped and reconnects.
 */
export const LIVE_WIRE = {
  path: '/__mv/app/live',
  type: 'text/event-stream',
  event: 'live',
  heartbeat: ': hb',
  heartbeatMs: 30_000,
  clients: 4,
  slowBytes: 65_536,
} as const

/** What a notice's click hands the shell (A4.6 #29, r1 #1): the item as the stream gave it, its words left out. */
export type OpenItem = Pick<LiveItem, 'id' | 'kind' | 'board' | 'thread' | 'msg' | 'cards' | 'batch' | 'gen' | 'occ'>
/**
 * The shell's answer (A4.6 #30): `handled` - the item is on screen; `stale` - its target stands in another state, or
 * the same state with another counter, and opens as it stands; `missing` - the target is gone, its board opens;
 * `busy` - a capture records or words wait unsent, nothing moved; `dropped` - a read failed, the deadline passed or
 * a later request took its place, nothing moved.
 */
export const OPEN_RESULTS = ['handled', 'stale', 'missing', 'busy', 'dropped'] as const
export type OpenResult = (typeof OPEN_RESULTS)[number]
/** `mv:open` (main to canvas; on the wire `{ doc, item }`, stamped by main like `mv:app-state`). */
export interface Open { item: OpenItem }
/** `mv:opened` (canvas to main; on the wire `{ doc, p }`, stamped by the preload and accepted like the reports). */
export interface Opened { id: string; result: OpenResult }

/** `mv:capture`'s rect, in view CSS px (A4.6 #35): finite, `x, y >= 0`, `width, height >= 1`, inside the view. */
export interface CaptureRect { x: number; y: number; width: number; height: number }
/** `mv:capture` (canvas to main, an invoke; on the wire `{ doc, p }`). */
export interface CaptureAsk { rect: CaptureRect }
/** Why there is no picture (A4.6 #35): the shell then takes the server's render, as without the app (#36). */
export const CAPTURE_WHY = ['hidden', 'busy', 'bounds', 'empty', 'timeout', 'stale', 'untrusted'] as const
export type CaptureWhy = (typeof CAPTURE_WHY)[number]
/** The PNG's bytes cross IPC as a `Uint8Array` (a sandboxed preload has no `Buffer` in Electron 45, A4.6 #1); its
 *  size in device pixels, its long side at most `BOUNDS.captureLong`. */
export type CaptureAnswer = { ok: true; png: Uint8Array; width: number; height: number } | { ok: false; why: CaptureWhy }

/** A deck PDF job's id (src/server/pdf.ts JOB_ID): 128 random bits, base64url. */
export const PDF_JOB = /^[A-Za-z0-9_-]{22}$/
/** The largest PDF main fetches and writes (spec 31: 200 MB). */
export const PDF_MAX = 200 * 2 ** 20
/** `mv:export-pdf` (canvas to main, an invoke; on the wire `{ doc, p }`): the finished job to save. */
export interface ExportPdfAsk { job: string }
/** Why nothing was saved: `cancelled` - the person closed the save panel; `untrusted` - the document is not the admitted,
 *  trusted one (before the panel or after it); `bad-job` - no such finished job on this canvas; `too-large` - past
 *  `PDF_MAX`; `failed` - the fetch or the write failed. */
export const EXPORT_PDF_WHY = ['cancelled', 'untrusted', 'bad-job', 'too-large', 'failed'] as const
export type ExportPdfWhy = (typeof EXPORT_PDF_WHY)[number]
export type ExportPdfAnswer = { ok: true } | { ok: false; why: ExportPdfWhy }

/**
 * `window.marverApp`, exposed by the canvas preload to verified local canvases. Typed methods only: a page never
 * names a channel. The six methods of 0.1 are required (marver-app.ts checks them); every A3 and A4 one is optional.
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
  /**
   * A3 (app 0.2): the display's refresh rate from main's `display` ask, null until one came; the shell puts it on its
   * gesture records. `watch` (app 1.0.1, spec 30 #38): true when main takes `mv:perf` `watch` - a shell sends it only then
   */
  perfInfo?(): { hz: number | null; watch?: boolean }
  /**
   * A4 (app 0.3): main's `mv:open` for a clicked notice, delivered once to this document after its hello when its
   * instance lists `open` (A4.6 #29). The shell resolves the occurrence against a fresh read and answers (#30); the
   * preload sends the answer as `mv:opened`
   */
  onOpen?(fn: (p: OpenItem) => OpenResult | Promise<OpenResult>): () => void
  /**
   * A4 (app 0.3): a picture of this document's own view, `rect` in view CSS px (A4.6 #35). Before an admit it
   * answers `untrusted` with no IPC; main answers `hidden`, `busy`, `bounds`, `empty`, `timeout` or `stale` otherwise
   */
  capture?(a: CaptureAsk): Promise<CaptureAnswer>
  /**
   * app 1.1 (spec 31): save a finished deck PDF. Only the job id crosses: main fetches the file itself from the admitted
   * canvas origin, shows the save panel, checks the document again, and writes the file where the panel says
   */
  exportPdf?(a: ExportPdfAsk): Promise<ExportPdfAnswer>
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
