# Draw together

A drawing frame shows a `.excalidraw` file in `design/scenes/<scene>/`. The person
and the agent edit that same drawing at the same time. Keep `npx marver dev`
running. Run draw commands outside the sandbox if it blocks localhost.

1. Read the current drawing: `npx marver draw describe <frame>`. Add `--since <rev>`
   to see changes since your last read.
2. Edit. Prefer `draw add` with elements for new structure; use `set`, `move` and
   `rm` for small, exact changes.
3. Run `npx marver shot <frame>`, look at the image, and fix what needs work.
   Repeat until the drawing reads clearly. Never rewrite a drawing from memory.

Create and pin a drawing with `npx marver draw new <board> --scene checkout
--name flow --title "Checkout flow" --size 960x640`. Use the frame id and file
path it prints. The scene defaults to `sketches`; the size defaults to 960x640.

Write a JSON array of partial Excalidraw elements (or `{"elements":[...]}`), then
run `npx marver draw add <frame> --elements elements.json --at 40,40`.
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
and list it in that shape's `boundElements`. Bind arrows with `startBinding` and
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

Raw file edits are allowed and merged. Read the file first and keep its revision
header and stable ids. The person wins a conflict; `draw describe` reports lost
changes. Re-read the current drawing and retry the intended change, then shoot
and inspect it again.
