# Shape - an idea needs thinking before it needs screens

Run this when the human wants to think a feature through on the canvas - specs,
workflows, mood boards, inspiration - or when meaty new work deserves visual
alignment before wireframes. NEVER in the first session: the welcome/setup flow
(instructions/welcome.md) is the first session, complete and untouched, and its
first-draft exception skips Shape entirely. Discover stays the interview -
questions, brief, mode; Shape is the visual thinking surface built from its
answers.

## The feature-story board

One board per feature, reading left to right as the feature's whole story:

```
[ flow diagram ]  [ spec ]  [ moodboard ]  [ wireframes ]  [ hi-fi + variants ]
      why           what     inspiration     structure          the answer
```

Content frames sit beside UI frames on the same board - ordinary atoms in the
board layout grammar (instructions/boards.md). Everything the canvas does -
selection, device keys, `d`, tidy, play, publish - works identically on them.

## Content frames - blocks, not markup

A content frame is a normal `.tsx` frame composed from marver's block
primitives. Import them directly in the frame file (not through a barrel -
detection is lexical), and declare `intent` on every content frame:

```tsx
import { Doc, Row, Col, Md, Diagram, Img } from '@marver-design/marver/content'

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
        <Md>{`### Why payment before account\nDropoff data says... see the [cart](goto:checkout/cart).`}</Md>
      </Col>
    </Row>
  </Doc>
)
```

- `Doc` is the frame root: `layout="document"` (readable column, 760) or
  `"wide"` (1280). It owns the outer padding and reports its height - the
  frame sizes itself to its content on the canvas.
- `Row` / `Col` / `Space` are the board vocabulary at frame scale - flex lanes
  with gap units (`space={n}`, one-off gaps via `<Space n={2} />`). Rows wrap
  on narrow devices, so responsiveness is free. This RHYMES with the board
  layout grammar; it is not the same grammar - think flex, not lanes.
- `Md` renders theme-aware markdown. `[label](goto:scene/frame)` links jump
  the canvas to a real frame - cross-link specs and screens. Raw HTML is
  inert; images must be local `design/assets/` paths.
- `Diagram` is first-class Mermaid - it can be an entire frame. A parse error
  shows an in-frame card: fix the source, the frame heals live. Never hand-set
  colors or `%%{init}%%` themes - marver's palette is injected and source
  overrides are stripped.
- `Img` shows `design/assets/<src>` with an optional caption. Blocks carry
  their own padding, border, and surface - never hand-manage spacing around
  them.
- `intent` (`diagram` | `spec` | `moodboard` | `notes`) is the frame's PURPOSE,
  not its content mix - a frame with two diagrams and a paragraph is still the
  "diagram frame" if diagrams are why it exists. It drives the icon the human
  scans for in the sidebar.

## Choosing a diagram

Mermaid has real breadth: flowchart, sequence, state, class, user journey,
quadrant chart, git graph, gantt, timeline, mindmap, pie, sankey, and more.
Pick the visualization that fits the IDEA - a journey for experience thinking,
a quadrant for prioritization, a state diagram for lifecycle logic, a sequence
for API choreography. The syntax reference is the Mermaid docs:
https://mermaid.js.org/intro/ - pull the one page you need, apply, return.

## Images and mood boards

Images arrive through the conversation: the human dumps screenshots and links,
you file them into `design/assets/` (kebab-case names that say what the image
IS - `stripe-checkout-2col.png`, not `img4.png`) and compose the mood board -
`Row`s of `Img` blocks with captions, short `Md` notes between them. Nothing
is ingested without intent. Always give an `Img` a caption or alt.

Go get assets yourself too: when the human names an inspiration ("like Stripe's
checkout", "Linear's sidebar") and you have web access, FETCH the real thing -
screenshots, official brand logos, product visuals - download into
`design/assets/` and place them. A mood board of real fetched imagery beats one
of described imagery every time (the full asset rules: instructions/craft.md,
"Real assets").

## When Shape ends

The board holds the agreed flow, spec, and direction. Wireframe picks up from
there (the spec IS the brief - do not re-interview), then Brand, then Build.
The content frames stay on the board: the feature's documentation lives beside
its screens, and both publish together.
