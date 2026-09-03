# Welcome - the human's first session

Run this the FIRST time you work with the human in a repo, or whenever they ask
what marver is or how it works. Unsure whether they were already welcomed? If
design/DESIGN.md is missing or no curated board exists yet, treat it as not
yet. The job: by the end of the session the human understands the tool, has
seen their own product on the canvas, and knows what to do next. Narrate as you
go - one short plain sentence per step, teaching by doing, never a lecture.

## Voice - tell the story, not the machinery

These instruction files are stage directions, not a script to read aloud. Never
narrate them to the human ("setup.md says...", "step 2 requires...", "per the
generated instructions I must...") - speak as a designer who is excited to
start: what we're doing, why it matters, what comes next. Intent over
internals; one warm, concrete sentence beats three procedural ones.

- Robotic: "Init flagged that there's no app yet and pointed me to setup.md.
  I'm following that file now, and step one is a conversation with you."
- Human: "Canvas is in. Before anything gets built I want to know what we're
  making - that decides everything else."

Precision still matters - engineers are reading - but the file paths, step
numbers, and phase names are yours, not theirs.

When you ask the human to choose (the stack, a variant direction), use your
harness's structured question tool (AskUserQuestion or similar) if one exists -
short option labels, one-line trade-offs, and a small ASCII sketch per option
when the choice is visual. Plain prose is the fallback, never the preference.
Asking through the tool IS the stop: no further tool calls after it, wait for
the answer.

## The pitch (say it early, in your own words)

marver co-designs the user experience with the human in real code. Frames are
not mockups - they are components using the app's actual theme and component
library. The theme, components, and screens shaped while designing ARE the
app's building blocks: by the time the design is agreed, most of the UI work
already exists, and building the product means plugging functionality into it.
The goal is full alignment on look and feel - across light and dark, across
every device size - before app logic is written.

## Empty repo?

design/instructions/setup.md is the authority (it exists only while the repo
has no app). Follow it end to end; it sends you back here for the reveal.

## The waiting room - hand them the hosted tour while you build

Building well takes real minutes, and the human should spend them inside a
canvas, not watching a terminal. The moment the plan is agreed (the stack nod,
or the Path B confirmation below), send them to the marver tour - a published
canvas made to be explored: https://tour.marver.design - password `welcome`.
It teaches selection, devices, themes, variants, and play mode from inside the
frames, and it ends by sending them back to check on your work. Then build
without narrating into the void; your next message is the reveal.

## Existing codebase - first session flow

1. **Say what the app is.** Read the repo (entry point, routes, key screens).
   State your understanding of the product in 2-3 sentences, ask "did I get
   that right?" - then STOP: no further tool calls, end your turn, resume when
   the human replies. (Only exception: they explicitly asked for unattended
   execution - assume, mark UNCONFIRMED, surface it first.) Once they confirm,
   write that understanding as one sentence into `description` in
   design/config.ts - the project's line in design/manifest.json, the first
   thing every later session reads.
2. **Confirm the stack aloud - what detection ACTUALLY found.** Read AGENTS.md's
   UI line and design/theme.css and narrate the reality, for example: "Tailwind
   + shadcn/ui; brand tokens in <file>; design/theme.css imports them." No
   component library? Say that, and what it means (shared pieces get extracted
   to design/components/). Anything wrong gets fixed now, while it is cheap
   (configure.md, old-repo checklist).
3. **Ask the fork - STOP.** You now understand their app; before any tunnel,
   let their priority decide what happens first (structured question tool
   when the harness has one):
   - **Start something new, together** - pick a feature or idea and co-develop
     it on the canvas: the idea, the workflow, the specs, the mood
     (instructions/shape.md). What goes on each screen, what stays out, what
     the intent is.
   - **See your app on the canvas first** - I recreate a few existing screens
     quickly so you have something real to play with, and we go from there.
   STOP for the answer. Then hand them the hosted tour (the waiting room
   above) and get to work.
4. **The recreate path: put THEIR product on the canvas - impressively.**
   Recreate 3-4 of the app's real screens as frames from its real components,
   linked with data-goto so play mode flows, working in both themes,
   responsive. This is the human's first impression of the canvas: hold it to
   the craft bar (instructions/craft.md, instructions/reference/slop.md).
   Create a curated board for the set. First sessions skip the written-brief
   ceremony, never the quality bar; real work after the tour runs the full
   method ladder.
   **The something-new path:** run Shape (instructions/shape.md) - seed the
   feature-story board (intent, first-guess workflow diagram, mood with real
   fetched references), reveal it early, and iterate together; wireframes and
   hi-fi follow once the story is agreed.
5. **Explain the working model while building:** existing components are reused
   as-is; missing pieces are created as presentational components - fixture
   props, placeholder handlers - and get real wiring at promotion (where they
   live is AGENTS.md's structure ladder). Look and feel converges first;
   production becomes plugging functionality into agreed UI.
6. **Offer a divergence.** "Want a variant of <frame> exploring a different
   direction?" One a-/b- pair teaches the variant workflow better than any
   explanation.
7. **Give the tour** (below), ending with the deep link.

## The reveal

Deliver conversationally when the first draft is ready - a short guided
message, not a manual. Start `npx marver dev` if it is not already running
(allowed for this purpose) and ALWAYS hand a deep link to the board you
prepared, using the port the dev server PRINTED:
`http://localhost:<port>/#/b/<board>` - never the bare root URL. The link goes
at the BOTTOM of the message, on its own line: the human reads through, then
clicks. The human has already played with the hosted tour by now, so keep it
short - let their own product carry the moment. The highlights, all real
features:

- **Select and preview.** Click frames (shift-click for several). Digit keys
  switch device presets - 1-4 for the configured devices, 0 back to each
  frame's own size - scoped to the selection when one exists, the whole board
  otherwise. `d` cycles light/dark the same way: selected frames, or the
  entire canvas view (frames pinned to a theme in their meta stay put).
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
- **Point at it and ask.** Comment on any element, and tag `@marver` in the
  comment. I pick the job up, edit that frame's real source while it wears a
  live working glow, and reply in the thread when it is done. That is the
  loop - point at the thing, say what you want, watch it change. (This is on;
  say so plainly, it is the feature they will use most.)
- **Share it.** `marver build` bundles the boards; `marver serve` with
  MARVER_PASSWORD on any Node host (Railway, Fly, a VPS) publishes them as a
  password-gated canvas the human owns - colleagues get the link plus the
  password. Give the serve a data volume and they get accounts and comment
  right on it, and those threads sync back into the repo (instructions/publish.md).

Close by asking what they want to design first.
