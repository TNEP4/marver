# 0.2.3 spec - variants, grouping, iteration (WIP, 2026-08-12)

> **STATUS: WIP - design capture, not yet contract.** Promote (resolve the open
> questions, record in DECISIONS.md, drop this banner) before writing 0.2.3 code.

The thesis: diverge/converge is THE design-thinking loop, and the canvas currently
punishes it - variants are just frames that happen to sort together, comparisons
die on every tidy, and reviewing three directions across device sizes means manual
re-layout. 0.2.3 makes the variant group a first-class canvas idea while keeping
the file convention as the API.

## 1. The model: infer groups from the existing convention

The 0.2.2 Method already teaches: scene = surface, variants = sibling frames with
`a-`/`b-`/`c-` prefixes. 0.2.3's cleanest move is to make the shell UNDERSTAND that
convention rather than add a parallel API:

- A **variant group** = frames in one scene whose basenames match `^([a-z])-(.+)$`
  with 2+ members: `landing/a-terminal`, `landing/b-editorial` → group "landing",
  variants A/B/C with names Terminal/Editorial.
- `meta.variant` / `meta.order` exist only as OVERRIDES for when filenames can't
  carry it (renames mid-flight, >26 variants, display names with slashes).
- Zero migration: every repo following the Method gets groups for free the moment
  0.2.3 lands.

## 2. Canvas chrome: the variant badge

Nic's ask: a letter/name floating LEFT of the frame, scaling as you zoom.

- World-anchored badge left of each grouped frame: the letter large (readable at
  overview zoom), the variant name under it, both in world coordinates so they
  scale with the canvas - PLUS a screen-space minimum clamp so they never vanish
  at extreme zoom-out (the toolbar/edge-light pattern: world position, bounded
  screen size).
- A group caption above the row: "Landing · 3 variants".
- Badges live OUTSIDE the frame box (left gutter), so they never cover artwork and
  never affect frame layout. Grouped frames get slightly wider tidy spacing on the
  left to make room.

## 3. Group-aware layout (the durability fix, friction #19.2/#16)

- Tidy and device views treat a group as ONE unit: members share a row, same y,
  ordered by variant letter, never split or interleaved with other frames.
- Device sweep (keys 1-5): each member resizes to the device, the ROW survives -
  groups stack as rows, comparison holds at every width. This is "shift through
  device sizes without breaking the layout".
- Free-form x/y still allowed; tidy restores the group row.

## 4. Play mode: variant switching (the killer review feature)

In play mode on a grouped frame: ←/→ (or a variant pill in the play chrome) swaps
A→B→C IN PLACE, keeping the flow position and device. The review question is
"which direction is better on THIS screen" - today that takes three separate walks.
Mechanics: the stage already swaps frames in place; variant swap is the same rail
with a different target list. data-goto targets resolve within the CURRENT variant's
scene first, so walking a flow stays inside one direction.

## 5. Iterations (versions over time) - convention only in 0.2.3

Parallel = variants (this spec). Sequential = iterations: the Method's answer is
that losing directions get DELETED (wireframe.md exit criteria) and git holds
history. No new canvas machinery for iterations in 0.2.3; if real need emerges,
`meta.iteration` + a board-level filter is the seam. UNDECIDED - see open questions.

## 6. The resize-shift bug (Nic's report)

"Depending on what's on the board, resizing frames could shift around the canvas."
Investigate FIRST during 0.2.3 (it may constrain the layout work): suspects are
rzpp recentering when content bounds change, and the device-view baseLayout
restore interacting with manual resizes. Reproduce with big boards, file as its
own fix regardless of the variants work.

## Open questions - resolve before promoting

1. **Badge scaling law**: pure world-space (Nic's literal ask) vs world-space with
   a screen-min clamp (lean: clamp - pure world-space dies at 10% zoom on big
   boards). Decide by prototype on the pilot.
2. **Group detection strictness**: letter-prefix only (lean), or any shared-scene
   siblings? Loose detection risks grouping states (empty/error) as variants -
   states and variants are both sibling frames. Possible tell: states use nouns
   (empty.tsx), variants use letter prefixes. Needs a decision and a Method note.
3. **Caption + badge on curated boards**: groups render on all-scenes for sure;
   do curated boards that cherry-pick one variant show its badge? (Lean: yes,
   badge only, no caption.)
4. **Play-mode swap scope**: swap only the current frame, or re-enter the flow at
   the same POSITION in the sibling variant's flow (lean: same-position re-entry,
   falling back to the variant's entry frame when the position has no sibling).
5. **Iterations**: confirm "git + deletion is the iteration story" for 0.2.3, or
   pull `meta.iteration` forward.

## Sequencing

After the 0.2.2 unattended test debrief (it may reshape priorities), and gated on
the resize-shift investigation. Client-driven: this is the release the Carrara
engagement needs; promote fast, build in vertical slices (badges → group tidy →
device rows → play swap), pilot-verified per slice.
