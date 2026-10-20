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
  pointer still over one notes it too. `L` picks with the laser;
- **what you do in the prototype**: interactive mode on and off, every click and field, the
  screens you went to in play, the device and theme you switched to, what you copied;
- **notes** you type (`N` opens the notes card) - a note often names what your words point at;
- **pictures**: `I` takes one of the frame under the pointer, and the frames you touched are
  pictured as the capture ends, at the size you were looking at them (a device, a width you
  dragged, the play stage).

`E` ends it. `Esc` throws it away. One capture records at a time.

A capture is about the frames you **touched** - selected, clicked, typed in, scrolled,
resized, pictured, or zoomed to alone - not every frame that happened to be on screen. Those
are the frames its run may edit, and the frames pictured before and after it.

## The read-back

When a capture ends, its **read-back** opens: the timeline of what you said and did, with its
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

`jam: { capture: "at-once" }` skips the read-back: a capture queues as soon as it ends.

## The lane

Captures line up along the bottom of the canvas in the order you made them, newest on the
right - drafts, queued, working, ready to review, done. Each tile says where it is. `Q` gives
the lane the keyboard: `←` `→` move, `⏎` opens, `⌘⏎` runs a queued one next, `K` keeps,
`⌫` drops, `Esc` hands the keys back. Right-click a tile to rename it.

Your agent works on up to `jam.concurrency` captures at once (6 by default), each in its own
run, but never two on the same frame: a capture about a frame another run holds waits for it
("Queued · next").

## Review

When a run finishes, its tile turns to **Ready to review**, with a soft chime (`jam: { chime:
false }` silences it). `V` opens the next one to review:

- **Review** shows the agent's reply beside a picture of each frame it changed - `B` flips
  between before and after; `⌥←` `⌥→` move between frames. A frame the run made is marked
  **New**, with no before.
- **Capture** (the tab at the top) shows the capture as you made it: its pictures and timeline.

`⏎` **Looks good** closes it; `⇧⏎` **More work** sends it back with what is still wrong;
`→` leaves it for later, `←` goes back. A capture started while a review is open follows that
run - "and this too".

When a capture asked for something new beside a frame - "a laptop version of this, next to
it" - the frame it pointed at was only where the new one goes. If the run made a new frame
and left the one you pointed at unchanged, the capture's thread moves onto the new frame
(when that capture ran alone, so the new frame is surely its own).

## A session: `J`

`J` (or the Jam button in the toolbar) opens the start sheet: what Marver listens to, the
agent the session hands work to, and the keyboard shortcuts. **Start** (`⏎`) begins the
session and its first capture at once.

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
jam: { agent: "claude", concurrency: 6, capture: "confirm", chime: true, names: true, loc: true },
```

| Key | Default | What it does |
|---|---|---|
| `capture` | `"confirm"` | `"confirm"`: a capture waits for its read-back. `"at-once"`: it queues at `E` |
| `chime` | `true` | A soft chime when a capture is ready to review |
| `names` | `true` | Name each capture with Claude Haiku (Claude Code only) |
| `loc` | `true` | Stamp each element of your design files with `data-mv-loc` (dev only, never published) |

The rest - `agent`, `concurrency`, `subagents` - is in the [Live Jam guide](live-jam.md#the-config-block).
A bad value says so at boot and takes the default; nothing here turns Jam off.

## Keys

| Where | Keys |
|---|---|
| Anywhere on the canvas | `S` capture · `J` session · `Q` the lane · `V` next to review |
| A capture recording | `E` end · `N` note · `I` picture · `L` laser · `Esc` drop |
| A read-back | `⏎` add to queue · `K` keep · `R` resume · `Esc` drop |
| A review | `⏎` looks good · `⇧⏎` more work · `→` later · `←` back · `B` before/after · `⌥←` `⌥→` frames · `Esc` leave |
| The lane (`Q`) | `←` `→` move · `⏎` open · `⌘⏎` do next · `K` keep · `⌫` drop · `Esc` leave |

The keys work inside frames too, in interactive mode and in play.

## Where things are kept

Everything Jam keeps sits in `design/.local/` (gitignored, never published): captures and
their pictures under `design/.local/jam/`, the session transcript under
`design/.local/jam/sessions/`, the queue in `design/.local/jam-jobs.json`. The session
**record** your agent writes is the one thing meant to be committed. Published canvases carry
none of it: no captures, no queue, no microphone.
