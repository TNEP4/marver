# Slides - decks on the canvas

A slide is an ordinary frame with `slide: true`:

```tsx
export const meta = { title: 'Onboarding time halved', slide: true }
export default () => (
  <main className="deck deck-ink">
    <h1>Onboarding time halved in one quarter.</h1>
  </main>
)
```

That is the whole contract. Everything inside is your code - your
project's components and classes, any layout, any typeface, any image,
any SVG drawing, any CSS or JS animation. marver adds what a deck needs
around it: a stage, a player, and a place on the board.

- **The stage.** A slide renders at its stage size: 1280×720 by default,
  or the `viewport` it declares (`viewport: 'laptop'` gives a 16:10 deck at
  1280×800). On the canvas it is a frame like any other - comments, laser,
  variants, Live Jam - with a slide badge.
- **The deck.** One scene is one deck; numbered files (`01-cover.tsx`) are
  the authoring order, and **the board's reading order is the played
  order** - drag slides around the canvas to reorder the deck.
- **The host scales, not the slide.** A slide never reflows. Slides mode
  renders each slide at its stage and scales the whole stage to the screen -
  up on a projector, down on a laptop or a phone - and a canvas node resized
  smaller shows the same stage, scaled, like a thumbnail. The composition you
  approved is the one everyone sees, without breakpoints.
- **Notes.** `<slide>.note.md` beside the frame is its
  [sticky note](sticky-notes.md): the aim, the talk track, the visual
  intent, the sources. Notes ship with a published canvas, so keep anything
  the audience must not read out of them.

## The guidance the agent reads

`marver init` ships `design/instructions/slides.md` - not a rulebook, a
guide: how a slide plays and animates, the **deck kit** a strong deck is
built on (a master shell, whole-slide tones, the brand's type, hairlines
and labels, a drawing helper), the craft that makes a deck look made
rather than typed (the brand's own voice, one idea per slide, structure
with space instead of boxes, real images used big, a drawing system of its
own, pacing, honest numbers), the method (the answer first, a slide list
that tells the argument, a `_brief.md`, notes per slide), and a review that
squints at the contact sheet. Two references sit beside it:
`instructions/reference/deck-story.md` (intake, answer-first structure, the
evidence check, the words) and `instructions/reference/deck-layouts.md` (an
idea bank of compositions, rebuilding an existing deck, chart craft).

Your own **deck look** - master, tones, type, mark, imagery, drawing style,
colour meaning, voice - lives in `design/slides.md`, which the agent drafts
from your brand on the first deck, which overrides the shipped guide, and
which marver never overwrites.

## Playing and publishing a deck

Press `p` on a board whose publish row says slides and you get slides mode:
the stage scaled to the window, the standard prototype toolbars (with
`chrome: full`, the default), arrows / Space / click to advance, `d` cycles
the theme, and two views of the stage: Slide (fit to the window, room for
the chrome) and Fill window (edge to edge). Publish it with:

```json
{ "boards": { "pitch": { "max": "comment", "type": "slides",
  "open": "slides", "transition": "fade" } } }
```

- `transition`: `fade` (default) or `none`.
- `chrome`: `full` (default - the standard prototype chrome: the top-right
  toolbar with comment, laser, theme, and devices, plus the bottom-left
  walker; a locked deck-only share also carries the brand pill),
  `minimal` (a slim progress strip, comments, the canvas door when the
  board is not locked, and a pending-update control), or `none` (bare
  stage).
- Add `"lock": true` to freeze visitors in the deck - no way out to the
  canvas. When every published board is locked to present, focus, or
  slides, the canvas shell is left out of the bundle entirely.

Viewers land straight in the deck; the URL survives refresh and back.

## Motion

Motion is yours to write. While a deck plays, the stage puts
`data-sl-play` on `<html>` for the whole show, and `data-sl-entered` once
each slide has arrived (removed at each swap, set again when the new slide
settles); `useSlidePlay()` from `/content` is the playing flag in React. Key
your animations off them, so the canvas, `marver shot` and thumbnails show
the finished slide:

```css
:root[data-sl-entered] .route { animation: draw 900ms ease-out both }
@keyframes draw { from { stroke-dashoffset: 600 } to { stroke-dashoffset: 0 } }
```

On the canvas, a resting frame's animations are paused anyway (see sleep in
the README). marver adds three things on top:

- **Morphs**: give the same `view-transition-name` to an element on two
  adjacent slides and it travels or resizes between them.
- **Build steps**: progressive disclosure is sibling frames (`03a-`,
  `03b-`) sharing morph names - every step visible and commentable on the
  board.
- **Entrance shortcuts**: `data-animate="fade-up | fade | scale-in"` +
  `data-animate-delay="1-3"`, run once after a slide arrives. Never on an
  element that carries a morph name.

`--marver-slide-tempo` in your theme (default 350ms) times the morphs and
the shortcuts. `prefers-reduced-motion` flattens both.

## Charts and video

- `<Chart option={...} h={420} />` - an Apache ECharts option, on a
  fixed supported surface: series bar, line, pie, scatter, radar, gauge, heatmap, funnel, treemap, sunburst, sankey, boxplot; components grid, polar, radar, tooltip, legend, title, dataset (+ transform), markLine, markPoint, markArea, visualMap, dataZoom. Anything outside
  it is dropped by ECharts without an error, so stay inside. marver
  supplies the house theme from the slide's own ink and typeface (and
  `--marver-slide-accent`), sizes labels for a stage, keeps the chart
  still at rest and plays its entrance in slides mode. SVG-rendered, in a
  lazy chunk chart-free canvases never download.
- `<Video src="intro.mp4" poster="intro.jpg" />` - the poster is the frame
  at rest. Omit it on a local clip and marver renders one from the clip's own
  first moments (`intro.mp4.poster.png` beside it - the dev server on first
  sight, `marver build` before publishing; needs Chrome, like `shot`). An
  authored poster always wins. In slides mode the glass strip mounts
  on its own (play/pause, seek, mute, fullscreen); in any other live frame -
  interact mode, play, a published prototype - the poster is the play button.
  `ratio="9 / 16"` for a vertical clip; `autoplay` for a muted ambient loop
  (that frame then stays live on the canvas). Remote https direct files work
  too.
- Images: `Img` for a framed asset, or a plain `<img>` when the slide needs
  full control. Slides play scaled up, so use files at least 2x the size
  they show.

## Decks built before 0.20

Earlier decks wrap each slide in `<Slide>` and use its `sl-*` type classes.
`<Slide>` still exists, as an optional wrapper that fills the frame - but it
no longer pads the stage, centres content, sizes type or freezes animation,
and the `sl-*` classes carry no styles. Such a deck still plays; give it its
own styles (a deck kit, as the guide describes) to restore the look.
