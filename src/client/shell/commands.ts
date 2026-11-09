/**
 * One vocabulary in code (spec 30 R12 #48-#52): every command the canvas records, as data - its lifecycle, the signal
 * that ends it, its deadline and its codes - and the one call every dispatch point makes, `cmd(name, { via, keys, in })`,
 * which returns `done()`, `fail(why)`, `noop(why)`, `cancel()`, `step(name)`. The static gate
 * (test/r30-commands-static.test.ts) checks that every input site and dispatcher branch reaches `cmd()` or appears in
 * test/not-commands.json; the runtime tests (test/r30-commands-browser.test.ts, -engine.test.ts) expect each name's
 * declared lifecycle.
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
 *   later in its chain runs under `withCmd(id, fn)`, and a write that waits or retries keeps them with `keepCmds()`.
 * - Silence (the R12 note): `deselect`, `thread-close` and `jam-close` write nothing when they change nothing.
 *
 * Owner: the commands stream. Everything here is gated by the recorder being on at the `full` level (recorder-level.ts) -
 * on a published canvas or under `core` a call costs one check, and writes nothing.
 */
import { CMD_BOUNDS, decodeCmds, ID12, WRITER_HEADERS, type Candidates, type CmdIn, type CmdStep, type CmdVia, type ModeName } from '../../shared/perf-records.ts'
import { fullRecorder } from '../recorder-level.ts'
import { newId } from './recorder-core.ts'
import { hooked, perfSeams, type Answered, type LoadPhase } from './recorder-seams.ts'
import { canvasCtl } from './canvas/ctl.ts'
import { bootOf, fromLiveDocument, iframeOf } from './canvas/frame-registry.ts'

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
  // `nothing-to-play` (not in R12's table): `enterPlay` refused - no playable frame, or a lock
  play: se('stage-shown', { deadlineMs: S30, noop: ['nothing-to-play'], failed: ['stage-error'] }),
  slides: se('stage-shown', { deadlineMs: S30, noop: ['nothing-to-play'], failed: ['stage-error'] }),
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
  // `nothing-new` (not in R12's table): no write goes, so no answer can come
  'mark-seen': se('answer', { noop: ['nothing-new'], failed: ['api'] }),
  // spec 31 B: resolve every open thread in a scope; its notice's Undo. `nothing-open` (not in R12's table): no thread
  // to resolve, or every one is Jam's work in progress
  'resolve-all': se('answer', { deadlineMs: S30, noop: ['nothing-open', 'published'], failed: ['api'] }),
  'resolve-undo': se('answer', { deadlineMs: S30, failed: ['api'] }),
  // spec 31: a deck PDF - ends when the server takes the job (its progress is the notice's); `busy` - one is being made
  'export-pdf': se('answer', { deadlineMs: S30, noop: ['busy'], failed: ['api'] }),
  'export-pdf-cancel': se('answer', { failed: ['api'] }),
  // an app with no exportPdf (1.0.1): the notice's Download of the file it holds; `nothing-ready` - none waits
  'export-pdf-download': se('answer', { noop: ['nothing-ready'] }),
  'add-to-board': se('answer', { failed: ['api'] }),
  'update-copy': se('clipboard', { failed: CLIP }),
  'update-dismiss': se('2raf'),
  // `marver show` over unsent words (spec 31 D3): the notice's Go moves the tab (the camera lands), × leaves it be
  'show-go': se('camera', { cancelled: true }),
  'show-dismiss': se('2raf'),
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
  // spec 31 C: your own message - open its editor, save the words, delete it (asked first, then for real); ⌘A in a card
  'comment-edit': se('2raf'),
  'comment-edit-save': se('answer', { deadlineMs: S30, failed: ['send-failed', 'signed-out'] }),
  'comment-delete-cancel': se('2raf'),
  'comment-delete-ask': se('2raf'),
  'comment-delete': se('answer', { deadlineMs: S30, failed: ['send-failed', 'signed-out'] }),
  'thread-select-all': se('selection'),
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
  // `no-variants`, `no-frames` (not in R12's table): `[ ]` on a screen with none, R where nothing can walk
  'play-variant': se('stage-shown', { noop: ['no-variants'] }),
  'play-restart': se('stage-shown', { noop: ['no-frames'] }),
  'play-board': se('stage-shown', { deadlineMs: S30, failed: ['stage-error'] }),
  // `no-door` (not in R12's table): a locked board has no way out, Esc stays
  'play-exit': se('2raf', { noop: ['no-door'] }),
  'play-update': se('stage-shown', { deadlineMs: S30, failed: ['stage-error'] }),

  // ---- Jam (never a note's, an answer's or a read-back's words)
  // `stopped` (not in R12's table): the canvas stopped, and no sheet to close
  'jam-session': se('2raf', { noop: ['stopped'] }),
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
  // `no-selection` (not in R12's table): ⌫ on the lane with no tile selected
  'jam-drop': se('jam', { noop: ['no-selection'], failed: REFUSED }),
  // `empty` (not in R12's table): Q with no tile on the lane
  'jam-lane': se('jam', { noop: ['empty'], failed: REFUSED }),
  // `nothing-to-review` (not in R12's table): V's toast
  'jam-next-review': se('jam', { noop: ['nothing-to-review'], failed: REFUSED }),
  // `more-open` (not in R12's table): ⏎ with the composer open, its field not focused
  'jam-good': se('jam', { noop: ['more-open'], failed: REFUSED }),
  'jam-more': se('jam', { failed: REFUSED }),
  'jam-later': se('jam', { failed: REFUSED }),
  // `end` (not in R12's table): no review left to step back to
  'jam-back': se('jam', { noop: ['end'], failed: REFUSED }),
  'jam-before-after': se('jam', { failed: REFUSED }),
  // `end` (not in R12's table): ⌥← ⌥→ at the last tab
  'jam-frame-tab': se('jam', { noop: ['end'], failed: REFUSED }),
  'jam-confirm': se('jam', { failed: REFUSED }),
  // `not-keepable` (not in R12's table): K on a lane tile neither a draft nor queued
  'jam-keep': se('jam', { noop: ['not-keepable'], failed: REFUSED }),
  'jam-resume': se('jam', { failed: REFUSED }),
  // `end` (not in R12's table): ← → at the lane's end
  'jam-lane-move': se('jam', { noop: ['end'], failed: REFUSED }),
  // `no-selection` (not in R12's table): ⏎ on the lane with no tile selected
  'jam-open': se('jam', { noop: ['no-selection'], failed: REFUSED }),
  // `not-queued` (not in R12's table): ⌘⏎ on a tile that is not queued
  'jam-do-next': se('jam', { noop: ['not-queued'], failed: REFUSED }),
  // `on` (not in R12's table): the mic button while it hears you has nothing to ask
  'jam-mic': se('voice', { noop: ['on'] }),
  'jam-capture-note': se('note-step'),
  'jam-notes-close': se('2raf'),
  'jam-note-add': se('answer', { deadlineMs: S30, failed: REFUSED }),
  'jam-more-send': se('answer', { deadlineMs: S30, failed: REFUSED }),
  // `busy` (not in R12's table): Write the record while its last try is out
  'jam-wrap-send': se('answer', { deadlineMs: S30, noop: ['busy'], failed: REFUSED }),
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

// ---- the engine (the commands stream) -------------------------------------------------------------------------------

/** What a flight waits for, beside its own call site's ending: set from its signal (auto) or by a helper below. */
type Wait =
  | { on: 'mode'; mode: ModeName; phase?: 'enter' | 'exit' }
  | { on: 'acks' }
  | { on: 'theme' }
  | { on: 'stage'; at?: string }
  | { on: 'load'; board: string; until: 'settled' | 'visible'; load?: string }
  | { on: 'save'; board: string }
  | { on: 'ready'; node: string; was?: string }
  | { on: 'answer'; path: string; failed: string }

interface Flight {
  id: string
  name: CmdName
  spec: CmdSpec
  input: Record<string, unknown>
  t0: number
  started: boolean
  ended: boolean
  /** its deadline passed (or no signal can come): a later completion is a `late` end */
  lapsed: boolean
  steps: CmdStep[]
  waits: Wait[]
  /** `t`s minted while it was the current command (#26's acks), and the documents that acknowledged them */
  ts: Set<string>
  posts: number
  acked: Set<string>
  timer?: ReturnType<typeof setTimeout>
}

let current: string | undefined
let clearAt: ReturnType<typeof setTimeout> | undefined
const flights = new Map<string, Flight>()
let relay: CmdIn | null = null
let started = false

/** The start bucket (#48): 10/s, burst 20; what it refuses is counted and written once a second. */
const bucket = { tokens: CMD_BOUNDS.burst as number, at: 0 }
let refused = 0
let refusedTimer: ReturnType<typeof setTimeout> | undefined
function admit(now: number): boolean {
  bucket.tokens = Math.min(CMD_BOUNDS.burst, bucket.tokens + ((now - bucket.at) / 1000) * CMD_BOUNDS.perSecond)
  bucket.at = now
  if (bucket.tokens >= 1) { bucket.tokens -= 1; return true }
  refused++
  refusedTimer ??= setTimeout(() => {
    refusedTimer = undefined
    const n = refused
    refused = 0
    if (n) write('dropped', { n, reason: 'cmd' })
  }, 1_000)
  return false
}

/** Every write, charged to `cmd` in `self` (#58). */
const write = hooked('cmd', (kind: 'cmd' | 'dropped', body: Record<string, unknown>) => perfSeams.record(kind, body))
const ms = (f: Flight) => Math.max(0, Math.round(performance.now() - f.t0))
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

function writeStart(f: Flight): void {
  if (f.started || f.spec.life === 'once') return
  f.started = true
  write('cmd', { phase: 'start', id: f.id, cmd: f.name, ...f.input })
}

type Outcome = 'done' | 'failed' | 'noop' | 'cancelled' | 'unobserved'
function end(f: Flight, outcome: Outcome, why?: string): void {
  if (f.ended) {
    // after `unobserved`: only a real completion is written again, once, as `late` (#49)
    if (!f.lapsed || (outcome !== 'done' && outcome !== 'failed')) return
    f.lapsed = false
    write('cmd', clean({ phase: 'end', id: f.id, cmd: f.name, outcome, why, ms: ms(f), steps: f.steps.length ? f.steps : undefined, late: true }))
    drop(f)
    return
  }
  f.ended = true
  const result = clean({ outcome, why, ms: ms(f), steps: f.steps.length ? f.steps : undefined })
  // decided in its input's own turn: a `once` name, or a noop before its start went (#48)
  if (f.spec.life === 'once' || (!f.started && outcome === 'noop')) write('cmd', { phase: 'once', id: f.id, cmd: f.name, ...f.input, ...result })
  else { writeStart(f); write('cmd', { phase: 'end', id: f.id, cmd: f.name, ...result }) }
  if (outcome === 'unobserved') {
    // kept a while for a late completion: as long again as its deadline
    f.lapsed = true
    clearTimeout(f.timer)
    f.timer = setTimeout(() => drop(f), f.spec.deadlineMs)
    return
  }
  drop(f)
}
function drop(f: Flight): void {
  clearTimeout(f.timer)
  f.lapsed = false
  flights.delete(f.id)
  for (const w of f.waits) if (w.on === 'save') pendingSave.get(w.board)?.delete(f.id)
}

function handle(f: Flight): CmdHandle {
  return {
    id: f.id,
    name: f.name,
    done: () => end(f, 'done'),
    fail: (why) => end(f, 'failed', why),
    noop: (why) => end(f, 'noop', why),
    cancel: (why) => end(f, 'cancelled', why),
    unobserved: (why) => end(f, 'unobserved', why),
    step: (name) => { if (!f.ended && f.steps.length < 16) f.steps.push({ name, ms: ms(f) }) },
  }
}
const flightOf = (h: CmdHandle): Flight | undefined => (h.id ? flights.get(h.id) : undefined)

/** The one call every dispatch point makes (#52): the command named for the rest of this turn (`currentCmd()`), its
 *  start written at the end of the turn (a noop decided before then is one `once` record), and its declared signal
 *  waited for - a call site ends the rest itself (`answer`, `clipboard`, ...) or through a helper below. */
export function cmd(name: CmdName, o: CmdOpts): CmdHandle {
  if (!perfSeams.on || !started || !fullRecorder()) return NOTHING
  try {
    const now = performance.now()
    if (!admit(now)) return NOTHING
    const spec: CmdSpec = COMMANDS[name]
    const id = newId()
    // a relayed menu item (#51): the key handler that runs it records it, as the relay it is
    const via = relay && o.via === 'key' ? 'relay' : o.via
    const where = relay && o.via === 'key' ? relay : o.in
    const input = clean({ via, keys: via === 'key' || via === 'relay' ? o.keys : undefined, in: where, arg: o.arg, board: o.board, frames: o.frames, frame: o.frame })
    const f: Flight = { id, name, spec, input, t0: now, started: false, ended: false, lapsed: false, steps: [], waits: [], ts: new Set(), posts: 0, acked: new Set() }
    flights.set(id, f)
    setCurrent(id)
    queueMicrotask(() => { if (!f.ended) writeStart(f) })
    f.timer = setTimeout(() => end(f, 'unobserved', 'deadline'), spec.deadlineMs)
    autoWait(f, o)
    return handle(f)
  } catch { return NOTHING }
}

/** `current` names the command for the rest of its input's task: React's render and effects of the change it made
 *  (a sync-lane commit flushes them in a microtask) read it for `by`; the next task starts without it. */
function setCurrent(id: string): void {
  current = id
  clearTimeout(clearAt)
  clearAt = setTimeout(() => { current = undefined }, 0)
}

/** The command whose input this turn is, for an effect's `by`; undefined when none. */
export const currentCmd = (): string | undefined => current

/** `fn` run as `id`'s effect: an effect started later in a command's chain (after an await) names it in `by`. */
export function withCmd<T>(id: string | undefined, fn: () => T): T {
  const was = current
  current = id || was
  try { return fn() } finally { current = was }
}

/** The commands one request names when it carries a batch (the sidebar's queue, one tree write); else `current`. */
let carried: readonly string[] | undefined
const named = (): readonly string[] => carried ?? (current ? [current] : [])
/** `fn`'s requests name these commands (#18), and no other that happens to be current. */
export function withCmds<T>(ids: readonly string[], fn: () => T): T {
  const was = carried
  carried = ids
  try { return fn() } finally { carried = was }
}
/**
 * A write that waits its turn (a queue, a flush first) or goes again (a 409): the commands behind it, read now - in its
 * command's own turn, or under `withCmd`/`withCmds` further along its chain - and put back around each request it
 * sends, long after `current` has cleared (#18).
 */
export function keepCmds(): <T>(send: () => T) => T {
  const ids = named()
  return (send) => withCmds(ids, send)
}

/** #51: a menu item relayed from the app (`runMenuItem`): the key handler that runs it records `via: 'relay'` with the
 *  menu it came from - `in: 'app'` from an app that does not say (1.0.0). */
export function relayed(from: CmdIn, fn: () => void): void {
  const was = relay
  relay = from
  try { fn() } finally { relay = was }
}

/** A key as jam-keys.ts `descriptor()` writes it - `[Ctrl+][Meta+][Alt+][Shift+]key`, a letter lowercase - from the
 *  key the handler matched (`key` for an ⌥ letter or a shifted digit, which the event's own `key` misnames). */
export function keysOf(e: { key: string; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; ctrl?: boolean }, key = e.key): string {
  const k = key === ' ' ? 'Space' : key
  return `${e.ctrlKey || e.ctrl ? 'Ctrl+' : ''}${e.metaKey || e.meta ? 'Meta+' : ''}${e.altKey || e.alt ? 'Alt+' : ''}${e.shiftKey || e.shift ? 'Shift+' : ''}${k.length === 1 ? k.toLowerCase() : k}`
}

// ---- signals: what ends a command (#49) ---------------------------------------------------------------------------

/**
 * The `mode` record (signals, #25) that ends each mode-applied or mode command: its own mode's transition, never the
 * exit a switch makes on its way (⌥L with the laser on: `laser` exits, then `inspect` enters, and only that is applied).
 * No `phase` for a toggle: the one record its press writes for that mode, enter or exit, is the one it meant.
 */
const MODE_OF: Partial<Record<CmdName, { mode: ModeName; phase?: 'enter' | 'exit' }>> = {
  comments: { mode: 'comments' }, laser: { mode: 'laser' }, inspect: { mode: 'inspect' }, interact: { mode: 'interact', phase: 'enter' }, 'interact-off': { mode: 'interact', phase: 'exit' },
}
/** The signals stream's transition ids (#21, #26): its `perfSeams.transition` replaces this default when it runs. */
const NO_TRANSITIONS = perfSeams.transition
/** `startCommands`' wrapper, and what it wraps. */
let wrapper: typeof perfSeams.transition | undefined
let wrapped = NO_TRANSITIONS
const signalsOn = () => (perfSeams.transition === wrapper ? wrapped : perfSeams.transition) !== NO_TRANSITIONS

function autoWait(f: Flight, o: CmdOpts): void {
  switch (f.spec.done) {
    case '2raf': endAfterFrames(handle(f)); return
    case 'selection': queueMicrotask(() => end(f, 'done')); return
    case 'camera': endOnCamera(handle(f)); return
    case 'layout': watch(f, layoutDone); return
    case 'mode-applied': case 'mode': {
      const own = MODE_OF[f.name]
      if (own) f.waits.push({ on: 'mode', ...own })
      if (f.spec.done === 'mode-applied') f.waits.push({ on: 'acks' })
      // without the stream that writes `mode` records and mints transitions, two frames after the change is the signal
      // #26 itself uses for the modes no document acknowledges; with it, the acks or the record - and a change that
      // posted to no document (none displayed) is applied once it rendered
      frames(2, () => { if (!f.ended && (!signalsOn() || (!own && !f.posts))) end(f, 'done') })
      return
    }
    case 'theme':
      f.waits.push({ on: 'theme' })
      frames(2, () => { if (!f.ended && !signalsOn()) end(f, 'done') })
      return
    case 'stage-shown': f.waits.push({ on: 'stage' }); return
    case 'settled': if (o.board) f.waits.push({ on: 'load', board: o.board, until: 'settled' }); return
    case 'save': if (o.board) endOnSave(handle(f), o.board); return
    default:
  }
}

const raf = (fn: () => void) => { try { requestAnimationFrame(fn) } catch { setTimeout(fn, 16) } }
function frames(n: number, fn: () => void): void { raf(() => (n <= 1 ? fn() : frames(n - 1, fn))) }

/** Ends `h` two animation frames after the change (the table's "2 rAF"): a page hidden meanwhile draws none, and its
 *  deadline says so. */
export function endAfterFrames(h: CmdHandle): void { const f = flightOf(h); if (f) frames(2, () => end(f, 'done')) }

/** Polls a flight's condition once per animation frame until it holds or the flight ends. */
function watch(f: Flight, cond: (st: { n: number; busy: boolean; sawBusy: boolean; since: number }) => boolean): void {
  const st = { n: 0, busy: false, sawBusy: false, since: performance.now() }
  const tick = () => {
    if (f.ended) return
    st.n++
    st.busy = canvasCtl.cameraBusy()
    if (st.busy) st.sawBusy = true
    if (cond(st)) end(f, 'done')
    else raf(tick)
  }
  raf(tick)
}
/** A fit or a zoom: the camera landed - it flew and came to rest, or rested for 250 ms (a fit to where it already is,
 *  or one a caller sends after a short delay). */
const cameraDone = (st: { n: number; busy: boolean; sawBusy: boolean; since: number }) => !st.busy && (st.sawBusy || performance.now() - st.since > 250) && st.n >= 2
/** A layout animation (`animateLayout`'s `sh-preset`) ended, and the fit after it landed. */
const layoutDone = (st: { n: number; busy: boolean; sawBusy: boolean; since: number }) => !canvasCtl.layoutBusy() && cameraDone(st)

/** Ends `h` when the camera lands (`fit-*`, `zoom-*`, a pick, `next-new`, a goto on this board). */
export function endOnCamera(h: CmdHandle): void { const f = flightOf(h); if (f) watch(f, cameraDone) }
/** Ends `h` on the next load of `board` after it: `settled` (with its steps, #49), or its `visible` (a goto's). */
export function endOnLoad(h: CmdHandle, board: string, until: 'settled' | 'visible' = 'settled'): void {
  const f = flightOf(h)
  if (!f) return
  f.waits = f.waits.filter((w) => w.on !== 'load')
  f.waits.push({ on: 'load', board, until })
}
/** Ends `h` on the play stage's `sh:stage-shown` - of `at` when given (the screen it walks to) - or fails it on a
 *  stage error when its row lists `stage-error`. */
export function endOnStage(h: CmdHandle, at?: string): void {
  const f = flightOf(h)
  if (!f) return
  f.waits = f.waits.filter((w) => w.on !== 'stage')
  f.waits.push({ on: 'stage', at })
}
/** Ends `h` on the `ready` of the document that replaces the one node `node` shows now (a reload by hand, asked before it
 *  navigates), or fails it on that document's `sh:error`. */
export function endOnReady(h: CmdHandle, node: string): void { const f = flightOf(h); if (f) f.waits.push({ on: 'ready', node, was: bootOf(iframeOf(node)) }) }
/** `h` changed `board`: it ends when the save carrying its id landed (#18, #49) - `save-conflict` on a 409. */
export function endOnSave(h: CmdHandle, board: string): void {
  const f = flightOf(h)
  if (!f || f.waits.some((w) => w.on === 'save')) return
  f.waits.push({ on: 'save', board })
  const p = pendingSave.get(board) ?? new Set<string>()
  p.add(f.id)
  pendingSave.set(board, p)
}

/** Ends `h` on the answer to the next request to `/api/<path>` after it (the marks write, a pin): ok → done, else
 *  `failed` with `code`. */
export function endOnAnswer(h: CmdHandle, path: string, code = 'api'): void { const f = flightOf(h); if (f) f.waits.push({ on: 'answer', path, failed: code }) }

// ---- board writes (#18): the ids a write carries, and its answer -----------------------------------------------------

/** Commands that changed a board, waiting for the save that carries them. */
const pendingSave = new Map<string, Set<string>>()
/** Commands that changed the board and end on their own signal (a tidy, a theme pin, a device): the next save still
 *  names them (#18). A short list: what a save cannot carry is counted, never kept. */
const folded: string[] = []
let foldedLost = 0
/** `h` changed the open board and ends elsewhere: the debounced save that follows names it (#18). */
export function foldsIntoSave(h: CmdHandle): void {
  if (!h.id) return
  folded.push(h.id)
  if (folded.length > CMD_BOUNDS.writeIds * 8) { folded.shift(); foldedLost++ }
}
/** A board's save PUT (store.ts `save`): `${ROUTE}/api/boards/<name>`. */
const SAVE_URL = /\/api\/boards\/([^/?#]+)(?:[?#]|$)/

/**
 * #18: the commands folded into a board write this page is about to send - a debounced save carries every command
 * that changed the board since its last save, a single write the command behind it - at most 8 ids, plus their count.
 * Read once per request by the edits stream's `perfSeams.requestHeaders` (`x-mv-cmds`); the commands stream keeps the
 * list, and ends those waiting on the write from `perfSeams.answered` (its headers carry the ids).
 */
export function cmdsForWrite(board: string, route: string): Candidates {
  // any other write: the commands behind it
  if (!(route === 'save' || route === 'boards/:board' || route.endsWith(`boards/${board}`) || route.endsWith(`boards/${encodeURIComponent(board)}`))) {
    const c = named()
    return { ids: c.slice(0, CMD_BOUNDS.writeIds), n: c.length }
  }
  // the board's own save: every command since the last one
  const ids = [...new Set([...(pendingSave.get(board) ?? []), ...folded])]
  const n = ids.length + foldedLost
  pendingSave.delete(board)
  folded.length = 0
  foldedLost = 0
  return { ids: ids.slice(0, CMD_BOUNDS.writeIds), n }
}

function answered(a: Answered): void {
  if (!flights.size) return
  const ok = typeof a.status === 'number' && a.status >= 200 && a.status < 300
  const sentAt = performance.now() - a.ms
  for (const [f, w] of waiting('answer')) {
    if (f.t0 > sentAt + 1 || !a.url.split(/[?#]/)[0].endsWith(`/api/${w.path}`)) continue
    f.waits = f.waits.filter((x) => x !== w)
    if (ok) end(f, 'done'); else end(f, 'failed', w.failed)
  }
  const outcome = (f: Flight) => (ok ? end(f, 'done') : end(f, 'failed', a.status === 409 && f.spec.failed?.includes('save-conflict') ? 'save-conflict' : 'save-failed'))
  const header = a.headers?.[WRITER_HEADERS.cmds]
  const carried = decodeCmds(header)
  if (carried) {
    for (const id of carried.ids) { const f = flights.get(id); if (f?.waits.some((w) => w.on === 'save')) outcome(f) }
    return
  }
  // no `x-mv-cmds` on it (a page whose writes do not name their commands): the board's save ends the commands that
  // were waiting before it was sent
  const m = SAVE_URL.exec(a.url)
  if (!m || (a.init.method ?? 'GET').toUpperCase() !== 'PUT') return
  const board = decodeURIComponent(m[1])
  for (const id of [...(pendingSave.get(board) ?? [])]) {
    const f = flights.get(id)
    if (f && f.t0 <= sentAt) { pendingSave.get(board)?.delete(id); outcome(f) }
  }
}

// ---- what the shell's documents and loads say -------------------------------------------------------------------------

function waiting<W extends Wait['on']>(on: W): [Flight, Extract<Wait, { on: W }>][] {
  const out: [Flight, Extract<Wait, { on: W }>][] = []
  for (const f of flights.values()) for (const w of f.waits) if (w.on === on) out.push([f, w as Extract<Wait, { on: W }>])
  return out
}

/** A record the page writes - signals' `mode` and `theme` (#23, #25) name the command behind them in `by`. */
function observed(kind: string, body: Record<string, unknown>): void {
  if (kind !== 'mode' && kind !== 'theme') return
  const by = typeof body.by === 'string' ? body.by : undefined
  const outcome = body.outcome
  const finish = (f: Flight) => (outcome === 'timeout' ? end(f, 'unobserved', 'timeout') : outcome === 'superseded' ? end(f, 'cancelled', 'superseded') : end(f, 'done'))
  if (kind === 'theme') {
    const ws = waiting('theme')
    const f = by ? ws.find(([x]) => x.id === by)?.[0] : ws.length === 1 ? ws[0][0] : undefined
    if (f) finish(f)
    return
  }
  const ws = waiting('mode').filter(([, w]) => w.mode === body.mode && (!w.phase || w.phase === body.phase))
  const f = by ? ws.find(([x]) => x.id === by)?.[0] : ws.length === 1 ? ws[0][0] : undefined
  if (f) finish(f)
}

/** A document's message (a frame's or the stage's): acks, readies, the stage's screens. */
function message(node: string | null, data: Record<string, unknown>): void {
  if (!flights.size) return
  const type = data.type
  if (type === 'sh:mode-applied') {
    const t = String(data.t ?? '')
    for (const [f] of waiting('acks')) {
      if (!f.ts.has(t)) continue
      f.acked.add(`${t}:${String(data.boot ?? node ?? '')}`)
      if (f.posts && f.acked.size >= f.posts) end(f, 'done')
    }
  } else if (node && (type === 'sh:ready' || type === 'sh:error')) {
    // told before App.tsx's own guard: a message still on its way from the document since replaced, or from the one
    // being replaced until its navigation commits, says nothing of the reload
    const iframe = iframeOf(node)
    if (!iframe || !fromLiveDocument(iframe, data)) return
    for (const [f, w] of waiting('ready')) if (w.node === node && data.boot !== w.was) (type === 'sh:ready' ? end(f, 'done') : end(f, 'failed', 'error'))
  } else if (!node && type === 'sh:stage-shown') {
    const at = String(data.at ?? '')
    for (const [f, w] of waiting('stage')) if (!w.at || w.at === at) end(f, 'done')
  } else if (!node && type === 'sh:stage-error') {
    for (const [f] of waiting('stage')) if (f.spec.failed?.includes('stage-error')) end(f, 'failed', 'stage-error')
  }
}

/** A load's way (#49): `board-open`, `history-nav` and a goto to another board end on theirs. */
function loadPhase(p: LoadPhase): void {
  for (const [f, w] of waiting('load')) {
    if (p.phase === 'request') { if (!w.load && p.board === w.board) w.load = p.load; continue }
    if (w.load !== p.load) continue
    const h = handle(f)
    switch (p.phase) {
      case 'visible': h.step('visible'); if (w.until === 'visible') end(f, 'done'); break
      case 'visible-ready': h.step('visible-ready'); break
      // a request already cut mounted all the same: a milestone, never the completion (#49)
      case 'commit': if (p.late) { if (f.ended && f.lapsed) f.steps.push({ name: 'commit-late', ms: ms(f) }); else h.step('commit-late') } break
      case 'settled': end(f, 'done'); break
      case 'cut': {
        const r = p.reason
        if (r === 'hidden' || r === 'timeout') end(f, 'unobserved', r)
        else if (r === 'unsaved') end(f, 'failed', 'save-blocked')
        else if (r === 'error') end(f, 'failed', 'load-error')
        else end(f, 'cancelled', r)
      }
    }
  }
}

/** #26's acks: the transition ids minted while a mode command was the current one. */
function minted(kind: 'theme' | 'mode', t: string | undefined): void {
  if (!t || kind !== 'mode' || !current) return
  const f = flights.get(current)
  if (!f || f.ended || !f.waits.some((w) => w.on === 'acks')) return
  f.ts.add(t)
  f.posts++
}

/** The id `shell-reload` keeps across the reload it asks for: the next page writes its end (the table's row). */
const RELOAD_KEY = 'mv-cmd-reload'
/** `shell-reload`: its start now, kept for the page the reload brings, which writes its end at its own start. */
export function shellReload(h: CmdHandle): void {
  const f = flightOf(h)
  if (!f) return
  writeStart(f)
  try { sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ id: f.id, cmd: f.name, at: Date.now() - ms(f) })) } catch { /* storage off: its end cannot come, and the reader says so */ }
}
function reloaded(): void {
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY)
    if (!raw) return
    sessionStorage.removeItem(RELOAD_KEY)
    const r = JSON.parse(raw) as { id?: unknown; cmd?: unknown; at?: unknown }
    if (typeof r.id !== 'string' || !ID12.test(r.id) || r.cmd !== 'shell-reload' || typeof r.at !== 'number') return
    write('cmd', { phase: 'end', id: r.id, cmd: 'shell-reload', outcome: 'done', ms: Math.max(0, Math.round(Date.now() - r.at)) })
  } catch { /* storage off */ }
}

/** recorder.ts `startRecorder`, at the full level: the rate bucket, the deadline timers, the listeners. */
export function startCommands(): void {
  if (started) return
  started = true
  bucket.at = performance.now()
  // signals' records and transition ids, seen as they are written and minted (their streams start first)
  const record = perfSeams.record
  perfSeams.record = (kind, body, load) => { record(kind, body, load); try { observed(kind, body) } catch { /* never in the way */ } }
  wrapped = perfSeams.transition
  wrapper = perfSeams.transition = (kind) => { const t = wrapped(kind); try { minted(kind, t) } catch { /* never in the way */ } return t }
  perfSeams.frameMessage.on(hooked('cmd', (node: string, data: Record<string, unknown>) => message(node, data)))
  perfSeams.stageMessage.on(hooked('cmd', (data: Record<string, unknown>) => message(null, data)))
  perfSeams.load.on(hooked('cmd', loadPhase))
  perfSeams.answered.on(hooked('cmd', answered))
  reloaded()
  if (import.meta.env.DEV) (window as unknown as { __mvCommands: unknown }).__mvCommands = { flights: () => [...flights.values()].map((f) => ({ id: f.id, name: f.name, started: f.started, ended: f.ended, waits: f.waits.map((w) => w.on) })) }
}

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
  { from: "app-bridge.ts runMenuItem('resolve-all-comments')", owner: 'resolve-all', why: "#51: via 'relay', in 'tab-menu' (spec 31 B.1)" },
]
