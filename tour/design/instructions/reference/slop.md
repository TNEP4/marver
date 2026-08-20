<!-- marver:managed d18481739c5f4edd83c2e8c011fc12f7f544daa70a06645de016c9cfc17cc132 - edit freely: init preserves your edits and stages upstream updates at design/.local/latest/ for you to merge. Delete this line to detach this file from updates entirely. -->
# Slop - the full catalog of generated-UI tells

Every pattern here is a statistical default of AI-generated design. None is banned
by nature - a brief can earn any of them - but reaching for one UNPROMPTED means no
decision was made. Use this as a sweep list on review passes and whenever output
feels generic. craft.md carries the short list; this is the complete one.

## Surfaces and decoration

- Thick colored side-stripe border on a card or alert (the single most recognizable tell).
- Thick accent border fighting rounded corners.
- Hairline border + wide diffuse shadow on the same card (pick one elevation system).
- Glassmorphism/blur/glow used as decoration on elements that overlay nothing.
- Decorative grid-line or blueprint background with no canvas, map, or measurement under it.
- Repeating-gradient stripes as surface texture.
- Saturated radial glow/halo behind a section as a fake spotlight.
- Dark mode built from colored box-shadow glows.
- Everything over-rounded into the same soft blob; pills on large containers.
- Hand-drawn-style SVG scenes and mascots (read as doodles); hero art assembled from generic vector shapes (reads as clip art). Crisp geometric/diagram SVG is fine - SVG imitating pictures is not.

## Typography

- Tracked uppercase kicker/eyebrow above a heading; the tiny pill chip above an oversized hero headline.
- A full-sentence headline at display size dominating the viewport.
- Oversized italic serif as the hero voice (the universal AI-startup landing look).
- The icon-tile-above-heading feature-card template.
- Flat hierarchy: adjacent sizes too close to carry different jobs.
- Inter, Geist, Space Grotesk as the "safe" display pick - no longer distinctive.
- One family carrying an entire Persuade page (fine on Operate; a tell on marketing).
- Tracking crushed past character integrity (tighter than -0.04em), or body tracking wider than 0.05em.
- Functional text under 11-12px; line-height under 1.3 on multi-line text; long passages in all-caps; justified text without hyphenation.

## Color

- Purple/violet gradients; cyan-on-dark; the neon-accent-on-near-black look.
- Warm cream/beige as the default "tasteful" ground.
- Gradient-filled text.
- Gray text on a colored surface (derive from the surface hue instead).

## Layout

- Same-size icon+heading+text card grids as the page structure; nested cards.
- The hero-metric template (big number, small label, three supporting stats, accent).
- Tiny numbered labels (01/02/03) beside headings when order carries nothing.
- One spacing value everywhere - no rhythm.
- A heading sitting closer to the PREVIOUS block than to its own content.
- One column of the first viewport running far past its neighbor, leaving dead space.
- Scroller cards flush against the panel edge with no matching inset.
- Text occluded by an overlapping element; content overflowing its container.
- Absolutely-positioned children (tooltips, menus) clipped by an overflow container.
- Prose wider than ~80ch; body text flush against the viewport edge; cramped padding.

## Motion

- Pulsing dot making a static status look live.
- Fake blinking terminal caret on non-editable copy.
- Auto-scrolling marquees.
- Bounce/elastic easing; animating width/height/padding/margin.
- Scaling or rotating images on hover (the image is not an action target - give the container the feedback).
- The identical fade-and-rise entrance stamped on every section.

## Copy

- Em dashes sprinkled through body copy (an AI cadence tell - use plain sentences).
- Manufactured-contrast aphorisms closing every section ("It's not X. It's Y.").
- Dismissing things as "theater" (a generated-copy tic).
- Generic SaaS buzzwords ("supercharge", "seamless", "unlock", "effortless").
- The same label repeated in several slots of one card.

## Mechanical (belongs in every review sweep)

- Broken or placeholder `<img>` (empty/missing src) shipped to the canvas.
- Uncaught script error on load; content invisible at rest because reveal code hid it.
- Skipped heading levels; missing accessible names.
- Any font, color, radius, or size that falls OUTSIDE the documented system in
  design/DESIGN.md - the tell that the system was decoration, not law.
