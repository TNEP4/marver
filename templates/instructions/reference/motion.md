# Motion - state, relationship, one authored moment

Motion explains state, relationship, and hierarchy - or delivers ONE authored moment
the surface has earned. Decoration without purpose is animation debt.

## Write the motion thesis first

- **Focal moment**: the one sequence that deserves authorship, if any. It must come
  from THIS product; a generic fade-and-rise, hover-lift, parallax, or scroll-reveal
  is not a thesis.
- **Continuity**: which state/layout/navigation changes need spatial explanation.
- **Feedback**: which controls need acknowledgment.
- **Budget**: which effects are expensive and how often they run.

## Material by meaning

Transform and opacity are the foundation, not the whole palette:

- Continuity/relationship → shared-element motion, FLIP transforms, view transitions.
- Focus/depth → bounded blur, backdrop, shadow, or light changes.
- Reveal → masks, clip-paths, controlled occlusion.
- Feedback → the SMALLEST change that makes cause and result unmistakable.

One strong material idea carried through beats stacked techniques. Sibling stagger
only when a list appears AS a list - cap the total delay; never reinterpret every
scrolled section as a staggered list.

## Timing

| Duration | Use |
|---|---|
| 100-150ms | immediate feedback |
| 150-300ms | routine state change |
| 300-500ms | layout, overlay, view transition |
| 500-800ms | one deliberately authored focal entrance |

Exits FASTER than entrances. Confident deceleration: `cubic-bezier(0.16, 1, 0.3, 1)`.
No bounce or elastic by reflex. Long feedback reads as latency.

## Implementation law

- Content visible in the DEFAULT state - a failed script must never hide the page.
- Never casually animate layout-driving properties (width/height/top/left/margin);
  use transforms or FLIP.
- Bound blur/filter/shadow work to isolated regions; `will-change` only during
  known animation.
- Every animation gets a `prefers-reduced-motion` path: preserve the MEANING, not
  necessarily the animation. Remove spatial movement; keep state changes legible via
  opacity/color; fully suppressing non-essential motion is a valid and often correct
  answer.
- No new dependency for an effect the stack already expresses.

## Operate surfaces

150-250ms for everything routine; motion conveys state, never decoration; NO
page-load choreography - users load into a task and don't want to watch it arrive.

## Verify

The focal motion belongs to this product; every supporting animation explains
something; interruption behaves; the reduced-motion path keeps meaning; removing any
remaining animation would lose information, not just garnish.
