/**
 * The edit's way to the frames, from the shell (spec 30 R1, R2): the reload Outbox (#16: `shell-boot`, `ready`,
 * `settled`, `invalidated`/`invalidated-nodes`, `inplace`, `watchdog`, each with `page` and `seq`, batched to
 * `POST perf/reload` under #7), the navigation tokens frozen at `startReload` (#14), the in-place reports
 * (`sh:inplace`, #15), the board writes' `x-mv-page`/`x-mv-cmds` headers (#18, `perfSeams.requestHeaders`) and the
 * watchdog's lines (#20). Owner: the edits stream.
 *
 * A stub until then: recorder.ts calls `startReloads()` once, at the full level only, after the page recorder is on.
 * It subscribes through recorder-seams.ts (`frameMessage`, `leaving`) and never imports recorder.ts at its top level.
 */

/** recorder.ts `startRecorder`, at the full level: the reload Outbox and its listeners. */
export function startReloads(): void {}
