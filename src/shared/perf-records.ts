/**
 * Spec 30's records, in one place (R13): every kind the complete recorder adds or changes, on the canvas side
 * (design/.local/perf/page.jsonl and reloads.jsonl, written by the dev server) and the `cmd` record the canvas and the
 * Mac app share. The app's other kinds (`launch`, `window`, the white-out fields) are in app-perf.ts, beside the kinds
 * they extend. Types, constants and a few pure helpers only - no imports - so the shell, the frame host, the server,
 * the CLI and the app's main bundle all take it as it is.
 *
 * FROZEN before the spec 30 streams split. `v` stays 1 (#3): every change is a new kind or an optional field, and a
 * field's meaning never changes. Owners (the stream that writes it; readers are the app-store stream's, R10, R11, R14):
 *  - edits (R1, R2): `change`, `update`/`update-ids`, `full-reload`, `invalidate`/`invalidate-ids`, the shell's reload
 *    lines (`shell-boot`, `ready`, `settled`, `invalidated`/`invalidated-nodes`, `inplace`, `watchdog`), `load`'s
 *    trigger, writer and candidates, `cut`'s partial times, the reload batch route and the `(page, seq)` dedupe;
 *  - signals (R3-R6): `theme`, `mode`, `error`'s new sources and `modes`, `warnings`, `hmr`, `gesture`'s new fields,
 *    `renders`;
 *  - commands (R12): `cmd` (page and app), `by` wherever an effect names its command;
 *  - app-store (R7-R11, R14, R15): `self`, `dropped`'s `retention-cap`, the segments, the recorder level's run.
 *
 * Privacy (#4): the recorder's own hooks record names, key combinations, ids, counts and times only - never an input's
 * value, the clipboard, a body or a query string. Error and console messages are kept as the code produced them.
 */

// ---- the recorder level (#57, #58) -------------------------------------------------------------------------------

/** `core` turns off everything spec 30 adds and keeps 0.29's load tracking; `full` (the default) records it all. */
export const RECORDER_LEVELS = ['core', 'full'] as const
export type RecorderLevel = (typeof RECORDER_LEVELS)[number]
/** The query parameter that sets it (`?mvrecorder=core`): on the shell's URL - `marver perf run --recorder core` puts
 *  it there - and carried by `withWs()` onto frame and stage URLs, so a frame's hooks keep the page's level. */
export const RECORDER_PARAM = 'mvrecorder'

// ---- ids --------------------------------------------------------------------------------------------------------

/** A page, a load, a command or a transition (`t`): 12 hex (recorder-core.ts `newId()`). */
export const ID12 = /^[0-9a-f]{12}$/
/** A watcher event's change (#8): `<boot 8 hex>:<n>`, minted by the dev server, one per event. */
export const CHANGE_ID = /^[0-9a-f]{8}:\d{1,9}$/
/** A refused refresh has no identity of its own (#8): its `update` line says so. */
export const UNKNOWN_CHANGE = 'unknown'

/** At most 8 ids, and how many there were (#R0: "at most 8 candidate ids and their count"). */
export interface Candidates { ids: string[]; n: number }

// ---- bounds (one place: writers, the server's cleaners and readers keep the same numbers) ------------------------

/** R1: ids per reload line before the rest go to `-ids` parts (#10, #12, #13); candidates kept (#8, #11); the
 *  `hmrTs → change` history (#8); a refused refresh's look-back (#8); an inplace's wait for the next commit (#15). */
export const RELOAD_BOUNDS = { idsPerLine: 256, candidates: 8, hmrHistory: 512, lookBackMs: 10_000, commitWaitMs: 2_000 } as const
/** #7: the server's best-effort `(page, seq)` window - every reader dedupes again. */
export const DEDUPE = { windowMs: 600_000, perPage: 4_096, pages: 64 } as const
/** #16: the shell's reload Outbox (recorder-core.ts `Outbox`), its send delay, and its share of a page's keepalive
 *  allowance at `pagehide` (#7: Jam's captures first, page records 16 KB, reload lines 8 KB). */
export const RELOAD_OUTBOX = { max: 1_000, bytes: 128 * 1024, sendMs: 2_000, keepaliveBytes: 8 * 1024 } as const
/** #18: the hashes a board write keeps, for the watcher's `sh:board` to match. */
export const WRITE_MATCH_MS = 10_000
/** #20: the ready watchdog's first silence (FrameNode.tsx:285). */
export const WATCHDOG_MS = 10_000
/** #23, #25: a transition's ack deadline, and the rate of `theme` and `mode` records (#57). */
export const TRANSITION = { timeoutMs: 5_000, perSecond: 10 } as const
/** #33: limited at the source. In each frame (bridge.js, before formatting or posting): errors, console errors and
 *  resource errors share `perSecond` and `perDoc`; refused counts travel in `sh:dropped`, at most one a `countsMs`.
 *  In the shell: `perLoad` and the `sameMs` duplicate rule for every source, plus `perSourcePerSecond` for console,
 *  api and resource. bridge.js ships verbatim (build.ts copies it): it repeats these numbers inline. */
export const ERROR_BUDGET = {
  frame: { perSecond: 5, perDoc: 50, countsMs: 1_000 },
  shell: { perLoad: 50, sameMs: 1_000, perSourcePerSecond: 5 },
} as const
/** #28: console warnings are counted per page per minute, the `top` nodes by count. */
export const WARNINGS = { periodMs: 60_000, top: 8 } as const
/** #35: the Long Animation Frames kept per gesture, and the script's `fn` length. */
export const LOAF = { kept: 3, fn: 64 } as const
/** #36: one `renders` record per minute, its heaviest rows (the rest folded into `others`). */
export const RENDERS = { periodMs: 60_000, rows: 64 } as const
/** #48: command starts per page (a token bucket), the default deadline (#49), and the ids a write carries (#18). */
export const CMD_BOUNDS = { perSecond: 10, burst: 20, deadlineMs: 10_000, writeIds: 8 } as const
/** #30: how long the canvas coming back waits for `hmr back` to go before it reloads. */
export const HMR_BACK_WAIT_MS = 1_000
/** #58: a `self` record every 5 minutes in which the page recorded anything. */
export const SELF_MS = 300_000

// ---- R9: files, segments and retention (#42-#45) ------------------------------------------------------------------

/** Days a closed segment is kept past its `bound` (`keepPerfDays` in the app). */
export const KEEP_DAYS = 14
/** Each file's segment size (a live file is also closed 24 h after it was opened) and its safety cap (#43). */
export const SEGMENTS = {
  'page.jsonl': { segmentBytes: 8 * 2 ** 20, capBytes: 128 * 2 ** 20 },
  'reloads.jsonl': { segmentBytes: 8 * 2 ** 20, capBytes: 48 * 2 ** 20 },
  'jam.jsonl': { segmentBytes: 2 * 2 ** 20, capBytes: 8 * 2 ** 20 },
  'runs.jsonl': { segmentBytes: 2 * 2 ** 20, capBytes: 8 * 2 ** 20 },
  'app.jsonl': { segmentBytes: 4 * 2 ** 20, capBytes: 16 * 2 ** 20 },
  'app-dev.jsonl': { segmentBytes: 4 * 2 ** 20, capBytes: 16 * 2 ** 20 },
  'samples.jsonl': { segmentBytes: 8 * 2 ** 20, capBytes: 128 * 2 ** 20 },
  'samples-dev.jsonl': { segmentBytes: 8 * 2 ** 20, capBytes: 128 * 2 ** 20 },
} as const
export type SegmentedFile = keyof typeof SEGMENTS
export const SEGMENT_MAX_AGE_MS = 86_400_000

/** A closed segment's name (#42): `<name>.<openedAt>-<bound>.jsonl`, both epoch ms; `bound` is a conservative newest
 *  time (the later of its close and the largest `ts` written into it; an adopted file's mtime + 24 h). */
export const segmentName = (file: SegmentedFile, openedAt: number, bound: number): string =>
  `${file.slice(0, -'.jsonl'.length)}.${Math.round(openedAt)}-${Math.round(bound)}.jsonl`
/** A segment of `file`, read back from its name; null for any other name (the live file included). */
export function parseSegmentName(file: SegmentedFile, name: string): { openedAt: number; bound: number } | null {
  const base = file.slice(0, -'.jsonl'.length).replace(/[.-]/g, (c) => `\\${c}`)
  const m = new RegExp(`^${base}\\.(\\d{10,16})-(\\d{10,16})\\.jsonl$`).exec(name)
  return m ? { openedAt: Number(m[1]), bound: Number(m[2]) } : null
}

// ---- the page's records (page.jsonl) -----------------------------------------------------------------------------

/** Every kind a page sends (recorder-core.ts `KINDS` and the server's `PAGE_KINDS` read this list). */
export const PAGE_KINDS = [
  'load', 'commit', 'visible', 'frame', 'move', 'quiet', 'settled', 'cut', 'gesture', 'error', 'dropped',
  // spec 30
  'renders', 'warnings', 'theme', 'mode', 'hmr', 'cmd', 'self',
] as const
export type PageKind = (typeof PAGE_KINDS)[number]

/** #17: why `boot()` read a board again; a switch keeps `cause: 'switch'` and has none. */
export const LOAD_TRIGGERS = ['first', 'disk', 'save-conflict', 'app-shown'] as const
export type LoadTrigger = (typeof LOAD_TRIGGERS)[number]
/** #18: who wrote the board file a disk reload read - never claimed as proven. */
export const WRITER_ATTRIBUTION = ['candidate', 'ambiguous', 'unknown'] as const
export type WriterAttribution = (typeof WRITER_ATTRIBUTION)[number]
/** One write the server saw whose hash matches (#18): the page and the commands folded into it. */
export interface WriterCandidate { page: string; cmds: string[]; n: number }

/** `load` gains (#17, #18; `by` #48): the request's trigger, the disk writer's attribution, the command behind it. */
export interface LoadFields {
  trigger?: LoadTrigger
  writer?: WriterAttribution
  /** candidate: one; ambiguous: two or more (at most 8) */
  candidates?: WriterCandidate[]
  by?: string
}
/** `cut` gains (#19): what was ready by then, as `settled` computes it, and the visible frames ready. */
export interface CutFields { visibleReadyMs?: number; allReadyMs?: number; visibleReady?: number }

/** #35: one of a gesture's three longest Long Animation Frames; Safari and Firefox (long tasks) give `ms` alone. */
export interface Loaf {
  ms: number
  blockMs?: number
  /** its longest script: `src` a URL path without query (a frame's module path names `frame`), `fn` 64 characters */
  script?: { src?: string; frame?: string; fn?: string; invoker?: string; ms: number; where?: string }
}
/** `gesture` gains (#34, #35). */
export interface GestureFields {
  scale?: { from: number; to: number; min: number; max: number }
  visible?: number
  /** iframes minus asleep (`weight()`) */
  awake?: number
  loaf?: Loaf[]
  by?: string
}

/** #36: one row of a minute's re-renders - `who` is `shell`, `stage`, a node key, or `others` (the rest folded). */
export interface RenderRow { who: string; frame?: string; commits: number; ms: number; maxMs: number; inGesture: number; rows?: number }
/** `renders`, one a minute: React's render work only (`actualDuration`), not layout or paint - the reader says so. */
export interface RendersBody { minute: number; rows: RenderRow[] }

/** Where an `error` came from (#28-#32, kept: shell, frame, stage). */
export const ERROR_SOURCES = ['shell', 'frame', 'stage', 'console', 'vite', 'api', 'resource'] as const
export type ErrorSource = (typeof ERROR_SOURCES)[number]
/** #32: the elements whose load error is recorded. */
export const RESOURCE_TAGS = ['img', 'script', 'link', 'video', 'audio', 'source'] as const
export type ResourceTag = (typeof RESOURCE_TAGS)[number]
/** `error` gains (#27-#32). `status`: an HTTP status of 400 or more, 0 for the network, `timeout` for mvFetch's own. */
export interface ErrorFields {
  source?: ErrorSource
  /** api: `boards/:board`, ids and names replaced; never a query */
  route?: string
  method?: string
  status?: number | 'timeout'
  ms?: number
  /** resource: the element, and a same-origin path without query - another origin: its origin */
  tag?: ResourceTag
  url?: string
  /** vite: repo-relative */
  file?: string
  plugin?: string
  /** the modes on when it happened (#27) */
  modes?: ModeName[]
}

/** #28: console warnings, counted - no text. */
export interface WarningsBody { n: number; top: { node: string; n: number }[] }

/** #21-#23: a theme switch, by transition. */
export const THEME_SCOPES = ['view', 'selection', 'play'] as const
export type ThemeScope = (typeof THEME_SCOPES)[number]
export const TRANSITION_OUTCOMES = ['done', 'timeout', 'superseded'] as const
export type TransitionOutcome = (typeof TRANSITION_OUTCOMES)[number]
export interface ThemeBody {
  t: string
  scope: ThemeScope
  to: string
  by?: string
  /** the displayed cohort (#22), and how many of it acknowledged */
  frames: number
  applied: number
  p50Ms?: number
  maxMs?: number
  /** unacknowledged at the timeout */
  late?: number
  outcome: TransitionOutcome
}

/** #24: a state that changes what input does until left. */
export const MODES = ['laser', 'inspect', 'comments', 'interact', 'play', 'slides', 'hide-ui', 'jam-session', 'jam-capture', 'jam-review', 'jam-lane'] as const
export type ModeName = (typeof MODES)[number]
/** #25, #26: `enter` carries the shown fields, `exit` the held ones. */
export interface ModeBody {
  mode: ModeName
  phase: 'enter' | 'exit'
  t: string
  by?: string
  shownMs?: number
  /** play and slides: to the first `sh:stage-shown` */
  firstFrameMs?: number
  frames?: number
  outcome?: TransitionOutcome
  heldMs?: number
  /** errors while it was on (#27) */
  errors?: number
}

/** #30: Vite's socket lost, and the canvas back. */
export interface HmrBody { phase: 'lost' | 'back'; downMs?: number }

/** #58: the recorder's own cost over the last 5 minutes. */
export const SELF_HOOKS = ['console', 'theme', 'mode', 'cmd', 'renders', 'send'] as const
export type SelfHook = (typeof SELF_HOOKS)[number]
export interface SelfBody { cpuMs: number; hookMs: Partial<Record<SelfHook, number>>; records: number; bytes: number; dropped: number }

/** Why records were dropped (#5, #33, #43, #48): `errors` past a load's 50 (as today), a source's own rate or a
 *  frame's budget (`sh:dropped`), command starts past their rate, transitions past theirs, the safety cap. */
export const DROP_REASONS = ['errors', 'shell', 'frame', 'stage', 'console', 'vite', 'api', 'resource', 'cmd', 'theme', 'mode', 'retention-cap'] as const
export type DropReason = (typeof DROP_REASONS)[number]
export interface DroppedBody { n: number; reason?: DropReason }

// ---- commands (R12; page.jsonl and app.jsonl) ----------------------------------------------------------------------

/** #50: how the input arrived. */
export const CMD_VIA = ['key', 'click', 'menu', 'context', 'drag', 'dblclick', 'relay'] as const
export type CmdVia = (typeof CMD_VIA)[number]
/** #50: the surface it arrived on; `app` is a relay from an app that does not say which menu (#51). */
export const CMD_IN = ['shell', 'frame', 'stage', 'strip', 'home', 'settings', 'tabpage', 'pill', 'menu', 'tab-menu', 'main', 'app'] as const
export type CmdIn = (typeof CMD_IN)[number]
/** #49: what a command came to. `unobserved` says only that no signal came by its deadline. */
export const CMD_OUTCOMES = ['done', 'failed', 'noop', 'cancelled', 'unobserved'] as const
export type CmdOutcome = (typeof CMD_OUTCOMES)[number]
/** What a reader makes of a start with no end whose page or app is gone (#48): never written. */
export type CmdReadOutcome = CmdOutcome | 'interrupted'
/** #48: a start and an end, or one `once` record for a command decided in its input's own turn. */
export const CMD_PHASES = ['start', 'end', 'once'] as const
export type CmdPhase = (typeof CMD_PHASES)[number]
/** A milestone on the way (#49): its name and ms from the start. */
export interface CmdStep { name: string; ms: number }

interface CmdInput {
  /** 12 hex: effects name it in `by` */
  id: string
  cmd: string
  via: CmdVia
  /** the combination as `descriptor()` writes it (jam-keys.ts:33): `key` and key relays only */
  keys?: string
  in: CmdIn
  /** a fixed identifier the command acts on - a setting's key, a Jam switch's name, Home's `dev`/`init`/`update` -
   *  never a value (an addition to R13's list: `setting` and `jam-pref` name what they changed) */
  arg?: string
  board?: string
  /** how many frames it acts on, and the one when there is one */
  frames?: number
  frame?: string
}
interface CmdResult {
  outcome: CmdOutcome
  /** a code from the command's table (commands.ts), or `deadline` for `unobserved` */
  why?: string
  /** from the input */
  ms: number
  steps?: CmdStep[]
  /** a completion after the deadline wrote `unobserved`: a second end */
  late?: true
}
export type CmdRecord =
  | ({ phase: 'start' } & CmdInput)
  | ({ phase: 'end'; id: string; cmd: string } & CmdResult)
  | ({ phase: 'once' } & CmdInput & CmdResult)

/** #18: the headers every shell request that can write a board file sends - its page, and the commands folded into
 *  it (`encodeCmds`). The server keeps them with the hash it wrote, for `WRITE_MATCH_MS`. */
export const WRITER_HEADERS = { page: 'x-mv-page', cmds: 'x-mv-cmds' } as const
/** `x-mv-cmds`: at most 8 ids, comma-separated, then `;n=<count>` when there were more. */
export function encodeCmds(c: Candidates): string {
  const ids = c.ids.filter((x) => ID12.test(x)).slice(0, CMD_BOUNDS.writeIds)
  return `${ids.join(',')}${c.n > ids.length ? `;n=${Math.floor(c.n)}` : ''}`
}
/** `x-mv-cmds` read back; null for anything else (an empty header is no commands). */
export function decodeCmds(h: unknown): Candidates | null {
  if (typeof h !== 'string' || h.length > 200) return null
  const m = /^((?:[0-9a-f]{12})(?:,[0-9a-f]{12}){0,7})?(?:;n=(\d{1,6}))?$/.exec(h)
  if (!m) return null
  const ids = m[1] ? m[1].split(',') : []
  const n = m[2] === undefined ? ids.length : Number(m[2])
  return n < ids.length ? null : { ids, n }
}

// ---- the reload log (reloads.jsonl) ------------------------------------------------------------------------------

/** Lines the dev server writes (once, never retried): they name no page - a change belongs to every page. */
export const SERVER_RELOAD_KINDS = ['change', 'update', 'update-ids', 'full-reload', 'invalidate', 'invalidate-ids'] as const
/** Lines the shell sends through its reload Outbox (#16): each names its page and seq. */
export const SHELL_RELOAD_KINDS = ['shell-boot', 'ready', 'settled', 'invalidated', 'invalidated-nodes', 'inplace', 'watchdog'] as const
export type ServerReloadKind = (typeof SERVER_RELOAD_KINDS)[number]
export type ShellReloadKind = (typeof SHELL_RELOAD_KINDS)[number]

/** Rollup's `watchChange` event. */
export type ChangeEvent = 'create' | 'update' | 'delete'
/** A part of a list split past `RELOAD_BOUNDS.idsPerLine`: 1-based, of `parts`. */
export interface Part { part: number; parts: number }

/** #9: one per watcher event, at its end. `fullReload`: a page-wide reload it caused passed or was dropped. */
export interface ChangeLine {
  kind: 'change'
  change: string
  file: string
  event: ChangeEvent
  hmrTs?: number
  flightMs?: number
  reloadN?: number
  inPlaceN?: number
  fullReload?: 'passed' | 'dropped'
  /** its hooks never ran: the watcher coalesced it */
  outcome?: 'no-hook'
}
/** #10 (and #8 for a refused refresh: `change` is `unknown`, with `graphTs` and `candidates`). */
export interface UpdateLine {
  kind: 'update'
  cause: 'update' | 'invalidate' | 'reload'
  file: string | null
  reload: string[]
  inPlace: string[]
  change?: string
  reloadN?: number
  inPlaceN?: number
  /** a refused refresh: the module's timestamp as read, never attributed */
  graphTs?: number
  candidates?: Candidates
  /** the lists continue in `update-ids` lines */
  parts?: number
}
export interface UpdateIdsLine extends Part { kind: 'update-ids'; change: string; reload?: string[]; inPlace?: string[] }
/** #11: the pathless full-reload says what it knows. */
export const FULL_RELOAD_BY = ['hook', 'ambiguous', 'unknown'] as const
export type FullReloadBy = (typeof FULL_RELOAD_BY)[number]
export interface FullReloadLine {
  kind: 'full-reload'
  passed: boolean
  triggeredBy: string | null
  path: string | null
  by?: FullReloadBy
  change?: string
  file?: string
  candidates?: Candidates
}
/** #12: the send, with every change it carries (edges many to many). */
export interface InvalidateLine { kind: 'invalidate'; revision: string; frames: number; changes: string[]; parts?: number }
export interface InvalidateIdsLine extends Part { kind: 'invalidate-ids'; revision: string; changes: string[] }

/** Why `ready()` held a node back (canvas/updates.ts:29-33), and `asleep` (sleep.ts). */
export const HELD_BY = ['offscreen', 'leased', 'play', 'loading', 'missing'] as const
export type HeldBy = (typeof HELD_BY)[number]

/** Every shell line's envelope (#16): today's `tab`, and the page and seq the `(page, seq)` dedupe reads. */
export interface ShellLineEnvelope { kind: ShellReloadKind; tab: string; page: string; seq: number; ts?: number }
export interface ShellBootLine extends ShellLineEnvelope { kind: 'shell-boot'; nav?: 'navigate' | 'reload' | 'back_forward' | 'prerender'; resumed?: true }
/** #14: today's `ready` (cause, node, frame, shown, ms) plus the token frozen at its navigation's start. */
export interface ReadyLine extends ShellLineEnvelope {
  kind: 'ready'
  cause?: string
  node: string
  frame: string
  shown?: string
  ms?: number
  revisions?: string[]
  queuedMs?: number
  bootMs?: number
  heldBy?: HeldBy
  asleep?: true
}
export interface SettledLine extends ShellLineEnvelope { kind: 'settled'; node: string; frame: string; ms: number }
/** #13: counted over board nodes; node keys follow in `invalidated-nodes` parts. */
export interface InvalidatedLine extends ShellLineEnvelope {
  kind: 'invalidated'
  revision: string
  asked: number
  offBoard: number
  onBoard: number
  awake: number
  asleep: number
  held: Partial<Record<HeldBy, number>>
  parts?: number
}
export interface InvalidatedNodesLine extends ShellLineEnvelope, Part { kind: 'invalidated-nodes'; revision: string; nodes: string[] }
/** #15: what was seen, no more - `applied` is never true. */
export interface InplaceLine extends ShellLineEnvelope {
  kind: 'inplace'
  node: string
  frame: string
  hmrTs: number
  fetched: true
  applyMs?: number
  nextObservedCommitMs?: number
  applied: 'unknown' | false
}
/** #20: the ready watchdog's silences. */
export interface WatchdogLine extends ShellLineEnvelope { kind: 'watchdog'; node: string; frame: string; nav: number; action: 'retry' | 'gave-up' }
export type ShellReloadLine = ShellBootLine | ReadyLine | SettledLine | InvalidatedLine | InvalidatedNodesLine | InplaceLine | WatchdogLine

/**
 * `POST perf/reload` (#16, #7), the shell's batch: `{ records }`, each rebuilt server-side from its kind's allowlist
 * (as `cleanPageRecord` does), dropped when its `(page, seq)` was written within `DEDUPE`'s window. Answered only after
 * the append returned: 200 `BatchAnswer`, or 503 when the append failed (counted in `failedWrites`). `POST perf/page`
 * keeps its body and answers the same way.
 */
export interface ReloadBatch { records: ShellReloadLine[] }
export interface BatchAnswer { ok: true; accepted: number; duplicates: number }
export interface BatchFailed { error: string; failedWrites: number }

// ---- the dev server to the shell (Vite's socket) -----------------------------------------------------------------

/** `sh:board` (plugin.ts:512) gains what the write match found (#18). */
export interface BoardWriter { writer: WriterAttribution; candidates?: WriterCandidate[] }
