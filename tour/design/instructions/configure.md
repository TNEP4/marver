<!-- marver:managed e0947f3c7628bd124a6b2f584a96fed83d443fb6063f27f1abb81f6b6a833170 - edit freely: init preserves your edits and stages upstream updates at design/.local/latest/ for you to merge. Delete this line to detach this file from updates entirely. -->
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
5. **Live Jam names you**: `jam.agent` in `design/config.ts` is the tool YOU are
   (`"claude"` for Claude Code, `"codex"` for Codex). Jam is on by default and init
   guessed from env markers and PATH - on a machine with both CLIs installed that guess
   can be wrong, and then every `@marver` comment is answered by the other tool. Fix the
   line and tell the human. Details, including the off switch: instructions/jam.md.
6. **The canvas looks like the product** (identity): in the Mac app's tab, on its Home
   card and in the sidebar, a canvas wears its name and its logo - left alone it is the
   folder's name and the Marver mark, like every other canvas there (`marver dev`'s boot
   line says so). So:
   - `name` in `design/config.ts` is the product's human name - "TMS Broker", not
     "tms-broker". A config a current `marver init` wrote has a first guess from
     package.json, else the folder (`my-repo` -> "My repo"): make it real - the boot line does not ask
     about a guess. An older config has no `name` line, and re-running init never adds
     one - add it yourself. 80 characters at most.
   - `design/logo.svg` is the product's REAL mark - find it in the app (`public/`,
     `src/assets/`, the favicon) and copy it in; draw a simple one only when the app
     truly has none, and tell the human. A regular file in the repo (never a symlink),
     an SVG, PNG or ICO of at most 256 KB; `logo: "path"` in the config names another.
     With no `logo` in the config, the canvas takes the first of design/logo.svg|png,
     public/logo.svg|png and public/favicon.svg|png|ico, else the Marver mark: check that
     what it found is the product's mark.
   - Boards, folders and frames carry titles written for people ("iPad landscape",
     "Checkout - empty cart"), never a slug ("Ipad-landscape").
   - Custom breakpoints read well: `viewports.<name>` takes a `label` and an `icon` (a
     built-in glyph or a repo .svg) - see the Frames section of AGENTS.md. A name like
     `ipad-landscape` needs neither: it already shows as "iPad landscape" with the tablet
     glyph turned.
   - `name`, `logo` and a viewport's `label` and `icon` are read when `marver dev` starts:
     the running canvas keeps its old name and icons until it starts again (a new
     `design/logo.svg` shows at once). Tell the human to stop and start `marver dev`
     when it suits them. Never restart it yourself while they are on the canvas. Its
     terminal then names anything ignored (`[marver] design/config.ts: ...` for a name, label or icon;
     `marver: logo <path> is ignored: ...` for a logo, when the canvas or the app first asks for it), and its
     boot line stops asking for a name and a logo once both are set.
   `share.name` / `share.logo` still work (`name` / `logo` win); nothing needs rewriting.

All six true → idle state. Go design.

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

On a canvas gated by Marver Sign In there are no per-engineer CLI accounts:
identity accounts have no password to connect with. The repo connects once with
the canvas's `MARVER_CLI_TOKEN`, acting as the owner - see instructions/publish.md.

## Dev identity (who comments render as)

`marver dev` resolves the local author from `design/.local/` - never invent or
edit these by hand; point the human at the UI instead:

- `profile.json` `{name, email?, avatar?}` - set from the composer: click your
  avatar next to any comment input, fill name + photo. Stays on this machine.
- `collab.json` - once connected, the connect account wins name + email (the
  published server validates authors); the local photo still applies.
- Unset → comments render as "You" with a green Y avatar.

The same identity stamps Live Jam: Marver's replies are authored by this
profile + `agent:true`, and the provenance tooltip's "Dev user" row shows the
profile name - so a proper profile makes agent work attributable too.

## When it breaks mid-project

Frames suddenly unstyled → the theme import path moved: fix `design/theme.css`.
New app components not resolving → the alias changed: fix the frame imports and tell
the human AGENTS.md's UI line is stale. Never work around a broken idle state with
hand-rolled CSS - that is how throwaway styling metastasizes.
