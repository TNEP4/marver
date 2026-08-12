# 0.2.3 spec - variants + canvas control (CONTRACT, 2026-08-12)

> Promoted from WIP after codex design review. Where this and convenience disagree,
> this wins. Ships WITH the 0.2.2 field-test fix pack as one release.

The thesis: diverge/converge is THE design loop. Variants exist for different
reasons - style directions, feature A/B, copy tests - and the canvas must keep
alternatives linked, visible, and comparable through every relayout, device sweep,
and prototype walk.

## 1. The model: variant groups

- **Inference (zero migration)**: a variant group = 2+ frames in the SAME directory
  whose basenames match `^([a-z])-`. Group id = the directory's frame-id prefix
  (`landing`, `checkout/payment`); variant key = the letter; display name = meta
  title or the humanized rest of the filename.
- **Scoped A/B inside a busy scene = a nested directory**:
  `checkout/payment/a-card.tsx` + `b-wallet.tsx` group as `checkout/payment`,
  sitting beside `checkout/cart.tsx`. States (`empty.tsx`, `error.tsx`) never
  letter-prefix, so they never misgroup.
- **Overrides, literal strings only** (extractor stays regex): `meta.of` (group id)
  and `meta.variant` (key). No `meta.order` - variant order is the natural order of
  the keys.
- **Manifest emits exactly two new optional fields** per frame: `variantGroup`,
  `variant`. Duplicate keys in one group: keep first, console warning.
- Variants are LOCAL comparisons, never global A/B lanes - no cross-group "B mode".

## 2. Canvas control: sceneRows

Board JSON gains ONE optional field, `sceneRows: string[][]` - rows of scene ids,
top to bottom, left to right: `[["landing","docs"],["pricing"]]` = landing and docs
side by side, pricing below. Tidy consumes it; scenes not listed append as rows at
the bottom (alphabetical). Backward compatible (version stays 1); agents author it
in board files (boards.md documents it); the shell round-trips it through save.
This is the "scenes next to / above / below each other" control.

## 3. Layout: groups are indivisible

Tidy treats a variant group as ONE unit inside its scene row: members contiguous,
ordered by variant key, never split or interleaved - and the nodes array is NEVER
reordered (iframe law G-1; tidy only assigns x/y). Device views resize members in
place; the group survives keys 1-5. Free-form drag still allowed; tidy restores.

## 4. Canvas UI: badge + caption

- Each grouped frame gets a floating badge LEFT of the frame, outside the artwork:
  the variant letter large, name beneath. World-anchored (scales with zoom) with a
  screen-space minimum via the existing `--sh-inv` clamp (the resize-handle
  pattern), so it stays legible at overview zoom and proportionate up close.
- A group caption above the row: "Landing · 3 variants".
- Curated boards showing a single member still show its badge, no caption.

## 5. Sidebar

Grouped frames render under one surface entry: group name + variant chips
(A/B/C, active-selection aware) instead of three sibling rows.

## 6. Play mode: variant switching

- A compact variant control in the play chrome (`A · Terminal · 1/3`), plus `[` and
  `]` to switch. Switching swaps the stage to the SIBLING FRAME at this position,
  in place - device, theme, and history preserved.
- Only offered when the current frame HAS siblings on the active board (published
  filtered builds exclude unlisted frames - privacy boundary respected).
- `data-goto` is never rewritten: each variant authors its own flow; after a
  switch, the mounted variant's own links drive.

## 7. Fix pack riding along (already in repo)

tsconfig self-exclusion + allowImportingTsExtensions + re-rooted `@/` paths (the
day-zero P0); setup.md scaffold-collision dance; unattended-mode path in
discover.md; init notes missing DESIGN.md; Method content fixes.

## 8. Investigate first

The resize-shift report (canvas shifting while resizing frames on some boards) -
reproduce during build; fix if pinned, file precisely if not.

## Out of scope (recorded)

`meta.order`; global experiment lanes; auto-including off-board siblings in
published builds; scene arrangement UI (authoring stays in board files this
release); comments (0.2.5).

## Acceptance (test-drive protocol per Nic)

Build → codex review of the diff → dev-mode test-drive on a fresh-stack repo with
the local tarball (dogfood marver-in-marver where possible) → published-bundle test
→ Nic approves → publish with the fix pack.
