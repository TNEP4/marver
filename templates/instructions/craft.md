# Craft - the quality floor for high-fidelity frames

Binding rules for every hi-fi frame. Read them before Build, then apply them silently -
never announce a checklist. The brief and the settled brand (DESIGN.md) override
anything here; your own habits never do.

## When you are stuck, or the human is unhappy: the reference shelf

This file is the floor. Depth lives in instructions/reference/ - pull the ONE file
that owns the problem, when the problem appears:

| Symptom / task | Read |
|---|---|
| hierarchy unclear, spacing monotone, "layout feels off" | reference/layout.md |
| type roles blur, reading uncomfortable, scale arbitrary | reference/typography.md |
| palette aimless, contrast failing, dark mode wrong | reference/color.md |
| adding any animation, or motion feels cheap | reference/motion.md |
| labels/errors/empty-state text | reference/copy.md |
| human says "bland" / "too much" / "too busy" | reference/tune.md |
| loading/empty/error coverage, stress inputs, first-run | reference/states.md |
| dense app UI, dashboards, settings, tables | reference/operate.md |
| a personality moment, celebration, easter egg | reference/delight.md |
| brand-new surface or visual world (with brand.md) | reference/concepts.md |
| a full review pass was requested | reference/critique.md |
| output feels generic; sweeping for AI tells | reference/slop.md |

These rules target content surfaces (marketing, docs, product pages). Dense Operate
UI (dashboards, editors, admin) follows its platform's conventions where they
conflict - a data table is allowed to be tight, and DESIGN.md's decisions always win.

## Verify - checks against the RENDERED frame, never against intentions

- **Contrast**: body and placeholder text ≥ 4.5:1, large text ≥ 3:1. Secondary text
  on a colored surface takes its tint from that surface's hue - plain gray on color
  reads broken.
- **Spacing rhythm**: elements inside a group sit close; groups sit far apart; a
  heading holds more air above it than below. All gaps come from the spacing scale.
- **Type**: prose columns in the 45-75ch range (65-75 ideal for long-form); each level of hierarchy differs in BOTH size and
  weight; letter-spacing never tighter than -0.04em; headings get `text-wrap:
  balance`; render the real copy at every device width and fix whatever overflows.
- **Depth**: pick borders or shadows per element, never stack both on one card. A
  real shadow has offset and blur; an unblurred colored ring around an element is
  ornament pretending to be elevation.
- **States**: hover, focus-visible, disabled, loading, error, empty. A control
  missing its states is an illustration of a control.
- **Copy**: buttons say what they do ("Publish", not "Submit"); error text says what
  went wrong and how to recover; everything in the product's own vocabulary.
- **Browser-owned surfaces**: selection color, caret, focus rings, scrollbars, and
  the numerals in data tables (`font-variant-numeric: tabular-nums`) all default to
  browser styling that belongs to no brand. Claiming them is cheap and reads as care;
  skipping them is the fastest giveaway of unconsidered work.
- **Motion**: one deliberate, well-placed moment beats an effect on everything.
  Ease-out, starting from a visible state; never the identical fade-in stamped on
  each section; honor `prefers-reduced-motion`.

## Refuse - the defaults every unguided model reaches for

A brief can explicitly ask for any of these. Reaching for one unprompted means no
decision was made - rewrite the element rather than toning it down. This is the
short list; the COMPLETE catalog of generated-UI tells is reference/slop.md - sweep
it on review passes.

- Uniform icon+heading+paragraph card grids as the whole page structure; a card
  inside a card (no exceptions); the oversized-number-with-tiny-label stat hero.
- Little uppercase labels riding above every heading; numbered section markers
  (01/02/03) when the order carries no information.
- Gradient-filled text; blur/glass on elements that aren't overlaying anything;
  thick colored left-border stripes on cards and alerts; chunky offset block shadows
  in a design that isn't committed to that style throughout.
- Monospace to signal "technical" - mono earns its place only under code, data, or
  measurement.
- Emoji or unicode symbols as icons - icons come drawn, from the app's icon set, in
  one consistent stroke weight.
- Centering everything; the same border-radius on every element; pill shapes on
  large containers (pills belong to small controls).
- Choosing light or dark by product category reflex - the use scene decides, or
  DESIGN.md already did.

## Real assets - fetched, not faked

The difference between a frame that feels alive and one that feels generated is
usually the assets. Doing the work - finding, downloading, and wiring the real
thing - changes everything. This section is binding, not aspiration:

- **Icons come from a real icon system, Phosphor by default.** The app's existing
  icon library always wins (consistency beats preference); when the repo has none,
  install Phosphor (`@phosphor-icons/react` or the framework's equivalent) - that
  is the house default and good taste. One weight throughout a design. Never emoji,
  never unicode glyphs, never hand-drawn approximations of icons that exist.
- **Real brands get their real logos.** An integrations row, a payment-methods
  strip, a press bar, a testimonial card - fetch the ACTUAL marks (official brand
  or press pages first; Simple Icons for product marks), download them into the
  repo (the host's `public/` for app frames, `design/assets/` for content frames),
  SVG preferred, respectful of clear space, checked in both themes. A gray box
  labeled "Logo" is a defect, not a placeholder.
- **Imagery is real imagery.** When the design calls for photos or screenshots,
  fetch and commit them locally with names that say what they are - never
  hotlink (published canvases make zero external requests, and remote URLs rot).
- **Charts are real charts.** A dashboard, a report, an analytics screen gets
  `Chart` from `@marver-design/marver/content` - Apache ECharts behind a house
  theme that inherits the SCREEN's ink, typeface and accent (light and dark),
  renders SVG, sits still at rest and follows the layout on resize. Importing it
  does not make the screen a content frame: it keeps its device, its height and
  its place in the flow. Write the ECharts `option` with fixture data; never
  set colors, fonts or animation in it. Never a static chart image, never
  hand-drawn bars from divs when the real thing is one import away.
- **Video is a real video.** A hero loop, an onboarding clip, a story in a
  phone screen: `Video` from `@marver-design/marver/content` - poster-first
  (still on the canvas, no media fetched at rest), click-to-play wherever the
  frame is live, `ratio="9 / 16"` for vertical, `autoplay` for a muted ambient
  loop (an explicit choice: that frame stays live on the canvas). Local files
  need a poster; `design/assets/` holds both. Never a gray "video" box, never
  a static screenshot standing in for motion the design depends on.
- **Licensing sanity, briefly:** brand marks from official sources shown to
  identify the brand are fine; photos come from sources that permit the use.
  Unsure about one? Use it, and flag it to the human in the same message.

## Interactive means visibly interactive - true to life

The prototype is only believable if everything that would respond in the shipped
product responds here. This is binding at EVERY fidelity (the lo-fi version is in
instructions/wireframe.md); in play mode a hover-dead control reads as a broken
app, and the human attributes the fault to your frame, not to a library.

- **Every clickable target shows `cursor: pointer` and a visible hover state** -
  buttons, dropdown triggers AND the options inside them, tabs, toggles, rows and
  cards that navigate, icon buttons. If it responds to a click, it must respond to
  a hover first.
- **Component libraries do not guarantee this - audit them.** shadcn/ui on
  Tailwind v4 notably ships buttons with the browser's `cursor: default`, and
  menu/select items can lack a hover treatment depending on version. These are
  design-system deficiencies, not reasons the rule bends.
- **Fix gaps at the design-system level, never per-instance.** One base-layer rule
  (e.g. `@layer base { button:not(:disabled), [role="button"]:not(:disabled)
  { cursor: pointer } }` plus the library's own hover token on option items) beats
  a hundred scattered `cursor-pointer` classes - and fixes the app, not just the
  frame. When you find such a gap, patch the theme/base layer and tell the human
  what the library got wrong.
- **Sweep by hand once per design system:** render a frame, hover every KIND of
  control it uses, and watch for the dead ones. The check is against the rendered
  frame - a class in the source proves nothing about what the cascade delivered.

## Frame law

- Frames are made of the app's real components and tokens. Rebuilding a lookalike of
  an existing component inside a frame is a defect.
- Repeated and semantic values (colors, type sizes, radii, the spacing rhythm)
  resolve to tokens; a missing one is a proposal to raise with the human, not a
  literal quietly inlined. One-off layout geometry (a grid ratio, a max-width, an
  SVG coordinate) may stay local - the test is "would a second use want this value".
- Declare `meta.viewport` for the target width, then check the neighbors - the human
  WILL sweep devices with keys 1-5.
- Live fully inside the settled visual world. A direction executed at full commitment
  can be judged and improved; a hedged one can only be redone.
