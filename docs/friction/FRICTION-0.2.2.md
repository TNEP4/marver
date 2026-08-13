# FRICTION: `@marver-design/marver@0.2.2` (design-session pass)

Blunt log, as asked. Written while doing the actual job (upgrade, then rebuild the
hero) rather than while auditing the release, so it records where the tool and this
repo got in the way of work.

## Read this first: there are now two logs for 0.2.2

You asked for `FRICTION-0.2.2.md`. The repo convention (and a **parallel Claude
session that was committing to this repo while I worked**) produced
`FRICTION-v0.2.2.md`, with the `v`. Both files now exist and neither is wrong.

- `FRICTION-v0.2.2.md` holds the other session's release audit: N1 to N7, `npm pack`
  diff of 0.2.1 vs 0.2.2, the managed-file mechanism, the update pill.
- `FRICTION-0.2.2.md` is this file: what broke while USING 0.2.2 to design.

They do not overlap. **Merge them into `FRICTION-v0.2.2.md` and delete this
filename**, or rename this one, but do not leave the repo with two logs for one
version. That is exactly the mess the one-log-per-version convention exists to stop.
I did not touch `README.md` or `AGENTS.md` because the other session owns them right
now and both were rewritten at 15:06, mid-task.

---

## 1. A second agent was writing to this repo the whole time 🔴

Not a Marver bug. The most expensive thing that happened, so it goes first.

Timeline, all today:

```
14:33  e82e1cf  initial commit (the state I was briefed on)
14:52  I run `npx marver init` → it creates design/scenes/demo/ (3 frames)
14:52  I ls design/scenes/demo/ → _fixtures.ts, dark.tsx, form.tsx, welcome.tsx
14:54  design/scenes/demo/ is GONE. I did not delete it.
14:55  8ea838e  "Deploy infra: Vercel … Railway" (not mine)
14:55  `npm run design` appears on :5199, parent PID 1 (not mine)
15:06  2e205a4  "Friction log for 0.2.2; freeze 0.2.1" (not mine)
```

Cost: I read `dist/init-*.mjs`, `dist/dev-*.mjs` and `dist/plugin-*.mjs` line by line
to work out how `init` could be deleting frame files, and proved it cannot. `init`
only ever does `if (opts.demo && !existsSync(scenes/demo)) cpSync(...)`. The three
`rmSync` sites in the shipped bundle touch `design/.local/latest/*`, `*.tmp`, and
`instructions/setup.md`. Nothing in the package deletes a scene. The other session
deleted it, per the upgrade recipe it then wrote into `AGENTS.md`.

Second-order damage: my `init` re-created the demo scene the other session had just
deleted, and I deleted it again. Two agents fighting over the same three template
files.

**What I want:** if two sessions are going to share a repo, say so in the brief. If
that is not controllable, `marver dev` should refuse or warn when another instance
is already serving the same root (see #7).

## 2. `init` breaks typechecking for the whole `design/` folder 🔴

Reproducible, and the most concrete tool bug I found.

`init` patches the host `tsconfig.json`:

```
patched tsconfig.json (the only host file touched):
  + "design" added to "exclude"  (revert this line to fully uninstall)
```

`design/tsconfig.json` (also written by `init`) does `"extends": "../tsconfig.json"`.
TypeScript resolves a base config's relative `exclude` against the base file's
directory, so `"design"` arrives in the design project as `"../design"`, which is
the design project itself.

```
$ npx tsc -p design/tsconfig.json --noEmit
error TS18003: No inputs were found in config file
'/Users/nictouron/marver-site/design/tsconfig.json'. Specified 'include' paths were
'["."]' and 'exclude' paths were '["../design","../node_modules"]'.
```

So after upgrading, **nothing typechecks the frames**: the root project excludes
`design/`, and the design project excludes itself. I had to typecheck my frames
through a hand-written override config in `/tmp` to know they compiled.

**Fix:** `templates/design-tsconfig.json` should set `"exclude": []` explicitly (or
list only `node_modules`), so the host's exclude cannot leak in through `extends`.
One line.

## 3. The idle-state checklist requires a file `init` never creates 🟠

`design/instructions/configure.md` defines the idle state as four things, item 3:

> **Brand documented**: `design/DESIGN.md` exists and matches the app's tokens.
> Without it, every hi-fi session re-derives the brand and drifts.

`init` has now run four times in this repo and has never created it, mentioned it, or
warned that the checklist fails. A binding checklist whose items the scaffolder
silently leaves unmet trains you to skip the checklist. I wrote `design/DESIGN.md` by
hand from `src/app/globals.css`.

**Fix:** either stub it at `init` from the detected theme, or print
`idle state: 3/4 (no design/DESIGN.md)` at `dev` boot.

## 4. The method has no unattended path 🟠

The new binding method is the best thing in this release, and it assumes a human is
in the room. Two places stop the work cold:

- `design/AGENTS.md`: *"Unsure which phase you are in? Ask the human, one question
  beats a phase of wrong work."*
- `design/instructions/discover.md`: *"nothing gets designed until the brief has a
  human nod."*

I was explicitly told not to ask. The contract has no documented fallback, so I
invented one: write the brief anyway, stamp it "written without a human nod, treat
every line as a decision made for him", and proceed to Build. It is in
`design/scenes/hero/_brief.md`.

**Fix:** one paragraph in `discover.md` on what an unattended run should do. Every
coding agent runs unattended some of the time, and the tool's whole premise is that
the agent is the designer.

## 5. A new npm import in a frame renders a blank white frame 🟠

Adding `lucide-react` to a frame's dependency graph gave me a fully white frame and
one console line:

```
Failed to load resource: the server responded with a status of 504 (Outdated Optimize Dep)
```

No error card. The frame host has a good one (`fail()` renders "frame failed" with the
file path) but a Vite dep re-optimization 504 does not route through it, so the canvas
shows a confident empty page. A reload fixes it permanently.

This is the same failure *shape* as 0.2.0 #22: the canvas rendered something that was
not the file, with no signal. It cost less because it was blank rather than plausible,
but a blank frame after an edit reads as "my code is broken", and I went looking in my
component first.

**Fix:** treat a 504 from the dep optimizer as a boot failure and render the error
card, or reload the iframe once automatically.

## 6. `eslint` now lints Marver's own build output 🟡

`init` taught `tsconfig.json` to ignore `design/`, but nothing tells eslint. Running
the repo's own lint over the design folder produces about 40 warnings from
`design/.dist/assets/*.js`, which is Marver's minified client bundle.

```
$ npx eslint src design
design/.dist/assets/client-Lwtj1gMx.js
  1:334  warning  Expected an assignment or function call … @typescript-eslint/no-unused-expressions
  … ~40 more
```

`design/.gitignore` already lists `.dist/`. The same two lines belong in whatever
lint config the host uses, or `.dist/` should live somewhere tools ignore by default.

## 7. Two canvases, one board file, no warning 🟠

`marver dev` found 5199 busy and quietly took 5200:

```
Port 5199 is in use, trying another one...
  marver canvas → http://localhost:5200/
```

Both processes were serving **the same repo**, and both own `design/boards/website.json`
(it is `auto: true`, so the shell rewrites it whenever frames change). `AGENTS.md`
says "do not edit `design/boards/*.json` while the canvas is open; the shell owns
them". The shell is happy to be two shells. I avoided the collision by never
touching board files.

**Fix:** on startup, if another `marver dev` is already serving this root, say so.
"another canvas is serving this repo on :5199" is one line and would have told me
about the parallel session 20 minutes earlier.

## 8. `--no-demo` still prints `(default: true)` 🟡

Unchanged from the 0.2.1 log (#9). Verbatim:

```
--no-demo      Skip the demo scene (the demo ships unless this flag is passed) (default: true)
```

Still one sentence saying both "skip the demo" and "default: true".

## 9. The brief did not match the repo 🟡

Recorded so nobody reads it as a regression later. I was asked to fix "our hero
frames", which "feel underwhelming, too generic". There were no hero frames:
`design/scenes/` held only `_layout.tsx`, and `AGENTS.md` says the previous
exploration was "deliberately cleared to start fresh". The three named directions
survive only as a nine-line array in `src/app/page.tsx`.

I judged those three from that array plus `theme-scope.tsx`, picked one, and built
it. Reasoning is in `design/scenes/hero/_brief.md`. If the intent was "improve the
frames I am looking at", they are not on disk and I did not restore them from git.

## 10. Not friction, a brand finding

The shipped `--primary` / `--primary-foreground` pair measures **3.88:1** for button
label text in light theme (14px/500, white on `oklch(0.52 0.215 276)`). That clears
the 3:1 bar `color.md` sets for meaningful controls and misses the 4.5:1 bar for text.
Dark theme is fine at 8.93:1.

I did not change it. `brand.md` Path A says a shipped brand gets documented, not
trimmed, and the accent is a decision that is yours. Every other text pair in the
hero passes in both themes: body 5.43 / 6.76, metadata 5.34 / 7.32, frame label
5.84 / 7.31, code 16.98 / 13.75, h1 18.71 / 15.73.

## What I did not verify

Stated plainly, per `instructions/review.md`.

- **The `Copied` success state.** Headless Chromium denies clipboard access, so every
  click landed in the failure branch. I verified the failure path renders, announces
  through `aria-live`, and no longer overlaps the line beneath it. The success path is
  code-reviewed only.
- **Play mode (`P`), tidy (`t`), the device hotkeys, and the theme toggle (`d`)** as
  keystrokes. I drove the frame host URL directly and set `theme` and viewport myself.
- **0.2.1 entries #20 (rename bricks the canvas), #23 (selection toolbar), #15
  (tombstones), N3, N4, N5.** All need canvas interaction; the other session's
  `FRICTION-v0.2.2.md` re-tested them.
- **`marver build` / `marver serve`.** Out of scope and I was told not to publish.

## Still good

The managed-file mechanism earns its release. `init` told me my `design/AGENTS.md`
predated managed regeneration, I deleted it, re-ran, and got a contract with a content
hash and a documented merge path. The phase files are short, opinionated, and
specific enough to argue with, which is the only useful kind. `reference/slop.md` is
the first list of AI design tells I have read that names things I actually do.
`instructions/tune.md`'s "bolder should look MORE like the same brand, not less" is
the sentence that produced this hero.
