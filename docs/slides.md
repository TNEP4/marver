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

## Why it stays light for the agent

There is no slide component library to learn. `Slide` is the ONE primitive:
it owns the 1280×720 stage, the asymmetric margins, six fixed type roles
(`sl-display` 160 · `sl-stat` 88 · `sl-assertion` 56 · `sl-support` 30 ·
`sl-body` 24 · `sl-caption` 18), your theme's tokens, and the motion
contract. Everything inside it is your project's own markup, classes, and
components - the same ones the app ships - so a slide is built the way a
screen is built, and an approved slide can be promoted like one.

Looking good at every size costs the agent nothing extra: the fit is pure
CSS on the root (a resized canvas node, a phone, a projector all get the
same composition, scaled), so the doctrine forbids `vw`/`vh` and media
queries inside a slide and asks for flex/grid in the stage's own
proportions. A dev-only overflow marker outlines any slide whose content
escapes the stage or collides inside it - the agent sees the defect on the
canvas, and the rule is always "cut or split, never shrink the type".

The craft lives in prose, not code. `marver init` ships
`design/instructions/slides.md` - the doctrine: assertion-first argument,
the type roles, **the space IS the design** (three bands, the 85% rule, one
px spacing scale), **seven silhouettes chosen before any recipe** (statement
/ hero / split / grid / stream / field / bookend) with a storyboard step
and pacing rules so a deck never reads as one repeated shape, 19 core
recipes with budgets and morph anchors, the choreography rules, and a
review gate that squints the contact sheet. Two depth references sit
beside it: `instructions/reference/deck-story.md` (intake, answer-first
structure, the evidence check, audience calibration, the words) and
`instructions/reference/deck-layouts.md` (the full layout atlas by job, the
grid, content budgets, rebuilding an existing deck, chart craft). Your own
**deck look** (tokens, type, the mark, colour meaning, numbers, voice - a
fill-in template the agent drafts on the first deck), layouts, and house
rules live in `design/slides.md`, which overrides the doctrine and which
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

- `<Chart option={...} h={420} />` - an Apache ECharts option, on a
  fixed supported surface: series bar, line, pie, scatter, radar, gauge, heatmap, funnel, treemap, sunburst, sankey, boxplot; components grid, polar, radar, tooltip, legend, title, dataset (+ transform), markLine, markPoint, markArea, visualMap, dataZoom. Anything outside
  it is dropped by ECharts without an error, so stay inside. marver
  supplies the house theme (colours, type, tooltip) from your
  `design/theme.css` tokens, strips animation at rest, and lets any
  styling you pass override the theme - so pass data and structure only.
  SVG-rendered, in a lazy chunk chart-free canvases never download.
- `<Video src="intro.mp4" poster="intro.jpg" />` - the poster is the slide
  at rest (required for local files); in slides mode the glass strip plays
  it (play/pause, seek, mute, fullscreen). Remote https direct files work
  too.

## Theme tokens

The `Slide` root reads `--marver-slide-ground / -ink / -muted` (each with a
`-dark` variant), `--marver-slide-accent` (one value, both themes),
`--marver-slide-font`, and `--marver-slide-tempo` (one duration that times
both the entrances and the morphs between slides) from your theme and falls
back to the house palette. The stage is 1280×720 (`SLIDE_W` / `SLIDE_H`, exported from `/content`)
with asymmetric margins - 88px sides, 44px top and bottom, overridable in
px via `--marver-slide-pad-x` / `--marver-slide-pad-y` - leaving a 1104×632
content box. Morphs between slides are progressive enhancement: where
`document.startViewTransition` is missing, slides crossfade at the tempo.
Type roles, fixed: `sl-display` (160px, the one
oversize - a hero number, a section numeral), `sl-stat` (88px, a row of
figures), `sl-assertion` (56px),
`sl-support` (30px), `sl-body` (24px), `sl-caption` (18px).
