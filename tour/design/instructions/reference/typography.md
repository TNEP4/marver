<!-- marver:managed 2060a073d4afe490b8e235c907675a1a56deb6cd0c5d1c1a7d8a246d35d9f343 - edit freely: init preserves your edits and stages upstream updates at design/.local/latest/ for you to merge. Delete this line to detach this file from updates entirely. -->
# Typography - roles, hierarchy, reading

Type carries information, hierarchy, and voice. Improve it inside the settled brand;
replacing the faces is a Brand decision, not a typesetting one.

## Diagnose first

- **Roles.** Can heading, body, label, metadata, and data be told apart at a glance?
  Adjacent sizes too close to carry different jobs is the classic failure.
- **Scale.** A deliberate role scale, or a collection of arbitrary values? Repeated
  roles must be byte-identical across frames.
- **Reading.** Body in the 45-75ch measure; line-height tuned to the face and width,
  not a universal ratio (wider measure needs more leading).
- **Stress.** Long headings, translation-length words, zoom, narrow containers, and
  font-loading fallback - run them.

## The system

- The fewest roles and families that make hierarchy unmistakable. Combine size,
  weight, spacing, and tone deliberately - never ask size alone to do all the work.
- Body floor is 1rem/16px on ordinary web surfaces; denser roles must be a decision.
- Light text on dark surfaces compensates on three axes: slightly more line-height,
  a touch more tracking, one step more weight if the face runs thin.
- Paragraph rhythm: spacing OR first-line indent, never both (double-marked
  boundaries).
- Use numeric/tabular font features where the content is numbers in columns.
- Load only the weights you use; give webfonts metric-compatible fallbacks so
  loading never reflows or blanks text.

## Operate surfaces (dense product UI)

- One well-tuned family is usually right - no display/body pairing needed.
- Default to a fixed rem scale; reach for fluid clamp sizes only when a heading
  genuinely must track its container (marketing display type) - a fluid heading that
  shrinks inside a sidebar looks worse, not more responsive.
- Tighter scale ratio (1.125-1.2 between steps): more type elements live here, and
  exaggerated contrast creates noise.
- Prose measure still applies to prose; tables and dense rows may legitimately run
  wider and smaller.

## Verify

Roles recognizable without reading the copy; long text comfortable at every relevant
width; repeated roles identical everywhere; zoom and user font settings respected;
no loading reflow.
