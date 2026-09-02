# Iterate - versions are nearly free, so keep them

Read this when you are about to CHANGE a frame the human has already seen, when
a round of feedback arrives on a scene they reviewed, or when a direction has
won and it is time to clean up. The rule underneath
everything: exploration is cheap here - never make the human lose a version
they might want back.

## Fork, don't overwrite

- **Meaningful direction change on a seen frame → fork a variant** (a round of
  changes across a whole scene versions the scene instead - next section). Rename the
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

## Version the scene before a round

Letters version one frame. A **round** versions the whole scene. A round is any
of: two or more open threads on one scene; one request that changes more than
one frame of a scene; the human saying "iterate", "push this further", "next
version", or asking for a change that is not a typo or a spacing polish. One
substantial comment on one frame is NOT a round - that is a letter (above).

Before the first edit of a round, snapshot the scene. One snapshot per round,
not per comment: if the newest `design/scenes/<scene>-v<N>/` is younger than
every file in the live scene (nothing changed since it was taken - a sibling
job or the previous comment took it minutes ago), the snapshot exists - skip
to step 4.

1. **Copy the scene**: `design/scenes/<scene>/` → `design/scenes/<scene>-v<N>/`
   (`v1` the first time; then the next free number), `_layout.tsx`,
   `_fixtures.ts` and nested variant directories included. Then re-point every
   id reference inside the copy from `<scene>/` to `<scene>-v<N>/`: `data-goto`
   attributes (`data-goto="<scene>/cart"` → `data-goto="<scene>-v<N>/cart"`),
   Markdown `goto:<scene>/…` links, and any scene-qualified `meta.of`. Check:
   `grep -rn "<scene>/" design/scenes/<scene>-v<N>/` returns nothing but imports.
   The archived flow then plays on its own and never leaks into the live one.
2. **Freeze what it imports.** Files INSIDE the scene folder travel with the
   copy; anything imported from outside it (`design/screens/`, the app's
   components, a CSS file) stays live - the snapshot tracks it. If the round
   will change any of those, copy them into `<scene>-v<N>/_snapshot/` and
   re-point the imports; otherwise leave a one-line note at the top of the
   version's first frame: `// v<N> tracks the live <Screen>; exact state: git`.
   Assets (`design/assets/`) stay shared - they are rarely edited in place.
3. **Pin it on the `archive` board** as its own band: a node per frame of the
   version (a board lists frames; the recipe arranges scenes), `layout.rows`
   with one lane per band, oldest version at the top, newest at the bottom,
   `{ "space": 4 }` between bands, and EVERY scene on the board named in the
   recipe with its own scene recipe (an unlisted scene falls to a trailing lane
   in default order). Create the board the first time (`"order"` high, so it
   sits last among the curated boards; `"auto": false`). Set the copied frames'
   `meta.title` to `"<title> · v<N>"` so the sidebar reads as history. The
   version also shows on `all-scenes` (it holds everything) - fine; it must NOT
   be added to any feature board or to `publish.json`.

   ```json
   { "version": 1, "name": "archive", "order": 90, "auto": false,
     "layout": {
       "rows": [ ["archive"], { "space": 4 }, ["checkout-v1"], { "space": 4 }, ["checkout-v2"] ],
       "scenes": {
         "checkout-v1": { "rows": [["cart", "payment", "confirm"]] },
         "checkout-v2": { "rows": [["cart", "payment", "confirm"]] } } },
     "nodes": [ { "frame": "archive/routines-guided" },
                { "frame": "checkout-v1/cart" }, { "frame": "checkout-v1/payment" }, { "frame": "checkout-v1/confirm" },
                { "frame": "checkout-v2/cart" }, { "frame": "checkout-v2/payment" }, { "frame": "checkout-v2/confirm" } ] }
   ```
4. **Now do the round on the live scene**, in place - the snapshot is the
   before. Keep each anchored element's tag, `data-testid` and visible text
   where you can, so pins self-heal; when a change must remove an anchored
   element, reply and close that thread FIRST, then make the change (resolve
   first, restructure second). Reply per thread with one line: what changed,
   and that `v<N>` is on the archive board. Who closes the thread depends on
   how the work arrived: from the CLI queue (`comments list --open`), you
   resolve with `--addressed-in <scene>/<frame>`; from a comment-born jam job,
   you never resolve - the owner does (instructions/jam.md).

Never wait for the human to ask for this. They should be able to say "make the
cards denser", "drop the sidebar", "try a warmer palette" three times in a row
and know every state is one board away: rollback is a copy back, the archive
bands are the proof of work they show a collaborator, and the before/after of
every comment is visible on the canvas rather than buried in a diff.

**Git rides along.** At the first snapshot of a session, offer once: "I'll commit
each version to git as well - ok?" If yes, two commits per version, staging ONLY
the paths the round touched (never `git add design` wholesale - the human may
have work in flight there; never a push):
`git add design/scenes/<scene>-v<N> design/boards/archive.json && git commit -m "design(<scene>): v<N> snapshot"`
and, after the round, `git add design/scenes/<scene> design/boards design/comments && git commit -m "design(<scene>): <the round, in a few words>"`.
Not a git repo, or the human declines: the archive board alone carries it.

Choosing between the two: one frame, one competing direction → a letter. A round
→ a version. They compose - a version can hold a variant run.

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
2. **Look sideways before you touch anything.** A pin marks where the human
   NOTICED the problem, not the only place it lives. Siblings are the LIVE
   frames on the board the comment names (on `all-scenes`, the frames of the
   pinned frame's own scene and its feature board) that share the component,
   the pattern, the copy or the state: the other steps of the flow, the sibling
   states, the variants. Never `archive/` and never a `<scene>-v<N>` version -
   history is not a sibling. Same defect there (the same element or pattern
   showing the same problem)? Fix it in the same pass and name the frames in
   your reply ("also applied to cart, payment, confirm"). A judgment call - a
   change that could be wanted here and not there? Do the pinned one, then ask
   in the thread: "the same pattern is in cart and confirm - roll it out there
   too?" and leave the thread open until answered. Fixing one frame and leaving
   its siblings wrong is the failure mode; asking is never the failure mode.
3. **Keep a before.** A round on a scene: snapshot the scene first (above) and
   iterate the live frames in place. A single frame going in a new direction:
   fork a variant (the letter convention) and iterate there - the commented
   frame stays as the before, your variant is the after.
4. **Resolve with the receipt.** `--addressed-in <the-new-variant>` records
   WHICH frame answered the feedback - the thread becomes an auditable link
   from complaint to fix. Reply first when the change deserves a sentence of
   explanation; resolve silently only for trivial mechanical fixes.
5. **Never resolve what you didn't address.** Disagree? Reply with your
   reasoning and leave the thread open - the human closes debates, you close
   completed work.
6. **A frame with open comments is load-bearing - never delete, rename, or
   gut it.** Its threads are anchored to elements INSIDE it; restructure the
   frame and the anchors strand (a dead anchor parks the pin at the frame
   edge; deleting the whole frame strands the thread off-canvas entirely -
   never lost from the log, but invisible until the frame returns). So: with a
   version snapshot taken, edit the live frame and resolve each thread right
   after its change, so no pin sits stranded; without one, fork the variant
   and iterate THERE, leave the commented frame untouched as the before, and
   only once you `resolve --addressed-in <variant>` its threads may it move to
   `archive/`. Resolve first, restructure second - never the reverse. Check `comments list --board <b>` (no `--open`) to see resolved
   threads too; the full history lives in the append-only log and in git.
