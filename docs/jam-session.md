# Jam sessions and captures

Talk through your canvas the way you would with a designer beside you. Press `S`, point at
things, click through the prototype and say what is wrong; press `E`. That is a **capture**:
your words, every click and pick, and pictures of the frames you touched, in one record your
own coding agent works from. Run a whole review as a **session** (`J`) and Marver keeps the
thread of it, then writes it up when you are done.

Everything here runs with `npx marver dev` and the agent [Live Jam](live-jam.md) already
uses. Nothing needs setting up; the microphone is optional.

## A capture: `S` ... `E`

`S` starts a capture. A teal ring runs round the canvas and the Jam button shows a pulsing
dot. While it records, everything you do is part of it:

- **what you say**, transcribed on this Mac (see [Words](#words-on-this-mac));
- **what you point at**: a click on an element numbers it on the frame, and holding the
  pointer still over one notes it too. `L` picks with the laser (`⌥L` for the inspect laser,
  every element outlined);
- **what you do in the prototype**: interactive mode on and off, every click and field, the
  screens you went to in play, the device and theme you switched to, what you copied;
- **notes** you type (`N` opens the notes card) - a note often names what your words point at;
- **pictures**: `I` takes one of the frame under the pointer, and the frames you touched are
  pictured as the capture ends - three at most - at the size you were looking at them (a
  device, a width you dragged, the play stage). A capture holds twelve pictures in all.

Two ways to end it (0.28): `E` **stops and queues it** - the agent starts on it, nothing to confirm - and `⇧E`
**stops to review**: its read-back opens so you can check it and add to it first. Both are on the capture bar. `Esc`
throws it away. One capture records at a time.

After `E` the tile reads **Sending** while its last words and pictures come in, then Queued or the agent's state;
nothing opens and the canvas stays where it is. If the queue cannot take it (rare: another comment already sits
under its id), it stays on the lane as a draft reading **Not queued** and one line says why - open it to add it to
the queue. After `⇧E` the tile reads **Finishing**, then **To confirm** as its read-back opens. Either way the capture
waits for the words you said last: 15 s, longer while the speech engine is still working through them (a minute at
most). With the microphone on and nothing heard (the speech engine not available, the microphone still opening),
its record says the words may be incomplete.

Closing or reloading the tab asks first while a capture is recording, finishing or not yet taken by the canvas (as it
does for any unsaved work). If you leave anyway, the capture
is kept as it stood - its words and notes so far, and a line saying the page closed before it finished - and comes
back as a draft to read, resume or drop; it never goes to your agent on its own. One you had already stopped with `E`
(its tile reading Sending) is queued as `E` does, with that line. (Best effort: a crash gives the page no chance to
keep it.)

A capture the page could not send waits in this browser, for this address, and sends itself the next time the canvas
opens there - see [A capture left on an old address](#a-capture-left-on-an-old-address).

A capture is about the frames you **touched** - selected, clicked, typed in, scrolled,
resized, pictured, or zoomed to alone - not every frame that happened to be on screen. Those
are the frames its run may edit, and the frames pictured before and after it.

## The read-back

When a capture ends with `⇧E` (and when `J` ends one to wrap the session up), its **read-back** opens: the timeline of what you said and did, with its
pictures, under a short name a small model gave it (see [Names](#names)). Read it, fix a
mistranscribed word in place, and decide:

| Key | |
|---|---|
| `⏎` **Add to queue** | it goes to your agent |
| `K` **Keep** | not work now - kept for the session's record |
| `R` **Resume** | it ended too soon: carry on recording into the same capture |
| `Esc` **Drop** | throw it away |

A draft's read-back also takes notes after the fact: type in **Add a note** and they are
logged under "Added after", in the timeline's style, and go to the agent with the rest.


## The lane

Captures line up along the bottom of the canvas in the order you made them, newest on the
right - drafts, queued, working, ready to review, done. Each tile says where it is. `Q` gives
the lane the keyboard: `←` `→` move, `⏎` opens, `⌘⏎` runs a queued one next, `K` keeps,
`⌫` drops, `Esc` hands the keys back. Right-click a tile to rename it.

Once two or more captures are done, they fold into one **Done** tile at the left end - "4
captures · 6 frames changed" - so the lane keeps its room for what still needs you. Click it
(or `⏎` on it) to open them in place, behind a narrow collapse tile that folds them back.

Your agent works on up to `jam.concurrency` captures at once (6 by default), each in its own
run - your Claude Code session up to 8 more, each in a background subagent of its own - but
never two runners on the same frame: a capture about a frame another runner holds waits for it,
and its tile says so ("Waits for 01-slide", the run holding it in its tooltip). One on a frame
your own session's run is working goes to that session at once, which decides how the two meet
- after, folded in, or a variant beside it ([Live Jam](live-jam.md#your-own-session-takes-the-work-028)).

## Review

When a run finishes, its tile turns to **Ready to review**, with a soft chime (`jam: { chime:
false }` silences it). `V` opens the next one to review:

- **Review** shows the agent's reply beside each frame it changed, **before and after at
  once**: side by side for a tall frame (a phone), one above the other for a wide one (a
  laptop), the panel as wide as that takes. **Both · Before · After** shows one alone; `B`
  steps through them. `⌥←` `⌥→` move between frames. A frame the run made is marked **New**,
  with no before.
- **Capture** (the tab at the top) shows the capture as you made it: its pictures and timeline.

`⏎` **Looks good** closes it; `⇧⏎` **More work** sends it back with what is still wrong;
`→` leaves it for later, `←` goes back. A capture started while a review is open follows that
run - "and this too".

When a capture asked for something new beside a frame - "a laptop version of this, next to
it" - the frame it pointed at was only where the new one goes. If the run made a new frame
and left the one you pointed at unchanged, the capture's thread moves onto the new frame
(when that capture ran alone, or its run put the frame on the board with `--run`, so the new frame is surely its own).

## A session: `J`

`J` (or the Jam button in the toolbar) opens the start sheet: what Marver listens to, who
works, three switches, and the keyboard shortcuts. **Start** (`⏎`) begins the session and its
first capture at once.

**Who works** (0.28): while the session runs, your tags and captures go to the coding-agent
session you already have open in the repo - "Your Claude Code session", with everything it
has. With several open, the newest takes the work; click the row for the next one. With none
open, a copy of your last session does the run. Claude Code hands each run to a background
subagent and is free again in seconds, so your captures run side by side; Marver gives Codex
and Cursor their runs one at a time. Starting the session connects every Claude
Code, Codex and Cursor session in the repo - nothing else to set up ([Live Jam](live-jam.md#your-own-session-takes-the-work-028)).
The three switches cover the runs Marver spawns: **MCP servers and skills** (on), **your
session's context** (on - off means no session and no copy take work, only fresh agents), and
**collaborators' comments** (off - only your own words reach the agent). They are kept for this
machine in `design/.local/jam/prefs.json`.

While a session runs, the canvas keeps its glowing edge and the Jam button its dot and
clock - seconds the first minute, then minutes - and the lane shows **Jam on**, listening
between captures. `S` starts the next capture.

`J` again wraps up. The wrap-up sheet lists every capture of the session with its state, and
a box for your instructions on how to take the session in - "prioritise the checkout fixes",
"file the small ideas as backlog". **Write the record** queues one more job: your agent
writes a page to `context/sessions/` (or `design/sessions/` without a `context/` folder) -
what was asked, what was done, what is left, the decisions heard, the ideas worth keeping.
It reads the confirmed and kept captures, your edits and notes, their replies and your
verdicts, and, unless you turn it off on the sheet, what you said between captures. **End
without a record** writes nothing.

Sessions are optional: captures, the lane and review all work without one.

## Words, on this Mac

The first `S` or `J` asks once whether to use the microphone. Speech becomes words on your
machine with NVIDIA's Parakeet v3, a small speech-to-text model that runs locally: the first
time, Marver asks before downloading it (488 MB, once, into `~/.marver/models/`, every file
checked against its published hash) and keeps it for every canvas. Captures keep recording
while it downloads; your words start with the next one.

- **The audio never leaves this Mac and is never written to disk** - only the words are kept.
- English, French and the other major European languages are recognised.
- The speech engine (`sherpa-onnx-node`) is an optional dependency. Where it cannot install
  or load, captures keep typed notes and the canvas says why.
- **Not now** keeps captures to typed notes; click the crossed-out microphone on a capture's
  tile to be asked again.

## Names

With Claude Code as the jam agent, each capture is named as soon as its words are in - a few
words like "Lamp tablet product page" on its tile, in the lane and on its thread. The name
comes from Claude Haiku, run through your own Claude Code login with no tools: **a draft's
words go to Anthropic for this**, as they do when the capture runs. A name you give it
(Rename) always wins. `jam: { names: false }` turns naming off; tiles then show their first
words. Other agents do not name captures.

## What your agent receives

Each capture reaches your agent as one job: its words with their times, your notes, every UI
step, the pictures, and the element under each point with its source location
(`data-mv-loc`, the file and line it was written at, so the agent goes straight there). It
reads each distinct ask, acts on the reserved frames only, and replies per ask; the reply
shows in the review, beside the before and after pictures. The managed instructions
(`design/instructions/jam.md`, refreshed by `npx marver init`) spell this out for the agent.

## Configuration

```ts
// design/config.ts
jam: { agent: "claude", concurrency: 6, chime: true, names: true, loc: true },
```

| Key | Default | What it does |
|---|---|---|
| `capture` | `"confirm"` | No longer used (0.28): `E` queues a capture, `⇧E` stops to review it |
| `chime` | `true` | A soft chime when a capture is ready to review |
| `names` | `true` | Name each capture with Claude Haiku (Claude Code only) |
| `loc` | `true` | Stamp each element of your design files with `data-mv-loc` (dev only, never published) |

The rest - `agent`, `concurrency`, `subagents` - is in the [Live Jam guide](live-jam.md#the-config-block).
A bad value says so at boot and takes the default; nothing here turns Jam off.

## Keys

| Where | Keys |
|---|---|
| Anywhere on the canvas | `S` capture · `J` session · `Q` the lane · `V` next to review |
| A capture recording | `E` stop and queue · `⇧E` stop to review · `N` note · `I` picture · `L` laser · `⌥L` inspect · `Esc` drop |
| A read-back | `⏎` add to queue · `K` keep · `R` resume · `Esc` drop |
| A review | `⏎` looks good · `⇧⏎` more work · `→` later · `←` back · `B` both/before/after · `⌥←` `⌥→` frames · `Esc` leave |
| The lane (`Q`) | `←` `→` move · `⏎` open (or open/fold the Done tile) · `⌘⏎` do next · `K` keep · `⌫` drop · `Esc` leave |
| A laser on | `L` pointer · `⌥L` inspect · `Esc` off (before it closes or drops anything) |

The keys work inside frames too, in interactive mode and in play.

## Where things are kept

How long each step takes on your machine - a capture sealing, its pictures, your words, naming, the queue, your agent,
the pictures before and after - is in `npx marver perf --jam` (median, slowest, and what went wrong lately), read from
`design/.local/perf/jam.jsonl`: numbers and fixed codes only, never your words ([Performance](performance.md)).

The capture itself sits in `design/.local/` (gitignored, never published): its full record
and pictures under `design/.local/jam/`, the session transcript under
`design/.local/jam/sessions/`, the queue in `design/.local/jam-jobs.json`.

A capture you add to the queue or keep also becomes a **thread** on its board, like a
comment: a short excerpt of its words (600 characters at most), then your agent's replies.
Threads live in `design/comments/<board>.jsonl`, which is committed with the rest of
`design/` - so what you said in a capture reaches your repository when you commit, as a
comment would. They never reach a published canvas: `marver build` and `marver comments sync`
leave capture threads (and Marver's notes and replies) on your machine. The session
**record** your agent writes goes to `context/sessions/`, also meant to be committed.
Published canvases carry none of Jam: no captures, no queue, no microphone.

## A capture left on an old address

A capture the page could not send - the canvas was away, or the page closed before its send landed - waits in that
browser's storage, under that page's address (`http://localhost:<port>`), and goes out the next time the canvas opens
**at that address** with Live Jam on. When the canvas moves, the capture stays behind: 0.27 moved canvases to slots,
and a later start lands on another slot when its own is taken. So does a tab still open there with edits it could not
save: it keeps them until its own canvas answers at that address again. `marver dev` says so as it starts - where it
was, which canvas runs there now (when one does), and the `--recover` number of that address:

```
  last run was at http://localhost:4806/ - "atlas" runs there now
  a tab still open there keeps its unsaved edits until this canvas runs there again (a Jam capture left unsent there waits too):
  stop "atlas" and this canvas, then `npx marver dev --recover 2`
```

`--recover` starts the canvas there again. Stop the canvas first if it runs (`Ctrl-C`): one canvas runs per folder, so
a recovery started beside it stops with "a canvas already runs here". The list works either way:

The list holds the last five distinct addresses the canvas ran on (an older one drops off as a sixth arrives), then
the address 0.26 gave the folder:

```bash
npx marver dev --recover      # the addresses this canvas ran on, newest first
npx marver dev --recover 2    # start on exactly that one
```

```
  addresses this canvas ran on, newest first:
     1  http://localhost:4807/  bound http://[::1]:4807  22 Oct 15:40 - 22 Oct 17:02
     2  http://localhost:4806/  bound http://[::1]:4806  21 Oct 09:12 - 21 Oct 18:30
     3  http://localhost:5329/  the address 0.26 gave it
  start on one: npx marver dev --recover <n> - then open its link in the browser that made the capture
```

A recovery runs on exactly that entry's port, the address it bound, and the project key that run used - never another.
Open the link it prints in the browser that made the capture; the captures waiting there send themselves. Then stop it
(`Ctrl-C`) and start the canvas as usual. If the port or the address cannot be had - another canvas or another program
holds it - it stops and says why; it never moves elsewhere. A recovery leaves the canvas's list of addresses as it was.

**The list always holds the address 0.26 gave this folder** (or would have given it), last unless this canvas has run
there since. It only matters coming from 0.26. The first 0.27 start of a canvas that ran before names it too ("0.26
served this canvas at http://localhost:5329/ - if a Jam capture was left unsent there, ..."); a new project's first
start says nothing of it. If 0.26 had moved to another port when you made the capture
(it said "port ... is in use - serving ... instead" as it started), name that port:
`npx marver dev --recover --port <that port>`.

**When it cannot come back** - an address that can no longer be had, or a browser profile that is gone - Marver cannot
send the capture. It is still readable by hand: in the browser's developer tools, under Local storage for that address,
the key `mv-jam-sealed:<project key>` holds it as JSON; copy what you said into a new capture's notes. A capture only
waits like this when it could not reach its canvas before the page closed.
