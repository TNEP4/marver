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

- One click selects a drawing like any frame (blue). **Double-click** it (or select it and press **Enter**, or
  **F** to fit it first) to draw in place: the frame, the sidebar, the Marver mark and the tab's icon turn the
  drawing's purple, as interact mode turns them magenta.
- The bar above the frame holds the tools - lock, hand, select, rectangle, diamond, ellipse, arrow, line, draw,
  text - and **⋯** for the rest (eraser, image, frame, web embed, laser pointer), export (PNG, PDF) and **Dark
  mode / Light mode**, then **Copy path** and **Copy as image** at its right end. Excalidraw's own letters work
  (V, H, R, D, O, A, L, P, T, E…): inside a drawing **D** is the diamond, so the theme is **⌥⇧D** - Excalidraw's
  own key for it. On the canvas, `d` still turns the theme.
- The panel on the frame's left shows what the selection - or the tool in hand - can change: stroke, background,
  fill, width, style, sloppiness, edges, arrow type and heads, font, size, alignment, opacity, layers, actions. It
  stays up while you type in a shape or a text, and acts on the words you are typing. With several shapes
  selected, Align and Distribute come first.
- The colour picker has the drawing's own **Most used** colours, Excalidraw's palette, the current colour's five
  **Shades**, its hex and an eyedropper (Chrome, Edge and the Mac app). The font picker lists the fonts **in this
  drawing** first, each name in its own face.
- The frame has its own view: zoom, fit and zoom to selection in its corner, the minimap while you pan. **Use this
  view for the frame** (in the zoom menu) makes it the view the frame rests at.
- Opened next to the sidebar, the board moves just enough for the panel to clear it.
- **Right-click** a selection for its menu, in the drawing's own design: **Comment**, Cut, Copy, Paste, Duplicate,
  **Copy selection as image** (3x), Copy as SVG, Copy as text, Copy and Paste styles, Group, Unbind text, Wrap in
  drawing frame, Link, the four layer moves, Flip, Lock and Delete - each with its shortcut. Right-click the paper for
  **Comment here**, Paste, Select all, Copy as image, Zoom to fit and Copy path. The arrows walk any drawing menu,
  Enter runs a row, Esc closes it.
- **Esc** (or a click outside) leaves drawing mode. Everything is saved as you go - there is no save button.

## Comment

A comment goes on **one element** - a shape, an arrow, a line, a stroke, a text, an image - or on a point of the
paper.

- Press **C** (inside a drawing too) or the comment button, then hover: the element under the pointer is outlined
  and named (`rectangle · "Account sweep"`). Click it, or the paper, and write. **Comment** in the right-click does
  the same for what you right-clicked.
- The pin sits where you clicked and **follows its element** when anyone moves, resizes or rotates it - you, the
  agent, a reviewer's view - and follows the paper as the drawing pans and zooms.
- An element out of the drawing's own view parks its pin in the frame's pin column (click it to bring the element
  into view); an element that is deleted parks it as gone, and an undo brings it back. A cut and paste makes a new
  element: its comment parks.
- Opening a thread from anywhere - the sidebar, search, a mail's link, a Marver question - brings its element into
  view and outlines it.
- In drawing mode the tool you had waits while you pick; **Esc** closes the comment first, then leaves the drawing.
- Comments work the same in play, and on a published canvas for the people invited to comment.
- **@marver** in a thread on an element starts Marver on that element, the usual way - or ask your coding agent to go
  through the comments (`npx marver comments list --open` names each drawing comment's element). The elements Marver
  works on shimmer in blue while it works; you can keep drawing elsewhere.

## Export

- **Export as PNG** and **Copy as image** give the drawing at 3x - sharp on a retina screen, in a slide or a doc.
- **Export as PDF** prints the drawing as vectors and real text, its fonts embedded: sharp at any zoom, and a
  few dozen KB. The canvas's own Chrome prints it (as for `marver shot`); a published canvas, which has no server
  to print with, gives the 3x picture on a page.

## Play

Select a drawing and press **P**: it fills the tab on its own paper - in the Mac app the strip behind the tabs
too. The left panel holds its name (its menu: export, copy, theme, Hide all UI) and its properties, the tools sit
top right, the view bottom right. **⌘\\** and **⌘/** collapse the panel and the tools; **H** hides all the UI and
brings it back (the pins stay - **⇧C** hides them); **⌥⇧D** (or **Dark mode / Light mode** in the ⋯) turns the theme.
The comment button sits in the tool bar (beside **×** on a published drawing). **Esc** closes an open comment first,
then goes back to the canvas.

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
npx marver comments new <scene/name> --element <id> --body "…"   # a note on an element (or --paper x,y)
npx marver comments move <thread> --element <id>                  # re-pin a thread to an element
```

An element that holds an open comment is the comment's anchor: agents change it with `set` and `move` and keep its
id; `draw rm` names the threads an element it removes was holding, and `draw describe` marks the elements that have
open comments.

A text the agent adds without a width and height is sized from its words and its font size, and every text is
measured again in its own font when the drawing opens - an agent's label is never cut off.

An agent may also edit the file directly. Either way the dev server merges element by element:

- what you are drawing, dragging or typing in is never moved under you;
- if you and the agent change the same element, **you win**, and `draw describe` tells the agent which of its
  changes lost, so it can try again;
- what the agent deleted is gone; what you added meanwhile stays.

Every change is a revision, kept in `design/.local/draw/` (local, never published) - the base of every merge, and
the history a later release will let you scrub.

## Published

On a published canvas a drawing is view-only: pan and zoom inside it, open it in play, export it. The people you
invited to comment on the board comment on its elements and its paper, at rest and in play; their comments reach your
canvas through sync, and Marver's replies in their threads reach them (see [publish.md](publish.md)). The right-click
there keeps Comment, Copy selection as image and Copy as text. Who drew what stays on your machine.

## Limits in this release

- Excalidraw 0.18.1's tools: no sticky note, lasso, draw-to-shape, bucket fill or pen pressure setting.
- **History** shows in the ⋯, greyed: it arrives with a later release.
- The laser and Jam captures treat a drawing as one frame; a comment goes on one element, never a whole group.
- Pasted images are stored inside the drawing file for now.
- Mermaid to drawing (`draw add --mermaid`) is not available yet - the agent writes elements.
