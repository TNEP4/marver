# Brand - extract it, or create it deliberately

Every high-fidelity frame renders inside a visual world. This phase makes that world
explicit. Never skip it silently: hi-fi work without a settled brand converges on the
same generic AI look every model produces.

## Path A - the repo has a brand: extract it

If the app has real screens, tokens, or a theme, the brand already exists. Document
it, never reinvent it:

1. Read the theme CSS, tokens, tailwind config, and 2-3 representative components.
2. Write `design/DESIGN.md` (10-20 lines): grounds and surfaces, accent
   and its meaning, type faces and scale, radius language, shadow/border policy,
   voice of the copy. Cite the token file as the source of truth.
3. Frames then consume the app's real tokens. Hand-typed hex values in a frame are a
   defect - if a value is missing, it is a token to propose, not a literal to inline.

## Path B - no brand exists: create one, deliberately

1. **Name the world first.** The product's mechanism in one sentence; the audience's
   cultural home; three adjectives the interface should earn. Write these down before
   touching a color.
2. **Derive, don't default.** From the audience's actual world (its objects, notation,
   publications, screen traditions), propose 2-3 distinct directions as one frame each -
   same content, different world. Each direction commits fully: its own palette, type
   pairing, radius/material language. Half-committed directions are unjudgeable.
3. **The forbidden defaults.** These are what every unguided model produces; reaching
   for one when the brief didn't ask means you were not deciding:
   - warm cream ground + serif display + terracotta accent
   - near-black + lone neon/acid accent, purple-to-blue gradient heroes
   - glassmorphism as decoration, gradient text, Inter/Space Grotesk as the "safe" pick
   - emoji as icons, `rounded-lg` on everything, everything centered
4. **Settle it into tokens.** The winning direction becomes CSS custom properties in
   the theme (grounds, text tiers, accent + meaning, radius scale, spacing scale, two
   type roles minimum). Then write DESIGN.md as in Path A. Components consume tokens;
   nothing hand-types values.

## Rules for CREATED brands (Path B)

Path A documents the shipped system as it is - a mature brand with three accents or
four faces gets described, never trimmed to fit these defaults. When CREATING:

- **One accent carries the brand.** Semantic colors (success/warning/danger) are not
  accents and never decorate.
- **The accent has a meaning** (action, selection, live state) - write it down and
  spend it only there.
- **Both themes or one, decided.** Light + dark as token sets, or a deliberate
  single-theme commitment recorded in DESIGN.md. Never an accidental single theme.
- **Type is two faces** (display + body; mono only when the content is code, data,
  or measurement). A third face is a decision Path B does not make alone.
