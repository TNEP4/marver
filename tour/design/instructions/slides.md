<!-- marver:managed 6c1bdf745a4b1afa5e7c61f89cc8866f7a27c4470a4f40bab3123559d88203a7 - edit freely: init preserves your edits and stages upstream updates at design/.local/latest/ for you to merge. Delete this line to detach this file from updates entirely. -->
# Slides - decks in code

Run this when the work is a DECK: the human asks for slides, a presentation,
a pitch, a review - or a scene of `slide: true` frames exists. Read
`design/slides.md` too, always: it holds this project's deck look and house
habits, and where it disagrees with this file, **the project file wins**.

A slide is an ordinary frame with `slide: true` in its meta. That is the
whole contract. What goes inside is your code - any layout, any typeface,
any image, any drawing, any animation the browser can render. This file is
not a rulebook. It is the craft of decks that look made rather than typed,
the method that gets the argument right before the pixels, and the few
mechanics of how a slide plays. Take what serves the deck in front of you.

| File | When |
|---|---|
| reference/deck-story.md | intake is thin or rich, the room is senior, the slide list reads like a table of contents, or the words need work |
| reference/deck-layouts.md | a slide needs a composition and none comes - an idea bank, plus rebuilding an existing deck and chart craft |
| craft.md + its references | a slide's type, colour, layout or motion feels off - reference/typography.md, color.md, motion.md and slop.md hold for slides as for screens |

## What a slide is

```tsx
export const meta = { title: 'Onboarding time halved in one quarter', slide: true }

export default function Frame() {
  return (
    <main className="dk-page dk-ink dk-statement">
      <h1>Onboarding time<br />halved in one quarter.</h1>
    </main>
  )
}
```

- **The stage.** A slide renders at its stage size: 1280×720 by default.
  Declare a `viewport` (any name in `design/config.ts`, e.g. `'laptop'` for
  1280×800) for another shape, and keep one stage per deck. Compose in px
  at that size: let your root fill the stage (`min-height: 100vh`) and place
  things where you want them.
- **The host scales, not you.** A slide never reflows: slides mode renders
  the stage and scales the whole of it to the screen - up on a projector,
  down on a laptop or a phone - and a resized canvas node shows it the same
  way, smaller. The document IS the stage, so no breakpoints are needed and
  viewport units are stage units (`100vh` is the stage's height).
- **On the canvas** a slide is a frame like any other: comments, laser,
  variants, Live Jam, plus the slide badge. The board's reading order (top to
  bottom, left to right) is the play order - drag slides to reorder the deck.
- **Notes.** `<slide>.note.md` beside the frame is its sticky note - the
  presenter's script and the next agent's memory (the method, below).
- `<Slide>` from `@marver-design/marver/content` is an optional wrapper that
  fills the frame; earlier decks use it. Nothing requires it.

## Motion

Code means the motion is yours: CSS keyframes and transitions, SVG
animation, a JS library the project already uses. Three habits make it play
well:

- **At rest, the finished slide.** On the canvas, in `marver shot`, in a
  thumbnail, the slide shows its final composition. Animate while the deck
  plays: the stage puts `data-sl-play` on `<html>` for the whole show and adds
  `data-sl-entered` once each slide has arrived. Key motion off them:

  ```css
  :root[data-sl-entered] .dk-loop path { animation: dk-draw 900ms ease-out both }
  @keyframes dk-draw { from { stroke-dashoffset: 600 } to { stroke-dashoffset: 0 } }
  @media (prefers-reduced-motion: reduce) {
    :root[data-sl-entered] .dk-loop path { animation: none }
  }
  ```

  In React, `useSlidePlay()` from `/content` says the deck is playing (it
  stays true for the whole show); to start something when THIS slide
  arrives, watch `data-sl-entered` on `<html>` - the stage removes it at
  each swap and sets it again once the new slide has settled.
- **Between slides, morphs.** Give an element the same
  `view-transition-name` on two adjacent slides and it travels or resizes
  between them; the rest crossfades. A persistent element (the mark, a
  diagram that grows) reads as continuity; a hard cut (no shared names)
  reads as a new chapter. One duration for the deck: `--marver-slide-tempo`
  in the theme (default 350ms).
- **Builds.** Progressive disclosure is sibling frames (`04a-`, `04b-`)
  sharing morph names, so every step stays visible and commentable.

Shortcuts, if they help: `data-animate="fade-up | fade | scale-in"` plus
`data-animate-delay="1 | 2 | 3"` run once after a slide arrives (never on an
element that also morphs - one owner per transform).

## The deck kit - build it once per deck

A strong deck is not twenty bespoke pages; it is one small system applied
with variety. Before the slides, write the kit into the scene - `_parts.tsx`
and `_style.css`, the leading underscore keeps them off the canvas:

- **The master** - a shell every content slide wears: the mark, a context
  line (who it is prepared for, the date, "confidential"), the body area.
  Covers and closings step outside it.
- **Tones** - two to four whole-slide colour sets as CSS variables (paper,
  ink, one accent ground), swapped by a class. A tone change is a pacing tool.
- **Type** - the brand's family, weights and tracking, and a handful of
  sizes: a display, a heading, a body, a small label. Hierarchy through size
  and a muted colour, rarely through weight.
- **Rules and labels** - the hairline, the numbered label, the spacing rhythm.
- **The drawing helper** - one component that renders the deck's
  illustrations by name, with their alt text.

```tsx
// design/scenes/<deck>/_parts.tsx
import type { ReactNode } from 'react'
import './_style.css'

export function Page({ tone = 'paper', className = '', children }: {
  tone?: 'paper' | 'ink' | 'accent'; className?: string; children: ReactNode
}) {
  return (
    <main className={`dk-page dk-${tone} ${className}`}>
      <header className="dk-header"><Mark /><span>Prepared for Acme · Confidential · May 2026</span></header>
      <div className="dk-body">{children}</div>
    </main>
  )
}
```

```css
/* _style.css - tones are variable swaps, so every rule reads the same names */
.dk-page  { --ground: #f1f0ea; --ink: #151616; --muted: #63645f; --line: #cacac2;
            min-height: 100vh; padding: 0 48px; background: var(--ground); color: var(--ink);
            font: 400 20px/1.4 var(--brand-font); letter-spacing: -.015em }
.dk-ink   { --ground: #151616; --ink: #f1f0ea; --muted: #b5b7ad; --line: #474a44 }
.dk-page h1 { font-weight: 400; font-size: 64px; line-height: 1.05; letter-spacing: -.045em; margin: 0 }
```

Derive every value from `design/DESIGN.md` and `theme.css`, and use the
project's real mark component. If the brand is not written down yet, that
comes first (instructions/brand.md): a deck look invented on slide one has
drifted by slide five.

## The craft - what makes a deck look made

The habits that carry the most, distilled from the best decks built on
marver:

1. **The brand, not a deck style.** The identity's own typeface, weights,
   colours and imagery. Large type at regular weight with tight tracking
   looks designed; bold everywhere looks generated.
2. **One idea per slide.** The headline is the message, written as a
   sentence. Under it, at most a short line and a few supporting items. The
   nuance, the caveats and the talk track go in the note.
3. **Structure with space and hairlines, not boxes.** Group by alignment and
   gaps, separate with 1px rules, order with small numbered labels in the
   muted colour. A card, a shadow or a badge is for the rare element that is
   genuinely a separate object.
4. **Real images, used big.** The client's or the product's own photography,
   full-bleed or bleeding off one edge, under a uniform scrim where text sits
   on it. Never a small picture floating in space; never stock that could
   belong to anyone.
5. **A drawing system of your own.** When an idea needs a picture, draw it as
   native SVG in one style: consistent line weights, a shared grid, mostly
   ink, ONE accent per slide marking the point (the approval, the bottleneck,
   the result). Light and dark versions where tones change. Colour that means
   something (red for the rework loop, green for the outcome) is introduced
   on purpose and kept consistent.
6. **Diagrams built for the argument.** A process with its failure loop drawn
   back across it, a context and a solution in two illustrated lanes, three
   numbers in a row - composed in HTML and SVG for this message, not picked
   from a menu.
7. **Pace the deck.** A sparse statement after the cover; working slides on
   the light ground; a dark slide at a turn of the argument; the accent ground
   once, for the proof. Dense slides alternate with quiet ones.
8. **Bookends are doors.** The cover pairs the marks (yours and the
   audience's) with one strong image and no header. The closing is a quiet
   card - the mark, a contact, a photograph - with the ask on the slide before.
9. **Honest numbers.** Evidence is big and specific; its limits sit on the
   slide in small type when they matter ("results from a reference project,
   not a forecast").
10. **Finish the details.** Control the line breaks in headlines, balance the
    gaps, align each drawing with the text beside it, check every tone. The
    distance between good and very good is twenty small passes - and a frozen
    copy of the deck before each big change, so nothing approved is lost.

Variety comes from the message: choose each slide's composition for what it
has to show, and let the kit hold the deck together.
reference/deck-layouts.md is a bank of compositions to borrow from when you
are stuck.

## The method

1. **The answer.** Before any frame: one paragraph - what the audience should
   believe or do when the last slide lands. If the material is too thin for a
   substantive deck, say so and ask; never pad.
2. **The slide list.** One line per slide, each its message as a sentence.
   Read the lines alone: they should tell the whole argument, specifically
   enough that a stranger could guess whose deck it is. Could you draft each
   slide without inventing a fact? The gaps become questions for the human.
3. **The brief.** Write `_brief.md` in the scene: the answer, the sequence as
   a storyboard (`message | what the eye lands on | composition | density`),
   the visual system (kit, tones, imagery, drawings) and the sources. It keeps
   a long iteration coherent.
4. **Scaffold, then build.** Put every slide on the board early - a frame
   holding just its sentence, in one scene, numbered files (`01-cover.tsx`) -
   so the outline is reorderable and vetoable on the canvas. Mark the work
   (`npx marver work start ...`). Then build the kit, then the slides.
5. **Notes as you go.** Each slide's `.note.md`, in four short parts:

   ```md
   ## Aim
   What this slide must do in the argument.

   ## Say
   The talk track, in the presenter's voice.

   ## Visual
   Why it looks the way it does - what the image or drawing carries.

   ## Source context
   Where the facts come from, and their limits.
   ```

   Notes ship with a published canvas: keep anything the audience must not
   read out of them.
6. **Review**, below - then iterate.

## Words

- Headlines that say something: "Every new market adds a week of manual
  reconciliation", not "Reporting challenges". A label suits a door (a
  section, an agenda, "How we work with your team") - not an argument.
- Numbers, names and dates over adjectives; units once.
- Active voice. Cut every word that is not earning its place. Kill on sight:
  "leverage", "robust", "world-class", "streamline", "seamless", "unlock",
  "going forward", "we believe", "it is important to note".
- Sources as a short line on the slide; the full citation in the note.
- When a slide is full, split it or move the detail to the note - shrinking
  the type to fit is the slide telling you it holds two ideas.

## Evidence

- **Chart** (`/content`): an Apache ECharts option on a fixed surface -
  series bar, line, pie, scatter, radar, gauge, heatmap, funnel, treemap,
  sunburst, sankey, boxplot; components grid, polar, radar, tooltip, legend,
  title, dataset (+ transform), markLine, markPoint, markArea, visualMap,
  dataZoom (anything else is dropped without an error). It inherits the
  slide's ink and typeface and reads `--marver-slide-accent`; pass data and
  structure, and style only what the deck needs. One message per chart,
  direct labels, bars from zero. When the form is simple and the brand
  matters more, draw the chart yourself in SVG.
- **Images**: `Img` for a framed asset from `design/assets/`, or a plain
  `<img>` / CSS background when the slide needs full control (`object-fit`,
  `object-position`, a scrim). Use files at least 2x the size they show -
  the player scales slides up.
- **Video** (`Video src poster`): the poster is the slide at rest; in slides
  mode the player mounts on its own. Omit `poster` and marver renders one
  from the clip.
- **Diagram** (Mermaid) for quick structure; hand-built SVG and HTML when the
  diagram IS the slide.

## Review - before you present

- **The contact sheet.** `npx marver shot --scene <deck>`, then look at every
  slide small, side by side. Does it read as one deck with range, or one
  shape repeated with different words? Squint: where does the eye land on each?
- **Play it.** Slides mode, start to end, in a big window and a small one:
  nothing clipped or spilling past the stage, every tone legible, motion
  finished at rest.
- **The cold read.** The headlines alone, in order: do they deliver the
  answer? Each slide alone, without a presenter: does it land its one
  message? A miss is a narrative question for the human, not a polish job.
- **The generated tells.** Heavy weights everywhere, five type sizes on one
  slide, a card around everything, a tiny uppercase kicker over every
  headline, filler numbers, the same composition three slides running with no
  reason. Delete before you add.

## Publishing a deck

The board is the deck. Publish with:

```json
{ "boards": { "pitch": { "max": "comment", "type": "slides",
  "open": "slides", "transition": "fade" } } }
```

`transition`: `fade` (default) or `none`. `chrome`: `full` (default - the
standard prototype toolbar and walker), `minimal` (a progress strip +
comments) or `none`. Add `"lock": true` for a share that is ONLY the deck.

## design/slides.md - this project's deck look

The project's own file: the deck look (master, tones, type, mark, imagery,
drawing style, colour meaning, motion, numbers, voice, end card) and any
compositions and habits the team wants repeated. On the first deck in a
project, draft its deck look from `design/DESIGN.md` and `theme.css` as a
reviewed edit and tell the human; it then outlives every deck. When the
human asks you to study `design/slides-inspiration/` (PPTX, PDFs,
screenshots), propose additions to it the same way.
