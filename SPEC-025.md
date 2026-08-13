# SPEC-025 - Onboarding: the first session is a conversation

Status: LOCKED (Nic, 2026-08-13). Source: 0.2.3 cold-start dogfood - the agent
scaffolded Next.js without asking, never explained marver, never gave a tour.
Mechanically flawless, humanly mute.

## The defect

Onboarding today is a command list. The agent executes it silently and the human
watches files appear. Three things are missing, in both entry paths:

1. **Consent** - the stack is the human's decision. setup.md "blesses" Next.js
   unconditionally; nobody is asked what they're building.
2. **Philosophy** - the human is never told WHY marver works this way (design with
   real code blocks → promotion is assembly, not rewrite). Without the why, the
   canvas looks like a toy.
3. **The tour** - after setup the agent says "done" and stops. The human is left
   at a bare localhost URL with no idea what the canvas can do.

## Doctrine: narrate and teach

First sessions are teaching sessions. The agent explains what it is doing and why
as it goes - short, plain sentences, no jargon-dumps. The human should end the
first session understanding both their repo and the tool. This is contract text
(AGENTS.md), not a suggestion.

## Path A - empty repo (setup.md, regenerated SETUP_MD)

Flow, in order. Steps 1-2 are STOP points: ask, then wait for the human.

STOP semantics (both paths, codex round 1): "STOP" means ask, make NO further
tool calls, end the turn, resume only after the human replies. The unattended
fallback (assume, mark UNCONFIRMED, surface first) applies ONLY when the human
explicitly asked for unattended execution.

0. **Greet the empty repo.** "Empty repo - perfect starting point." Then the
   philosophy, ~4 sentences: marver co-designs the UX with you in real code;
   the theme, components, and screens we make while designing ARE the app's
   building blocks; when we later wire the real app, ~90% of the UI work is
   already done - only functionality remains; goal: full alignment on look and
   feel across light/dark and every device size before writing app logic.
1. **Ask what they're building.** One question: "In a sentence or two - what are
   we building?" STOP.
2. **Propose the stack, get the nod.** From their answer, recommend a framework
   with one line of reasoning each (marketing/content/SEO → latest Next.js;
   app-like/interactive → latest React Router; something else if their answer
   calls for it). If web search is available, verify current major versions
   first - never let search stall the flow. shadcn/ui + latest Tailwind are the
   recommended default, NOT a requirement (Nic, 2026-08-13): the human's choice
   of component layer wins, and marver adapts to whatever detection finds.
   Close with "aligned, or tell me what you'd rather use." STOP.
3. **Scaffold and verify.** Scaffold the agreed stack (temp-dir merge mechanics
   preserved from the current template - scaffolders refuse non-empty dirs),
   install, wire shadcn, then START the dev server and verify it renders before
   moving on. Fetch the framework's docs when unsure; narrate each step in one
   line.
4. **Re-run `npx marver init`.** Detection now sees the real stack; setup.md
   deletes itself; AGENTS.md regenerates. Init refreshes the write-once files
   the no-app run shaped blind (providers.tsx, design/tsconfig.json) when they
   are still byte-pristine - an edited file is never overwritten (codex #3).
   Verify wiring: frames styled, one app component imports.
5. **The first draft - the quality bar (Nic).** This is both the human's first
   impression of marver AND the first draft of their product; it sets the
   direction, so it must impress - the generic demo scene gets deleted. Take
   the time: research the domain briefly (web search when available), write
   DESIGN.md as a reasonable brand, build ~4 frames of THEIR product to the
   craft bar (craft.md + reference/slop.md binding), responsive, both themes,
   linked with data-goto, on a curated board. Offer one a-/b- variant
   divergence to teach the workflow. First sessions skip the written-brief
   ceremony, never the quality bar.
6. **The tour** (instructions/welcome.md). Start `npx marver dev` if not
   running (the contract's one allowed canvas touch) and hand the deep link
   using the PRINTED port - `http://localhost:<port>/#/b/<board>` - never a
   bare localhost root.

## Path B - existing codebase (first session, instructions/welcome.md)

1. **Say what the app is.** Read the repo; state your understanding of the
   product in 2-3 sentences; confirm with the human.
2. **Confirm the stack aloud - what detection ACTUALLY found** (codex #8), not
   a canned Tailwind+shadcn sentence. Corrections happen here, cheaply
   (configure.md's old-repo checklist).
3. **Demo scenes from THEIR screens - to the same quality bar as Path A
   step 5.** Recreate 3-4 existing screens as frames using the app's real
   components, linked with data-goto so play mode works, both themes,
   responsive, on a curated board, with the variant offer. The first thing the
   human sees on the canvas is their own product, looking good.
4. **Explain the working model** while doing it: existing components get reused;
   missing ones get created dumb - fixture props, placeholder handlers - and
   promoted later with real wiring; the point is aligning look and feel across
   devices and themes BEFORE building, so production is plugging functionality
   into agreed UI.
5. **The tour** - same script, same deep link rule.

## The tour script (instructions/welcome.md, shared by both paths)

Deliver conversationally after setup, with the `#/b/<board>` link. Claims must
all be true in the shipped version:

- Select one or many frames; device presets via digits (1-4 configured devices,
  0 = each frame's own size) or the floating bar - scoped to the selection when
  one exists, whole board otherwise.
- `d` cycles light/dark the same way: selected frames, or the whole canvas view.
- Double-click a frame → interact mode (purple ring): a live, clickable frame.
- `p` = play mode: full-screen prototype; data-goto flows work; `[` and `]`
  switch variants in place; device switching inside play, including fill.
- Variants: letter-prefixed sibling files form A/B groups - the canvas keeps
  them contiguous, badges them, makes exploring alternatives cheap.
- `t` re-tidies; boards can carry a `layout` recipe (boards.md).
- Publishing: `marver build` + `marver serve` with MARVER_PASSWORD on any Node
  host = a password-gated canvas THEY own (codex #7: a bare static host has no
  gate). Comments are coming soon.

## Touched files

| File | Change |
|---|---|
| `src/cli/init.ts` SETUP_MD | Rewrite to Path A flow (steps 0-6, two STOPs) |
| `templates/instructions/welcome.md` | NEW - philosophy, Path B flow, tour script |
| `templates/AGENTS-{studio,embedded}.md` | Method table row: first session with the human → welcome.md; one narrate-and-teach line |
| `templates/instructions/configure.md` | Maturity section points first sessions at welcome.md |

## Acceptance (dogfood, fresh agent, empty repo)

- Agent explains philosophy BEFORE any scaffold command.
- Agent asks what's being built, and STOPS.
- Agent proposes a stack with reasoning tied to the answer, and STOPS.
- After the nod: scaffold → dev server verified → re-init → DESIGN.md → tailored
  demo → tour message ending in a `#/b/` deep link.
- Zero tour claims that aren't real features.

## Codex round 1 disposition

Accepted as specified above: #1 STOP semantics, #3 transition refresh of
pristine write-once files + stale-setup.md refresh (#10's migration half),
#4 board + printed port + dev-start allowance, #5 bounded ceremony exception,
#6 mode-neutral promotion wording, #7 truthful publish claim, #8 detection-
honest narration, #9 truthful digits. Declined as machinery: #2's dedicated
onboarding presence-file - welcome.md instead self-checks against existing
durable markers (DESIGN.md, curated board); #3's stronger noApp() definition -
the flow scaffolds the framework before shadcn, so single-signal flips do not
occur in practice.

## Non-goals

- No new CLI flags, no interactive prompts in `init` itself - the CONVERSATION
  lives in the agent contract, the CLI stays dumb and idempotent.
- No comments feature (that is SPEC-M3); the tour only teases it.
