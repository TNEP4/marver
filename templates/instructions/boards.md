# Boards - curated canvases and publishing

A board is a saved canvas: `design/boards/<name>.json` (name: `^[a-z0-9][a-z0-9-]*$`).
The human switches boards in the sidebar; YOU create and manage them by writing files.

## The file

Minimal is enough - list the frames; the shell fills sizes from each frame's
viewport and lays it out:

```json
{ "version": 1, "name": "checkout-compare", "order": 1, "auto": false,
  "nodes": [ { "frame": "checkout-a/cart" }, { "frame": "checkout-b/cart" } ] }
```

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
  in the sidebar (which rewrites `order`) and rename one from its right-click menu - so
  your ranking is a starting point they may adjust.
- `auto: false` boards show exactly their list. `all-scenes` is auto-managed (it holds
  EVERY frame, so it is the heavy one) and always sinks to the BOTTOM of the switcher -
  never the landing board, and never write its file.
- Do not edit board files while the canvas is open unless asked; the shell owns
  their layout fields.
- Use boards for comparisons: version A vs B vs C of a flow, side by side. Variant
  groups (letter-prefixed siblings) stay contiguous through every relayout
  automatically.
- Content frames (specs, diagrams, mood boards - instructions/shape.md) are ordinary
  atoms in every layout scope: a feature-story board mixes them freely with UI frames.
- The `archive` board (instructions/iterate.md) is the one board of retired
  explorations: curated over design/scenes/archive/, tidied with a recipe,
  every frame relabeled with what it was and why it retired. Winners live on
  the feature boards; the archive answers "what did we try?".

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
