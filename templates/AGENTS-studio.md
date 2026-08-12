# Design canvas - agent contract

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
- VERSIONS are sibling frames with letter prefixes, and the canvas understands them:
  design/scenes/landing/a-terminal.tsx + b-editorial.tsx form a VARIANT GROUP - kept
  contiguous through tidy and device views, badged A/B on the canvas, one row with
  chips in the sidebar, and switchable in place in play mode ([ and ]). Scope
  alternatives inside a busy scene with a nested dir: checkout/payment/a-card.tsx vs
  b-wallet.tsx groups beside checkout/cart.tsx. meta `of`/`variant` (literal strings)
  override when filenames can't carry it. Never spread versions across scenes.
- {{UI_GUIDANCE}}
{{NEXT_NOTES}}
- Navigation: put data-goto="scene/frame" on any element. That is the whole prototype system.
  In play mode (the human presses P) frames swap in place inside one device - design flows
  as complete graphs: every screen a data-goto points at should itself link somewhere or be
  a terminal state; play mode makes dead ends visible. Give an element the same
  view-transition-name CSS in two frames and play mode morphs it between screens.
- Files starting with _ are infrastructure (never frames): _layout.tsx, _fixtures.ts.

## Structure ladder
1. First pass: write the whole page inline in the frame file. Diverge fast.
2. When a direction wins: extract shared markup into design/screens/<Name>.tsx and
   shrink frames to harnesses that mount it with fixtures.
3. Layouts: design/scenes/<scene>/_layout.tsx wraps every frame in the scene (Next.js
   convention). The root design/scenes/_layout.tsx is the app shell.

## Fixtures
- design/scenes/<scene>/_fixtures.ts - typed plain objects shaped like the component's PROPS (containers map real APIs into them at promotion; see instructions/components.md).
- Frames import fixtures, never stores, never the network, never auth.
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
- Do not add network calls, app stores, or auth to frames. Mocked data only.
- Keep each frame self-sufficient: it must render from its file + fixtures + ui imports alone.
- A scene may not be named "components" or "screens".

## Promotion (when a design is approved)
- Move the screen from design/screens/ into the app (src/features/...), replace fixture
  props with live data/handlers, replace data-goto with the router's navigation.
- Leave the frame in place, importing from its new home, so the canvas stays true.

## Boards (curated canvases)

A board is a saved canvas: `design/boards/<name>.json` - you create and manage them
by writing files; `all-scenes` is auto-managed, never write it. Compose a board
deliberately with `"layout"`: rows/columns lanes of scenes plus `{ "space": n }`
whitespace tokens, and the same grammar per scene for frames (columns align left
edges; a variant-group name is one indivisible atom). BEFORE creating a board or
publishing anything, read instructions/boards.md (the layout grammar, file format,
publishing rules).
