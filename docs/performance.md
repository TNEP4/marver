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
   the record that ends the load, settled or cut. `perf --loads` prints only the last move (`still from`);
   `quiet` is in `--json`.
6. **Settled.** Every frame at its outcome, no re-flow pending or held, no frame booting or waiting its
   turn to, the camera still, and the board still for one second after its last change - its last move, or
   the mount when nothing moved - so a load never settles in under a second. It says how many moves and why,
   when the last one came, when the visible frames and all the frames were ready, and how heavy the board
   is: elements, frames awake and asleep, the heap (in Chrome).

Or **cut**: another board (`switch`), the same board loaded again (`reload`), the page hidden (`hidden`),
or 120 s without settling (`timeout`). A request that never mounted is cut too: a newer load
(`superseded`), a board that could not be read (`error`), your edits while it was read from disk
(`edited`), or a switch away from a board that could not be saved (`unsaved`). A request cut at 120 s or
while the page was hidden may still mount when its board arrives: its commit then says it came after the
cut (`late`), the cut stays, and what the board does from then is late.

## Reading `perf --loads`

A board of three content frames, `checkout`, titled "Checkout flow", opened twice. The first time no height
was known; the second time the heights the first load settled at were in `design/boards/_sizes.json`:

```
$ npx marver perf --loads
board loads, last 60 min - design/.local/perf/page.jsonl

  3:41:36 PM  Checkout flow (boot)                     settled 1.8 s
    committed 0.0 s · 3 frames (3 content) · 3 measure, 0 opened at a known height
    first frame started 0.05 s · visible ready 0.2 s (3 frames) · all ready 0.2 s · still from 0.8 s · settled 1.8 s
    5 moves, 1650 px: measure-height 3, reflow:measured 2
    slowest to settle: checkout/risks 0.4 s (waited 0.11 s, then 0.28 s), checkout/flows 0.3 s (waited 0.11 s, then 0.18 s), checkout/brief 0.3 s (waited 0.05 s, then 0.24 s)

  3:42:03 PM  Checkout flow (boot)                     settled 1.0 s
    committed 0.0 s · 3 frames (3 content) · 3 measure, 3 opened at a known height
    first frame started 0.05 s · visible ready 0.2 s (3 frames) · all ready 0.2 s · still from 0.0 s · settled 1.0 s
    0 moves
    slowest to settle: checkout/risks 0.3 s (waited 0.11 s, then 0.18 s), checkout/flows 0.3 s (waited 0.11 s, then 0.18 s), checkout/brief 0.2 s (waited 0.05 s, then 0.14 s)
```

Each load names its board as the sidebar does - its title, else its name - and `--json` by its name
(`board`). The first load opened each frame at a guess: each reported its height (`measure-height`) and
the frames below moved with the re-flow (`reflow:measured`) - five moves, the last at 0.8 s: still from
0.8 s, settled at 1.8 s. The second opened at the known heights: nothing moved, so it was still from the
mount, and it settled at 1.0 s, the one-second floor.

**Ready and settled are two clocks.** A frame is *ready* at its first render: `visible ready` and `all
ready` say when the last of the frames in view, and of all the frames, was. A content frame that measures
its own height has *settled* at its last height, later; `slowest to settle` lists the frames that took
longest to reach that (ready, for a frame that does not measure), so its times can come after `all ready`.
The board has *settled* once every frame has, and it has been still for one second after its last change:
`still from` says when that stillness began - its last move, or the mount when nothing moved - and
`settled` comes a second after it at the soonest, later when a frame was still on its way.

Each frame in `slowest to settle` says how long it waited for its turn to start, then how long it took once
started. The canvas starts a board's frames a few at a time: the first alone, as the board's first camera fit
sets off - a frame after the board mounts, 0.06 s later on a switch: `first frame started` - chosen as the
one nearest the centre of where the fit will land, then up to four at once, those in view first. Here every
frame took a quarter of a second or less of its own, and none waited much more than a tenth of one.

`--json` also has `quietMs`: when the first still second after the mount began. On a heavy board they part:
one that held still for a second after a move at 1.8 s, then moved again as late frames reported their
heights, has `quietMs` 1800 and says `still from 15.0 s`. The printed report leaves `quiet` out: the settle
waits on the last move, not the first still second.

A load that was cut has no ready times to give; it says how many of its frames were ready by the cut
instead - `69 of 121 ready`, of the frames on the board then (those placed while it loaded included, those
removed not) - when it last moved (`last move`: it never settled, so nothing was still from then), and,
after its slowest, how many never finished (`52 never finished`): `slowest to settle` lists only frames
that finished. A load can also say `never ready: ...`, `missing: ...`, its
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
- **`slowest to settle`** names the frames that held the load longest, of those that finished. Look at those first:
  what they load, how much they render - the time after `then` is the frame's own. A load cut before its frames
  finished counts the rest apart; cut at 120 s (`timeout`), the board is too heavy to finish - split it, or
  lighten what its frames load.
- **A frame that waits long to start: the queue, not the frame.** `waited` (and `first frame started`) is the
  time before its turn came; nothing in the frame shortens it. On a board of many frames the last wait for those
  before them: fewer frames on the board, or lighter ones that hand their turn on sooner. The first frame's wait
  is the canvas's own and about the same on every board - 0.03-0.08 s on a page's first load, 0.08-0.11 s on a
  switch, the time until the camera's first fit sets off - and a one-frame board that settles at 1.0 s has no
  lever left in the project.
- **The canvas's own lever, taken in 0.27.1.** Until 0.27.0 the first frame waited 0.35 s after the board
  mounted, for the first camera fit to land (`SETTLE` in `canvas/admission.ts`): that wait exists so the first
  frame - booting alone, the quickest first content - is the one nearest the centre of the view you will see,
  not of a camera still on its way. It now starts as the fit sets off, ranked on where the fit will land
  (`canvasCtl.landing`); with no fit said (a frame added, a calm update), it waits as before. Measured on a
  real project's boards - four of them, each opened three times in a fresh tab (`boot`) and three times picked
  from another board (`switch`), headless Chrome at 1440x900, `perf --loads --json`, medians in ms (every frame
  was in view, so visible ready and all ready are the same):

  | board, frames | load | first frame started | ready | settled | moves |
  |---|---|---|---|---|---|
  | v1 build, 4 content | boot | 392 → 39 | 672 → 251 | 1051 → 1025 | 0 → 0 |
  | v1 lo-fi, 30 | boot | 425 → 83 | 1306 → 1039 | 1370 → 1087 | 0 → 0 |
  | Meeting, 14 | boot | 409 → 64 | 769 → 504 | 1029 → 1027 | 0 → 0 |
  | Capture, 13 | boot | 404 → 52 | 721 → 457 | 1028 → 1019 | 0 → 0 |
  | v1 build | switch | 369 → 82 | 613 → 500 | 1005 → 1005 | 0 → 0 |
  | v1 lo-fi | switch | 395 → 112 | 1187 → 912 | 1194 → 1007 | 0 → 0 |
  | Meeting | switch | 388 → 103 | 752 → 472 | 1005 → 1005 | 0 → 0 |
  | Capture | switch | 380 → 93 | 636 → 377 | 1005 → 1005 | 0 → 0 |

  Every board's first frame was the same one before and after. What it costs: that frame boots during the
  fit's 0.32 s zoom over blank cards, which draws a frame or two fewer - over the twelve switches, 221 frames
  drawn instead of 241, 18 intervals over 17 ms instead of 3 (4 over 33 ms instead of 3, none over 50 ms).
  The boards that settle at 1.0 s were already at the one-second floor; a board whose frames finish later
  settles sooner.
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
| `commit` | the board mounts | `request`, `ms`, `frames`, `byKind` (`hifi`, `content`, `html`), `measuring`, `savedHeights`; `late` when its request was cut first (120 s, the page hidden) and its board arrived after all |
| `visible` | the first camera fit after it | `nodes`, `ms`; `assumed` when no fit came before the load ended (the frames the camera showed then) |
| `frame` | a frame reaches its outcome, or the load ends | `node`, `frame`, `gen` (the URL revision), `boot` (the document's id), `admitted` (its turn to boot), `ready`, `firstMeasure`, `settled`, `outcome`, `kept` |
| `move` | a frame's place or size changes | `node`, `dx`, `dy`, `dw`, `dh` (px), `cause`, `late` (after the load ended, settled or cut) |
| `quiet` | the first second after the commit with no move | `ms`: when the move before that second came (the commit, when none had) |
| `settled` | the load settled | `ms`, `moves`, `distance` (px), `causes`, `lastMove` (when the last move came; absent when nothing moved), `visibleReadyMs`, `allReadyMs`, `missing`, `neverReady`, `errors`, `weight` (`domNodes`, `iframes`, `awake`, `asleep`, `heapMB`) |
| `cut` | a load, or a request, ended early | `reason`, `ms`, `lastMove` (as `settled`'s); on a load that mounted, `frames` (on its board then) and `ready` (how many of those were settled or ready); `request` for a request cut before it mounted |
| `gesture` | a pan, zoom or layout animation ends | `type` (`pan` / `zoom` / `layout`), `ms`, `frames`, `p50`, `p95`, `max`, `over17ms`, `over33ms`, `longFrames` |
| `error` | an error the page sees | `source` (`shell` / `frame` / `stage`), `frame`, `component`, `message`, `stack`, `late` |
| `dropped` | records were lost | `n`; `reason: "errors"` for errors past a load's 50 - with no reason, a full queue or a failed send |

Times are ms from the load's request. Frame records stop once the load has settled or been cut. `settled.moves`
counts every change to the board; `perf --loads` counts move records, where a drag's steps are one.

## `--json`

`npx marver perf --loads --json` prints `{ minutes, loads, unowned, dropped }`. Each load has `board` (the
board's name; the printed report shows its title), `cause` and `state` - `settled`, `cut`, or `open` (still going, or its end past the window) - and, as it
got there:

- `cut`: `reason`, `ms`, and `request: true` when the cut came before it mounted;
- the commit: `commitMs`, `frames`, `byKind`, `measuring`, `savedHeights` - and `mountedAfterCut: true` for a
  request cut first whose board arrived after all (`perf --loads` says `cut (hidden) at 0.4 s before it
  mounted · mounted 3.2 s`, and counts its moves as late);
- `visible` (with `visibleAssumed`), `visibleReadyMs`, `allReadyMs` (each frame's first render), `quietMs` (when
  the first still second began), `lastMoveMs` (settled or cut; `still from` in the printed report, which says the
  mount when it is absent), `settledMs`;
- `moves`: `count`, `distance`, the top five `causes` as `[cause, count]` pairs, and `late` (count and
  causes of the moves after the load ended, settled or cut);
- `slowest`: the five slowest frames that finished (`node`, `frame`, `ms` - when it settled, or was ready -
  `outcome`, `admittedMs` - when it started: its turn to boot - and `readyMs`; `ms - admittedMs` is its own time);
- `firstStartedMs`: when the load's first frame started;
- `errors` (each once, every one, `late` marked), `errorsNotRecorded`, `neverReady`, `missing`,
  `unfinished` (frames still on their way when it was cut: they never finished);
- on a load cut after it mounted, `framesAtCut` - the frames on its board when it was cut, those placed while it
  loaded included, those removed not - and `readyByCut`, how many of them were ready (settled, or ready) by
  then (both absent on one cut before it mounted);
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
| `--crashes` | the Mac app's crashes and hangs of this repo's canvases (below) |
| `--flashes` | the flashes marked in the Mac app, and the white-out candidates (below) |
| `--machine` | the machine profiles (below) |
| `--all` | with `--flashes`: also the marks on other canvases or on Home |
| `--days <n>` | how far back `--runs`, `--crashes`, `--flashes` and `--machine` read: 14 by default |
| `--json` | machine-readable |
| `--minutes <n>` | how far back to read: 60 by default (24 h with `--jam`) |
| `--root <dir>` | the project (default: here) |

Plain `npx marver perf` reads the reload log and ends with one line per board load. It and `--loads` leave out a
headless run's loads (`marver perf run`): they say how many.

## The Mac app's half

The Mac app (0.2 and later) records what only the app can see, in `~/.marver/perf/`: `app.jsonl` (Marver Dev writes
`app-dev.jsonl`; one writer per file), one line per event with `{ v, ts, kind, app, seq, flavour, machine }` - `app`
names the launch, `seq` counts its lines, `machine` the profile the line was written on. Every 5 s the app samples its
processes (`getAppMetrics()`: CPU from cumulative time, memory as each process's working set, a canvas renderer's own
footprint from its page, the memory pressure level), keeps the last minute in memory and writes one `sample` line a
minute; and it records renderer and GPU process ends, hangs, GPU changes, power and thermal events, each tab's state
and document, and the time a tab switch takes to its second frame (`shown`: until the app hears back from that
frame, so the reply's own way back is in it). A minute's canvas memory per tab (`canvases.byTab`) counts a renderer
two tabs share in each of them and says `shared`; add up `canvases.memMB`, never `byTab`. A line about a tab carries
its `tab`, `ws`, `commit` and `page` - the page id the shell's hello sent, which is the `page` of its records in
`page.jsonl`. With Settings' recorder off, nothing of this is written (a flash you mark still is, and so is an
error main did not catch: a `main-error` line, in `app-dev.jsonl` for Marver Dev, written the moment it happens).
`machine/<hash>.json` holds one profile per distinct machine state (the chip, the displays and their rates, the
GPU's renderer, power): a display change, the window moved to another display, or a GPU fallback makes a new one, and
old lines keep theirs. The app keeps 14 days of it (`keepPerfDays`, pruned a few seconds after launch and then
daily), at most 5 MB a file, 50 flash pictures and 10 crash reports.

`marver perf` joins the two halves by `page`, so each app event lands on the board load it happened in:

- `--crashes`: each canvas crash of this repo (not one the app ended itself: an unload, Reload Page) with its board,
  whether its load had settled, the last gesture before it, and the minute before it; hangs, and when the page
  answered again; then, **by time (machine-wide)**, the GPU process's and utility processes' ends and a GPU process
  replaced silently (`gpu-restart`); and how many crash reports `crashpad/completed` holds.
- `--flashes`: each flash you marked with `⌃⌥F` on this repo's canvases, with its board, the gesture that ended
  within 2 s of it, the GPU process's events within a second, pressure, thermal state, the GPU figures (machine-wide)
  and the picture's path. A mark is dated by the moment you pressed it (the state the app took then), not by its
  line, which is written a second or two later, once the picture and the GPU figures are in. The picture is the app's views as the app stacks them, not the screen: it holds no traffic
  lights and may miss a flash that happens in the compositor. Marks on Home or other canvases are counted (`--all`
  shows them). White-out candidates, found automatically during gestures, are listed apart: automatic, not verified.
- `--machine`: the profiles, grouped by host (the app and a headless run of one Mac share its `hostHash`), which is
  current, and how many records and runs name each.

A record that carries no page (a 0.27.0 canvas, or a document that has not said hello) is joined by workspace and
time, and the output says so. The repo's workspaces are its own and every workspace in its `page.jsonl`, so a
`--recover` run's records join too.

## In the page

In a dev canvas's console, `__mvPerf.report()` sums up the gestures so far - `gestureFrames`, `frameP50`,
`frameP95`, `frameMax`, `over17ms`, `over33ms`, `longFrames`, `longFrameP95`, `longFrameMax` and
`counters` - and `__mvPerf.reset()` starts over. On a published canvas, `?mvperf` in the URL (or
`localStorage.mvPerf = '1'`) turns it on; the recorder itself never runs there.
