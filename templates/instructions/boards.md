# Boards - curated canvases and publishing

A board is a saved canvas: `design/boards/<name>.json` (name: `^[a-z0-9][a-z0-9-]*$`).
The human switches boards in the sidebar; YOU create and manage them by writing files.

## The file

Minimal is enough - list the frames; the shell fills sizes from each frame's
viewport and lays it out:

```json
{ "version": 1, "name": "checkout-compare", "order": 1, "auto": false,
  "title": "Checkout A/B",
  "description": "Cart step, direction A vs B side by side - B is the current favourite",
  "nodes": [ { "frame": "checkout-a/cart" }, { "frame": "checkout-b/cart" } ] }
```

- **The file name is the board's identity** - what you, `publish.json`, URLs and
  comment threads address (`board: checkout-compare`). It is a slug
  (`^[a-z0-9][a-z0-9-]*$`) and never moves on a rename.
- `title` - what humans SEE: free text, any casing, punctuation, emoji ("MVP", "UI",
  "Checkout (v2) 🛒"). Optional: without one the sidebar Title-Cases the slug
  (`checkout-compare` → "Checkout Compare"), which is fine for most boards. Write a
  title when the slug would read wrong (`mvp` → "Mvp") or when the human names it.
  The human's Rename in the sidebar edits the title only; the manifest carries both, so
  "the Checkout A/B board" resolves to `checkout-compare`.
- `description` - one sentence on what the board is for and where it stands. It is
  how a later session (or the human's next agent) knows this board without opening
  it; it lands in design/manifest.json. Write it at creation, keep it true.

- The same frame may appear on many boards, or twice on one (add `"w"`/`"h"` on a
  node to pin a size, `"x"`/`"y"` to place it - e.g. a comparison row: same `y`,
  increasing `x`).
- The human's tidy (`t`) and device views re-layout in frame-id order, so id
  ordering is the durable arrangement; explicit coordinates are one-off setups.
- **`"order": <n>` ranks the board in the switcher, and the LOWEST-ordered board is
  the LANDING board the canvas opens on.** Rank them so the first is a tight, fast,
  orienting board (an overview or the primary flow) - never a giant one. Boards
  without an `order` sort after the ranked ones, by name. Set `order` deliberately on
  every curated board; it is the first impression. The human can also drag-reorder boards
  in the sidebar (which rewrites `order`), retitle one from its right-click menu (which
  writes `title`), and file boards into folders (below) - so your ranking is a starting
  point they may adjust.
- `auto: false` boards show exactly their list. `all-scenes` is auto-managed (it holds
  EVERY frame, so it is the heavy one) and always sinks to the BOTTOM of the switcher -
  never the landing board, and never write its file.
- Do not edit board files while the canvas is open unless asked; the shell owns
  their layout fields (`x`/`y`/`w`/`h`, node keys). What is always yours, canvas
  open or not: creating a board, appending nodes, and writing the `layout` recipe
  of a board you curate (the `archive` board above all).
- Use boards for comparisons: version A vs B vs C of a flow, side by side. Variant
  groups (letter-prefixed siblings) stay contiguous through every relayout
  automatically.
- Content frames (specs, diagrams, mood boards - instructions/shape.md) are ordinary
  atoms in every layout scope: a feature-story board mixes them freely with UI frames.
- The `archive` board (instructions/iterate.md) is the one board of history:
  retired explorations (design/scenes/archive/, every frame relabeled with what
  it was and why it retired) and **scene versions** (`<scene>-v1`, `<scene>-v2`
  … - the whole flow as it stood before each round of feedback), one band per
  version, oldest at the top. Winners live on the feature boards; the archive
  answers "what did we try?" and "what did it look like before?".

## Folders - organising the sidebar

Boards can sit in folders, one level deep (folders hold boards, never folders).
Files are the truth, and two files carry it:

- **Membership lives on the board**: `"folder": "research"` in the board file, next
  to `order`. `order` then ranks the board among its folder siblings (root boards and
  folders share the root sequence). Same grammar as board names
  (`^[a-z0-9][a-z0-9-]*$`); an invalid value means top level. `all-scenes` never
  lives in a folder.
- **Folders live in `design/boards/_folders.json`** - the underscore marks it as
  infrastructure, never a board:

  ```json
  { "version": 1, "folders": [
    { "name": "research", "order": 1, "title": "R&D", "description": "The thinking behind the live boards - specs, flows, references" },
    { "name": "archive", "order": 3, "description": "Retired directions and scene versions, oldest first" } ] }
  ```

  A folder's `name` is its slug - the identity its boards point at with `folder`; its
  `title` (optional, free text) is what humans see, exactly as on a board; its
  `description` says what belongs in it - the next session files boards right without
  asking.

  It exists so an EMPTY folder can exist and so a folder has a rank at the root.
  A folder a board names but the registry lacks is still real (it sorts after the
  ranked items, by name) - two boards with `"folder": "research"` make a Research
  folder on their own. A malformed registry is an error the canvas shows, not an
  empty one - fix it, never delete it.

**Look before you organise: `npx marver boards`** prints the sidebar as the files say
it is - every folder (and whether it is empty or only implied by its boards), every
board in reading order with its `order`, the landing board, and whether the registry
exists (`--json` for the tree). Run it before any of the moves below; the human may
have rearranged things since you last looked, and their arrangement stands.

The moves, each a file edit, so the files always agree:
- **Create** a folder: add `{ "name": "<slug>", "order": <n>, "description": "…" }`
  to the registry's `folders` (create the file if absent) - or just point a board at it.
- **Move a board in**: write `"folder": "<slug>"` on the board and give it an `order`
  among that folder's boards. **Move it out**: delete the `folder` field and give it
  an `order` among the top-level items.
- **Rank** folders and boards: `order` on the board (among its siblings) and on the
  registry entry (among the top-level items). Renumber the siblings you touch.
- **Retitle** a folder (or a board): set `title` on the registry entry (on the board
  file). **Rename a slug** - a folder's `name`, a board's file name - only when asked,
  and as one refactor: a folder slug is on every member's `folder` field (rewrite them
  all, AND the registry entry - a registry rename alone leaves the members in the old,
  implied folder); a board file name is in `publish.json`, in its comment threads and in
  every path anyone copied. A title does what a rename usually wanted.
- **Delete** a folder: remove `folder` from every member, then its registry entry.
  Folders organise, never own: deleting one never deletes a board.
- The **landing board** is the first board in sidebar order, folders included -
  rank a folder first and its first board opens the canvas.

Use folders proactively, the way a tidy studio would: a canvas past six or eight
boards wants grouping - the live feature boards at the top level, `research` /
`specs` for the thinking, `decks` for slides, `archive` for history and versions
last. Propose the grouping in one sentence and do it; keep folder names short and
plain.

The human does all of this too - from the sidebar: New folder (right-click the Boards
header, or its `+`), Rename (the title - slugs never move from the sidebar), Delete
folder, "Move to …" on a board, and DRAG: boards into and out of folders, folders among
boards. Each drag rewrites `order` (and
`folder`) on the boards it touches and the registry - the shell owns those fields
while the canvas is open, exactly as it owns `order`; write membership and new
folders freely, and never rewrite an arrangement the human just made. The shell
refuses a write that would overwrite an edit it has not seen (your file write and
the human's drag can never silently erase each other), so read a board file before
you rewrite it. Published canvases show the folders of the published boards only; a
folder with nothing published never reaches the bundle.

## The default composition: one horizontal band

A board reads like a page: left to right first, down only for a reason. The
default for every curated board is **one `rows` lane holding the scenes side by
side, in reading order, each scene's frames flowing left to right** - the whole
story on one horizontal band the human pans along. Without a recipe the shell
stacks every scene as its own row (a vertical pile of unrelated bands), so a board
without a `layout` is a board you have not composed yet.

```json
"layout": { "rows": [["onboarding", "checkout", "account"]] }
```

A **second band** is a decision, not a reflex. Open one when you can say in a
sentence why the eye should move down - a different chapter of the story (the
specs that argue for the flow above), a different audience (admin vs customer),
an archive or a version history, a scene so wide that beside the others it would
not be read. Then make the break unmistakable: the gap between bands must read as
"below", never as "next". Units are adaptive (proportional to the touching
frames), so judge the RENDERED gap: between rows of phone or laptop frames that
is `{ "space": 4 }`; after a band of tall spec frames `{ "space": 2 }`-`3` already
reads as a chapter break. Inside a band, `{ "space": 2 }`-`{ "space": 3 }`
separates clusters (a variant run, a scene that ends one thought and starts
another); plain adjacency joins.

Two boards are multi-band BY DESIGN and set their own gaps: the feature-story
board (instructions/shape.md - thinking, structure, answer, three bands) and the
`archive` board (instructions/iterate.md - one band per version). Everything else
starts as one band.

```json
"layout": { "rows": [["onboarding", "checkout", "account"], { "space": 4 }, ["checkout-specs"]] }
```

`columns` are for the rarer case where things must share a left edge (versions of
one flow stacked as a timeline, a parked archive under a hero) - never as a way to
fit more on screen.

## Composing the canvas: `layout`

Compose a board deliberately - whitespace, lanes, alignment - with a `layout`
recipe. One grammar: a scope is `"rows"` OR `"columns"` of lanes; a lane is an
ordered list of atoms and `{ "space": n }` tokens.

```json
{ "version": 1, "name": "showcase", "auto": false,
  "layout": {
    "columns": [
      ["hero", { "space": 2 }, "archive"],
      { "space": 4 },
      ["variants"]
    ],
    "scenes": {
      "hero": { "rows": [["overview", "detail", "proof", { "space": 3 }, "directions"]] }
    }
  },
  "nodes": [ { "frame": "hero/overview" }, { "frame": "hero/detail" } ] }
```

- **Board scope** (`layout.rows` / `layout.columns`): atoms are scene names.
  `rows` lanes stack top-to-bottom, scenes in a lane flow left-to-right.
  `columns` lanes sit left-to-right, scenes in a lane stack top-to-bottom and
  share a left edge - use columns when things must align vertically (a parked
  archive under a hero, a variants cluster off to the right).
- **Scene scope** (`layout.scenes.<scene>`): the same grammar, atoms are frame
  basenames within that scene; a variant-group name (its directory name) is ONE
  atom - the run stays together. Example above: three frames, a 3-unit gap, then
  the variant run.
- `{ "space": n }` = n gap units at that boundary; a unit is the adaptive gutter
  (proportional to the touching frames), so spacing holds across phone and
  monitor frames and through resizes. Plain adjacency = 1 unit.
- **Isolate variant runs.** When a variant group shares a scene with regular
  flow frames, put `{ "space": 2 }` or `{ "space": 3 }` before (and after, if
  frames follow) the group's atom in that scene's recipe - explorations should
  read as their own cluster, not blend into the flow:
  `"scenes": { "checkout": { "rows": [["cart", "payment", { "space": 3 }, "directions"]] } }`
- Tidy, device switches, and frame resizes re-apply the recipe; dragging stays
  free until sizes change. Scenes/frames not listed append after, in default
  order. Unknown names warn and skip - check the name against the sidebar.
- Legacy `"sceneRows": [["landing","docs"]]` still works (= a plain `rows`
  layout); prefer `layout` for anything new.

## Publishing

Boards are the unit of publishing: `design/publish.json` names each shipped board
with `read` or `comment` rights (`marver build` fails without it - default-closed;
`--boards <name>` overrides ad hoc). Every frame a published flow data-gotos must
be ON a published board - unlisted frames are excluded from the bundle at build
time. Deploying the built canvas - gate password, the collaboration volume,
accounts and invites - is its own phase: **instructions/publish.md**.

The published gate page shows the app's identity: `design/logo.svg` + the host
package name (overridable via config `share`). If the app has no logo asset yet,
create a simple `design/logo.svg`. Leave `share.branding` ON unless the human
explicitly asks to remove it: marver is free, the gate is already personalized to
the app, and the small "Powered by" line is how the tool spreads. Do not remove it
as part of "branding polish".
