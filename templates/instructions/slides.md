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

**4. Choose layouts.** For each slide, first write one sentence on what the
slide WANTS visually (concept before catalog), then scan the WHOLE recipe
list (below + the atlas in reference/deck-layouts.md + `design/slides.md`)
and pick against the content's real volume. A deck that keeps reaching for
the same two recipes is a defect. A recipe's budget breached = a different
recipe or a split - decided now, before markup. Slides that describe parts
of one concept (three pillars, four pipeline stages) share ONE layout -
variety comes between groups, never within one.

**5. Build.** Real markup inside `<Slide>`, the project's own classes and
components, the type roles, the theme's tokens. Name morph anchors as you
go (choreography, below). HTML stays honest: the assertion is the `h1`,
images carry `alt`, a chart or diagram gets a one-line text summary in a
caption, and every colour pair reads in both themes.

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
- Sources live in an `sl-caption` line at the foot of the slide: source,
  date, and the chart's data origin. Same position on every slide that
  cites.
- The closing slide is a specific, time-bound ask. "Questions?" is not a
  closing slide.

## The type and the space

The `<Slide>` root provides the roles - use them, never font-size by hand.
The values are fixed (one coordinate system with the stage):

| Role class | Size | Job |
|---|---|---|
| `sl-display` | 160px | the ONE oversize: a hero number, a section numeral, the manifesto line - never running text, at most once a deck |
| `sl-stat` | 88px | a ROW of figures (3-4 across), where `sl-display` would not fit |
| `sl-assertion` | 56px, heavy | the one-line claim (~40 characters full-width, ~20 inside a split - two lines is the ceiling, verify the render) |
| `sl-support` | 30px | the second voice |
| `sl-body` | 24px | evidence text - the floor for anything read |
| `sl-caption` | 18px | sources, footnotes, kickers |

Nothing smaller than 18px, ever. One family (`--marver-slide-font`, the
theme's); the roles carry their weights - add none of your own. One focal point per slide. Consecutive slides keep
shared elements in the SAME position unless the movement is the message.

## The space IS the design

This is what separates a deck that looks made from one that looks typed.
The stage is 1280×720 with ASYMMETRIC margins - 88px at the sides, 44px top
and bottom - so the title sits high, the footnote sits low, and the middle
is the tallest band on the slide. Content box: **1104×632px**, at every
viewport. (Override `--sl-pad-x` / `--sl-pad-y` in px, never a percentage:
a percentage resolves against the viewport, not the stage.)

The three bands, top to bottom, in the same place on every content slide:

| Band | Height | Holds |
|---|---|---|
| Title | ~113px | kicker (18px) over the assertion (56px), a hairline under |
| Body | **~438px** | the recipe - and it is the star, so give it the room |
| Foot | ~25px | the source line, or the takeaway bar above it |

**The 85% rule.** Body content fills at most ~85% of the body band (≈372 of
438px). The remaining sliver is not waste - it is the void that makes a
slide read as a slide. If your content fills the band, you have a document:
cut a sentence, drop a card, or split the slide. Never close the gap by
shrinking type.

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

- **One anchor visual per slide, at most.**
- **Charts** (`Chart`): pick the FORM from the Apache ECharts docs
  (https://echarts.apache.org/en/option.html) - marver injects the house
  theme (colors, type, tooltip) and strips yours, so pass DATA and
  STRUCTURE, never styling. One message per chart; the takeaway is the
  slide's assertion; direct labels over legends; bar baselines at zero
  (lines may zoom - annotate when they do); hue = category, shade = variant,
  fixed across the whole deck.
- **Diagrams** (`Diagram`) for structure, plain shapes + arrows for
  concepts - a 2×2 or a flow in divs beats imported artwork.
- **Images** (`Img`): full-bleed with a scrim and a short assertion, or
  generously matted. Never a small image floating in space.
- **Video** (`Video src poster`): the poster IS the slide at rest - choose
  it like a photograph. Local sources require a poster.
- **Backgrounds are code**: theme-derived gradients, an oversized numeral, a
  clipped photo, one geometric accent. ONE effect per slide, and decoration
  never touches the evidence's contrast.

## The recipes

Scan all of them (plus `design/slides.md`) for every slide. Each entry:
when · skeleton · budget (breach = split, never shrink) · morph anchor.

1. **cover** - deck title + one line + the mark. Budget: title ≤6 words.
   Anchor: the mark.
2. **section** - an oversized numeral/word divider in `sl-display`. Budget:
   ≤3 words. Anchor: none (hard cuts live here).
3. **assertion-evidence** - the workhorse: `sl-assertion` + ONE visual.
   Budget: assertion 1 line, caption 1 line. Anchor: the visual.
4. **big-number** - one `sl-display` stat + a context line. Budget: 1 stat.
   Anchor: the number.
5. **stat-row** - 3-4 quick proofs in a row. Budget: each ≤4 words + value.
6. **metric-grid** - a 2×2 of labeled values. Budget: 4 cells exactly.
7. **quote** - the words, the person, nothing else. Budget: ≤30 words.
8. **quote-wall** - 3-6 short quotes. Budget: each ≤15 words.
9. **two-up** - comparison / before-after. Budget: ≤4 rows per side.
10. **two-stage** - diagnosis → prescription with a connector. Budget: one
    sentence per stage.
11. **numbered-reasons** - 3-5 ordered points. Budget: each ≤12 words.
12. **bento** - 3-5 cells for a system view. Budget: cell = title + 1 line.
13. **timeline** - a horizontal spine, 3-6 beats. Budget: beat ≤5 words.
14. **roadmap-phases** - 2-4 phases with contents. Budget: ≤3 items/phase.
15. **matrix** - a 2×2 positioning. Budget: ≤6 plotted items.
16. **full-bleed** - image + scrim + assertion. Budget: assertion only.
17. **chart-focus** - one `Chart`, near full-slide. Anchor: the chart.
18. **wall** - logos/team grid. Budget: 6-12 cells, no captions.
19. **closing** - the ask, one CTA, contact. Budget: ask ≤2 lines.

These are the core. The atlas in reference/deck-layouts.md carries the rest
- split, cards, spectrum, insight + evidence, trajectory, table, scenarios,
flow, cycle, chain, swim lanes, funnel, schedule, layers, concentric,
pyramid, number line, capability matrix, scorecard, heat map, tracker,
testimonials, team, manifesto, framed source - each with its budget, plus
the composition grid they all sit on. Scan it for every slide.

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
- Every adjacent pair shares AT LEAST one stable named element - the anchor.
  (Each recipe names its default above; the assertion is the fallback.)
- A hard cut (zero shared names) is punctuation - section boundaries only.
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
rest (no loops, no autoplay) · recipe variety (the same composition twice
in a row only inside a declared visual group or a build sequence; more than
three in a row anywhere earns a breather slide) · one anchor morph per
adjacent pair.

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

Finally the contact sheet: all frames small on the canvas. One layout on
more than half the deck, dense slides clumped together, accent fills
bunched on neighbours, a card row where one card is 8 words and the others
40 - each a defect. Iterate until the gate passes; after three passes that
still surface defects, the remaining list goes to the human and the deck
ships at their call.
