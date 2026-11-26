# Drawings

A drawing is a frame you sketch in, on the board, with the agent at the same time. It is a plain
`.excalidraw` file in your repo - the same file excalidraw.com and the VS Code extension open.

```
design/scenes/<scene>/<name>.excalidraw
```

## Make one

- **W** on the canvas drops a new drawing (960 × 640) at the pointer and opens it with the pen in hand. It goes in
  the scene of the nearest frame (else `sketches`), named `sketch-01`, `sketch-02`, …
- `npx marver draw new <board> [--scene s] [--name n] [--title t] [--size 960x640]` makes one and pins it.
- Any `.excalidraw` file you add under `design/scenes/` is a drawing frame. Pin it like any frame.

## Draw

- **Double-click** a drawing (or select it and press **Enter**, or **F** to fit it first) to draw in place.
- The bar above the frame holds the tools - lock, hand, select, rectangle, diamond, ellipse, arrow, line, draw,
  text - and **⋯** for the rest (eraser, image, frame, web embed, laser pointer), export (PNG, PDF), then
  **Copy path** and **Copy as image**. Excalidraw's own letters work too (R, D, O, A, L, P, T, E, V, H…).
- The panel on the frame's left shows what the selection can change: stroke, background, fill, width, style,
  sloppiness, edges, arrow type and heads, font, size, alignment, opacity, layers, actions.
- The frame has its own view: zoom and fit in its corner, the minimap while you pan. **Use this view for the
  frame** (in the zoom menu) makes it the view the frame rests at.
- **Esc** (or a click outside) leaves drawing mode. Everything is saved as you go - there is no save button.

## Play

Select a drawing and press **P**: it fills the tab on its own paper. The left panel holds its name and its
properties, the tools sit top right, the view bottom right. **⌘\\** and **⌘/** collapse the panel and the tools;
**Hide all UI** is in the ⋯ (**H** brings it back). **Esc** goes back to the canvas.

## The agent draws with you

The agent edits the same file while you draw. Its changes appear live - no reload, nothing you are doing is
interrupted, and **⌘Z** undoes only your own changes.

```
npx marver draw describe <scene/name> [--since <rev>]       # the drawing as text: ids, labels, boxes, arrows, who
npx marver draw add <scene/name> --elements f.json [--at x,y]
npx marver draw set <scene/name> <id> key=value…
npx marver draw move <scene/name> <ids…> --by dx,dy
npx marver draw rm <scene/name> <ids…>
npx marver shot <scene/name>                                 # look at it
```

An agent may also edit the file directly. Either way the dev server merges element by element:

- what you are drawing, dragging or typing in is never moved under you;
- if you and the agent change the same element, **you win**, and `draw describe` tells the agent which of its
  changes lost, so it can try again;
- what the agent deleted is gone; what you added meanwhile stays.

Every change is a revision, kept in `design/.local/draw/` (local, never published) - the base of every merge, and
the history a later release will let you scrub.

## Published

On a published canvas a drawing is view-only: pan and zoom inside it, open it in play, comment on it as on any
frame. Who drew what stays on your machine.

## Limits in this release

- Excalidraw 0.18.1's tools: no sticky note, lasso, draw-to-shape or bucket fill.
- History, Restore and **Send to Marver** are in the ⋯ but not live yet.
- Pasted images are stored inside the drawing file for now.
- Mermaid to drawing (`draw add --mermaid`) is not available yet - the agent writes elements.
