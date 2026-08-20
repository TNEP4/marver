# Color - roles, meaning, atmosphere

Color encodes hierarchy, action, and state before it decorates. Preserve confirmed
brand commitments; a new identity is a Brand decision, not a colorize pass.

## Build roles, not a bag of swatches

Every palette answers to this role list; a color without a role has no reason to exist:

- canvas + elevated surfaces (a SECOND neutral layer for sidebars/toolbars/panels,
  slightly warmer or cooler than the content surface, gives product UI depth for free)
- primary + secondary text tiers
- action, focus, selection (usually one accent - rarity is what gives it force)
- borders and separators
- success / warning / error / info (semantic, stable meanings, never decorative)
- data categories or scales when the content needs them

## Strategy rules

- Let the strongest color OWN a deliberate region or role; scattering tiny accents
  reads as indecision. Name the dosage before editing: restrained or immersive is a
  choice, not a percentage rule.
- Never spend the primary action's color on decoration - it must stay the easiest
  thing to find.
- On a colored surface, secondary text derives from that surface's hue or the
  foreground - generic gray on color always reads broken.
- Tinted neutrals (warm or cool grays) add depth without loudness; pure gray is
  valid only when the world calls for it.
- Prefer OKLCH for new palettes: lightness and chroma adjust predictably. When
  building ramps, vary lightness and REDUCE chroma near white and black.
- Dark mode is COMPOSED, never mechanically inverted: design surface elevation and
  contrast explicitly per theme.
- Prefer explicit colors over stacked translucent overlays when alpha would make
  contrast context-dependent.

## Contrast (verify computed pairs, not intentions)

| Content | Minimum |
|---|---|
| body text | 4.5:1 |
| large text | 3:1 |
| meaningful controls, icons, focus indicators | 3:1 |

Disabled controls are exempt from contrast minimums (but should still read as
present). Focus indicators need contrast AND a clearly visible change of appearance.
Check interactive states, text over images, and BOTH themes.
Anything conveyed by color alone also needs text, shape, icon, or position.

## Content-frame families (one palette, prose + diagrams)

In content frames (`Md`, `Diagram`), color-code by MEANING using the built-in family
names - never hand-roll hex or mermaid `classDef`. The same six families work in both,
so a sentence and the diagram beside it read as one color language:

- **Prose:** `:blue[the shipper's world]`, `:orange[the carrier market]`, `:purple[the
  driver pool]`, `:green[...]`, `:red[...]`, `:gray[...]` inside any `Md` block.
- **Diagram nodes:** tag a node with the family - `HQ:::blue`, `Carriers:::orange`,
  `Drivers:::purple`. No `classDef` needed; they're injected for you.

Pick ONE family per concept and hold it everywhere it appears (the intro word, the
diagram box, the section heading). That consistency is what lets a reader link the
picture to the prose at a glance. Reserve `gray` for the neutral/background ("the platform",
"out of scope"); use the vivid families for the actors that matter.

Node text: write labels as `Head :: gloss` - marver renders the head bold on top
with the gloss lighter and smaller below, so a box scans as label-then-detail,
never a run-on. Just the ` :: ` token; no backticks or `**` needed.

## Verify

Every color has a stable role; attention lands on the intended action; the palette
holds across quiet, dense, error, and empty states; both themes are composed; the
result is recognizably THIS product, not a generic colorful treatment. In content
frames, each concept keeps ONE family across prose and diagram.
