<!-- marver:managed 166335d402eb23aa6e47db9bf320faa120e11213b46d1b93f674249bd1998049 - edit freely: init preserves your edits and stages upstream updates at design/.local/latest/ for you to merge. Delete this line to detach this file from updates entirely. -->
# Components - engineering rules for promotable design

Frames become the app (see AGENTS.md's promotion section). These rules make that
promotion mechanical instead of a rewrite.

## Structure

- **Composition over configuration.** A component takes children and a few props;
  it does not take a `variant` prop that swaps its entire body. When two variants
  share less than half their markup, they are two components.
- **Variants are props, never forks.** `<Button intent="danger">`, not
  `DangerButton.tsx` copied from `Button.tsx`. A fork's fixes never propagate.
- **Presentational only.** Props in, JSX out. No stores, no network, no auth, no
  router imports inside anything that lives in `design/` (the AGENTS.md law) - and
  keep it true after promotion: containers own data, components own pixels.
- **Fixture shapes match PROP shapes, not API shapes.** `_fixtures.ts` exports typed
  objects the component accepts directly, so tsc catches drift. Mapping backend
  responses into those props is the container's job at promotion time - never bend a
  component's props toward an endpoint.

## Accessibility baseline (non-negotiable)

- Interactive = a real `<button>`, `<a>`, or input - never a div with onClick.
- Every input has a label; every icon-only button has an aria-label.
- Focus-visible styling exists and comes from the palette.
- Keyboard order follows reading order; Escape closes what Enter opened.

## States are part of the component, not the page

Every component ships knowing the states that APPLY to it: an input has error and
disabled; a list has loading and empty; a divider has neither. Screens own the
orchestration states (page-level loading, empty, failure - see
reference/states.md). Pages compose component states; they never invent them per-use.

## The gallery is the contract

Each shared component gets `design/components/<name>/variants.tsx`: every variant ×
every state, labeled, in one frame. The gallery is the review surface, the regression
canary, and the documentation. A component change without a gallery update is
incomplete work.

## Maintain - pay down drift before it solidifies

When the same ad-hoc pattern (a value, a markup shape, a style cluster) appears a
third time, that is the promotion trigger: extract it into a token or shared
component and update design/DESIGN.md in the same pass. Drift left in place becomes
the system; three identical one-offs are a primitive announcing itself.

## Naming

Name by role, not appearance: `PriceCard`, not `BlueBox`. Appearance changes;
the role is the API.
