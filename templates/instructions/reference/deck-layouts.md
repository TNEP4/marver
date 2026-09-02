# Deck layouts - the atlas, the grid, the budgets

Required reading at step 4 of every deck. The doctrine's recipe list is the core;
this is the full atlas grouped by the JOB a slide does, the composition grid every
recipe sits on, and the content budgets that keep type at design size. The atlas
is a vocabulary, not a fence: when nothing fits the concept you wrote for the
slide, compose it from divs.

Words used below: **kicker** = the small-caps `sl-caption` label above a title;
**hero** = a card's one-line headline in `sl-support`; **ghost numeral** = a large,
low-contrast number behind or beside a card that carries order; **display** =
`sl-display`, the one oversize role; **stat** = `sl-stat`, the row-of-figures size.

## The grid (the padded content box is 1104×632px)

Stage margins are asymmetric: 88px at the sides, 44px top and bottom, in px
at every viewport. Inside that box, three bands (the doctrine's 85% rule and
spacing scale govern what goes in them):

- **Title band** - the top ~113px: kicker (18px, one line) over the assertion
  (56px, one line), a hairline under. Same position on every content slide -
  the eye learns it once, and a travelling title morph lands where it left.
- **Body band** - full width, ~438px, starting 48px below the title block.
  Content fills at most ~372px of it. This band is the slide.
- **Foot** - the source line (25px), 48px under the body. A takeaway bar sits
  between them: 56px tall, 40px clear above it.
- **Split** - text left at 43% of the width, visual right at 48%, a 9% gutter.
  Argument reads first, proof confirms it. A `sl-assertion` in a 43% column
  holds ~20 characters a line - write to it.
- **Columns** - three equal at a 32px gap (~347px each); five narrow (~192px)
  for spectrums; a 2×2 when the four cells are peers. Card padding 32px.
- **Fill the canvas.** A half-width block needs a companion on the other half.
  An empty half is a defect unless the whitespace IS the point (a single anchor
  number, one quote) - then say so in the frame's comment.

The canonical skeleton, in the project's own Tailwind:

```tsx
<Slide>
  {/* one child at flex:1 claims the box, so the bands land in the same
      place on every slide; gap 48 is the title-to-body / body-to-foot step */}
  <div className="flex-1 min-h-0 flex flex-col gap-12">
    <header className="shrink-0">
      <p className="sl-caption uppercase tracking-[.14em]">Retention</p>
      <h1 className="sl-assertion mt-2">Churn halved after onboarding v2</h1>
      <hr className="mt-5 border-0 h-px bg-black/10" />
    </header>
    <div className="flex-1 min-h-0 grid grid-cols-[43fr_9fr_48fr] items-center gap-8">
      <div className="sl-body space-y-6">…argument…</div>
      <div />
      <Chart option={…} />
    </div>
    <footer className="sl-caption shrink-0">Source: product analytics, Aug 2026</footer>
  </div>
</Slide>
```

## The atlas (when · skeleton · budget · anchor)

A recipe without a named anchor morphs on the assertion (the doctrine's fallback).
Budgets are heuristics: the rendered 1280×720 frame and the Slide's overflow
outline are the authority - when they disagree with a number here, the frame
wins. And a slide that merely FITS is not done: the 85% rule is the bar.

**Parallel points**
- **cards** - 2-6 equal cards (kicker · hero · body), ghost numerals for order,
  at most ONE accented card for the emphasised option. Budget: 2-3 cards carry a
  body (≤120 chars, 3 lines); 4-6 cards are kicker + hero only. Anchor: the row.
- **spectrum** - 3-7 narrow cards for a progression or maturity model, low to
  high left to right. Budget: kicker ≤8 chars, hero ≤15, body ≤40 (≤5 cards) or
  none (6-7).
- **columns** - N headers + descriptions + an optional metric strip beneath:
  product lines, tracks, team areas. Budget: ≤4 columns with bodies, ≤6 without.
- **stacked list** - 4-6 items on the right panel, argument on the left; the
  numbered variant carries ghost numerals for ordered reasons. Budget: item ≤2
  lines at 24px. Anchor: the list.
- **split** - argument left (1-3 short paragraphs, optional `sl-support`
  sub-head), ONE visual right (metric, card, image, chart). The workhorse of
  analytical slides. Anchor: the visual.
- **insight + evidence** - one large insight left (≤30 words, `sl-support`),
  3-4 evidence items right (one-line title + one line). Anchor: the insight.

**Proof**
- **metric** - one hero number (`sl-display`) in a card with label + sub-line;
  pair with a split or a stat row. Budget: value ≤8 chars, label ≤20, sub ≤30.
- **stat row** - 3-4 figures across in `sl-stat` with a label under each.
  Budget: value ≤7 chars at 3 across, ≤5 at 4; label ≤4 words. Anchor: the row.
- **trajectory** - stacked from → to pairs with a label ("$100k → $480k MRR").
  Budget: 3-4 pairs. Anchor: the arrows.
- **table** - header row with a rule under it, zebra rows, numbers right-aligned,
  units in the header. Budget at 24px: ≤5 columns × ≤6 rows, header ≤15 chars,
  cell ≤14; more than that is two slides or a chart.
- **mini grid** - N×M small value + label cells with hairline dividers, for a
  dashboard glance. Budget: ≤12 cells (4×3).
- **takeaway bar** (modifier) - a full-width dark bar at the foot with the
  so-what, centred, no trailing full stop, ≤12 words. Never a paraphrase of the
  assertion - a different angle or nothing.

**Contrast**
- **before / after** - the doctrine's two-up, the "after" side accented.
- **scenarios** - bear / base / bull columns over a metric list, the recommended
  column highlighted. Budget: 3 scenarios × ≤5 metrics.

**Process** (the subject, never the provenance)
- **flow** - step cards with forward arrows; ≤5 steps keep bodies, 6+ drop to
  labels only. Budget: label ≤15 chars, body ≤40.
- **cycle** - 3-6 auto-numbered nodes around a centre; four nodes sit square at
  the corners, others on a circle. Budget: label ≤15, body ≤40. Anchor: the ring.
- **chain** - primary chevrons for the value chain with support bars beneath (the
  enabling activities). Budget: ≤6 chevrons, ≤3 bars.
- **swim lanes** - lanes (rows) × stages (columns) with mini-cards at the
  intersections: hand-offs, RACI, cross-functional flow. Budget: ≤4 lanes × ≤5
  columns, card ≤8 words.
- **funnel** - 3-8 narrowing tiers, the drop-off stated. Budget: label + one
  line ≤5 tiers; labels only at 6-8.

**Time**
- **schedule** - sections × time columns, task bars, milestone diamonds. Budget:
  ≤7 rows, ≤8 columns. Anchor: the time header.
- **timeline**, **roadmap phases** - the doctrine's; alternate event labels
  above and below the spine when they crowd.

**Structure and position**
- **layers** - full-width stacked layers with tag pills; the foundation layer
  dark. Budget: ≤5 layers, ≤4 tags each.
- **org** - boxes + connectors, two levels max; deeper goes to an appendix.
- **venn** - 2-3 circles with 2-3 items each and a named overlap.
- **concentric** - TAM / SAM / SOM rings, labels inside the rings, legend right.
- **pyramid** - 3-6 trapezoid tiers, widest at the top, each tier a label + 1-3
  items. For priority, never for volume (that is the funnel).
- **number line** - ticks with labels, one highlighted range: pricing tiers, a
  valuation range, benchmarks. Budget: ≤6 ticks.
- **capability matrix** - competitors × capabilities with empty / half / full
  circles (CSS), us in the first column. Budget: ≤6 × ≤7.

**Status**
- **scorecard** - rows with a red / amber / green dot + a one-line note. ≤7 rows.
- **heat map** - rows × columns of RAG cells, a legend, no numbers inside cells.
  Budget: ≤6 × ≤6.
- **tracker** - initiative · owner · phase · next milestone; or decision · owner ·
  date · status. Budget: ≤6 rows, owners as initials badges.

**People and voice**
- **testimonials** - 1-6 quote cards with an initials avatar, name, company -
  attributed voices (the doctrine's quote-wall is unattributed fragments, ≤15
  words). Budget: ≤25 words a quote at ≤4 cards, ≤15 at 5-6. Anchor: the avatars.
- **team** - 1-8 people: initials, name (≤15 chars), role (≤22). Budget: ≤4
  people carry a bio (≤30 words); 5-8 are name + role.
- **manifesto** - a single large claim in `sl-support` or `sl-display`, one
  accent-coloured phrase, an attribution line. Budget: ≤20 words. Anchor: the
  accent phrase.

**Images**
- **framed source** - a screenshot, a chart from a PDF, a product shot: the real
  image on the right, framing text on the left saying what it shows. The bitmap
  is at least 2× the CSS box it renders in. Never redraw a source chart as a
  fake: rebuild it as a `Chart` when the underlying data is available, embed the
  render when it is not.

## Budgets that keep type at design size

| Element | Cap |
|---|---|
| card kicker · hero · body | 20 · 30 · 120 chars (bodies only at ≤3 cards) |
| narrow (spectrum) card | 8 · 15 · 40 chars |
| metric value · label · sub | 8 · 20 · 30 chars |
| table header · cell | 15 · 14 chars, ≤5 × ≤6 |
| flow / cycle label · body | 15 · 40 chars |
| timeline date · title · body | 8 · 20 · 20 chars |
| quote | 30 words; testimonial 25 (≤4) / 15 (5-6); quote-wall 15 |
| bio | 30 words at ≤4 people; name 15 chars, role 22 |
| takeaway bar | 12 words, one line |
| body paragraphs | 3-5 short paragraphs, ~600 chars total |

A breach is a different recipe or a split. Type never shrinks to fit - the review
gate reads shrunk type as the tell it is.

## Rebuilding an existing deck

When the human hands you a finished deck to rebuild on the canvas, ask which
mode - and default to faithful:

- **Faithful** - their order, their words, exactly. You may normalise
  punctuation (em dashes → commas or periods) and number formats; you may not
  change a word. Label titles stay labels. Suggested rewrites go in a comment on
  the frame, never on the slide.
- **Editorial** (opt-in) - order kept, copy passed through the doctrine's words
  rules: jargon, hedges, filler out; numbers, names, dates verbatim; titles
  turned into assertions where the source supports the claim.

Then map shapes - a companion visual ONLY where the source supplies it; a
paragraph with no metric, image, or chart behind it is a text-led composition,
and that whitespace is honest:

| Source shape | Layout |
|---|---|
| a paragraph | split when the source has a companion (metric, image, chart); else text-led |
| 3 bullets | cards |
| 4-6 bullets | stacked list (numbered if ordered) |
| up to 4 numbers | metric grid or stat row |
| a quote | quote |
| a table | table (or two slides past the budget) |
| a chart with its data | `Chart` from the data |
| an image, chart, schedule, diagram you cannot rebuild losslessly | framed source |

## Charts and diagrams - the extra mile

- **Decision flows**: boil choices to yes / no, quantify the branches (%, volumes)
  so the eye follows the path that matters, hang customer quotes on the node
  they support.
- **Waterfalls** beat tables for build-ups and breakdowns: left to right in the
  logical order, the one or two bars that matter highlighted, a few callouts that
  pre-empt the room's questions.
- **When a slide must be complex**: large visual cues (boxes, highlights) on the
  point, grouping and colour that steer interpretation, and the voiceover ON the
  page - the slide must make sense with no presenter.
- **Aggregate.** The chart is not the model. Single series is fine. Overlay
  detail (lines, shading) on the base chart instead of adding a second chart.
- **Formatting**: label bars directly and drop the value axis when the chart is
  simple (keep the axis for dense or grouped series); growth rates visible; one
  label size across the deck; series in logical order (base first, growth
  next); same hue = same thing on every slide; charts aligned to the grid and to
  each other across slides.
