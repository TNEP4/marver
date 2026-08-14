# Configure - reach the idle state, once per repo

The idle state is marver fully wired into THIS repo: frames render with the app's
real theme, the app's components import cleanly, and the brand is documented. Every
design session assumes it. Verify it on your first session in a repo, or whenever
frames render suspiciously unstyled - then never think about it again.

## The idle-state checklist

1. **Theme wired**: `design/theme.css` exists and imports the app's real stylesheet.
   Proof: the demo/existing frames render styled on the canvas, not as bare HTML.
2. **Components importable**: the import alias in AGENTS.md's UI line actually
   resolves (open one app component from a frame and render it).
3. **Brand documented**: `design/DESIGN.md` exists and matches the
   app's tokens (see brand.md Path A). Without it, every hi-fi session re-derives
   the brand and drifts.
4. **Manifest honest**: `design/manifest.json` lists what is really on disk.

All four true → idle state. Go design.

## By repo maturity

The human's first session layers on top of this: philosophy, their product on the
canvas, the tour - that flow lives in instructions/welcome.md, run it alongside.

- **Brand-new repo (no app)**: `design/instructions/setup.md` exists and is the
  authority - follow it (set up the stack WITH the human, re-run init). Do not
  design against a repo that has nothing to build from.
- **Fresh repo (app scaffolded, little product code)**: init's detection is usually
  right. Verify the checklist, create DESIGN.md from the starter tokens (Path A -
  even a default shadcn theme is a documentable brand), and note in it which parts
  are placeholder so Brand can revisit deliberately.
- **Old repo (mature app)**: detection may have picked the wrong stylesheet or missed
  the real component library. Read the app's entry point and layout to find the TRUE
  theme entry; fix `design/theme.css`'s import if init guessed wrong. Map the real
  component library (where do buttons actually live?) and correct AGENTS.md's UI
  line if needed (delete its marker line first to take ownership, or ask the human
  to re-run `npx marver init` after fixing `components.json`). Old repos often have
  several half-brands - document the one the app actually ships in DESIGN.md and
  name the others as legacy.

## Working with teammates (branches, merges, a second engineer)

The whole `design/` folder is git-tracked - boards, scenes, comment logs, the
publish policy, these instructions. Only `design/.local/` (this machine's
connect credential) and `design/.dist/` (built on the host) are ignored. So a
teammate gets the exact canvas by pulling the branch: `pnpm install` →
`npx marver dev`. Nothing else to sync.

How the three kinds of design state merge across branches:

- **Comment logs (`design/comments/*.jsonl`) merge themselves.** They're
  append-only and keyed by event id, and init writes a `merge=union` git
  attribute for them - two branches that both collected feedback union
  cleanly, no conflict. Even a hand-botched merge self-heals: replay dedupes
  by id. This is the point of the event-log design - multiplayer comments
  Just Work through plain git.
- **Scenes (`design/scenes/**.tsx`) merge like any code** - they're React
  components. Standard review, standard conflicts.
- **Boards (`design/boards/*.json`) are the one friction** - they're node
  positions, so two people rearranging the same board conflict on x/y. It's
  cosmetic: take either side and re-run Tidy, or give features their own
  boards so layouts don't overlap. Never let a boards conflict block a merge.

If collaboration is deployed, each engineer runs `marver comments connect
<url>` ONCE with their own account (the owner invites them) to get the live
cloud sync on top of git. Git carries the committed comments; `connect` adds
the real-time stream from published viewers.

## When it breaks mid-project

Frames suddenly unstyled → the theme import path moved: fix `design/theme.css`.
New app components not resolving → the alias changed: fix the frame imports and tell
the human AGENTS.md's UI line is stale. Never work around a broken idle state with
hand-rolled CSS - that is how throwaway styling metastasizes.
