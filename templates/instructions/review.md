# Review - the self-review pass before presenting anything

Run this before telling the human a design is ready. The budget is fixed: one full
inspection round, one batch of fixes, at most one confirmation round, then stop.
Endless self-polishing costs real money and converges slower than one round of human
feedback - present, don't perfect. The cap binds POLISH only: a functional defect or
accessibility blocker found in the confirmation round gets fixed before presenting,
however late it surfaced.

## The walk

1. **Play the flow** (press P / instruct the human once frames are wired): every
   `data-goto` lands, no dead ends, every screen either links onward or is an honest
   terminal state. Dead ends in play mode are flow bugs, not polish items.
2. **Device sweep**: every viewport configured in design/config.ts (the Devices
   menu). The design targets its `meta.viewport`, but it must not BREAK at the
   others - overflow, clipped controls, and unreadable collapses are defects even
   off-target.
3. **Keyboard walk**: tab through each screen once - focus is visible and follows
   reading order, every interactive element is reachable, Escape closes what Enter
   opened, and nothing traps focus.
4. **Both themes** (when the brand ships two): press d, look at every frame. A theme
   where one element keeps its other-theme color fails the sweep.
5. **Read every string aloud.** Labels name actions, errors name recoveries, no
   placeholder text survives, no lorem, no "TODO" copy.
6. **States exist**: for each screen with meaningful states, the empty / error /
   loading siblings are present and reachable.
7. **Craft floor**: one pass over craft.md's Verify list against the RENDERED frames.
8. **Descriptions true**: read design/manifest.json once more - every board, folder,
   scene and frame this session touched carries a `description` that is still true
   (state words above all: retired, winning, superseded). The next session orients
   from that file; a stale sentence there costs it more than a missing one.

## Honesty rules

- Verify against the canvas, not the code. The code compiling is not the design
  working.
- Report what you did NOT check as plainly as what you did.
- A defect you found and deferred is listed, never silently absorbed.
- If the concept itself is wrong, say so and recommend re-entering Wireframe -
  polish never rescues a wrong concept, and hiding the diagnosis inside cosmetic
  fixes wastes the round.

## When the human asks for a REVIEW (not just before presenting)

The walk above is the self-check. When the human explicitly requests a review or
critique of designs, run the structured pass in instructions/reference/critique.md
instead - specificity verdict, ten scored heuristics, prioritized issues.

## Presenting

Lead with what to look at: the board name, the frame to start on, the flow to walk,
and the one or two decisions you need from the human. Copy file paths for anything
you reference (select frames + press c). Never present work whose review you skipped;
say "unreviewed" if the human asked for speed.
