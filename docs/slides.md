# Slides - decks on the canvas

A slide is an ordinary frame with `slide: true`:

```tsx
import { Slide } from '@marver-design/marver/content'
export const meta = { title: 'Cover', slide: true }
export default () => (
  <Slide>
    <h1 className="sl-assertion">Churn halved after onboarding v2</h1>
  </Slide>
)
```

It renders 1280×720 on the canvas, wears the slide badge, and everything
you know - comments, lasers, variants, promotion, Live Jam - keeps working.
**The stage fits every screen**: you author at exactly 1280×720, and the
slide scales and centers itself to whatever viewport plays it - fill window,
a laptop, a viewer's phone - author px, Tailwind classes, and charts all
scale together, so the composition you approved is the composition everyone
sees. One scene = one deck; numbered files
(`01-cover.tsx`) are the authoring order; **the board's reading order is the
played order** - drag slides around the canvas to reorder the deck.

The agent's full craft doctrine ships at `design/instructions/slides.md`
after `marver init`, with two depth references beside it -
`instructions/reference/deck-story.md` (finding the answer, the evidence
check, the words) and `instructions/reference/deck-layouts.md` (the layout
atlas, the grid, content budgets, charts). Your own deck look, layouts and
house rules live in `design/slides.md`, which the agent must honor and
marver never overwrites.

## Playing and publishing a deck

Press `P` on a board whose publish row says slides and you get slides mode:
the 16:9 stage with the standard prototype toolbars - arrows / Space / click
to advance, `D` for theme, devices including fill window.
Publish it with:

```json
{ "boards": { "pitch": { "max": "comment", "type": "slides",
  "open": "slides", "transition": "fade" } } }
```

- `transition`: `fade` (default) or `none`.
- `chrome`: `full` (default - the standard prototype chrome: the top-right
  toolbar with comment, laser, theme, and devices including fill, plus the
  bottom-left walker; a locked deck-only share also carries the brand pill), `minimal`
  (a slim progress strip + comments only), or `none` (bare
  stage).
- Add `"lock": true` to share ONLY the deck (no canvas shell in the bundle).

Viewers land straight in the deck; the URL survives refresh and back.

## Motion - the diff is the animation

A resting slide is STILL - that is a contract, not a hope: charts render
final-state SVG, videos are posters (no `<video>` element exists), and the
`Slide` root suspends every animation at rest. Motion happens in slides
mode, one-shot:

- **Morphs**: give the same `view-transition-name` to an element on two
  adjacent slides and it travels/grows between them. This is the house move.
- **Build steps**: progressive disclosure is sibling frames (`03a-`, `03b-`)
  sharing morph names - every step visible and commentable on the board.
- **Entrances**: `data-animate="fade-up | fade | scale-in"` +
  `data-animate-delay="0-3"`, run once after the transition settles. Never
  on an element that carries a morph name.

`prefers-reduced-motion` flattens everything.

## Charts and video

- `<Chart option={...} h={420} />` - the full Apache ECharts option surface
  for FORM; marver injects the house theme (colors, type, tooltip) from your
  `design/theme.css` tokens and strips animation at rest. SVG-rendered, in
  a lazy chunk chart-free canvases never download.
- `<Video src="intro.mp4" poster="intro.jpg" />` - the poster is the slide
  at rest (required for local files); in slides mode the glass strip plays
  it (play/pause, seek, mute, fullscreen). Remote https direct files work
  too.

## Theme tokens

The `Slide` root reads `--marver-slide-ground / -ink / -muted` (each with a
`-dark` variant), `--marver-slide-accent` (one value, both themes),
`--marver-slide-font`, and `--marver-slide-tempo` (one duration that times
both the entrances and the morphs between slides) from your theme and falls
back to the house palette. Type roles, fixed: `sl-display` (160px, the one
oversize - a hero number, a section numeral), `sl-stat` (88px, a row of
figures), `sl-assertion` (56px),
`sl-support` (30px), `sl-body` (24px), `sl-caption` (18px).
