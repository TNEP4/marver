# SPEC-026 - Content frames: the co-thinking canvas

Status: DRAFT v2 (Nic, 2026-08-13; codex round 1 folded). Source: marver enters
the story at "wireframe" - real co-building starts earlier. Specs, workflows,
mood boards, and inspiration need a visual, git-versioned, agent-writable home
on the SAME canvas as the UI they lead to. This is the last capability before
comments (SPEC-M3): commenting on a spec frame is design-doc review, so
shipping this first doubles M3's reach.

## The idea in one picture

One board per feature, reading left to right as the feature's whole story:

```
[ mermaid flow ] [ spec ] [ moodboard ] [ wireframes ] [ hi-fi + variants ]
      why          what    inspiration    structure         the answer
```

No new board type, no new canvas, no new floating menu. Same boards, same
selection, same tidy, same publish gate, same deep links. What is new is a
category of FRAME: the content frame.

## The model - one vocabulary, two scales

The board grammar (SPEC-024) taught agents rows/columns of atoms with `space`
tokens. Content frames reuse the same **vocabulary** one level down - rows,
columns, space units - as CSS-native flex primitives. This is deliberately NOT
the SPEC-024 Flow/Lane grammar (codex r1 #7): boards keep their exact locked
lane/boundary semantics; frame interiors are ordinary nested flex with gap.
The two scales rhyme so one mental model covers both; they do not share an
implementation, and instructions say so plainly.

Blocks: **markdown**, **diagram** (Mermaid), **image**.

## Authoring - one path: block primitives in a normal frame

A content frame is a `.tsx` frame - the existing model, the existing pipeline -
composed from primitives marver ships at a new package export,
`@marver-design/marver/content` (precedent: `./runtime`). Manifest, boards,
variants, tidy, publish, play, and interact-mode scrolling are all inherited
because nothing about the frame contract changes.

(codex r1 #1-#4: raw `.md`/`.mmd` frame files are CUT from v1. They looked like
sugar but are a second frame pipeline - new loaders across dev/HMR/stage/play/
build, a variant contract that excludes them, an extension-precedence table,
and a metadata story `extractMeta` can't serve. A minimal markdown frame is a
5-line tsx wrapper; the single path keeps every existing contract intact. Raw
files return in v2, if dogfood demands them, as a virtual-module spec.)

**The scope principle (Nic, 2026-08-13): the cut trades an authoring shortcut,
never capability.** Tiny tsx boilerplate is acceptable - agents write it. What
is NOT acceptable is any canvas feature working differently for content frames
than for UI frames: variants, boards, tidy, device presets, theme cycling,
play, publish, deep links, interact mode all behave identically, because a
content frame IS an ordinary frame. Any implementation choice that would make
a feature "work except for content frames" is wrong by definition.

```tsx
import { Doc, Row, Col, Space, Md, Diagram, Img } from '@marver-design/marver/content'

export const meta = { title: 'Checkout - how it works', intent: 'diagram' }

export default () => (
  <Doc layout="wide">
    <Row>
      <Diagram title="Checkout flow">{`
        flowchart LR
          Cart --> Pay --> Confirm
      `}</Diagram>
      <Col>
        <Img src="stripe-ref.png" caption="Inspiration: Stripe checkout" />
        <Md>{`### Why payment before account\nDropoff data says...`}</Md>
      </Col>
    </Row>
  </Doc>
)
```

The primitive set - and the refusal to grow it until dogfood demands more:

| Primitive | Role |
|---|---|
| `Doc` | Frame root. `layout="document" \| "wide"` sets the frame's default own-size width (readable column 760 / wide canvas 1280). Owns outer padding and the height-measurement protocol (below). |
| `Row` / `Col` | Flex lanes with gap. `space={n}` = gap units between children (default 1). Rows wrap on narrow widths. |
| `Space` | One-off boundary gap: `<Space n={3} />`. |
| `Md` | Markdown block. Theme-aware typography from marver's tokens; headings, tables, quotes, lists, code, task lists. Raw HTML OFF (security, below). |
| `Diagram` | First-class Mermaid block - a peer, never a guest inside markdown. Can be the entire frame; renders to intrinsic SVG size, scales down to fit its column. In-frame error card on parse failure - a broken diagram never blanks a frame or trips the readiness timeout. |
| `Img` | Image from `design/assets/` (relative path only; normalization + publish rules below). Optional `caption`. |

**The rubber**: `Diagram` and `Img` own their breathing room - inner padding, a
thin hairline border, a subtle surface background, small radius - so blocks sit
composed on the frame, never flush against an edge. The agent never hand-manages
padding; the block does. `Md` gets measure and rhythm for free.

**goto links** (codex r1 #13): `Md` transforms links of the form
`[checkout screen](goto:checkout/cart)` into elements carrying
`data-goto="checkout/cart"` - the existing bridge primitive; target syntax is
the frame id, unknown ids behave as any bad data-goto does today. Other
protocols: `http(s)`/`mailto` render as real links with
`target="_blank" rel="noopener"` (never navigate the iframe); anything else is
rendered as plain text.

## Sizing - the measurement protocol (codex r1 #5, #6; r2 rewrite)

Frame dimensions belong to the shell (`Node.w/h`); an iframe child cannot set
them by styling itself. The shell also cannot see inside the iframe, so WIDTH
must travel in the message too (r2 #1) - a height-only protocol strands an
unannotated wide Doc at the mobile fallback width forever.

**The message.** `Doc` observes its content (ResizeObserver, debounced ~300ms
after last change) and posts `sh:measure { ownWidth, measuredWidth, height, gen }`:

- `ownWidth` - the Doc layout's natural width (`document` 760 / `wide` 1280).
- `measuredWidth` - the iframe's actual innerWidth when the height was taken
  (r3: ownWidth alone is the DESIRED width and cannot enforce the match).
- `height` - content height as measured at `measuredWidth`. The shell commits
  a height only when `measuredWidth` matches the width it is applying (a
  phone-width height is never applied to a 1280 frame); mismatched
  measurements just trigger a remeasure at the right width.
- `gen` - REALIZED AS (impl round 3): the sending document echoes the `r`
  (manifest rev) from ITS OWN frame URL; the shell compares it against the
  iframe's CURRENT src and drops mismatches. A WindowProxy survives
  navigation, so routing alone cannot tell a pre-navigation document's late
  message from the live one - the URL-rev echo can, with zero new state
  (frame URLs are already rev-stamped). Plus: routing (event.source must map
  to a mounted iframe inside a live node), a `frame` id equal to the node's,
  auto-only admission, and the width match. The shell-side reflow debounce
  carries the board-name generation (cancel-on-switch).

**Admission** (r2 P2): the shell accepts `sh:measure` only from frames whose
manifest entry is content-detected, only finite positive numbers, clamped
(width to [320, 1600], height to the cap below) before any store mutation.
Everything else is ignored. This is integrity hardening, not a security
boundary - authored tsx is already same-origin.

**Size states** (r2 #2). Each node carries explicit provenance,
`sizeMode: 'auto' | 'manual' | 'device'`:

| Event | New mode | Dimensions |
|---|---|---|
| node created / digit 0 | `auto` | ownWidth x latest matching measurement (placeholder height until it arrives) |
| human resize gesture | `manual` | the human's - measurements NEVER overwrite |
| device preset (scoped or global) | `device` | the preset's, as on any frame |
| reload | restored from `sizeMode` | `auto` nodes remeasure; `manual`/`device` keep saved dimensions |

`meta.viewport`, when declared, wins over `Doc layout` for the auto width -
the existing precedence, unchanged.

**Persistence** (r2 #3): measured dimensions are TRANSIENT - never serialized.
The board file saves `sizeMode`, and `w/h` only for `manual`/`device` nodes;
`auto` nodes save no dimensions and remeasure on load. Saves triggered by
tidy/reflow therefore cannot leak an auto-measured height into the file, and
the "shell owns layout fields" contract is unchanged.

**Reflow**: on a recipe board, measurements coalesce into ONE cancelable
board-scoped debounce; after content stabilizes the recipe re-applies once
through the existing gesture-end path. SPEC-024 semantics untouched; height
oscillation cannot cause save storms (auto heights aren't saved at all).

**Caps and devices**: height cap 2.5x the tallest configured viewport; past it
the frame scrolls (interact mode already scrolls in-frame). Device switch
applies the preset's width AND height as on any frame; rows wrap; a `Diagram`
wider than its column scales down losslessly. Digit keys, Devices menu, `d`,
and selection scoping behave identically on content frames.

## The marver diagram style

Stock Mermaid looks dated; the differentiator is diagrams that look like they
belong. marver injects a Mermaid theme via `themeVariables` (base theme +
variable overrides - the supported theming path), built on the FULL Apple
system palette (HIG, developer.apple.com/design/human-interface-guidelines/color)
so every diagram role - background, border, line, label, series - has a
designed color in both modes. Never invert; every value below is the HIG's own
light/dark pair.

- **Structure comes from the gray ramp** (iOS systemGray 1-6, light
  `#8E8E93 #AEAEB2 #C7C7CC #D1D1D6 #E5E5EA #F2F2F7`, dark
  `#8E8E93 #636366 #48484A #3A3A3C #2C2C2E #1C1C1E`): node fills, borders,
  edge lines, edge-label backgrounds, canvas-matching diagram background.
  Diagrams read as grayscale drawings first.
- **Emphasis comes from the two primary accents**: system blue (light
  `#0088FF`, dark `#0091FF`) and system purple (light `#CB30E0`, dark
  `#DB34F2`) - primary nodes, active states, highlighted paths.
- **Diversity comes from the full 12-color system set** (red, orange, yellow,
  green, mint, teal, cyan, blue, indigo, purple, pink, brown - each with its
  HIG light and dark value) mapped to Mermaid's categorical variables: pie
  slices (`pie1-12`), git branches (`git0-7`), quadrant points, journey
  sections, gantt task states. Multi-series diagrams never fall back to
  Mermaid pastels.
- **Type is the system font stack** - `-apple-system, BlinkMacSystemFont,
  "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` - so labels render
  in SF on Apple hardware and stay native everywhere else. Sensible stroke
  weights, no default Mermaid typography.
- **Theme switching** (codex r1 #8): the bridge mutates `<html data-theme>`
  with no React event, so `Diagram` installs a MutationObserver on the root
  element and re-renders on change - race-safe (a render superseded by a newer
  theme is discarded) with stable per-instance ids. Play mode keeps its
  existing stage semantics: the viewer-selected theme wins across frame and
  variant swaps, exactly as today - this spec adds no new precedence.
- References for which variables matter: mermaid theming docs
  (mermaid.ai/open-source/config/theming), gotoailab/modern_mermaid,
  agents.craft.do/mermaid.

**Cost and containment** (codex r1 #11): Mermaid is marver's dependency, not
the host's, behind a dynamic import in `Diagram` - and the acceptance bar is
stronger than "lazy": a workspace whose included frames contain no `Diagram`
ships no Mermaid chunk and makes no Mermaid request, dev and published.

## Security - the content trust boundary (codex r1 #10)

Frames run same-origin; "the agent wrote it" is not a trust model once specs
are pasted from outside. Locked for v1:

- `Md`: raw HTML disabled entirely. LINKS and IMAGES have separate policies
  (r2 #5 - one shared allowlist lets pasted markdown exfiltrate via remote
  image requests): links may be `goto:`, `http(s)`, `mailto` (external always
  `target="_blank" rel="noopener"`, never navigating the iframe); images are
  LOCAL ONLY - relative `design/assets/` paths, no URLs, no protocols.
- `Diagram`: Mermaid `securityLevel: 'strict'` (which covers HTML labels and
  clicks but is NOT a no-network policy) plus: external image/icon references
  in diagram source are rejected - the rendered SVG is sanitized before
  insertion, stripping any external `href`/`xlink:href`/`image` URL. And
  source-level theme overrides (`%%{init}%%` directives, frontmatter config)
  are stripped/ignored (r2 P2) so pasted diagrams cannot bypass the marver
  palette.
- `Img`: relative paths within `design/assets/` only - `..`, absolute paths,
  and URLs are rejected with an in-frame error card.
- Net effect: a content frame makes zero external network requests.

## Assets - referenced, never wholesale (codex r1 #9)

- Dev: the server exposes `design/assets/` on a dedicated route; `Img`
  resolves against it.
- Build: assets are copied by REFERENCE, not by directory. The scan follows
  the MODULE GRAPH reachable from the included frame roots the filtered build
  already computes (r2 #4 - scanning only frame files misses
  `export { default } from './body'`, shared content components, and variant
  implementation modules): every reachable module is scanned for `Img` src
  literals AND markdown image literals, and only those files are copied. A
  screenshot referenced by no published frame never ships - the existing
  `--boards` privacy guarantee extends to assets, including excluded variants.
- Dynamic/computed `src` anywhere in the reachable graph fails closed: build
  error naming the module, asking for a literal.
- Containment: resolved asset paths are `realpath`-checked against
  `design/assets/` - a symlink inside the directory cannot publish a file
  outside it.
- Missing file: in-frame error card in dev; build error at publish.

## Intent - how the human finds a frame at a glance

The badge lives at the FRAME level. Scanning the sidebar for "my diagram
frame" is an icon scan, not a title read.

- **Declared intent wins.** `meta.intent` - a literal string, extracted by the
  existing `extractMeta` pass. Vocabulary v1: `diagram`, `spec`, `moodboard`,
  `notes`. The agent sets the frame's PURPOSE, which may not equal its content
  mix: a frame with two diagrams, an image, and a paragraph is still "my
  diagram frame" if diagrams are why it exists. Unknown values fall back to
  the generic content icon (forward-compatible, never an error).
- **Inference fills the gaps.** Content-frame DETECTION is lexical: the FRAME
  FILE ITSELF imports `@marver-design/marver/content` (import specifier scan,
  not JSX matching - example code in strings can't misbadge a UI frame, codex
  r1 #15). This is a stated convention, not module-graph analysis (r2 P2):
  a frame that reaches the primitives through a barrel or re-export is not
  detected - the instructions say "import content primitives directly in the
  frame file, and declare `intent` on every content frame", and `meta.intent`
  always works regardless of import shape (it's the taught convention;
  inference is the safety net). Among detected content frames with no
  declared intent, the heuristic counts block usage: any `<Diagram` →
  `diagram`; else `<Img` majority → `moodboard`; else → `spec`.
- Manifest: `intent?: string` on `FrameEntry` (`kind` stays file-kind).
- **Placement** (codex r1 #12; revised per Nic's dogfood feedback 2026-08-13):
  EVERY sidebar row leads with an icon - intent glyph for content frames, a
  plain frame rectangle for UI frames, the variants flask for group rows
  (variant-ness is the group row's identity; member rows keep their letter
  chips, indented one step deeper than the group). Sidebar ORDER follows the
  canvas reading order (nodes by y then x; groups anchor at their earliest
  member) - the list tells the same story as the layout. Canvas - the intent
  icon joins the frame's title chrome; the variant badge is untouched. Icon
  tooltip and accessible label = the intent name.

## Teaching the agent - link, don't prescribe

New instruction file `templates/instructions/shape.md` + a method-table row:
**Shape** - "an idea needs thinking before it needs screens".

**Routing** (codex r1 #14; amended by the SPEC-025 fork, Nic 2026-08-13):
Shape never runs UNPROMPTED in the first session - but the onboarding fork
(SPEC-025 "The fork") now offers it explicitly: "think it through together"
(Path A) / "start something new, together" (Path B) route the first session
INTO Shape by the human's choice. Outside first sessions it enters when the
human wants to think a feature through on canvas (or the agent proposes it
for meaty new work). The Discover boundary: Discover stays the interview -
questions, brief, mode taxonomy; Shape is the visual thinking surface built
from Discover's answers (the feature-story board). discover.md's existing
flow-diagram note points to Shape instead of duplicating it.

shape.md teaches:

1. The feature-story board (the picture at the top) - diagram, spec, moodboard,
   wireframes, hi-fi, left to right.
2. The block primitives, the layout vocabulary (and that it is NOT the board
   grammar - rhyming vocabulary, flex semantics), the rubber rules, `intent`
   on every content frame, a canonical minimal frame example.
3. **Diagram choice by taxonomy link, not rules**: one line naming the breadth -
   flowchart, sequence, state, user journey, quadrant, git graph, gantt,
   mindmap, timeline, and more - and a link to the Mermaid intro docs
   (mermaid.ai/open-source/intro/). The agent picks the visualization that
   fits the idea; we do not enumerate per-type instructions. Plus one recovery
   line: a Diagram error card means a syntax error - fix the source, the frame
   heals live.
4. Assets: images arrive via chat in v1 - the human dumps screenshots and
   ideas in conversation; the agent files them into `design/assets/`
   (kebab-case names that say what the image IS, always a `caption` or alt).
   Nothing is ingested without intent.

AGENTS.md templates: method-table row for Shape; one line in Frames noting
content frames and where their primitives import from.

## Touched files

| File | Change |
|---|---|
| `package.json` | `"./content"` export; mermaid + markdown renderer deps (lazy) |
| `src/client/content/` | NEW - Doc/Row/Col/Space/Md/Diagram/Img, mermaid theme bridge, sanitizer |
| `src/client/frame-host/bridge.js` | `sh:measure` message |
| `src/client/shell/store.ts` + canvas | Own-size measurement state; debounced recipe reflow |
| `src/server/manifest.ts` | `intent` field: meta key + import-based detection + usage heuristic |
| `src/server/dev.ts` / `build.ts` | assets route; referenced-asset copying with `--boards` filtering |
| `src/client/shell/icons.tsx` + sidebar + frame chrome | Intent icons, placement rules |
| `templates/instructions/shape.md` | NEW - the Shape phase (above) |
| `templates/instructions/discover.md` | Flow-diagram note points to Shape |
| `templates/AGENTS-{studio,embedded}.md` | Shape row (never first session); content-frame note |
| `templates/instructions/boards.md` | One line: content frames are ordinary atoms in board layouts |

## Acceptance (dogfood + regression)

- A feature-story board built by a fresh agent post-onboarding: mermaid flow +
  spec + moodboard + existing UI frames on one board; tidy, device keys, and
  `d` working across all of it.
- A wide flowchart as an entire frame: breathing room, hairline border, scales
  to fit on the phone preset, readable in both themes, re-renders on `d`,
  correct after rapid double `d` (race check).
- Sidebar shows intent icons; a two-diagram frame declared `intent: 'diagram'`
  badges as diagram regardless of its text; a UI frame containing the string
  `"<Diagram"` in example code stays badge-free.
- `goto:` link in a spec paragraph jumps to the named UI frame; an `http` link
  opens a new tab and never navigates the iframe; raw HTML in markdown renders
  inert.
- Measurement: growing a spec's text grows the frame once, settled; a manually
  resized content frame keeps its size through edits AND through reload
  (`sizeMode` round-trips); digit 0 restores measured size at the Doc's own
  width, never a phone-width height on a wide frame; a recipe board reflows
  once; the saved board file contains no auto-measured dimensions; a spoofed
  or NaN `sh:measure` from a UI frame is ignored; a measurement debounced
  across a board switch never touches the new board.
- Publish privacy: `marver build --boards <b>` ships only assets reachable
  from frames on `<b>` - including assets referenced via a shared content
  module - and an excluded variant's assets are absent; a symlink in
  `design/assets/` pointing outside the directory fails the build; pasted
  markdown with a remote image URL renders the image as text; a mermaid
  source with an external image node or an `%%{init}%%` theme override
  renders without the external request and in the marver palette.
- UI-only workspace: no mermaid chunk in the build graph, no mermaid request
  in dev or published.
- First-session onboarding transcript unchanged: no Shape work appears before
  the SPEC-025 flow completes.

## Codex round 1 disposition

FIX verdict, 10 P1 / 5 P2. Accepted: #5+#6 (measurement protocol + reflow
ownership), #7 (vocabulary-not-grammar reframe), #8 (MutationObserver rerender
+ play precedence unchanged), #9 (referenced-asset build), #10 (sanitization +
strict Mermaid), #11 (bundle-graph acceptance), #12 (badge placement rules),
#13 (goto transform + URL policy), #14 (Shape never-first-session + Discover
boundary), #15 (contract examples, lexical detection, expanded acceptance).
Resolved by scope cut: #1-#4 - raw `.md`/`.mmd` frame files removed from v1;
single tsx authoring path. Deferred: raw-file sugar as v2 virtual modules.

## Codex round 2 disposition

FIX verdict: r1 #1-#4/#7/#8 confirmed resolved; 5 P1 + 3 P2 on the v2
additions, all folded into v3. #1 width-aware measurement
(`{ownWidth, height, gen}`, commit only width-matched heights). #2 explicit
`sizeMode: auto|manual|device` with a transition table and reload semantics.
#3 auto-measured dimensions are transient, never serialized - board files
save `sizeMode` and only manual/device `w/h`; reflow is board-scoped and
cancelable. #4 asset scan follows the filtered build's reachable module
graph (re-exports, shared modules, variant bodies, markdown image literals),
with realpath containment. #5 split link/image policies (images local-only),
mermaid SVG sanitized of external refs, `%%{init}%%`/frontmatter theme
overrides stripped - net: content frames make zero external requests.
P2s: `sh:measure` admission + clamping; direct-import detection stated as
convention (meta.intent is the taught path); mixed-intent variant groups get
the generic icon.

## Non-goals

- No new board type, no new floating menu, no per-frame chrome variants.
- No raw `.md`/`.mmd` frame files in v1 (v2 candidate: virtual React modules).
- No bespoke layout JSON/grammar for frame interiors - JSX primitives only;
  and no claim that frame layout IS the board grammar.
- No canvas drag-drop image ingestion (v2: drop → `design/assets/` inbox).
- No app-specific mermaid theming (later layer; marver identity ships first).
- No comments (SPEC-M3) - this spec only widens what M3 will comment on.
- No growth of the primitive set without a dogfood-proven need.
