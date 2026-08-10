# Design canvas - agent contract (embedded mode)

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

## Structure ladder (embedded mode: screens live in src/)
1. First pass: write the whole page inline in the frame file. Diverge fast.
2. When a direction wins: extract the screen into src/features/<feature>/<Name>.tsx as a
   presentational component (props in, JSX out - no hooks into stores or the network),
   and shrink the frame to a ~5-line harness mounting it with fixtures.
3. Layouts: design/scenes/<scene>/_layout.tsx wraps every frame in the scene (Next.js
   convention). The root design/scenes/_layout.tsx mounts the app's real shell component.

## Fixtures
- design/scenes/<scene>/_fixtures.ts - typed plain objects shaped like the future API.
- Fixture shapes should match the component's props so tsc catches drift.

## Orientation
- design/manifest.json lists every frame (id, file, scene, title) - read it before exploring.
- Component galleries: create design/components/<name>/variants.tsx rendering each variant
  and each state (default / hover-styled / focus / disabled / loading) of one ui component.

## Rules
- Do not edit design/boards/*.json while the canvas is open unless asked; the shell owns them.
- Do not import from "design/" inside src/ or app/. The arrow points one way.
- Do not add network calls, app stores, or auth to frames or the presentational screens.
- A scene may not be named "components" or "screens".

## Handoff (when a design is approved)
- The screen already lives in src/features/. Implementation wires routes, data, and handlers
  into the same component - fixtures are the only thing replaced. The frame stays, so the
  canvas remains living documentation of every screen and state.
