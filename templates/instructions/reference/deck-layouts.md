# Deck layouts - an idea bank

Compositions to borrow when a slide needs a shape and none comes. Nothing
here is required and nothing has a size: the stage, the brand and the
message decide. When no idea fits what the slide has to say, compose your
own - that is what code is for.

## Seeing a deck as silhouettes

A silhouette is the largest geometry the eye sees when the words blur. It is
the quickest way to check a deck has range:

- **statement** - one sentence owns the stage.
- **hero** - one number, quote, image or object owns most of it; the
  headline frames it.
- **split** - two unequal fields: one argues, one proves.
- **grid** - a few true peers side by side.
- **stream** - a path across the stage: time, sequence, cause, hand-off.
- **field** - one chart, table, diagram or document fills the slide.
- **bookend** - cover, section turn, closing: a door, not a page.

A deck that reads as one silhouette with different words underneath looks
templated. Vary by what each message needs, not by a quota.

## Patterns from a strong consulting deck

Thirteen slides for a finance pitch: a regular-weight sans at large sizes,
paper / ink / one blue as whole-slide tones, the client's own photography,
and a line-drawing system on a dotted grid. A shared master (the firm's
mark, "prepared for … · confidential · date") sits on every content slide.
The compositions, generically:

1. **Paired cover** - ink ground, no master. Left half: the firm's mark ×
   the client's mark, centred. Right half: one black-and-white photograph to
   the edges.
2. **Statement on ink** - the master, then one sentence at display size,
   left-aligned, low on the stage. Nothing else. The opening answer.
3. **Problem split** - left: a three-line headline, one muted paragraph, and
   a wide line drawing under it. Right: three numbered failure modes, each a
   hairline, a small number, a short title and one muted line.
4. **Process with its loop** - four numbered stages along a ruled line with
   small arrowheads; under them an SVG route drawn back from a later stage to
   an earlier one, in the deck's one "problem" colour, captioned in the loop.
5. **Half-bleed opportunity** - copy on the left (headline, a line, two
   ruled benefits); a photograph bleeding off the right edge behind the
   master, under a uniform dark scrim.
6. **Illustrated mechanism** - headline and intro, then three columns: a
   drawing on the shared grid, a hairline, a numbered step title, one line.
   The accent appears in only one drawing - the step that matters most.
7. **Principles on ink** - headline on the left; four ruled rows on the
   right, each a small square drawing, a title and one line.
8. **Two lanes** - a small badge naming the case, the headline, then a
   "context" row and a "solution" row, each copy on the left and a three-step
   drawn flow on the right.
9. **Evidence on the accent ground** - the headline states the result; three
   figures at display size with a short title and a line each; the source's
   limits in small type at the foot.
10. **Stage columns** - three numbered columns (analyse / build / operate),
    each a title, a question and its measures, separated by hairlines.
11. **Invitation** - a large headline and one drawing on the left; a muted
    kicker and three ruled sections (who to invite, what to share, what you
    get) on the right.
12. **Photo end card** - a full-bleed photograph under a scrim, the mark
    top left, the contact bottom left. No ask - that was the slide before.

What makes them work together: one master, one type voice, hairlines
instead of boxes, an accent that appears once per slide, imagery that could
only belong to this client - and each composition chosen for its message.

## The atlas, by job

A wider vocabulary. Each is a starting point - change it until it fits.

**Parallel points**
- **cards** - a few equal items (label · title · line); one may be accented
  as the recommended option.
- **spectrum** - narrow items low to high, left to right: maturity, a scale.
- **columns** - parallel headers with descriptions, an optional strip of
  figures beneath.
- **stacked list** - the argument on the left, an ordered list on the right,
  large ghost numerals for order.
- **insight + evidence** - one large insight on the left, three or four
  short proofs on the right.

**Proof**
- **metric** - one figure at display size, a label, a line of context.
- **stat row** - three or four figures across, a label under each.
- **trajectory** - from → to pairs ("$100k → $480k MRR").
- **table** - a header rule, quiet rows, numbers right-aligned, units in the
  header. Past a handful of rows it wants to be a chart or two slides.
- **takeaway bar** - a full-width band at the foot carrying the so-what -
  a different angle from the headline, never a paraphrase.

**Contrast**
- **before / after** - two sides, the "after" accented.
- **scenarios** - bear / base / bull columns over the same metrics, the
  recommended one highlighted.

**Process** (the subject of the slide, never how the deck was made)
- **flow** - steps with forward arrows.
- **cycle** - nodes around a centre.
- **loop** - a flow with the failure path drawn back across it.
- **chain** - primary chevrons with the enabling activities as bars beneath.
- **swim lanes** - lanes × stages, small cards at the intersections.
- **funnel** - narrowing tiers with the drop-off stated.

**Time**
- **timeline** - a horizontal spine with dated beats above and below.
- **roadmap phases** - phases with their contents.
- **schedule** - sections × time, task bars, milestone diamonds.

**Structure and position**
- **layers** - stacked horizontal layers, the foundation darkest.
- **org** - boxes and connectors, two levels.
- **venn** - two or three circles with a named overlap.
- **concentric** - TAM / SAM / SOM rings.
- **pyramid** - tiers for priority (volume is a funnel).
- **matrix** - a 2×2 positioning with plotted items.
- **number line** - ticks with one highlighted range.
- **capability matrix** - competitors × capabilities, empty / half / full marks.

**Status**
- **scorecard** - rows with a red / amber / green mark and a one-line note.
- **heat map** - rows × columns of status cells, with a legend.
- **tracker** - initiative · owner · phase · next milestone.

**People and voice**
- **quote** - the words and the person, nothing else.
- **testimonials** - a few attributed quotes with initials and company.
- **team** - people with name, role, a short bio when there are few.
- **manifesto** - one large claim with one accented phrase.
- **wall** - logos or faces in a grid, no captions.

**Images**
- **full-bleed** - the image to every edge, a scrim, a short headline.
- **half-bleed** - copy on one side, the image bleeding off the other.
- **framed source** - a real screenshot, report page or product shot on one
  side, the text saying what it shows on the other. Never redraw a source
  chart as a fake: rebuild it as a `Chart` from its data, or show the real
  render.

## Rebuilding an existing deck

When the human hands you a finished deck to rebuild on the canvas, ask which
mode - and default to faithful:

- **Faithful** - their order, their words, exactly. You may normalise
  punctuation and number formats; you may not change a word. Suggested
  rewrites go in a comment on the frame, never on the slide.
- **Editorial** (opt-in) - order kept, copy passed through the slides
  guide's words: jargon, hedges and filler out; numbers, names and dates
  verbatim; titles turned into claims where the source supports them.

Then map shapes - a companion visual only where the source supplies one; a
paragraph with no metric, image or chart behind it is a text-led
composition, and that whitespace is honest:

| Source shape | Composition |
|---|---|
| a paragraph | split when the source has a companion (metric, image, chart); else text-led |
| 3 bullets | cards or columns |
| 4-6 bullets | stacked list (numbered if ordered) |
| up to 4 numbers | stat row or metric grid |
| a quote | quote |
| a table | table, or two slides when it is long |
| a chart with its data | `Chart` from the data |
| an image, chart, schedule or diagram you cannot rebuild losslessly | framed source |

## Charts and diagrams - the extra mile

- **Decision flows**: boil choices to yes / no, quantify the branches (%,
  volumes) so the eye follows the path that matters, hang customer quotes on
  the node they support.
- **Waterfalls** beat tables for build-ups and breakdowns: left to right in
  the logical order, the one or two bars that matter highlighted, a few
  callouts that pre-empt the room's questions.
- **When a slide must be complex**: large visual cues on the point, grouping
  and colour that steer the reading, and the voiceover ON the page - the
  slide must make sense with no presenter.
- **Aggregate.** The chart is not the model. A single series is fine.
  Overlay detail on the base chart instead of adding a second chart.
- **Formatting**: label bars directly and drop the value axis when the chart
  is simple; growth rates visible; one label size across the deck; series in
  logical order; the same hue means the same thing on every slide.
