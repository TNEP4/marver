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

```tsx
import { Slide } from '@marver-design/marver/content'
export const meta = { title: 'Cover', slide: true }
export default () => (
  <Slide>
    <h1 className="sl-assertion">Churn halved after onboarding v2</h1>
  </Slide>
)
```

## The pipeline (in order, no skipping)

**1. The answer.** Before any frame: write the deck's one-paragraph answer -
what the audience should believe or do when the last slide lands. If the
human's material is too thin for a substantive deck, SAY SO and ask - never
pad. Then the slide list: one line per slide, each line the slide's single
message as a full-sentence assertion.

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

**4. Choose layouts.** For each slide, scan the WHOLE recipe list (below +
`design/slides.md`) and pick against the content's real volume. A deck that
keeps reaching for the same two recipes is a defect. A recipe's budget
breached = a different recipe or a split - decided now, before markup.

**5. Build.** Real markup inside `<Slide>`, the project's own classes and
components, the type roles, the theme's tokens. Name morph anchors as you
go (choreography, below).

**6. The review gate.** Run it before presenting, every time (bottom of this
file).

## The words

- **Assertions, not labels.** "Q3 revenue beat plan by 12%" - never "Q3
  revenue". One line, it commits to a position.
- **Overflow is a second slide.** Never fix a full slide by shrinking type.
- Numbers over adjectives - every claim carries a figure, a name, or a date.
- Active voice. Write like you talk, then cut every word that isn't earning.
- Kill on sight: "leverage", "robust", "world-class", "streamline",
  "going forward", "potentially", "we believe", "it is important to note".
- Negatives in brackets: (123). Units once, in the header or axis - one
  unit, one time-basis per deck.
- The closing slide is a specific, time-bound ask. "Questions?" is not a
  closing slide.

## The type and the space

The `<Slide>` root provides the roles - use them, never font-size by hand:

| Role class | Size | Job |
|---|---|---|
| `sl-assertion` | 48-64px, heavy | the one-line claim |
| `sl-support` | 28-32px | the second voice |
| `sl-body` | 24px FLOOR | evidence text |
| `sl-caption` | 18px FLOOR | sources, footnotes |

Nothing smaller than 18px, ever. One family (the theme's), at most two
weights on any slide. Margins come from the root (≥7%); compose on a
12-column rhythm; one focal point per slide; generous space is the layout.
Consecutive slides keep shared elements in the SAME position unless the
movement is the message.

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
2. **section** - an oversized numeral/word divider. Budget: ≤3 words.
   Anchor: none (hard cuts live here).
3. **assertion-evidence** - the workhorse: `sl-assertion` + ONE visual.
   Budget: assertion 1 line, caption 1 line. Anchor: the visual.
4. **big-number** - one stat at 120-200px + a context line. Budget: 1 stat.
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
- Every slide shares ONE persistent element with its neighbor - the anchor.
  (Each recipe names its default above; the assertion is the fallback.)
- A hard cut (zero shared names) is punctuation - section boundaries only.
- ONE traveler per transition. Persist freely, travel once.
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
standard prototype toolbars + the progress strip), `minimal` (progress
strip + comments only), or `none`. Add `"lock": true` for a share that is
ONLY the deck.

## The living list - `design/slides.md`

The project's own recipes and rules; it OVERRIDES this file. When the human
asks you to study `design/slides-inspiration/` (PPTX, PDFs, screenshots),
propose additions to `design/slides.md` as a normal reviewed edit - each
with a gap justification (what no existing recipe serves) and a stress pass
(minimal / typical / worst-case content, both themes) before it earns its
entry.

## The review gate (run it, every deck, before presenting)

Twelve tells, each a defect: label titles · bullet walls · lines past ~15
words · data without a "so what" · process slides · hedge language ·
audience-mismatched jargon · filler words · passive voice · claims missing
numbers · formatting drift between slides · a weak closing.

Then: the sequence test (titles alone tell the argument) · BOTH themes ·
the 1280×720 view and one 390px glance · every slide still at rest (no
loops, no autoplay) · recipe variety (not the same two twice in a row) ·
one anchor morph per adjacent pair.
