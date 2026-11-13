# Boards and folders

A board is a saved canvas - a set of frames, arranged. Boards sit at the top of the sidebar, and
folders keep them tidy: a folder holds boards and folders, a folder inside a folder - a
**sub-folder** - holds boards. Two levels, so a board sits at the root, in a folder, or in a
sub-folder.

```
Start here
Features
  Shipper            <- a sub-folder
    New load
    Orders
  Phone
    Pickup inspection
  Carrier office     <- a board, straight in Features
Context
  Meetings
Archive
```

Everything below works the same way at both levels, and the same from the sidebar as from the files
- so a person arranging boards by hand and an agent arranging them by writing files always agree.

## Every frame on a board

There is no board that holds everything (0.25 retired All Scenes). One rule instead: **every frame
goes on the board it belongs to - its feature, its spec, its flow - and a frame that belongs to two
goes on both.** A board shows the frames its nodes hold, or every frame when it says `"auto": true`.

- `npx marver boards pin <board> <scene/frame | scene ...>` puts frames on a board (appended as
  nodes, the ones it already shows skipped).
- A frame on no board is never lost: the sidebar shows **Not on a board** when there are some - a
  temporary view of just those frames, never saved, where right-click a frame's row, **Add to
  board…**, puts it on one. Comments need a board to live on, so new ones are off there. The dev log
  and `npx marver boards` list them too.
- `work done` still clears the glow for a frame on no board, and warns with where its scene's other
  frames live; `comments new` refuses it until it is pinned.
- A fresh `marver init` puts its demo on a `welcome` board. A canvas with no board shows "No boards
  yet - ask your agent to make one".
- Old `#/b/all-scenes` links still land: on the board that shows their frame (or most of their
  frames, with a notice naming where the rest are). A leftover `design/boards/all-scenes.json` is set
  aside - the dev log says once that it can go - and its threads keep working, published too, where
  some published board shows their frame. `all-scenes` in `publish.json` is dropped with a warning.

## In the sidebar

- **New folder** - right-click the Boards header, or its `+`. Name it inline: what you type is its
  title, any casing, punctuation or emoji.
- **New folder inside** - right-click a top-level folder: a sub-folder, at its end.
- **Drag** a board into any folder or sub-folder (drop it on the header), or between any two rows -
  the blue seam shows exactly where a release lands, indented with the level it lands in. Drag a
  folder among the boards; a folder with no sub-folders can also drop into a top-level folder and
  become one.
- **Move to new folder** on a board makes a folder at the board's own level, with the board inside:
  in its slot at the root, a sub-folder in its slot when it sits in a folder, and right after its
  sub-folder when it sits in one (a sub-folder holds no folders).
- **Move to top level** - on a board in a folder, or on a sub-folder.
- **Rename** changes the title. **Delete folder** never deletes a board: what the folder held moves
  up one level, into its place.

At the bottom of a folder, one gap belongs to several levels: after the last board of a sub-folder
you can drop into the sub-folder, after it in its folder, or after the folder at the root. Where you
hold the pointer decides - over the row above, its indent picks the level; over the row below, the
seam takes that row's level.

## What is new, what needs you

The sidebar shows where to look.

- **New** - a frame that changed since you looked: its icon and title turn blue, with a dot at the
  right of its row. On the canvas, its title above the card does the same.
- **Waiting on you** - Marver is waiting on you on a frame: a question (a note from your agent, or
  a reply that asks), or work to review and resolve. Its icon turns orange, and an orange bubble at
  the right holds how many threads are open - `1`, `2`. Answer in the thread and the bubble goes
  hollow while the agent works; it is gone once the thread is resolved, and the frame turns blue if
  the agent changed it.
- **One slot per row.** Every row keeps the one item at its right edge it has today, and what matters
  most takes it: the bubble first, then the row's own count or status, then a frame's dot. A board
  you are not on turns blue when its frames hold something new, and the bubble takes its status
  glyph's place until answered. A closed folder shows the bubble when something inside waits on you,
  else a blue dot when something inside is new, else nothing - never a number for new: it is not a
  to-do count (0.31). An open folder shows how many boards it holds. A folded scene keeps its frame count, blue when something inside is new.
- **`U`** goes to the next frame that asks you something, then the next one waiting on you, then the
  next new one.

"Changed" means the frame or anything it reads changed - its file, its sticky note, a kit or a
spec's markdown it imports, a layout or the providers around it; an edit, your agent, a `git pull`
(even while `marver dev` was off) - or an agent named the frame in `npx marver work done`. A file
every frame reads lights every frame; **Mark all as seen** on the board clears them.

"Looked at" means you selected it, opened it from the sidebar or a link, opened it in focus or play,
kept it on screen at a readable zoom (50 % or more) for two seconds, or chose **Mark all as seen** on
a scene, board or folder (**Mark as seen** on one frame's row, 0.33) - for the version on screen: a change still loading (or behind **Update** in
focus or play) stays new until its new version shows, and a look you made while it loaded counts as
soon as it does.

**Resolve all comments** sits beside every **Mark all as seen** - a board's, a folder's, a scene's,
and the Mac app's tab menu - for when the bubbles are noise (0.31). It resolves what that row shows,
never a log: a board's every open thread on the frames it shows, a folder's over all its boards and
sub-folders, a scene's on its frames, the tab's every open thread on the canvas. A frame's own row in
the sidebar has the pair too (0.33), each only when there is something to do: **Mark as seen** while it
is new, **Resolve comments** while a conversation on it is open. It is the same as
resolving each one by hand - Jam's questions, reviews and failed runs on them are finished - except
live work: a thread Jam is queued or working on is left open and counted ("2 left open: work in
progress"). The notice says how many, with **Undo**: it reopens each thread nothing happened in since - no
reply, edit, reaction, resolve or reopen ("1 changed since - left as is"); what Jam finished stays finished. From the terminal: `npx marver
comments resolve --all --board <b>` (`--folder`, `--scene`, `--canvas`, `--dry-run`), then `--undo <op>`
with the op it prints. Missed the notice's Undo (it shows for 10 seconds)? Every run is kept as
`design/.local/comment-ops/<op>.json` (its `scope` and `at` say which), and `npx marver comments resolve --undo <op>`
undoes it. On the board you have open, it saves your latest edits first; while they are not saved it resolves nothing
and says so ("this board's latest changes are not saved yet"). A published canvas has no Resolve all of its own: run it
here, and each thread it resolves reaches the published canvas with the next sync.

The marks start when `marver dev` starts, so whatever your agent makes before you open the canvas is
new when you do; everything already there the first time counts as seen. They live in
`design/.local/`, on this machine only, and a published canvas shows none. `npx marver marks` prints
them, and the open conversations per board - for you, or for your agent at the start of a session.

**In the Mac app** (0.3, with Marver 0.29), each canvas's tab sums this up, even while it is hidden: an
orange count of what needs you - Marver's questions, captures to review, runs that failed or stalled -
else a blue dot for new frames (no number, from app 1.1), else a shimmer while an agent works, and a teal
dot while a Jam session runs; while Home is open the tabs drop them: Home shows them. Its right-click menu holds
**Resolve all comments** beside **Mark all as seen** for a canvas on Marver 0.31 or later. Home's card says the same
in words ("2 questions on Checkout", "3 new frames to look at"), and with Marver 0.32 (app 1.2) which board an agent
works on and for how long ([Home](app.md#home)). Turn notices on and a canvas you are not looking at sends one when something new needs you, and the
Dock counts them all. Clicking a notice opens what it names where you can see it, on its board: a question
in its thread on the frame (Play left and hidden pins shown for it), or in a panel with a field to answer
when no frame on the board holds it; a review in its review; a failed run with Retry in view, a stalled
one with its three choices (a stalled capture's or Jam session's on its tile in the lane, on the board you are on). On a
board locked to play, Play stays and the thread opens over it; a resolved thread opens read-only. It moves
nothing while you are capturing or have typed words not yet sent.

## Edits land calmly

When a file changes, the canvas reloads only the frames that read it, a few at a time, the ones on
screen first; a frame off screen waits until you scroll to it, and one you are using (typing in it,
drawing a laser, commenting) waits until you are done. A content frame keeps its height while it
reloads, so the rows below stay still; if heights did change, the board moves once. The canvas page
itself never reloads for a design edit. `npx marver perf` shows what each edit reloaded and how long
it took (from `design/.local/perf/reloads.jsonl`), and `npx marver perf --loads` what each board load
did: how long until it settled, how many moves it took on the way, and why
([Performance](performance.md)).

## In the files

Two files carry it, and they are the truth.

**A board names its folder** - the one it sits in directly, at either level - next to its rank:

```json
{ "version": 1, "name": "new-load", "folder": "shipper", "order": 0, "nodes": [] }
```

`order` ranks the board among its siblings. At every level the boards and folders there share one
sequence: the root's boards and folders, a folder's boards and sub-folders, a sub-folder's boards.

**`design/boards/_folders.json` lists the folders**, ranks them, titles and describes them - and
nests a sub-folder with `parent`:

```json
{ "version": 2, "folders": [
  { "name": "features", "order": 1, "title": "Features", "description": "One board per capability, by surface" },
  { "name": "shipper", "parent": "features", "order": 0, "title": "Shipper" },
  { "name": "context", "order": 2 } ] }
```

- A folder's `name` is its slug - what boards point at with `folder`, unique across both levels. Its
  `title` is what people see; renaming in the sidebar changes the title and never the slug.
- `parent` names a top-level folder. A sub-folder never holds a folder.
- The file says `"version": 2` while any folder has a parent, and `1` when none does.
- A folder a board names but the registry lacks is still real - it shows at the top level. To nest
  it, register it with its `parent`.
- A registry that breaks these rules is an error the canvas shows, never read as empty.

`npx marver boards` prints the tree as the files say it is - every folder and sub-folder, every board
with its rank, the landing board - and `--json` gives the same tree. The landing board is the first
board in that reading order, down through folders.

A board file that is not valid JSON says why, with the line and column: a red mark on its row in the
sidebar (hover it), the toast when you open it, the dev server's log, and an `(invalid JSON: …)` note
on its line in `npx marver boards` (`invalid` in `--json`).

### Sizes

A content frame - a `Doc` of markdown, diagrams and images - is as tall as its content, which only a
render can tell. **`design/boards/_sizes.json` remembers it**: the height each one measured at its
own width, one line per frame.

```json
{ "about": "Written by marver dev: ...",
  "heights": {
    "spec/checkout@760": 1834,
    "spec/pricing@1280": 1210 } }
```

So a board opens with every frame at its real size - the content fills in, nothing moves - in
`marver dev` and on a published canvas alike (`marver build` ships the heights of the published
frames). `marver dev` writes it when a frame settles at a new height; commit it with the rest of
`design/`, and never edit it. A stale height is only a first guess: the frame measures, and the file
follows. A merge conflict in it is safe to resolve either way.

A board with a layout recipe also notes, as `laidOut`, which heights its rows were laid out around.
When a doc on it changed while the board was closed, the board re-runs its recipe as it opens; a
frame you dragged, at heights that did not change, stays where you put it.

When content does change the layout - an agent makes a doc taller, and the rows below move down -
the canvas holds the frame you are looking at in place: the selected one when it is on screen, else
the one in the middle of the view.

## Descriptions

Every folder, board, scene and frame takes one `description`: a sentence for agents - what it is
for, and its state when that is not obvious. A folder's sits on its entry in `_folders.json`. They
all land in `design/manifest.json`, the file an agent reads first, so a new session knows what each
folder is for before it files a single board.

## Types

Every board wears an icon for what it is for, the same on every canvas:

| Type | For |
|---|---|
| `start` | the way in: the index, the shipped record, the timeline |
| `feature` | one capability: its spec, lo-fi and hi-fi |
| `surface` | the whole product to walk, from frames on feature boards |
| `project` | a deliverable or a question |
| `feedback` | one frame per theme |
| `context` | what came in from outside: meetings, threads, competitors |
| `deck` | slides |
| `archive` | snapshots and retired work |

A board states `"type"` in its JSON, or wears the type of the folder it sits in - `"type"` on the
folder's entry in `_folders.json` - or of that folder's parent; else it is plain. Moving a board
changes an inherited type, never one the board states. The type never decides how a board publishes,
but `marver build` suggests a publish type from it - `slides` for a deck, `refs` for a context board,
`doc` for a project - and the publish row decides.

## Status

Feature and project boards also wear a status, read from the project's `context/` - Backlog, To do,
In progress (filling by phase), Building (the design agreed, the code underway: `stage: build` in the
open plan), Done, Done reported, Unknown - or decided on the board itself:
`"status": "archived"`, `"paused"`, or `"blocked"` with a `"reason"`. **Done is never set by hand.**
The tooltip says what decided it. [Context](context.md) has the rules.

**Set it from the sidebar:** right-click a feature or project board, **Change status…**. The picker
shows what the evidence says and offers only what a person decides - Blocked (it asks why), Paused,
Archived, and **Back to the evidence** to undo a decision; where an open plan names the capability,
In progress and Building too, which write that plan's `stage` (no plan: "Building needs an open
plan"); without `context/`, Backlog, To do, In progress and Building as well. Type to filter, or press
a number. It writes `status` and `reason` into the board file, or the `stage` into the plan, and
nothing else.

One rule draws them: a status still open is an outline in its colour - grey, yellow filling by phase,
the code in accent blue for Building, red for blocked - and a settled one is filled: Done a green
disc, Archived a solid brown box. Done, reported is the green outline - a written claim, not yet
confirmed.

**An agent at work.** While an agent works on a board's frames (`marver work start`, or a Live Jam
job), that board's icon in the sidebar turns accent blue with a highlight sweeping across it - the
frames' working shimmer, in miniature - and so does a closed folder holding it. It lasts exactly as
long as the work, so nobody sets it. In the Mac app (1.2, with Marver 0.32), the canvas's Home card reads "Agent
working on <board> · N min", counted from when the work began: a Jam run waiting for its turn does not count.

## Starting points

- `npx marver init --kind product|knowledge` - on a fresh canvas, the typed folders every canvas
  shares: Start here, Features and Surfaces (a product) or Projects (knowledge work), Feedback,
  Context, Archive. Without the flag a fresh canvas gets product folders when an app is detected,
  knowledge otherwise, and says which. On an existing canvas only `--kind` adds them, and only the
  missing ones - init never renames or moves a folder.
- `npx marver folders add decks` - one more typed folder later: `start`, `features`, `surfaces`,
  `projects`, `feedback`, `context`, `decks`, `archive`.
- `npx marver boards new <name> --folder features` - a board in its type's starting layout: a
  feature's three phase scenes as three bands (spec, lo-fi, hi-fi), a start board rendering
  `context/INDEX.md` and `context/shipped.md`, a deck on its title slide. `--type` overrides the
  folder's; `--title`, `--description`, `--capability` fill the rest. A phase scene with its brief
  and no frame yet waits quietly: its band takes no room until its first frame lands.

## Agents

Agents make the same moves by editing those two files (`npx marver boards` prints the tree with each
board's type and status); `instructions/boards.md` in your project
teaches each one - creating a sub-folder, moving a folder in or out, renaming a slug (members'
`folder` and sub-folders' `parent` move with it), deleting (contents up one level). The sidebar
refuses a write that would overwrite an edit it has not seen, so an agent's file write and a
person's drag never silently erase each other.

## Links to frames

`npx marver link <scene/frame | scene ...>` prints the canvas link that lands on those frames: the
board they sit on, in canvas mode, with them selected and the camera fitted to them - not the
full-screen focus view. The board is the first in sidebar order that shows them all (archive boards
last); frames that sit on several boards get one link per board, and a frame on no board gets a hint
instead of a link. `--board` picks one. The link reads `#/b/<board>?f=<scene/frame>,...` (or
`?s=<scene>` for a whole scene), and a link naming a frame its board does not show follows the
frame to where it lives. `npx marver work done` prints the same links for the frames it clears, so an
agent's reply ends with them. When the Mac app has this canvas open in a tab, each of them is a `marver://` link that
opens it there ([Links into the app](app.md#links-into-the-app)); `--web` prints the localhost link anyway.

## Showing you a place

`npx marver show <scene/frame | scene ... | board>` (needs `marver dev`) moves every tab where this canvas is open to
that place - its board, selected, the camera fitted, even when it is already there - and in the Mac app brings that tab
and the window forward. A name alone is a board, fitted whole, when no frame or scene has that name. `--thread <id>`
opens a comment thread there too; frames on two boards are refused (show one board at a time). A tab where you are
typing (a comment, a Jam edit) or recording a capture does not move: it says "Your agent wants to show you <title> ·
Go", and Go takes you. Click, pan or press a key while it is on its way and yours wins: it stops. The command waits 3
seconds and says "shown in 2 tabs" (or "not shown - no open tab took it" when no tab answered), then prints the link. Agents run it only
when you ask to be shown; otherwise they give the link.

A focus link (`#/f/<frame>`) opened on your dev canvas now has its way
back to the canvas (the grid button, or Esc); on a published canvas a focus link stays a page of
its own.

## Publishing

A published canvas shows the folders of the published boards only - a sub-folder's parent included,
since the tree needs it. A folder with nothing published at any depth never reaches the bundle, so
its name and description stay private. Board types ship; statuses do not - a published board loses its
`status`, `reason` and `capability`, and shows a status only where its publish row says
`"showStatus": true` and the evidence behind it is `publishable` - never a blocked reason.

## Mixed versions

Marver 0.20 and earlier read one level of folders. They refuse a version-2 registry with an error
instead of rewriting it flat, so upgrade the whole team before nesting a folder. A browser tab opened
before the upgrade is refused the same way once folders nest - reload it.
