# Design canvas - agent contract

You design by writing files. The canvas at the printed localhost URL reflects them live.
Never run or talk to the canvas tool; read and write files only.

## Frames
- A frame = one file: design/scenes/<scene>/<name>.tsx or .html. One frame, one surface.
- It default-exports a React component. No imports from the tool are needed. Optional:
  export const meta = { title: "...", viewport: "mobile" }   // literal values only
  // viewport names come from design/config.ts (default: mobile, tablet, laptop, monitor;
  // tv available commented-out). Pick the one the screen is designed for - the human can
  // flip the whole board to any device (Devices menu, hotkeys 0-5) to check responsiveness.
- States are sibling frames: empty.tsx, filled.tsx, error.tsx, success.tsx.
- Use the app's UI: import from {{UI_ALIAS}}; style with the app's Tailwind classes.
- Navigation: put data-goto="scene/frame" on any element. That is the whole prototype system.
- Files starting with _ are infrastructure (never frames): _layout.tsx, _fixtures.ts.

## Structure ladder
1. First pass: write the whole page inline in the frame file. Diverge fast.
2. When a direction wins: extract shared markup into design/screens/<Name>.tsx and
   shrink frames to harnesses that mount it with fixtures.
3. Layouts: design/scenes/<scene>/_layout.tsx wraps every frame in the scene (Next.js
   convention). The root design/scenes/_layout.tsx is the app shell.

## Fixtures
- design/scenes/<scene>/_fixtures.ts - typed plain objects shaped like the future API.
- Frames import fixtures, never stores, never the network, never auth.

## Orientation
- design/manifest.json lists every frame (id, file, scene, title) - read it before exploring.
- Component galleries: create design/components/<name>/variants.tsx rendering each variant
  and each state (default / hover-styled / focus / disabled / loading) of one ui component.

## Rules
- Do not edit design/boards/*.json while the canvas is open unless asked; the shell owns them.
- Do not import from "design/" inside src/ or app/. The arrow points one way.
- Do not add network calls, app stores, or auth to frames. Mocked data only.
- Keep each frame self-sufficient: it must render from its file + fixtures + ui imports alone.
- A scene may not be named "components" or "screens".

## Promotion (when a design is approved)
- Move the screen from design/screens/ into the app (src/features/...), replace fixture
  props with live data/handlers, replace data-goto with the router's navigation.
- Leave the frame in place, importing from its new home, so the canvas stays true.

## Boards (curated canvases)

A board is a saved canvas: `design/boards/<name>.json` (name: `^[a-z0-9][a-z0-9-]*$`).
The human switches boards in the sidebar; YOU create and manage them by writing files.
Minimal file - just list the frames; the shell fills sizes from each frame's viewport,
lays it out, and keeps it tidy:

```json
{ "version": 1, "name": "checkout-compare", "auto": false,
  "nodes": [ { "frame": "checkout-a/cart" }, { "frame": "checkout-b/cart" } ] }
```

- The same frame may appear on many boards, or twice on one board (e.g. two widths:
  add `"w"`/`"h"` on a node to pin a size).
- `auto: false` boards show exactly their list. The `all-scenes` board is auto-managed -
  never write it.
- Use boards for comparisons: version A vs B vs C of a flow, side by side.
