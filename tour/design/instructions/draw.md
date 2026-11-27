<!-- marver:managed a60fb6d1d813766c0085cf76195e023d11d8820f704af7a434b9254cf1799de0 - edit freely: init preserves your edits and stages upstream updates at design/.local/latest/ for you to merge. Delete this line to detach this file from updates entirely. -->
# Draw together

A drawing frame shows a `.excalidraw` file in `design/scenes/<scene>/`. The person
and the agent edit that same drawing at the same time. Keep `npx marver dev`
running.

The draw commands talk to the running canvas. If your sandbox keeps you off
localhost (a draw command says it cannot reach the canvas) and you cannot run
it outside the sandbox, edit the `.excalidraw` file directly instead - the
canvas merges your edit the same way - and check the result with
`npx marver shot <frame>`, which works from a sandbox.

1. Read the current drawing: `npx marver draw describe <frame>`. Add `--since <rev>`
   to see changes since your last read.
2. Edit. Prefer `draw add` with elements for new structure; use `set`, `move` and
   `rm` for small, exact changes.
3. Run `npx marver shot <frame>`, look at the image, and fix what needs work.
   Repeat until the drawing reads clearly. Never rewrite a drawing from memory.

Create and pin a drawing with `npx marver draw new <board> --scene checkout
--name flow --title "Checkout flow" --size 960x640`. `<board>` is required: the
board the new drawing is pinned on. Use the frame id and file path it prints.
The scene defaults to `sketches`; the size defaults to 960x640.

Write a JSON array of partial Excalidraw elements (or `{"elements":[...]}`), then
run `npx marver draw add <frame> --elements elements.json --at 40,40`.
`--at x,y` moves the whole group so its top-left corner lands at that point
(labels move with their shapes); without it, your coordinates are kept as given.
Use rectangle, diamond, ellipse, arrow, line and text elements. Give each an
`id`, `type`, `x`, `y`, `width` and `height`; give text its `text` too (a text
with no `width`/`height` is sized from its words and `fontSize`). Keep ids
stable and meaningful, such as `box-cart` and `label-cart`.

```json
[
  {"id":"box-cart","type":"rectangle","x":0,"y":0,"width":160,"height":80,
   "boundElements":[{"id":"label-cart","type":"text"}]},
  {"id":"label-cart","type":"text","x":40,"y":28,"width":80,"height":25,
   "text":"Cart","containerId":"box-cart"}
]
```

Make a label a separate text element with `containerId` pointing to its shape,
and list it in that shape's `boundElements`. A label sits centred in its shape
unless you give it `textAlign` and `verticalAlign`. Bind arrows with `startBinding` and
`endBinding`, each `{"elementId":"box-cart","focus":0,"gap":4}` using the
appropriate endpoint's id. Give lines and arrows relative `points`, for example
`[[0,0],[200,0]]`. Coordinates belong to the drawing itself: the frame shows its
own view, separate from the board's coordinates.

```sh
npx marver draw set checkout/flow label-cart 'text=Review cart' fontSize=24
npx marver draw set checkout/flow box-cart 'backgroundColor="#e3fafc"' locked=false
npx marver draw move checkout/flow box-cart --by=-20,40
npx marver draw rm checkout/flow box-cart
```

Quote values containing spaces or JSON. `set` parses JSON values (numbers,
booleans, null, arrays, objects); other values stay strings. Move carries bound
labels and arrow ends. Removing a shape also removes its bound label.
Mermaid conversion is not available yet; write elements instead.

Leave the person's elements where they are unless the task asks you to change
them: make room by placing yours elsewhere, and say so if the drawing is crowded.

Raw file edits are allowed and merged. Read the file first and keep its revision
header and stable ids. The person wins a conflict; `draw describe` reports lost
changes. Re-read the current drawing and retry the intended change, then shoot
and inspect it again.

## Working through drawing comments

In chat, read `npx marver comments list --open --json` and `npx marver marks`, then
`npx marver work start <drawing>` BEFORE a commented change. Finish with
`npx marver work done <drawing>`. A run from the canvas already holds its drawing:
use `npx marver draw ... --run <handle> [--as <connection>]` so the log names its
work even when runs overlap. A spawned run inherits its handle automatically.

An element with an open thread is load-bearing: use `set` or `move`, never
`rm` + `add`. Keep its id in raw file edits too. `describe` marks open threads;
`describe --since <rev>` names threads orphaned by agent changes; `rm` names the
threads it strands. Re-pin only when needed with
`npx marver comments move <thread> --element <id>` or `--paper 412,96`.
`comments new <drawing> --element <id> --body "..."` pins a note on an element;
`--paper x,y` pins it on blank paper. Screen flags do not apply to drawings.

Polish a drawing in place, with no scene snapshot, including rounds begun in
chat. Its revisions and git preserve the before.

**Answer every comment in its thread, and never resolve the owner's.** For each
thread you addressed, run `npx marver comments reply <thread> --body "..."`
naming what changed and the revision. The owner's own threads stay open - they
resolve them after looking at the drawing. Only a collaborator's thread is
yours to resolve, after replying: `npx marver comments resolve <thread>
--addressed-in <drawing>`. If your sandbox keeps you off the canvas, say in
your answer which threads you could not reply to. After a raw file edit the
revision is the canvas's to give: read it back with `draw describe` (or say
"saved to the file") rather than guessing a number. Siblings mean the same kind of element in the SAME drawing:
change them only when asked; otherwise ask about them in the thread.
A published reply is read by the owner's people: name elements, never file paths.
