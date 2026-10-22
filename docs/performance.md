# Performance

The canvas measures itself while you work, on your Mac: what each edit reloaded, what each board load
did, how long each step of Jam took. `npx marver perf` reads it back - for you, and with `--json` for your
agent. A published canvas records nothing.

## What is recorded

| Log | What | Read with |
|---|---|---|
| `design/.local/perf/reloads.jsonl` | each edit and the frames it reached; page-wide reloads, sent or dropped; each frame document that booted, and how long it took | `npx marver perf` |
| `design/.local/perf/page.jsonl` | each board load, as the page saw it: every frame's outcome, every move and why, when the board settled; gestures; errors | `npx marver perf --loads` |
| `design/.local/perf/jam.jsonl` | Jam's timings: numbers and fixed codes only, never your words | `npx marver perf --jam` |

`design/.local/` is gitignored, and `marver dev` never serves it. The perf folder is yours alone: mode 700,
each file 600 from the moment it is made - and files an earlier version made are tightened when `marver dev`
starts. At start, each log loses its lines older than 14 days, and past its cap its oldest half; a log that
passes its cap while the canvas runs loses its oldest half too. The cap is 2 MB, and 8 MB for `page.jsonl`:
one load of a 120-frame board writes about 140 KB there, most of it moves, so 2 MB held about fourteen such
loads - hours of work, not days. 8 MB holds four times as many.

`page.jsonl` holds frame names, node keys and numbers. Error messages and stack lines can hold file paths,
so, like the rest, they stay on this Mac.

## A board load

Each time a board opens - the page's first (`boot`), another board you chose (`switch`), or the open board
read again because its file changed on disk (`disk-reload`) - the page follows it until it settles:

1. **Requested.** The board, and why it loads. Until it mounts, every move belongs to the board still up.
2. **Committed.** It mounts: its frames by kind (hi-fi, content, HTML), how many are content frames that
   measure their own height, and how many of those open at a height already known.
3. **Visible.** The frames the first camera fit shows - the ones you see first.
4. **Each frame's outcome** - [below](#frames).
5. **Quiet.** The first second after it mounts with nothing moving, written as that second ends: it says
   when the move before it came (the mount itself, when nothing had moved yet). It is not when the board
   stopped moving - a frame that reports its height later moves it again. That is the **last move**, on
   the record that ends the load, settled or cut.
6. **Settled.** Every frame at its outcome, no re-flow pending or held, no frame booting or waiting its
   turn to, the camera still, and a second with no move - so a load never settles in under a second. It says
   how many moves and why, when the last one came, when the visible frames and all the frames were ready,
   and how heavy the board is: elements, frames awake and asleep, the heap (in Chrome).

Or **cut**: another board (`switch`), the same board loaded again (`reload`), the page hidden (`hidden`),
or 120 s without settling (`timeout`). A request that never mounted is cut too: a newer load
(`superseded`), a board that could not be read (`error`), your edits while it was read from disk
(`edited`), or a switch away from a board that could not be saved (`unsaved`).

## Reading `perf --loads`

A board of three content frames, opened twice. The first time no height was known; the second time the
heights the first load settled at were in `design/boards/_sizes.json`:

```
$ npx marver perf --loads
board loads, last 60 min - design/.local/perf/page.jsonl

  3:41:36 PM  Checkout (boot)                          settled 2.1 s
    committed 0.0 s · 3 frames (3 content) · 3 measure, 0 opened at a known height
    visible ready 0.5 s (3 frames) · all ready 0.5 s · quiet 1.1 s · last move 1.1 s · settled 2.1 s
    5 moves, 1650 px: measure-height 3, reflow:measured 2
    slowest: checkout/risks 0.7 s, checkout/flows 0.6 s, checkout/brief 0.6 s

  3:42:03 PM  Checkout (boot)                          settled 1.0 s
    committed 0.0 s · 3 frames (3 content) · 3 measure, 3 opened at a known height
    visible ready 0.5 s (3 frames) · all ready 0.5 s · quiet 0.0 s · settled 1.0 s
    0 moves
    slowest: checkout/risks 0.6 s, checkout/flows 0.6 s, checkout/brief 0.5 s
```

The first load opened each frame at a guess: each reported its height (`measure-height`) and the frames
below moved with the re-flow (`reflow:measured`) - five moves, the last at 1.1 s, settled at 2.1 s. The
second opened at the known heights: nothing moved (so no last move), and it settled at 1.0 s, the
one-second floor.

`quiet` and `last move` agree here. On a heavy board they part: one that held still for its first second
and then moved again as late frames reported their heights says `quiet 1.8 s · last move 15.0 s`. `quiet`
is the first still second; `last move` is when it stopped moving.

A load that was cut has no ready times to give; it says how many of its frames were ready by the cut
instead - `69 of 121 ready` - and, after its slowest, how many never finished (`52 never finished`):
`slowest` lists only frames that finished. A load can also say `never ready: ...`, `missing: ...`, its
errors (`late error` for one after it ended, settled or cut), how many errors past the first 50 went
unrecorded, and its gestures (how many, the worst p95, the frames over 33 ms). The last line says how many
records never reached the log, when any did.

## Making a board faster

Read the load, name the lever, change it, compare the next load - you, or your agent with
`npx marver perf --loads --json`.

- **Moves named `measure-height`, then `reflow:...`** - the board opened before it knew its heights.
  `marver dev` writes each content frame's settled height to `design/boards/_sizes.json`
  ([Sizes](boards-and-folders.md#sizes)), and the next load opens at those heights (`savedHeights`
  counts them) and the moves go, as above. Commit it with the rest of `design/`, and every clone and the
  published canvas open at them too.
- **`slowest`** names the frames that held the load longest, of those that finished. Look at those first:
  what they load, how much they render. A load cut before its frames finished counts the rest apart; cut
  at 120 s (`timeout`), the board is too heavy to finish - split it, or lighten what its frames load.
- **Never ready, missing, errors** are broken frames, not slow ones: fix them first. A missing frame's
  file was deleted or renamed.
- **The weight** (`settled.weight`) says how heavy the settled board is: elements in the page and its
  frames, frames awake and asleep, the heap.
- **Late moves** came after the load ended - settled, or cut. After a cut at 120 s, or while the page was
  hidden, they are the board still loading. After it settled - and any **`unknown`** move, with no cause
  named - they say something moved the board after it looked done: worth a look, or an
  [issue](https://github.com/TNEP4/marver/issues).

## Frames

Each frame of a load ends at one outcome:

- **settled** - a content frame that renders a `Doc` measures its own height, and is done at its first
  settled measurement taken at its current width (a width change waits for the next one);
- **ready** - every other frame (hi-fi, HTML, a content frame shown at a device size, content without a
  `Doc`) is done when it is ready;
- **missing** - the frame is not in the manifest;
- **error** - it threw;
- **never-ready** - the ready watchdog gave up on it;
- **cut** - it was still on its way when the load ended.

An outcome counts only from the document the frame shows now: a message from a document since replaced, or
from one a reload is replacing, never counts. When the same board is read again its frames keep their
documents, and a frame whose document is older than the load is marked `kept`. A load with missing or
never-ready frames settles anyway, and says so.

## Moves and why

Every change to a frame's place or size is a `move`, with its cause:

| Cause | What moved it |
|---|---|
| `measure-height` | a content frame reported its height |
| `measure-width` | a content frame took its `Doc`'s own width |
| `reflow:<reasons>` | the board re-flowed its rows - `measured` (a height came in), `cramped` (a sticky note needed room), `stale` (heights changed since the board was laid out), `gesture-end` (a re-flow that waited for a drag); several join with `+` |
| `manifest` | the frames on disk changed: a frame that arrived had its guessed size corrected |
| `drag` | you moved it (a drag's steps add up in one record while it waits to be sent) |
| `resize` | you resized it, or the board re-tidied after a resize |
| `device` | a device view (`0`-`5`), or a device size for the selection |
| `tidy` | a tidy (`t`) |
| `unplaced` | the **Not on a board** list changed |
| `spawn` | a frame added to the board on the canvas |
| `unknown` | a change with no cause named |

A move after the load ended - it settled, or it was cut (a board cut at 120 s, or while the page was hidden,
stays open and goes on loading) - is `late`. A load owns its board for as long as the board stays open, so
its late moves are its own; `perf --loads` counts them apart: `late, after it settled` or `late, after it
was cut`.

## Gestures

Each pan, zoom or layout animation ends in a `gesture` record: how long it ran, how many frames it drew, and
the frame intervals as they are - `p50`, `p95`, `max`, and two plain counts, the intervals over 17 ms
(`over17ms`) and over 33 ms (`over33ms`) - plus `longFrames`, the long animation frames that started inside
it (long tasks, where the browser has no long-animation-frame). There is no "missed frames" count measured
against the median: it would call a steady half-rate gesture smooth. The sampler runs only from a gesture's
start to its end; at rest it asks for no frames.

## Errors

The page records the errors it sees - its own (an uncaught error or rejection, a crash the shell caught,
with the component), a frame's, and the play stage's - with the message and up to three stack lines, 200
characters each. At most 50 per load, the same one at most once a second; those past 50 are counted, not
recorded. An error after its load settled or was cut is `late`: a load owns its board for as long as the
board stays open. Errors from before the first board mounted are kept apart (`unowned` in the JSON).

## The records

Every line of `page.jsonl` carries `v`, `ws` (the project's key), `page` (one id per page load), `load`
(for `load`, `commit` and a request's `cut`, the request's own id; for every other record, the load that
owns the board then; `-` before the first), `seq` (its place in the page's order), `ts` and `kind`:

| `kind` | When | Fields |
|---|---|---|
| `load` | a board load starts, before the board is read | `board`, `cause` (`boot` / `switch` / `disk-reload`), `request`; on a page's first load `sinceNav`, the ms since the page started loading |
| `commit` | the board mounts | `request`, `ms`, `frames`, `byKind` (`hifi`, `content`, `html`), `measuring`, `savedHeights` |
| `visible` | the first camera fit after it | `nodes`, `ms`; `assumed` when no fit came before the load ended (the frames the camera showed then) |
| `frame` | a frame reaches its outcome, or the load ends | `node`, `frame`, `gen` (the URL revision), `boot` (the document's id), `admitted` (its turn to boot), `ready`, `firstMeasure`, `settled`, `outcome`, `kept` |
| `move` | a frame's place or size changes | `node`, `dx`, `dy`, `dw`, `dh` (px), `cause`, `late` (after the load ended, settled or cut) |
| `quiet` | the first second after the commit with no move | `ms`: when the move before that second came (the commit, when none had) |
| `settled` | the load settled | `ms`, `moves`, `distance` (px), `causes`, `lastMove` (when the last move came; absent when nothing moved), `visibleReadyMs`, `allReadyMs`, `missing`, `neverReady`, `errors`, `weight` (`domNodes`, `iframes`, `awake`, `asleep`, `heapMB`) |
| `cut` | a load, or a request, ended early | `reason`, `ms`, `lastMove` (as `settled`'s); `request` for one that never mounted |
| `gesture` | a pan, zoom or layout animation ends | `type` (`pan` / `zoom` / `layout`), `ms`, `frames`, `p50`, `p95`, `max`, `over17ms`, `over33ms`, `longFrames` |
| `error` | an error the page sees | `source` (`shell` / `frame` / `stage`), `frame`, `component`, `message`, `stack`, `late` |
| `dropped` | records were lost | `n`; `reason: "errors"` for errors past a load's 50 - with no reason, a full queue or a failed send |

Times are ms from the load's request. Frame records stop once the load has settled or been cut. `settled.moves`
counts every change to the board; `perf --loads` counts move records, where a drag's steps are one.

## `--json`

`npx marver perf --loads --json` prints `{ minutes, loads, unowned, dropped }`. Each load has `board`,
`cause` and `state` - `settled`, `cut`, or `open` (still going, or its end past the window) - and, as it
got there:

- `cut`: `reason`, `ms`, and `request: true` when it never mounted;
- the commit: `commitMs`, `frames`, `byKind`, `measuring`, `savedHeights`;
- `visible` (with `visibleAssumed`), `visibleReadyMs`, `allReadyMs`, `quietMs`, `lastMoveMs` (settled or cut),
  `settledMs`;
- `moves`: `count`, `distance`, the top five `causes` as `[cause, count]` pairs, and `late` (count and
  causes of the moves after the load ended, settled or cut);
- `slowest`: the five slowest frames that finished (`node`, `frame`, `ms` - when it settled, or was ready -
  and `outcome`);
- `errors` (each once, every one, `late` marked), `errorsNotRecorded`, `neverReady`, `missing`,
  `unfinished` (frames still on their way when it was cut: they never finished);
- on a load cut after it mounted, `readyByCut`: how many of its `frames` were ready (settled, or ready) by
  the cut;
- `gestures` (`n`, `worstP95`, `over33ms`) and `weight`.

`unowned` holds what a page recorded before its first board mounted (its errors, how many gestures);
`dropped`, how many records never reached the log. A send the page tried again is counted once.

## What it costs

Nothing at rest. While no load is in flight and nothing waits to be sent, the recorder has no timer and no
frame callback of its own; it hears each change to the canvas's state with one check. Records wait 2 s for
company, then go in one request, one at a time. A send that fails on the network or the server is tried
twice more, 2 s apart; a refusal, or a canvas that stopped, is not tried again (a 403 goes once more,
after the page has asked for its request cookie). What never lands is counted in a `dropped` record. The
queue holds 2,000 records or 256 KB, and past that the oldest go, counted the same way. When the page
closes, Jam captures go first: while a capture is open or waiting to be sent, the recorder sends nothing;
otherwise its last records go with `keepalive`, 16 KB at most.

The dev server takes them only from the canvas's own page, rebuilds each from the fields its kind allows -
strings cut to 200 characters, 512 KB a request - and appends them to `page.jsonl`.

## Options

| Option | |
|---|---|
| `--loads` | each board load in full |
| `--jam` | Jam's timings |
| `--json` | machine-readable |
| `--minutes <n>` | how far back to read: 60 by default (24 h with `--jam`) |
| `--root <dir>` | the project (default: here) |

Plain `npx marver perf` reads the reload log and ends with one line per board load.

## In the page

In a dev canvas's console, `__mvPerf.report()` sums up the gestures so far - `gestureFrames`, `frameP50`,
`frameP95`, `frameMax`, `over17ms`, `over33ms`, `longFrames`, `longFrameP95`, `longFrameMax` and
`counters` - and `__mvPerf.reset()` starts over. On a published canvas, `?mvperf` in the URL (or
`localStorage.mvPerf = '1'`) turns it on; the recorder itself never runs there.
