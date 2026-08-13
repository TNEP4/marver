# Welcome - the human's first session

Run this the FIRST time you work with the human in a repo, or whenever they ask
what marver is or how it works. Unsure whether they were already welcomed? If
design/DESIGN.md is missing or no curated board exists yet, treat it as not
yet. The job: by the end of the session the human understands the tool, has
seen their own product on the canvas, and knows what to do next. Narrate as you
go - one short plain sentence per step, teaching by doing, never a lecture.

## The pitch (say it early, in your own words)

marver co-designs the user experience with the human in real code. Frames are
not mockups - they are components using the app's actual theme and component
library. The theme, components, and screens shaped while designing ARE the
app's building blocks: by the time the design is agreed, most of the UI work
already exists, and building the product means plugging functionality into it.
The goal is full alignment on look and feel - across light and dark, across
every device size - before app logic is written.

## Empty repo?

STOP - design/instructions/setup.md is the authority (it exists only while the
repo has no app). Follow it end to end; it sends you back here for the tour.

## Existing codebase - first session flow

1. **Say what the app is.** Read the repo (entry point, routes, key screens).
   State your understanding of the product in 2-3 sentences, ask "did I get
   that right?" - then STOP: no further tool calls, end your turn, resume when
   the human replies. (Only exception: they explicitly asked for unattended
   execution - assume, mark UNCONFIRMED, surface it first.)
2. **Confirm the stack aloud - what detection ACTUALLY found.** Read AGENTS.md's
   UI line and design/theme.css and narrate the reality, for example: "Tailwind
   + shadcn/ui; brand tokens in <file>; design/theme.css imports them." No
   component library? Say that, and what it means (shared pieces get extracted
   to design/components/). Anything wrong gets fixed now, while it is cheap
   (configure.md, old-repo checklist).
3. **Put THEIR product on the canvas - impressively.** Recreate 3-4 of the
   app's real screens as frames from its real components, linked with data-goto
   so play mode flows, working in both themes, responsive. This is the human's
   first impression of the canvas: hold it to the craft bar
   (instructions/craft.md, instructions/reference/slop.md). Create a curated
   board for the set. First sessions skip the written-brief ceremony, never the
   quality bar; real work after the tour runs the full method ladder.
4. **Explain the working model while building:** existing components are reused
   as-is; missing pieces are created as presentational components - fixture
   props, placeholder handlers - and get real wiring at promotion (where they
   live is AGENTS.md's structure ladder). Look and feel converges first;
   production becomes plugging functionality into agreed UI.
5. **Offer a divergence.** "Want a variant of <frame> exploring a different
   direction?" One a-/b- pair teaches the variant workflow better than any
   explanation.
6. **Give the tour** (below), ending with the deep link.

## The tour

Deliver conversationally after setup - a short guided message, not a manual.
Start `npx marver dev` if it is not already running (allowed for this purpose)
and ALWAYS hand a deep link to the board you prepared, using the port the dev
server PRINTED: `http://localhost:<port>/#/b/<board>` - never the bare root
URL. The highlights, all real features:

- **Select and preview.** Click frames (shift-click for several). Digit keys
  switch device presets - 1-4 for the configured devices, 0 back to each
  frame's own size - scoped to the selection when one exists, the whole board
  otherwise. `d` cycles light/dark the same way: selected frames, or the
  entire canvas.
- **Touch it.** Double-click a frame - the purple ring is interact mode: the
  frame is live, clickable, scrollable.
- **Play it.** `p` opens play mode: the design full screen in a device, with
  data-goto links navigating between frames like the real app. `[` and `]`
  switch variants in place; devices switch inside play too, including
  full-screen fill.
- **Explore alternatives.** Letter-prefixed sibling files (a-bold.tsx,
  b-minimal.tsx) form a variant group - badged, kept contiguous, compared at a
  glance. The cheap way to diverge on a direction before committing.
- **Compose.** `t` re-tidies; boards carry a `layout` recipe for deliberate
  arrangement (instructions/boards.md).
- **Share it.** `marver build` bundles the boards; `marver serve` with
  MARVER_PASSWORD on any Node host (Railway, Fly, a VPS) publishes them as a
  password-gated canvas the human owns - colleagues get the link plus the
  password. Comments on the board are coming soon.

Close by asking what they want to design first.
