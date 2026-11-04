/**
 * One vocabulary in code (spec 30 R12 #48-#52): every command the canvas records, as data - its lifecycle, the signal
 * that ends it, its deadline and its codes - and the one call every dispatch point makes, `cmd(name, { via, keys, in })`,
 * which returns `done()`, `fail(why)`, `noop(why)`, `cancel()`, `step(name)`. The static gate
 * (test/commands-static.test.ts) checks that every input site and dispatcher branch reaches `cmd()` or appears in
 * `not-commands.json`; the runtime tests (test/commands.test.ts) expect each name's declared lifecycle.
 *
 * The rules the commands stream implements here:
 * - A record per command (#48): `start` at the input and `end` after its signal, the same `id` (12 hex). A command
 *   decided in its input's own turn - `once` names, and any `noop` - writes one `once` record instead. Starts are bounded
 *   at 10/s per page, burst 20; past it `dropped { reason: 'cmd' }` (perf-records.ts `CMD_BOUNDS`).
 * - Outcomes are bound to real signals (#49): its deadline passing with no signal ends it `unobserved` (why
 *   `deadline`); a completion after that is a second `end` with `late: true`.
 * - Provenance from the handler that received it (#50): `via`, `keys` (jam-keys.ts `descriptor()`, key inputs only)
 *   and `in`. A relay is recorded once, by the side that executes it (#51).
 * - Effects name the command behind them (`by`): one started in the command's turn reads `currentCmd()`; one started
 *   later in its chain runs under `withCmd(id, fn)`.
 * - Silence (the R12 note): `deselect`, `thread-close` and `jam-close` write nothing when they change nothing.
 *
 * Owner: the commands stream. Until it fills them, `cmd()` returns a handle that writes nothing (its `id` and
 * `currentCmd()` already work), and `cmdsForWrite()` folds nothing. Everything here is gated by the recorder being on
 * at the `full` level (recorder-level.ts) - on a published canvas or under `core` a call costs one check.
 */
import { CMD_BOUNDS, type Candidates, type CmdIn, type CmdVia } from '../../shared/perf-records.ts'
import { fullRecorder } from '../recorder-level.ts'
import { newId } from './recorder-core.ts'
import { perfSeams } from './recorder-seams.ts'

/** `once`: decided in its input's own turn, one record. `start-end`: a start at the input, an end after its signal. */
export type Lifecycle = 'once' | 'start-end'

/**
 * What ends a command (`done`), named after the table's "Done when" column:
 * - `2raf`: two animation frames after the state changed; `turn`: the input's own turn (`once`);
 * - `mode-applied`: the displayed cohort's `sh:mode-applied` (#26); `mode`: the `mode` record's enter or exit;
 * - `stage-shown`: the (new) screen's `sh:stage-shown`; `camera`: the camera lands or its motion ends;
 * - `layout`: the layout animation ends (and, for `device`, the fit); `gesture`: the pan gesture ends;
 * - `clipboard`: `clipboard.write`/`writeText` resolved; `theme`: the `theme` record's outcome (#23);
 * - `selection`: the selection changed; `exit`: the exit it made (`escape`'s steps);
 * - `save`: the board save carrying its id landed; `ready`: the node's next `ready`; `settled`: its load settled,
 *   with steps (#49); `where`: where it leads (`history-nav`); `goto`: the camera, the target board's `visible`, or
 *   `sh:stage-shown`;
 * - `answer`: the API, the queue or the store answered ok (the table names which); `thread`: the thread revealed;
 *   `shell-boot`: the next page's `shell-boot` (the id kept in `sessionStorage`); `image`: the picked image read;
 *   `jam`: the Jam state's transition (jam.jsonl keeps the timings); `voice`: the voice, consent or download state
 *   changed; `note-step`: the capture's note step added.
 */
export type Signal =
  | '2raf' | 'turn' | 'mode-applied' | 'mode' | 'stage-shown' | 'camera' | 'layout' | 'gesture' | 'clipboard' | 'theme'
  | 'selection' | 'exit' | 'save' | 'ready' | 'settled' | 'where' | 'goto' | 'answer' | 'thread' | 'shell-boot' | 'image'
  | 'jam' | 'voice' | 'note-step'

/** One command's row of the R12 tables. Codes are the `why` each outcome may carry; `cancelled` and `unobserved` are
 *  always possible where listed (`unobserved` by its deadline whatever the row says). */
export interface CmdSpec {
  life: Lifecycle
  done: Signal
  /** ms from the input; the table's "(N s)", else 10 s */
  deadlineMs: number
  failed?: readonly string[]
  noop?: readonly string[]
  /** the person can back out (Esc on a rename, a refused sheet), or another load or an edit took over */
  cancelled?: true
  /** codes beyond `deadline`: a load cut `hidden` or `timeout` (#49) */
  unobserved?: readonly string[]
  /** the milestones it may record in `steps` */
  steps?: readonly string[]
  /** writes nothing when it changes nothing (the R12 note's three incidental inputs) */
  silent?: true
}

const D = CMD_BOUNDS.deadlineMs
const S30 = 30_000, S60 = 60_000, S120 = 120_000
const se = (done: Signal, o: Partial<Omit<CmdSpec, 'life' | 'done'>> = {}): CmdSpec => ({ life: 'start-end', done, deadlineMs: D, ...o })
const once = (o: Partial<Omit<CmdSpec, 'life' | 'done'>> = {}): CmdSpec => ({ life: 'once', done: 'turn', deadlineMs: D, ...o })
/** #49's board codes: `board-open` and `history-nav` end on where the load goes. */
const LOAD_CODES = { unobserved: ['hidden', 'timeout'], cancelled: true, failed: ['load-error', 'save-blocked'] } as const
const CLIP = ['clipboard-blocked'] as const
const REFUSED = ['refused'] as const

/** The canvas's commands (R12's Canvas and sidebar, Comments, Play and Jam tables), by name. */
export const COMMANDS = {
  // ---- canvas and sidebar
  comments: se('mode-applied', { noop: ['unplaced', 'stopped'] }),
  pins: se('2raf'),
  laser: se('mode-applied', { noop: ['stripped'] }),
  inspect: se('mode-applied', { noop: ['stripped'] }),
  'laser-comment': se('mode-applied'),
  play: se('stage-shown', { deadlineMs: S30, failed: ['stage-error'] }),
  slides: se('stage-shown', { deadlineMs: S30, failed: ['stage-error'] }),
  'hide-ui': se('2raf'),
  tidy: se('layout', { noop: ['nothing-moved'] }),
  'next-new': se('camera', { noop: ['nothing-new'] }),
  notes: se('2raf'),
  'space-pan': se('gesture', { noop: ['no-drag'] }),
  'copy-image': se('clipboard', { deadlineMs: S60, noop: ['multi', 'busy', 'indexing'], failed: ['browser', 'clipboard-blocked', 'render-failed', 'render-timeout'] }),
  'copy-path': se('clipboard', { noop: ['no-selection'], failed: CLIP }),
  'laser-copy': se('clipboard', { failed: CLIP }),
  'thread-copy-link': se('clipboard', { failed: CLIP }),
  'copy-error': se('clipboard', { failed: CLIP }),
  theme: se('theme', { noop: ['one-theme'] }),
  device: se('layout', { noop: ['unknown-device'] }),
  'zoom-100': se('camera', { noop: ['no-selection'] }),
  'fit-all': se('camera', { noop: ['no-selection'] }),
  'fit-selection': se('camera', { noop: ['no-selection'] }),
  'zoom-to': se('camera', { noop: ['no-selection'] }),
  'group-fit': se('camera'),
  'scene-pick': se('camera'),
  'frame-pick': se('camera'),
  'scene-toggle': se('2raf'),
  'folder-toggle': se('2raf'),
  goto: se('goto', { failed: ['no-target'] }),
  'history-nav': se('where', { deadlineMs: S120, ...LOAD_CODES, failed: [...LOAD_CODES.failed, 'stage-error'], steps: ['visible', 'visible-ready', 'commit-late'] }),
  panel: se('2raf'),
  toolbar: se('2raf'),
  select: se('selection'),
  'select-all': se('selection'),
  deselect: se('2raf', { silent: true }),
  escape: se('exit', { steps: ['comments-off', 'laser-off', 'interact-off', 'deselect'] }),
  interact: se('mode'),
  'interact-off': se('mode'),
  'frame-move': se('save', { deadlineMs: S30, failed: ['save-conflict', 'save-failed'] }),
  'frame-resize': se('save', { deadlineMs: S30, failed: ['save-conflict', 'save-failed'] }),
  'frame-reload': se('ready', { deadlineMs: S30, failed: ['error'] }),
  'remove-node': se('save', { deadlineMs: S30, failed: ['save-failed'] }),
  'board-open': se('settled', { deadlineMs: S120, ...LOAD_CODES, steps: ['visible', 'visible-ready', 'commit-late'] }),
  'board-move': se('answer', { deadlineMs: S30, cancelled: true, failed: ['api'] }),
  'folder-new': se('answer', { deadlineMs: S30, cancelled: true, failed: ['api'] }),
  'folder-move': se('answer', { deadlineMs: S30, cancelled: true, failed: ['api'] }),
  'folder-delete': se('answer', { deadlineMs: S30, cancelled: true, failed: ['api'] }),
  'board-rename': se('answer', { deadlineMs: S30, cancelled: true, failed: ['exists', 'invalid', 'api'] }),
  'folder-rename': se('answer', { deadlineMs: S30, cancelled: true, failed: ['exists', 'invalid', 'api'] }),
  'scene-rename': se('answer', { deadlineMs: S30, cancelled: true, failed: ['exists', 'invalid', 'api'] }),
  'board-status': se('answer', { deadlineMs: S30, cancelled: true, failed: ['api'] }),
  'mark-seen': se('answer', { failed: ['api'] }),
  'add-to-board': se('answer', { failed: ['api'] }),
  'update-copy': se('clipboard', { failed: CLIP }),
  'update-dismiss': se('2raf'),
  'notice-view': se('thread', { failed: ['missing'] }),
  'notice-retry': se('answer', { deadlineMs: S30, failed: ['refused', 'missing'] }),
  'notice-dismiss': se('2raf'),
  'notices-clear': se('2raf'),
  'notices-expand': se('2raf'),
  'notices-collapse': se('2raf'),
  'shell-reload': se('shell-boot'),

  // ---- comments
  'comment-pick': se('2raf'),
  'comment-send': se('answer', { deadlineMs: S30, failed: ['send-failed', 'signed-out'] }),
  'comment-reply': se('answer', { deadlineMs: S30, failed: ['send-failed', 'signed-out'] }),
  'draft-discard': se('2raf'),
  'comment-resolve': se('answer', { deadlineMs: S30, failed: ['send-failed'] }),
  'mention-pick': once(),
  'mention-dismiss': once(),
  'thread-open': se('2raf'),
  'thread-close': se('2raf', { silent: true }),
  'ask-to-comment': se('answer', { deadlineMs: S30, noop: ['too-soon'], failed: ['api'] }),
  'identity-open': se('2raf'),
  'identity-switch': se('2raf'),
  'sign-in': se('answer', { deadlineMs: S30, failed: ['rejected', 'api'] }),
  claim: se('answer', { deadlineMs: S30, failed: ['rejected', 'api'] }),
  'identity-dismiss': se('2raf'),
  'profile-dismiss': se('2raf'),
  'profile-open': se('2raf'),
  'profile-save': se('answer', { deadlineMs: S30, failed: ['rejected', 'api'] }),
  'avatar-pick': se('image', { failed: ['unreadable'] }),

  // ---- play (`escape` and `toolbar` in play are the canvas's names, `in: 'shell'` or `'stage'`)
  'play-next': se('stage-shown', { noop: ['end'] }),
  'play-prev': se('stage-shown', { noop: ['end'] }),
  'play-variant': se('stage-shown'),
  'play-restart': se('stage-shown'),
  'play-board': se('stage-shown', { deadlineMs: S30, failed: ['stage-error'] }),
  'play-exit': se('2raf'),
  'play-update': se('stage-shown', { deadlineMs: S30, failed: ['stage-error'] }),

  // ---- Jam (never a note's, an answer's or a read-back's words)
  'jam-session': se('2raf'),
  'jam-start': se('answer', { deadlineMs: S30, failed: REFUSED }),
  'jam-sheet-close': se('2raf'),
  'jam-pref': se('answer', { failed: ['api'] }),
  'jam-talk': se('2raf'),
  'jam-end-bare': se('answer', { deadlineMs: S30, failed: REFUSED }),
  'jam-capture': se('jam', { failed: REFUSED }),
  'jam-end': se('jam', { failed: REFUSED }),
  'jam-end-review': se('jam', { failed: REFUSED }),
  'jam-notes': se('jam', { failed: REFUSED }),
  'jam-picture': se('jam', { failed: REFUSED }),
  'jam-drop': se('jam', { failed: REFUSED }),
  'jam-lane': se('jam', { failed: REFUSED }),
  'jam-next-review': se('jam', { failed: REFUSED }),
  'jam-good': se('jam', { failed: REFUSED }),
  'jam-more': se('jam', { failed: REFUSED }),
  'jam-later': se('jam', { failed: REFUSED }),
  'jam-back': se('jam', { failed: REFUSED }),
  'jam-before-after': se('jam', { failed: REFUSED }),
  'jam-frame-tab': se('jam', { failed: REFUSED }),
  'jam-confirm': se('jam', { failed: REFUSED }),
  'jam-keep': se('jam', { failed: REFUSED }),
  'jam-resume': se('jam', { failed: REFUSED }),
  'jam-lane-move': se('jam', { failed: REFUSED }),
  'jam-open': se('jam', { failed: REFUSED }),
  'jam-do-next': se('jam', { failed: REFUSED }),
  'jam-mic': se('voice'),
  'jam-capture-note': se('note-step'),
  'jam-notes-close': se('2raf'),
  'jam-note-add': se('answer', { deadlineMs: S30, failed: REFUSED }),
  'jam-more-send': se('answer', { deadlineMs: S30, failed: REFUSED }),
  'jam-wrap-send': se('answer', { deadlineMs: S30, failed: REFUSED }),
  'jam-field-discard': se('2raf'),
  'jam-edit': se('answer', { deadlineMs: S30, failed: REFUSED }),
  'jam-answer': se('answer', { deadlineMs: S30, failed: ['send-failed'] }),
  'jam-close': se('2raf', { silent: true }),
  'jam-done-fold': se('2raf'),
  'jam-step': se('2raf'),
  'jam-pane': se('2raf'),
  // the download's 120 s is the longest of its choices'
  'jam-voice': se('voice', { deadlineMs: S120, cancelled: true, failed: ['download-failed'] }),
  'jam-status-open': se('2raf'),
  'jam-status-close': se('2raf'),
  'jam-status-act': se('answer', { deadlineMs: S30, failed: REFUSED }),
  'jam-rename': se('answer', { deadlineMs: S30, cancelled: true, failed: REFUSED }),
  'jam-retry': se('answer', { deadlineMs: S30, cancelled: true, failed: REFUSED }),
  'jam-again': se('answer', { deadlineMs: S30, cancelled: true, failed: REFUSED }),
  'jam-background': se('answer', { deadlineMs: S30, cancelled: true, failed: REFUSED }),
  'jam-reply': se('answer', { deadlineMs: S30, cancelled: true, failed: REFUSED }),
  'jam-thread': se('answer', { deadlineMs: S30, cancelled: true, failed: REFUSED }),
} as const satisfies Record<string, CmdSpec>

export type CmdName = keyof typeof COMMANDS

/**
 * #50, #51: how and where the input arrived. `keys` only for `via: 'key'` and key relays; `arg` a fixed identifier
 * the command acts on (a Jam switch's name), never a value; `board`, `frames` (n) and `frame` what it acts on.
 */
export interface CmdOpts { via: CmdVia; in: CmdIn; keys?: string; arg?: string; board?: string; frames?: number; frame?: string }

/**
 * A command in flight. The first ending call wins; later ones are ignored, except a completion after `unobserved`
 * (its deadline passed), written as a second `end` with `late: true`. `step` records a milestone (#49).
 */
export interface CmdHandle {
  /** 12 hex; '' when nothing records */
  readonly id: string
  readonly name: CmdName
  done(): void
  fail(why: string): void
  noop(why: string): void
  /** the person backed out, or another load or an edit took over (`why`: the cut's reason) */
  cancel(why?: string): void
  /** no signal can come (the page hid, a load timed out): `why` the reason; the deadline's own is `deadline` */
  unobserved(why: string): void
  step(name: string): void
}

const NOTHING: CmdHandle = { id: '', name: 'escape', done() {}, fail() {}, noop() {}, cancel() {}, unobserved() {}, step() {} }
let current: string | undefined

/** The one call every dispatch point makes (#52). A stub until the commands stream fills it: it names the command
 *  for the rest of this turn (`currentCmd()`) and writes nothing. */
export function cmd(name: CmdName, _o: CmdOpts): CmdHandle {
  if (!perfSeams.on || !fullRecorder()) return NOTHING
  const id = newId()
  current = id
  queueMicrotask(() => { if (current === id) current = undefined })
  return { id, name, done() {}, fail() {}, noop() {}, cancel() {}, unobserved() {}, step() {} }
}

/** The command whose input this turn is, for an effect's `by`; undefined when none. */
export const currentCmd = (): string | undefined => current

/** `fn` run as `id`'s effect: an effect started later in a command's chain (after an await) names it in `by`. */
export function withCmd<T>(id: string | undefined, fn: () => T): T {
  const was = current
  current = id || was
  try { return fn() } finally { current = was }
}

/**
 * #18: the commands folded into a board write this page is about to send - a debounced save carries every command
 * that changed the board since its last save, a single write the command behind it - at most 8 ids, plus their count.
 * Read once per request by the edits stream's `perfSeams.requestHeaders` (`x-mv-cmds`); the commands stream keeps the
 * list, and ends those waiting on the write from `perfSeams.answered` (its headers carry the ids). A stub: none.
 */
export function cmdsForWrite(_board: string, _route: string): Candidates { return { ids: [], n: 0 } }

/** recorder.ts `startRecorder`, at the full level: the rate bucket, the deadline timers, the listeners. */
export function startCommands(): void {}

/**
 * Forwarding paths with declared owners (R16 static gate): an input recorded elsewhere, and where. The walk checks that
 * each owner exists and records. The app's twin is app/src/main/commands.ts `APP_RELAYS`.
 */
export interface Relay { from: string; owner: string; why: string }
export const RELAYS: readonly Relay[] = [
  { from: 'ContextMenu.tsx dispatcher (:71)', owner: "each MenuItem's onClick", why: 'each item is an input site of its own' },
  { from: "a frame's post({ type }) (bridge.js, inspect.js, keys.js)", owner: "App.tsx's frame message branch for that type", why: 'the shell executes it' },
  { from: "the stage's post({ type }) (stage/main.tsx)", owner: "Play.tsx's stage message branch for that type", why: 'the shell executes it' },
  { from: 'app-bridge.ts runMenuItem (a synthetic keydown)', owner: "App.tsx's key handler branch", why: "#51: via 'relay', in 'menu', 'tab-menu' or 'app'" },
  { from: "app-bridge.ts runMenuItem('mark-all-seen')", owner: 'mark-seen', why: "#51: via 'relay', in 'tab-menu'" },
]
