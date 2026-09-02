# Slides - decks that argue, on frames that move

Run this when the work is a DECK: the human asks for slides, a presentation,
a pitch, a review - or a scene of `slide: true` frames exists. Read
`design/slides.md` too, ALWAYS: it is the project's own layout list and house
rules, and where it disagrees with this file, **the project file wins**.

A slide is an ordinary frame with `slide: true` in its meta - 1280×720, the
slide badge, and slides mode when published. Everything you know holds:
real components, the project theme, comments, variants, promotion. What
changes is the CRAFT BAR - a deck is an argument wearing the product's
clothes, and every rule below is binding.

**The stage fits every screen.** You author at exactly 1280×720 and the
Slide root scales and centers itself to any viewport - fill window, a
laptop, a viewer's phone. One coordinate system: your px, Tailwind classes,
and charts scale together, so what you compose is what plays. This is a
guarantee to LEAN ON, not to fight:
- lay out with flex/grid and the stage's own proportions (percentages,
  `--sl-margin`, the type roles) - never against the window;
- no viewport units (`vw/vh`) and no media queries inside a slide - the
  stage is the world, and it is always 1280×720 to your code;
- images and video posters at 2x the box they sit in, so an upscaled fill
  stage stays sharp.

```tsx
import { Slide } from '@marver-design/marver/content'
export const meta = { title: 'Cover', slide: true }
export default () => (
  <Slide>
    <h1 className="sl-assertion">Churn halved after onboarding v2</h1>
  </Slide>
)
```

This file is the floor. Depth lives in instructions/reference/:

| File | When |
|---|---|
| reference/deck-layouts.md | REQUIRED at step 4 of every deck - the full atlas, the grid, the budgets, charts; and BEFORE step 1 when rebuilding an existing deck (its mode decision comes first) |
| reference/deck-story.md | when intake is thin or rich, the room is senior, the slide list reads like a table of contents, or the words need work |

## The pipeline (in order, no skipping)

**1. The answer.** Before any frame: write the deck's one-paragraph answer -
what the audience should believe or do when the last slide lands. If the
human's material is too thin for a substantive deck, SAY SO and ask - never
pad. Then the slide list: one line per slide, each line the slide's single
message as a full-sentence assertion. Walk that list once more asking
"could I draft this slide without inventing a single fact?" - the gaps
become specific questions to the human, or a smaller deck (the evidence
check, reference/deck-story.md). The scaffold (step 2) may carry gaps as
visible placeholders; the build (step 5) may not - a factual gap blocks its
slide until answered or cut, while editorial copy (framing, captions) you
draft and label as proposed.

**2. Show the deck.** Scaffold every listed slide immediately as a
placeholder frame - `<Slide>` + its assertion in `sl-assertion` - in one
scene (one scene = one deck), numbered files (`01-cover.tsx`,
`02-problem.tsx`), pinned on the board, marked working
(`npx marver work start ...`). The outline now lives ON the canvas,
reorderable and vetoable while every slide is still one sentence. THEN
research, gather evidence, design.

**3. The sequence test.** Read only the assertions, in file order. They must
tell the complete argument - specifically enough that a stranger could guess
whose deck this is. Generic titles mean the thinking is not done; fix the
titles before touching layout.

**4. Storyboard the silhouettes.** Before any markup, one line per slide:

`message | dominant object | silhouette | density | recipe`

The dominant object first - what the eye lands on (a number, a quote, a
chart, the claim itself; for a grid the peer set as one shape, for a stream
the path) - then the silhouette that serves it (the seven, below), density (airy / balanced / dense), and only
then the recipe from the list below + the atlas in
reference/deck-layouts.md + `design/slides.md`, picked against the content's
real volume. Read the finished list as THUMBNAILS, not as recipe names.
Pacing, for any deck of eight or more content slides:
- no silhouette on more than 40% of the deck;
- no silhouette twice running, except inside a declared visual group
  (three pillars, four pipeline stages - those share ONE layout, variety
  comes between groups) or a build sequence;
- never three dense slides in a row;
- an airy statement, hero, or bookend at the opening answer, at every
  major turn of the argument, and at the close.
Do not alternate mechanically - pace follows the argument. A recipe's
budget breached = a different recipe or a split, decided here.

**5. Build.** Real markup inside `<Slide>`, the project's own classes and
components, the type roles, the theme's tokens. Name morph anchors as you
go (choreography, below). The assertion is always the `h1`, but it need not
sit at the top or be the largest thing: when the slide is about a number,
a quote, a chart, or a source, THAT dominates and the assertion frames it.
Never write one wrapper that fixes the title geometry for every slide -
share tokens, the source treatment, and primitives; give each silhouette
its own shell. HTML stays honest: images carry `alt`, a chart or diagram
gets a one-line text summary in a caption, every colour pair reads in both
themes.

**6. The review gate.** Run it before presenting, every time (bottom of this
file).

## The words

- **Assertions, not labels.** "Q3 revenue beat plan by 12%" - never "Q3
  revenue". One line, it commits to a position. (The one exception: a
  FAITHFUL rebuild of an existing deck keeps its titles as written -
  reference/deck-layouts.md.)
- **Overflow is a second slide.** Never fix a full slide by shrinking type.
- Numbers over adjectives - every FACTUAL claim carries a figure, a name, or
  a date; a conceptual assertion earns its place by being specific to this
  company, not generic.
- Active voice. Write like you talk, then cut every word that isn't earning.
- Kill on sight: "leverage", "robust", "world-class", "streamline",
  "going forward", "potentially", "we believe", "it is important to note".
- Negatives in brackets: (123). Units once, in the header or axis; within a
  metric family one unit and one time-basis ($M everywhere revenue appears,
  FY or CY - never both).
- Sources are a short `sl-caption` slug at the foot of the slide - "OpenAI
  technical report, §IV.B" - never a bibliographic sentence; that band
  repeated seventeen times is a report template. Full citations go in the
  frame's comment.
- The closing slide is a specific, time-bound ask. "Questions?" is not a
  closing slide.

## The type and the space

The `<Slide>` root provides the roles - use them, never font-size by hand.
The values are fixed (one coordinate system with the stage):

| Role class | Size | Job |
|---|---|---|
| `sl-display` | 160px | the oversize: a hero number, a section numeral, the manifesto line - never running text; at most once per argument group, never on adjacent slides |
| `sl-stat` | 88px | a ROW of figures (3-4 across), where `sl-display` would not fit |
| `sl-assertion` | 56px, heavy | the one-line claim (~40 characters full-width, ~20 inside a split - two lines is the ceiling, verify the render) |
| `sl-support` | 30px | the second voice |
| `sl-body` | 24px | evidence text - the floor for anything read |
| `sl-caption` | 18px | sources, footnotes, kickers |

Nothing smaller than 18px, ever. One family (`--marver-slide-font`, the
theme's); the roles carry their weights - add none of your own. One
reading intent per slide - a single object, a peer set, or a path, never two
competing. Within a visual group, shared elements keep the SAME
position unless the movement is the message.

## Silhouette - the deck at thumbnail size

A silhouette is the largest geometry the eye sees when the words are
blurred. Swapping a card row for a stat row under the same standing header
changes nothing at thumbnail size, and the review gate looks at thumbnails.
Choose the silhouette before the recipe. Seven:

- **statement** - one claim owns the canvas. No kicker, no header, at most
  one short support line. The opening answer, a turn, a synthesis.
- **hero** - one number, quote, image, or source object owns 60-80% of the
  canvas; the assertion frames it, smaller, and does not compete.
- **split** - two UNEQUAL fields, 40/60 or 60/40: one argues, one proves.
- **grid** - 2-6 true peers in one field. Equal weight only when the ideas
  are equal - a 2×2 of causes makes them look like feature cards.
- **stream** - a path across the canvas: time, sequence, causality,
  escalation, hand-off. The path IS the geometry, not a ruled list.
- **field** - one chart, table, diagram, or document fragment fills the
  slide; the assertion sits at an edge or inside the field.
- **bookend** - cover, section turn, closing: a statement or hero that
  ALSO carries the mark and drops the source line, so it reads as a door,
  not a page. Count it as its own silhouette only when that geometry is
  visibly different from the statements around it.

The kicker + assertion + hairline over a body is ONE way to build a grid or
split - it is not the default shell for content slides, and shared margins
never require shared title geometry. Whitespace needs no defence when it
establishes dominance; an added companion panel does. Alignment before
enclosure: if spacing and a hairline establish the group, remove the box -
cards, panels, and badges are interface furniture, and a deck of them reads
as a dashboard.

## The space IS the design

This is what separates a deck that looks made from one that looks typed.
The stage is 1280×720 with ASYMMETRIC margins - 88px at the sides, 44px top
and bottom - so the title sits high, the footnote sits low, and the middle
is the tallest band on the slide. Content box: **1104×632px**, at every
viewport. (Override `--marver-slide-pad-x` / `--marver-slide-pad-y` in px,
never a percentage: a percentage resolves against the viewport, not the
stage.)

When a slide carries a title band (grids and splits usually do; statements,
heroes, and fields usually do not), the three bands are:

| Band | Height | Holds |
|---|---|---|
| Title | ~113px | kicker (18px) over the assertion (56px), a hairline under |
| Body | **~438px** | the recipe - and it is the star, so give it the room |
| Foot | ~25px | the source slug, or the takeaway bar above it |

**The 85% rule.** Content fills at most ~85% of whatever band it lives in
(≈372 of a 438px body). The remaining sliver is not waste - it is the void
that makes a slide read as a slide. If your content fills the band, you
have a document: cut a sentence, drop a card, or split the slide. Never
close the gap by shrinking type.

**One spacing scale**, in px, every value from it and nothing between:

| Step | Use |
|---|---|
| 8 | label to its value, icon to its text |
| 16 | rows inside one list, line to hairline |
| 24 | siblings inside a card or a group |
| 32 | padding inside a card; between columns |
| 40 | between distinct groups in the body |
| 48 | title block to body, body to the foot |

Rhythm comes from CONTRAST between those steps - tight inside a group, wide
between groups. One value repeated everywhere is the flattest thing you can
do to a slide. Gaps go on the parent (`gap`), never as per-child margins.

## The evidence

- **One anchor visual per slide, at most** - a peer set or a path counts as
  one.
- **Charts** (`Chart`): pick the FORM from the Apache ECharts docs
  (https://echarts.apache.org/en/option.html), inside the supported surface
  - series bar, line, pie, scatter, radar, gauge, heatmap, funnel, treemap, sunburst, sankey, boxplot; components grid, polar, radar, tooltip, legend, title, dataset (+ transform), markLine, markPoint, markArea, visualMap, dataZoom; anything else is dropped without an
  error. marver supplies the house theme (colors, type, tooltip); styling
  you pass overrides it, so pass DATA and STRUCTURE, never styling. One message per chart; the takeaway is the
  slide's assertion; direct labels over legends; bar baselines at zero
  (lines may zoom - annotate when they do); hue = category, shade = variant,
  fixed across the whole deck.
- **Diagrams** (`Diagram`) for structure, plain shapes + arrows for
  concepts - a 2×2 or a flow in divs beats imported artwork.
- **Images** (`Img`): full-bleed with a scrim and a short assertion, or
  generously matted. Never a small image floating in space.
- **Video** (`Video src poster`): the poster IS the slide at rest - choose
  it like a photograph. Local sources require a poster. In slides mode the
  player mounts on its own; everywhere else a frame is live, the poster is
  the play button (the same primitive serves screens and specs).
- **Backgrounds are code**: theme-derived gradients, an oversized numeral, a
  clipped photo, one geometric accent. ONE effect per slide, and decoration
  never touches the evidence's contrast.

## The recipes

Scan all of them (plus `design/slides.md`) for every slide. Each entry:
silhouette · skeleton · budget (breach = split, never shrink) · anchor (the
element that morphs INSIDE a group or build; "none" = a hard cut).

1. **cover** (bookend) - deck title + one line + the mark. Budget: title ≤6
   words. Anchor: the mark.
2. **section** (bookend) - an oversized numeral/word divider in
   `sl-display`. Budget: ≤3 words. Anchor: none.
3. **assertion-evidence** (split or field) - the workhorse: `sl-assertion`
   + ONE visual. Budget: assertion 1 line, caption 1 line. Anchor: the
   visual.
4. **big-number** (hero) - one `sl-display` stat + a context line. Budget:
   1 stat. Anchor: the number.
5. **stat-row** (grid) - 3-4 quick proofs in a row. Budget: each ≤4 words +
   value. Anchor: the row.
6. **metric-grid** (grid) - a 2×2 of labeled values. Budget: 4 cells
   exactly. Anchor: the grid.
7. **quote** (hero) - the words, the person, nothing else. Budget: ≤30
   words. Anchor: none.
8. **quote-wall** (grid) - 3-6 short quotes. Budget: each ≤15 words.
   Anchor: the wall.
9. **two-up** (split) - comparison / before-after. Budget: ≤4 rows per
   side. Anchor: the divider.
10. **two-stage** (stream) - diagnosis → prescription with a connector.
    Budget: one sentence per stage. Anchor: the connector.
11. **numbered-reasons** (grid) - 3-5 ordered points. Budget: each ≤12
    words. Anchor: the numerals.
12. **bento** (grid) - 3-5 cells for a system view. Budget: cell = title +
    1 line. Anchor: the largest cell.
13. **timeline** (stream) - a horizontal spine, 3-6 beats. Budget: beat ≤5
    words. Anchor: the spine.
14. **roadmap-phases** (stream) - 2-4 phases with contents. Budget: ≤3
    items/phase. Anchor: the phase heads.
15. **matrix** (field) - a 2×2 positioning. Budget: ≤6 plotted items.
    Anchor: the axes.
16. **full-bleed** (hero) - image + scrim + assertion. Budget: assertion
    only. Anchor: the image.
17. **chart-focus** (field) - one `Chart`, near full-slide. Anchor: the
    chart.
18. **wall** (grid) - logos/team grid. Budget: 6-12 cells, no captions.
    Anchor: the grid.
19. **closing** (bookend) - the ask, one CTA, contact. Budget: ask ≤2
    lines. Anchor: none.

These are the core. The atlas in reference/deck-layouts.md carries the rest
- split, cards, spectrum, insight + evidence, trajectory, table, scenarios,
flow, cycle, chain, swim lanes, funnel, schedule, layers, concentric,
pyramid, number line, capability matrix, scorecard, heat map, tracker,
testimonials, team, manifesto, framed source - each with its budget, plus
the shared stage, margins, and the optional banded grid they draw from. Scan it for every slide.

## Choreography - the diff IS the animation

You never animate. You name elements consistently, and slides mode
interpolates the difference between adjacent stills. The board is the
timeline: design motion by designing the diff.

**Five verbs** via `view-transition-name` (style prop or class):

| Verb | How | Reads as |
|---|---|---|
| persist | same name, same box | continuity - the anchor |
| travel | same name, new position | "follow this" |
| grow | same name, new size | "this is now the point" |
| swap | unmatched content | the default crossfade |
| reveal | new element + `data-animate` | "and then" |

**Binding rules:**
- Adjacent slides inside a visual group or a build share AT LEAST one stable
  named element - the anchor (each recipe names its default above). Across
  a turn of the argument, or into and out of a statement, hero, or bookend,
  a HARD CUT (zero shared names) is the right punctuation - use it. Never
  name the assertion `headline` on every slide as a deck-wide fallback: a
  title that morphs into the next title on seventeen slides is the
  strongest possible signal that every slide has the same shape.
- AT MOST one element changes position or size per transition. Persist
  freely, travel once.
- Build steps are sibling frames (`03a-`, `03b-`) sharing morph names -
  progressive disclosure that stays visible and commentable. Variants are
  for exploration, siblings for builds - never both on one slide.
- Entrances: `data-animate="fade-up | fade | scale-in"` +
  `data-animate-delay="0|1|2|3"`. Never on an element that carries a morph
  name. Runs once, after the transition settles - trust it, don't stack it.
- Morphs tween bounds and crossfade pixels - a chart "morph" is the picture
  growing, not bars re-plotting. Design for that honestly.
- One tempo per deck (the root's token). Motion never varies per slide.
- NOTHING loops, scrolls, or free-runs. A resting slide is still - that is
  what keeps a 40-slide canvas fast, and the review gate checks it.

## Publishing a deck

The board is the deck: reading order (top-left to bottom-right) is play
order - rearrange the board to reorder the deck. Publish with:

```json
{ "boards": { "pitch": { "max": "comment", "type": "slides",
  "open": "slides", "transition": "fade" } } }
```

`transition`: `fade` (default) or `none`. `chrome`: `full` (default - the
standard prototype toolbar and walker), `minimal` (a progress strip +
comments only), or `none`. Add `"lock": true` for a share that is ONLY the
deck.

## The living list - `design/slides.md`

The project's own recipes and rules; it OVERRIDES this file. Its first
section, **the deck look**, is a fill-in template (tokens, type, the mark,
colour meaning, imagery, tempo, numbers, voice, terminology, end card): on
the FIRST deck in a project, draft it from `design/DESIGN.md` and
`theme.css` as a reviewed edit, tell the human, and build on with the
theme's tokens meanwhile - fields you cannot settle stay `TBD`, never
invented. No DESIGN.md yet means the brand doc comes first
(instructions/brand.md). When the human
asks you to study `design/slides-inspiration/` (PPTX, PDFs, screenshots),
propose additions to `design/slides.md` as a normal reviewed edit - each
with a gap justification (what no existing recipe serves) and a stress pass
(minimal / typical / worst-case content, both themes) before it earns its
entry.

## The review gate (run it, every deck, before presenting)

Twelve tells, each a defect: label titles · bullet walls · lines past ~15
words · data without a "so what" · provenance slides (how the work was
done - a process that IS the subject, an operating model or a rollout plan,
is content) · hedge language ·
audience-mismatched jargon · filler words · passive voice · claims missing
numbers · formatting drift between slides · a weak closing.

Then: the sequence test (titles alone tell the argument) · BOTH themes ·
the slide view AND fill window (the fit scales your composition - check
nothing relied on the window) and one 390px glance · every slide still at
rest (no loops, no autoplay) · the silhouette pacing from step 4, checked
against the storyboard, not the recipe names · anchors inside groups, hard
cuts at the turns.

Then the two reads that catch what polish hides:
- **Landing, per slide.** Read each slide cold - no presenter, no
  neighbours. Does it deliver the one message you planned for it? Landed ·
  partial (present but buried or hedged) · missed. A missed message on a
  polished slide is still a must-fix.
- **The cold read, whole deck.** Read every assertion and every takeaway
  bar in sequence, nothing else. Do they alone deliver the one thing the
  human said the audience must leave with? If not, no surface edit fixes it
  - take the gap to the human as a narrative question, do not polish
  around it.

Finally the contact sheet: all frames small on the canvas, then squint. If
the deck blurs into one repeated shape with different fillings, it failed -
whatever the recipe names say. One silhouette on more than 40% of the
content slides (decks of eight or more), the same top and bottom horizon on
every slide, dense slides clumped
together, accent fills bunched on neighbours, a card row where one card is
8 words and the others 40 - each a defect. Iterate until the gate passes; after three passes that
still surface defects, the remaining list goes to the human and the deck
ships at their call.
