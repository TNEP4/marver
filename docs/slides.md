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

It renders 1280×720 on the canvas (an authored `viewport` still wins), wears
the slide badge, and everything you know - comments, lasers, variants,
promotion, Live Jam - keeps working. One scene = one deck; numbered files
(`01-cover.tsx`) are the authoring order; **the board's reading order is the
played order** - drag slides around the canvas to reorder the deck.

The agent's full craft doctrine ships at `design/instructions/slides.md`
after `marver init`; your own layouts and house rules live in
`design/slides.md`, which the agent must honor and marver never overwrites.

## Playing and publishing a deck

Press `P` on a board whose publish row says slides and you get slides mode:
full-bleed 16:9, arrows / Space / click to advance, a slim progress strip.
Publish it with:

```json
{ "boards": { "pitch": { "max": "comment", "type": "slides",
  "open": "slides", "transition": "fade", "chrome": "minimal" } } }
```

- `transition`: `fade` (default) or `none`.
- `chrome`: `minimal` (progress strip + comments) or `none`.
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

The `Slide` root reads `--marver-slide-ink/-ground/-accent/-muted/-tempo`
(plus `-dark` variants) from your theme and falls back to the house palette.
Type roles: `sl-assertion` (48-64px), `sl-support` (28-32px), `sl-body`
(24px floor), `sl-caption` (18px floor).
