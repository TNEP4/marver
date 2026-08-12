# Design canvas - agent contract (embedded mode)

You design by writing files. The canvas at the printed localhost URL reflects them live.
Never run or talk to the canvas tool; read and write files only.

## The method (binding)

Design work moves through phases. BEFORE working in a phase, read its instruction
file in design/instructions/ - they are short, strict, and part of this contract:

| Phase | When | Read |
|---|---|---|
| Configure | first session in a repo, or frames render unstyled | instructions/configure.md |
| Discover | any new surface, feature, or flow | instructions/discover.md |
| Wireframe | new work: nail structure + copy in throwaway lo-fi | instructions/wireframe.md |
| Brand | before the first hi-fi work: extract or create the world | instructions/brand.md |
| Build | hi-fi frames from real components | instructions/craft.md + components.md |
| Review | before presenting anything | instructions/review.md |
| Boards | creating a board or publishing | instructions/boards.md |

Refining an existing screen: Configure must hold, then Build + Review. New work runs
the full ladder. Unsure which phase you are in? Ask the human - one question beats a
phase of wrong work.

Stuck, or the human is unhappy with a result? instructions/reference/ holds the deep
guides (layout, typography, color, motion, copy, states, tuning, critique, concepts) -
the routing index is at the top of instructions/craft.md. Pull ONE file, apply, return.

## Frames
- A frame = one file: design/scenes/<scene>/<name>.tsx or .html. One frame, one surface.
- It default-exports a React component. No imports from the tool are needed. Optional:
  export const meta = { title: "...", viewport: "mobile" }   // literal values only
  // viewport names come from design/config.ts (default: mobile, tablet, laptop, monitor;
  // tv available commented-out). Pick the one the screen is designed for - the human can
  // flip the whole board to any device (Devices menu, hotkeys 0-5) to check responsiveness.
- States are sibling frames: empty.tsx, filled.tsx, error.tsx, success.tsx.
- VERSIONS are sibling frames too - the scene is the surface, each frame one direction:
  design/scenes/landing/a-terminal.tsx, landing/b-editorial.tsx, landing/c-product.tsx.
  Layout and the sidebar follow frame-id order, so variants named under one scene with
  a-/b-/c- prefixes stay adjacent and ordered through tidy and every device view.
  Never spread versions across scenes (terminal/landing, editorial/landing) - they
  interleave with everything else and the comparison falls apart.
- {{UI_GUIDANCE}}
{{NEXT_NOTES}}
- Navigation: put data-goto="scene/frame" on any element. That is the whole prototype system.
  In play mode (the human presses P) frames swap in place inside one device - design flows
  as complete graphs: every screen a data-goto points at should itself link somewhere or be
  a terminal state; play mode makes dead ends visible. Give an element the same
  view-transition-name CSS in two frames and play mode morphs it between screens.
- Files starting with _ are infrastructure (never frames): _layout.tsx, _fixtures.ts.

## Structure ladder (embedded mode: screens live in src/)
1. First pass: write the whole page inline in the frame file. Diverge fast.
2. When a direction wins: extract the screen into src/features/<feature>/<Name>.tsx as a
   presentational component (props in, JSX out - no hooks into stores or the network),
   and shrink the frame to a ~5-line harness mounting it with fixtures.
3. Layouts: design/scenes/<scene>/_layout.tsx wraps every frame in the scene (Next.js
   convention). The root design/scenes/_layout.tsx mounts the app's real shell component.

## Fixtures
- design/scenes/<scene>/_fixtures.ts - typed plain objects shaped like the component's PROPS (containers map real APIs into them at promotion; see instructions/components.md).
- Fixture shapes should match the component's props so tsc catches drift.
- Loading states are fixtures too: export const slowOrders = () => new Promise(r =>
  setTimeout(() => r(orders), 800)) and let the frame render its skeleton while awaiting.

## Orientation
- design/manifest.json lists every frame (id, file, scene, title) - read it before
  exploring. `init` writes the first one; `marver dev` keeps it fresh.
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

## Boards (curated canvases)

A board is a saved canvas: `design/boards/<name>.json` - you create and manage them
by writing files; `all-scenes` is auto-managed, never write it. BEFORE creating a
board or publishing anything, read instructions/boards.md (file format, layout
durability, publishing rules).
