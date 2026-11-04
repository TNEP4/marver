/**
 * The messages spec 30 adds or extends between the shell and its documents - canvas frames (bridge.js, inspect.js,
 * main.tsx) and the play stage (stage/main.tsx) - beside the ones they already exchange. Types and constants only.
 * Every field spec 30 adds to an existing message is optional: an older document, a document of another level
 * (`core`) or a document whose bridge has not run yet sends none, and the shell then counts nothing for it.
 *
 * bridge.js and inspect.js are plain JS that ship verbatim (build.ts copies them for published HTML frames): they
 * post these shapes by hand and repeat `ERROR_BUDGET.frame` (perf-records.ts) inline. A new module either imports
 * must be added to build.ts's copy list, or every published HTML frame stops.
 *
 * FROZEN before the spec 30 streams split. Owners: signals (theme and mode acks, `sh:gesture`, `sh:console`,
 * `sh:resource-error`, `sh:dropped`, `sh:warnings`, `sh:renders`), edits (`sh:inplace`), commands (`sh:stage-key`'s `origin`).
 */
import type { ResourceTag } from '../../shared/perf-records.ts'

/** The names, one place. The first block is new; the second extends existing messages. */
export const SH = {
  modeApplied: 'sh:mode-applied',
  console: 'sh:console',
  resourceError: 'sh:resource-error',
  dropped: 'sh:dropped',
  warnings: 'sh:warnings',
  renders: 'sh:renders',
  gesture: 'sh:gesture',
  inplace: 'sh:inplace',
  // extended
  setTheme: 'sh:set-theme',
  themeApplied: 'sh:theme-applied',
  laser: 'sh:laser',
  pick: 'sh:pick',
  hmr: 'sh:hmr',
  stageKey: 'sh:stage-key',
  stageShown: 'sh:stage-shown',
} as const

// ---- the shell to a document --------------------------------------------------------------------------------------

/** #21: a theme switch carries its transition `t` (FrameNode.tsx:139, Play.tsx:390). The spec's "`sh:theme`
 *  (FrameNode)" is this message. */
export interface SetThemeMsg { type: 'sh:set-theme'; theme: string; t?: string }
/** #26: a mode change carries its transition `t` (FrameNode.tsx:180, :187; Play.tsx:356-357). */
export interface LaserMsg { type: 'sh:laser'; on: boolean; inspect: boolean; t?: string }
export interface PickMsg { type: 'sh:pick'; on: boolean; quiet: boolean; t?: string }
/** #36: a gesture's start and end, to the on-screen frames - their Profiler counts `inGesture` between them. */
export interface GestureMsg { type: 'sh:gesture'; on: boolean }

// ---- a document to the shell --------------------------------------------------------------------------------------

/** #21: the ack echoes the switch's `t` and the document's boot id (bridge.js:36-40; the stage posts the same, two
 *  animation frames after). An ack with an old `t`, or from a document no longer the live one, does not count. */
export interface ThemeAppliedMsg { type: 'sh:theme-applied'; id: string; theme: string; t?: string; boot?: string }
/** #26: inspect.js, two animation frames after `applyModes` (:535-536): the modes it applied, for transition `t`. */
export interface ModeAppliedMsg { type: 'sh:mode-applied'; id: string; t: string; boot: string; laser: boolean; inspect: boolean; pick: boolean }
/** #28: a frame's `console.error`, as produced (the original runs first). Its own message: `sh:error` marks the
 *  frame failed, a console error does not. */
export interface ConsoleMsg { type: 'sh:console'; id: string; gen: string; boot: string; message: string; stack?: string[] }
/** #32: an element's load error, caught in the capture phase: `url` a same-origin path without query, else the
 *  other origin alone. */
export interface ResourceErrorMsg { type: 'sh:resource-error'; id: string; gen: string; boot: string; tag: ResourceTag; url: string }
/** What a frame's budget refuses, by source (#33): console errors, resource errors. A window error spends it and is never refused. */
export type FrameDropSource = 'console' | 'resource'
/** #33: counter-only, independent of the detail budget, at most one a second, a final one at `pagehide`. Counts since
 *  the document's previous `sh:dropped`: the shell adds them to `dropped { reason: <source>, n }`. */
export interface DroppedMsg { type: 'sh:dropped'; id: string; boot: string; counts: Partial<Record<FrameDropSource, number>>; final?: true }
/** #28: a frame's `console.warn` calls, counted - no text. Counter-only, at most one a second, a final one at
 *  `pagehide`; the shell adds them up by node into the minute's `warnings` record. */
export interface WarningsMsg { type: 'sh:warnings'; id: string; boot: string; n: number; final?: true }
/** #36: a document's minute of React commits (the frame root's, or the stage root's: `id` 'stage'). `minute`: the
 *  minute's start, epoch ms. */
export interface RendersMsg { type: 'sh:renders'; id: string; boot: string; minute: number; commits: number; ms: number; maxMs: number; inGesture: number }
/** Today's (main.tsx:129): an update applied in place, so a sleeping frame wakes. Unchanged; `sh:inplace` reports. */
export interface HmrMsg { type: 'sh:hmr'; id: string }
/** #15: a document that fetched `<acceptedPath>?t=<hmrTs>` (Resource Timing) reports what it saw - after its next
 *  observed commit, or `RELOAD_BOUNDS.commitWaitMs` with none. `applied` is `false` only on Vite's own failure message
 *  for that path; never `true`. Registry-only updates send nothing (main.tsx:129's filter). `noAfterUpdate`: its round
 *  ended with no `vite:afterUpdate`, so this is what was known by then, `applyMs` how long the round stood open. */
export interface InplaceMsg { type: 'sh:inplace'; id: string; boot: string; hmrTs: number; applyMs?: number; nextObservedCommitMs?: number; applied: 'unknown' | false; noAfterUpdate?: true }
/** #50: the stage's background click posted as Space (stage/main.tsx:273) says so. */
export interface StageKeyMsg { type: 'sh:stage-key'; key: string; code: string; alt?: boolean; meta?: boolean; origin?: 'click' }
/** #26: Play's first `sh:stage-shown` after `enterPlay`/`enterSlides` ends the mode's `firstFrameMs`; the existing
 *  fields (stage/main.tsx:152), with the stage's boot id so an old stage's never counts. */
export interface StageShownMsg { type: 'sh:stage-shown'; at: string; nav: string; epoch: string; doc: number; boot?: string }

export type DocMsg = ThemeAppliedMsg | ModeAppliedMsg | ConsoleMsg | ResourceErrorMsg | DroppedMsg | WarningsMsg | RendersMsg | HmrMsg | InplaceMsg | StageKeyMsg | StageShownMsg
export type ShellMsg = SetThemeMsg | LaserMsg | PickMsg | GestureMsg
