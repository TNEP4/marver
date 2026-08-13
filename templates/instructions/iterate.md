# Iterate - versions are nearly free, so keep them

Read this when you are about to CHANGE a frame the human has already seen, or
when a direction has won and it is time to clean up. The rule underneath
everything: exploration is cheap here - never make the human lose a version
they might want back.

## Fork, don't overwrite

- **Meaningful direction change on a seen frame → fork a variant.** Rename the
  current file to `a-<direction>.tsx`, write the new take as `b-<direction>.tsx`
  (nested dir when the scene is busy: `checkout/payment/a-card.tsx`). The
  canvas badges them, keeps them together, and `[` `]` swaps them in place in
  play mode - the human compares in seconds and nothing is lost.
- **Successive iterations are variants too.** "v2 of the hero" is just another
  letter: `c-tighter.tsx`. Simultaneous alternatives and successive versions
  use the same mechanism - letters carry the order, names carry the idea.
- **Polish in place** for small refinements (spacing, copy, states): git holds
  the fine-grained history; letters are for DIRECTIONS, not typo fixes.
- Name variants for the idea, never the sequence alone: `b-editorial.tsx`
  beats `b-v2.tsx` - three weeks later, "editorial" still means something.

## Keep the working set live

Divergences stay on the board while a decision is open - visible, comparable,
playable. Never silently delete an exploration the human has seen; the human
decides what dies, you decide when to ask.

## The cleanup ritual - when a path wins

The human picks a direction; then, in one pass:

1. **The winner takes the clean name.** Drop its letter prefix (or promote it
   over the original file); update goto targets pointing at old ids.
2. **The losers move to `design/scenes/archive/`** - never deleted, RELABELED:
   filename `<feature>-<direction>.tsx`, meta.title saying exactly what it was
   and why it retired, e.g.
   `{ title: "Routines editor - guided steps (retired: sentence canvas won, sharper mental model)" }`.
   A one-line comment at the top of the file carries any longer why. That
   sentence is the learning - write it while the reason is fresh.
3. **The `archive` board stays clean and organized:** a curated board over the
   archive scene, tidied with a layout recipe, grouped by feature. Anyone
   opening it should know what every frame was without asking.
4. **The main boards show winners only.** A feature board after cleanup holds
   the kept path; the archive holds the rest. In-between states are fine WHILE
   deciding - the ritual is what ends them.

Archived frames are history, not options: never link them from live flows,
never count them as current design. They exist so "what did we try for the
editor?" has a visual answer.

## Comments are your work queue

When collaboration is on, humans pin comments to specific elements inside
frames. Those threads are addressed to YOU as much as to the designer - treat
the open list as a queue:

```bash
npx marver comments list --open --json     # what needs you (anchors included)
npx marver comments reply <thread> --body "…"
npx marver comments resolve <thread> --addressed-in <scene/frame>
```

The discipline:

1. **Read the anchor before the words.** Each thread carries the element it
   points at - tag, quote, source hint, position. "Too cramped" pinned to a
   button is a different task than "too cramped" on the whole frame.
2. **Fork, don't overwrite.** Address feedback by creating a NEW variant of the
   frame (the letter convention above) and iterating there. The commented
   frame stays as the before; your variant is the after.
3. **Resolve with the receipt.** `--addressed-in <the-new-variant>` records
   WHICH frame answered the feedback - the thread becomes an auditable link
   from complaint to fix. Reply first when the change deserves a sentence of
   explanation; resolve silently only for trivial mechanical fixes.
4. **Never resolve what you didn't address.** Disagree? Reply with your
   reasoning and leave the thread open - the human closes debates, you close
   completed work.
