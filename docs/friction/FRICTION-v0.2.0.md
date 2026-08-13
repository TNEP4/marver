# FRICTION — `@marver-design/marver@0.2.0`

> **Frozen.** This file is the friction log as written against **0.2.0** and is kept
> unedited as the historical record. Do not add new findings here.
>
> Most of it has since been fixed. The current log — including a re-test of every
> entry below against the shipped fix — is **[FRICTION-v0.2.1.md](./FRICTION-v0.2.1.md)**.

A deliberately blunt log of every place Marver confused me, its docs failed to
answer a question, behavior diverged from what was written, or I had to read
`node_modules/@marver-design/marver` source to make progress.

Written by a coding agent (Claude) using the tool cold, building the real
marver.design marketing site. Line references are to the published `0.2.0`
bundle, so they should map directly onto source.

Format per entry: **Expected → Happened → Cost → Fix I'd want**. Where I could
not reproduce something or could not pin a mechanism, I say so rather than
guessing — every claim below is either measured or cited to a file and line.

Severity: 🔴 blocks or silently degrades the core promise · 🟠 costs real time ·
🟡 papercut.

## Environment

| | |
|---|---|
| Marver | `@marver-design/marver@0.2.0` (CLI self-reports `0.1.0` — see #8) |
| Stack | Next.js 16.3.0 · React 19.2.8 · Tailwind v4.3.3 · shadcn/ui 4.16.2 (`base-nova`, base-ui) |
| Node / npm | v22.23.1 / 10.9.8 |
| OS | macOS (darwin 25.6.0), Chrome |
| Repo at start | **completely empty** — `.git` only. See #1, which is the origin of much of what follows. |

## Index

| # | Sev | Issue | Where it bites |
|---|---|---|---|
| [1](#-1-init-succeeds-in-an-empty-repo-and-that-is-the-trap) | 🔴 | `init` succeeds in an empty repo and hands the agent a fictional contract | First run |
| [2](#-2-tailwind-v4--nextjs-is-broken-by-default-and-the-warning-is-buried) | 🔴 | Tailwind v4 + Next.js needs `@tailwindcss/vite`; silent degrade | First run |
| [3](#-3-dark-mode-does-not-reach-shadcn-components) | 🔴 | `data-theme` never meets shadcn's `.dark`; `d` does nothing | Daily |
| [19](#-19-there-is-no-concept-of-these-frames-are-versions-of-the-same-thing) | 🔴 | No concept of "versions of the same thing" | Core workflow |
| [20](#-20-renaming-or-moving-a-frame-file-bricks-every-open-canvas--and-only-a-new-tab-recovers-it) | 🔴 | Renames **and dev-server restarts** brick open canvases; only a new tab recovers | Daily |
| [22](#-22-new-frame-files-get-no-tailwind-classes-until-you-restart-the-dev-server) | 🔴 | New frames silently render without their Tailwind classes | Every new frame |
| [4](#-4-designtsconfigjson-extends-a-file-that-init-does-not-create) | 🟠 | `design/tsconfig.json` extends a file `init` never creates | First run |
| [5](#-5-three-different-contradicting-answers-to-where-does-the-theme-go) | 🟠 | Three contradicting answers to "where does the theme go?" | First run |
| [6](#-6-agentsmd-tells-me-to-read-a-manifest-that-does-not-exist-yet) | 🟠 | `AGENTS.md` points at a manifest `init` doesn't write | First run |
| [15](#-15-the-auto-managed-board-keeps-dead-frames-forever) | 🟠 | "Auto-managed" board keeps dead-frame tombstones forever | After deletes |
| [16](#-16-boards-auto-lay-out-into-a-column-which-is-the-opposite-of-what-boards-are-for) | 🟠 | Boards auto-lay-out into a column; `x`/`y` undocumented | Comparisons |
| [21](#-21-marvers-dev-server-watches-next-and-storms-on-every-app-build) | 🟠 | Watcher storms on `.next/` during app builds | Daily |
| [23](#-23-the-selection-toolbar-has-no-collision-handling-and-can-land-on-top-of-the-frame) | 🟠 | Selection toolbar has no collision handling | Daily |
| [7](#-7-readme-links-to-two-documents-nobody-can-read) | 🟡 | README links to SPEC.md / DECISIONS.md that don't ship | Docs |
| [8](#-8-the-cli-reports-the-wrong-version) | 🟡 | CLI reports `0.1.0` for a `0.2.0` package | Bug reports |
| [9](#-9---no-demo-default-true-is-unreadable) | 🟡 | `--no-demo (default: true)` is ambiguous | First run |
| [10](#-10-nextjs-support-is-partial-and-it-says-so-exactly-once) | 🟡 | "Next.js support is partial" said exactly once, at `init` | Next.js users |
| [11](#-11-nextfont-silently-does-not-exist-inside-frames) | 🟡 | `next/font` silently absent in frames; canvas lies about type | Next.js users |
| [12](#-12-sourcemap-noise-from-marvers-own-dependency) | 🟡 | ~35 lines of sourcemap noise buries real warnings | Every start |
| [13](#-13-module_typeless_package_json-warning-on-every-start) | 🟡 | `MODULE_TYPELESS_PACKAGE_JSON` on every start | Every start |
| [14](#-14-stale-404-on-a-board-the-readme-says-is-auto-managed) | 🟡 | 404 on `all-scenes` in a clean console | Every start |
| [17](#-17-marver-serve-crashes-with-a-raw-node-stack-trace-on-a-busy-port) | 🟡 | `serve` crashes with raw Node stack on busy port (`dev` retries) | Publishing |
| [18](#-18-marver-serve-prints-nothing-at-all-on-success) | 🟡 | `serve` prints nothing on success | Publishing |

## If you fix five things, fix these

1. **#22** — new frames render without their Tailwind classes. The only bug here
   that *lies*: it shows a confident, complete design that is not the one in the
   file. Aimed squarely at the core loop of an agent-native tool.
2. **#20** — renames and dev-server restarts brick every open canvas, and no
   in-app recovery works (not even a hard reload). Hit three separate times in
   one session.
3. **#1** — `init` succeeding in an empty repo cost me three fully-written
   landing pages built on nothing. The tool's happy path led straight there.
4. **#2 + #3** — the blessed stack (Next + Tailwind v4 + shadcn, all of which
   `init` detects) is misconfigured and dark-mode-broken out of the box.
5. **#19** — no first-class way to express "these are versions of the same
   thing", which is the activity boards exist for.

---

## 🔴 1. `init` succeeds in an empty repo, and that is the trap

**Expected:** A tool whose pitch is "a canvas of live frames built from your
app's **real components and theme**" to check that there is an app, and stop me
if there isn't.

**Happened:** `npx marver init` in a repo containing nothing but `.git` and a
bare `npm init -y` package.json printed a cheerful success block and scaffolded
the whole `design/` tree. One line scrolled by:

```
[marver] no theme CSS detected - set `theme` in design/config.ts when you have one.
```

Then `design/AGENTS.md` — the contract I am told to obey — instructed me to
"Use the app's UI: import from `@/components/ui`; style with the app's Tailwind
classes." There is no `@/components/ui`. There is no Tailwind. The contract
described a repo that did not exist.

So I did the obvious wrong thing: I designed three landing pages in inline
`<style>` blocks and hand-rolled CSS variables, because that was the only way to
make pixels appear. They looked fine on the canvas and were worth nothing —
built on no design system, sharing no components with an app that had not been
created, and impossible to promote into `src/` later. My human caught it and
stopped me; the tool never did.

**Cost:** Three fully-written landing page frames thrown away. The single most
expensive mistake of the session, and the tool's happy path led me straight
into it.

**What I think is wrong:** `init` treats "no app detected" as a warning. It is
not a warning, it is a different situation. The value of Marver is precisely
that designs are made of your real parts; with no app, the tool is a worse
CodePen with more ceremony.

**Fix I'd want:**

- When `init` detects no framework, no theme CSS, and no component alias, it
  should say so loudly and offer the setup, e.g.:

  ```
  [marver] No app detected in this repo (no framework, no theme CSS, no ui alias).
           Marver builds frames from YOUR components — with none, frames will be
           hand-rolled CSS that cannot be promoted into the app later.

           Set up an app first, then re-run init. For a marketing site or web app:
             npx create-next-app@latest . --ts --tailwind --app --src-dir
             npx shadcn@latest init

           Continue anyway with an empty scaffold?  [y/N]
  ```

- `AGENTS.md` should be generated conditionally. When no `ui` alias was
  detected, the line telling the agent to import from `@/components/ui` should
  be replaced by an explicit "this repo has no component library yet; STOP and
  ask the human to set one up before designing." An agent follows the contract
  it is given, and the given contract was fiction.

**Fix applied here:** scaffolded Next.js 16.3 + Tailwind v4 + shadcn/ui into the
repo, then re-ran `init`. Everything below was found on that (supported,
detected, blessed) stack.

---

## 🔴 2. Tailwind v4 + Next.js is broken by default, and the warning is buried

**Expected:** `create-next-app --tailwind` + `shadcn init` + `marver dev` — the
exact stack `init` detects and celebrates — to just work.

**Happened:**

```
[marver] tailwindcss v4 detected but @tailwindcss/vite not found in the host - theme classes may be missing.
```

Marver requires **`@tailwindcss/vite`** in the host's `node_modules`
(`dist/plugin-DB5t2WUl.mjs` → `tailwind4Plugin()` imports
`node_modules/@tailwindcss/vite/dist/index.mjs` and returns `null` on failure).

But a Next.js app does not use `@tailwindcss/vite`. Next.js uses
**`@tailwindcss/postcss`** — that is what `create-next-app` and `shadcn init`
install, and it is the correct dependency for the app itself. So the officially
supported combination is guaranteed to hit this path on a clean install.

The failure is soft. The canvas still loads, frames still render, they are just
missing every Tailwind utility class — which for a shadcn app means the design
is silently, subtly wrong rather than obviously broken.

Worse, the warning prints on `dev` startup, immediately above ~35 lines of
`Sourcemap for "react-zoom-pan-pinch"` noise from Marver's own dependency. In a
scrollback it is invisible. I only caught it because I was grepping the log.

**Cost:** ~15 minutes, and required reading `dist/plugin-DB5t2WUl.mjs` to learn
that the missing package was `@tailwindcss/vite` and not something I had done
wrong. The message names the package but nothing tells you it is safe/expected
to add a *Vite* plugin to a *Next.js* app, which feels wrong when you read it.

**Fix I'd want:**

- `init` should detect Tailwind v4 without `@tailwindcss/vite` and either add it
  to devDependencies itself or print the exact remedy: `npm i -D @tailwindcss/vite`
  — with the reassurance that it is used **only** by the canvas and never by the
  app's own build.
- Promote this from `console.warn` at dev-start to a persistent banner in the
  canvas UI. Anything that means "your frames are rendering wrong" should be
  visible in the thing you are looking at, not in a terminal you scrolled past.
- Silence the `react-zoom-pan-pinch` sourcemap spam (`build.sourcemap` /
  `optimizeDeps` config). It buries real diagnostics.

**Fix applied here:** `npm i -D @tailwindcss/vite`.

---

## 🔴 3. Dark mode does not reach shadcn components

**Expected:** Pressing `d` on the canvas ("toggle light/dark for the board",
per the README) to flip my shadcn components into dark mode.

**Happened:** Nothing. The canvas chrome changes, the frame does not.

The reason took two files to find:

- `src/client/frame-host/main.tsx:15` sets the theme as a **data attribute**:
  `document.documentElement.dataset.theme = theme`.
- shadcn on Tailwind v4 ships `@custom-variant dark (&:is(.dark *))` in
  `globals.css` — it keys off a **class**.

`[data-theme="dark"]` and `.dark` never meet. Marver's theme resolution
(`plugin-DB5t2WUl.mjs:292`) only decides *which CSS file to import*; nothing
bridges the dark signal into the app's own convention.

This is not an edge case. shadcn is the component library `init` explicitly
detects (`config-DMBEpdEN.mjs:30` reads `components.json` for the `ui` alias),
Tailwind v4 is the current version, and the class strategy is the shadcn
default. The advertised feature (`d` toggles dark) is broken for what I'd guess
is most of the intended audience.

**Cost:** ~20 minutes, two source files, and I had to invent the fix myself.

**Fix I'd want:** the frame host should set **both** signals — the data
attribute *and* the class configured by the host's CSS. Marver already parses
`components.json`; it can read the `@custom-variant dark` declaration out of the
theme CSS, or simply add `class="dark"` alongside `data-theme="dark"`, which
covers the default for both Tailwind v4 and v3 (`darkMode: 'class'`). Doing
nothing and leaving it to the user is the wrong default when the tool knows the
host is shadcn.

Documenting it would be the minimum. Right now nothing anywhere mentions it.

**Fix applied here:** in `src/app/globals.css`, taught the app's own dark variant
to accept Marver's signal too:

```css
@custom-variant dark (&:is(.dark *, .dark, [data-theme="dark"] *, [data-theme="dark"]));
```

and duplicated the selector on the token block: `.dark, [data-theme="dark"] { … }`.
Note this edits **the app's stylesheet** to satisfy the design tool — exactly the
kind of one-way coupling the README's "uninstall = delete `design/`" promise
implies should not be necessary.

---

## 🟠 4. `design/tsconfig.json` extends a file that `init` does not create

**Expected:** A scaffolder to emit a config that resolves.

**Happened:** `init` writes `design/tsconfig.json` containing
`"extends": "../tsconfig.json"`. In a repo with no root `tsconfig.json` — which
is exactly the repo `init` is happy to run in (see #1) — that file does not
exist. The result on `marver dev`:

```
Build failed with 1 error:
[TSCONFIG_ERROR] Failed to load tsconfig 'tsconfig.json': Tsconfig not found
(!) Failed to run dependency scan. Skipping dependency pre-bundling.
```

The canvas still came up, so this is another soft failure that leaves you
running degraded without understanding why.

**Cost:** ~10 minutes. Not obvious that the fix was "create a root tsconfig",
since I had not asked for TypeScript config anywhere.

**Fix I'd want:** `init` should write a root `tsconfig.json` when none exists,
or emit a `design/tsconfig.json` that stands alone when there is nothing to
extend. Checking `existsSync` before writing an `extends` is one line.

---

## 🟠 5. Three different, contradicting answers to "where does the theme go?"

Four sources, three answers:

| Source | Says |
|---|---|
| `init` stderr | "set `theme` in **design/config.ts**" |
| generated `design/config.ts` comment | "Theme lives in **design/theme.css** … **not here**" |
| canvas toast | "no theme configured — frames render unstyled (**design/config.ts → theme**)" |
| `plugin-DB5t2WUl.mjs:292` (the truth) | `design/theme.css` **>** `config.theme` **>** detected **>** none |

The generated comment is right; the two user-facing messages point at the lower-
priority fallback. And the scaffolded `config.ts` ships with no `theme` key at
all, so following the warning means adding a key that is not there, to override
a file the comment told you is the real home.

**Cost:** ~10 minutes reading `plugin-DB5t2WUl.mjs` to find the actual
resolution order, because I did not want to guess wrong and debug it later.

**Fix I'd want:** make both messages say the same thing as the comment: "create
`design/theme.css` importing your app's stylesheet (or set `theme` in
`design/config.ts`)". They are one string each.

---

## 🟠 6. `AGENTS.md` tells me to read a manifest that does not exist yet

**Expected:** "`design/manifest.json` lists every frame (id, file, scene, title)
— **read it before exploring**" to describe a file I can read after `init`.

**Happened:** `init` does not create `design/manifest.json`. It is generated by
`marver dev` (`plugin-DB5t2WUl.mjs:368`, `writeManifest`). An agent that follows
`AGENTS.md` literally — read the manifest first, before doing anything — finds
nothing and has to work out whether it is missing, stale, or the docs are wrong.

**Cost:** 🟡 small, but it is the *first* orientation instruction in the file,
which makes it a bad first impression for exactly the reader the file is for.

**Fix I'd want:** have `init` write the initial manifest (it already scans the
demo frames it just copied), or change the line to "generated by `marver dev`;
if it is missing, start the canvas."

---

## 🟡 7. README links to two documents nobody can read

The README's closing line: "The implementation contract is
[SPEC.md](./SPEC.md). Deviations live in [DECISIONS.md](./DECISIONS.md)."

Neither is in `files` in `package.json` (`dist`, `src/client`, `templates`,
`README.md`, `LICENSE`, `NOTICE`), and the GitHub repo is private — the README
says so itself, in a stray unfinished line that ships to npm:

```
; private; TNEP4.
```

So the authoritative documentation is advertised and unavailable. Every "how
does this actually work" question in this file was answered by reading `dist/`.

**Fix I'd want:** ship them, or drop the links. And delete the `; private; TNEP4.`
line — it reads like a note-to-self left in a published README.

---

## 🟡 8. The CLI reports the wrong version

`npx marver --help` prints `marver/0.1.0`. The installed package is `0.2.0`.
Version is the first thing anyone includes in a bug report; this makes every
report wrong by default. (`cac` is being handed a hardcoded or stale version.)

---

## 🟡 9. `--no-demo (default: true)` is unreadable

```
--no-demo      Skip the demo scene (default: true)
```

Does `true` describe `--no-demo` (so demo is skipped by default) or the
underlying `demo` value (so demo is included)? It is the latter — `init`
scaffolds the demo unless you pass the flag — but the rendering is genuinely
ambiguous and I had to run it to find out.

---

## 🟡 10. Next.js support is "partial", and it says so exactly once

`init` prints:

```
note: Next.js support is partial until M3 - HTML frames and next-free components work today.
```

Real and useful, but:

- It appears **only** in `init` output, which is a one-time command whose
  scrollback is long gone by the time you hit a limitation.
- It is not in the README, not in `AGENTS.md`, not in the canvas.
- In my case `init` ran *before* Next.js existed in the repo (see #1), so the
  detection said nothing — I only saw this warning because I happened to re-run
  `init` after scaffolding the app. A first-time user does that exactly never.
- "partial until M3" means nothing to someone outside the project. Which parts?
  `next/font`? `next/image`? Server Components? `next/link`? I still don't know
  what will break until it breaks.

**Fix I'd want:** put the caveat in `AGENTS.md` (generated conditionally when
the router is Next) and in the README, and say concretely what does not work.

---

## 🟡 11. `next/font` silently does not exist inside frames

Related to #10 and worth its own line because it is invisible.

`src/app/layout.tsx` sets `--font-geist-sans` via `next/font/google`. That is a
Next-only build feature; inside a Marver frame there is no Next, so the variable
is simply undefined and every frame renders in a different typeface than the
real app. Nothing warns you. The canvas looks authoritative and is quietly
lying about your typography — the one thing a design tool must not do.

**Fix applied here:** gave every font token a real fallback chain in
`globals.css` (`--font-sans: var(--font-geist-sans, ui-sans-serif, system-ui, …)`)
so the canvas degrades to a near-identical system stack instead of Times New Roman.

**Fix I'd want:** `init` should detect `next/font` usage in the root layout and
either warn or scaffold the fallback. Better: document that frames should never
depend on build-time-injected CSS variables.

---

## 🟡 12. Sourcemap noise from Marver's own dependency

Every `marver dev` prints ~35 lines of:

```
Sourcemap for ".../react-zoom-pan-pinch/dist/index.esm.js" points to a source file
outside its package: ".../node_modules/src/utils/calculations.utils.ts"
```

Marver's own dependency, nothing the user can act on, and it buries the two
warnings that actually matter (#2, #5). See also #2.

---

## 🟡 13. `MODULE_TYPELESS_PACKAGE_JSON` warning on every start

```
Warning: Module type of file:///…/design/config.ts is not specified and it doesn't
parse as CommonJS. Reparsing as ES module… To eliminate this warning, add
"type": "module" to /Users/…/package.json.
```

Marver loads `design/config.ts` through Node's native TS import. The suggested
fix — adding `"type": "module"` — is advice about **the host app's**
`package.json`, which for a Next.js app is a meaningful change the user should
not be nudged into by a design tool. Marver should load its own config in a way
that does not emit this, or suppress it.

---

## 🟡 14. Stale 404 on a board the README says is auto-managed

Console on a clean canvas load:

```
GET /__mv/api/boards/all-scenes → 404
```

The README says `all-scenes` is auto-managed and never written by hand, so a
404 for it on first load is presumably harmless — but it is a red error in the
console of a freshly installed tool, which costs trust and makes real errors
harder to spot.

---

## 🟠 15. The "auto-managed" board keeps dead frames forever

**Expected:** The README is explicit — "`all-scenes` is auto-managed" and
`AGENTS.md` says "never write it". So deleting a frame file should remove it
from that board. That is what auto-managed means.

**Happened:** I deleted `design/scenes/demo/` (three frames). On the canvas they
stayed, as three large tombstones reading **"file deleted"** with a
`× remove from board` button. My human noticed them before I did and asked what
the weird unclickable frames were.

`design/boards/all-scenes.json` still listed all three in `nodes`, with
`"auto": true` right there in the same file. So the board adds frames
automatically but never prunes them, and the one board the user is told they
must not hand-edit is the one that accumulates garbage.

Compounding it: the board had `"deviceView": "monitor"` persisted, so every
tombstone was sized 1920×1080 — three screen-filling empty slabs you have to
pan around, for files that no longer exist.

**Cost:** Confusing enough that the human interrupted the work to report it as a
bug. The fix is not discoverable: you either click a small button on each
tombstone, or delete `design/boards/all-scenes.json` and let it regenerate
(which is what I did) — and `AGENTS.md` explicitly tells agents not to touch
that file, so the obvious remedy is one the contract forbids.

**Fix I'd want:** on manifest rescan, drop nodes from `auto: true` boards whose
frame no longer exists. If tombstones are intentional (so you notice an
accidental deletion), give them a lifetime — clear on next start, or show one
compact notice ("3 frames deleted — clear?") instead of persisting full-size
placeholders indefinitely.

---

## 🟠 16. Boards auto-lay-out into a column, which is the opposite of what boards are for

**Expected:** `AGENTS.md` says a minimal board file — just a frame list — is enough:
"the shell fills sizes from each frame's viewport, lays it out, and keeps it
tidy." It also says, two lines later, "Use boards for comparisons: version A vs
B vs C of a flow, **side by side**."

**Happened:** I wrote exactly the documented minimal board (four frames, no
coordinates) for the three landing directions. The shell stacked them in a
single vertical column and fit the canvas to 8% zoom. Comparing them side by
side — the stated purpose — was impossible without scrolling past three
full-length pages.

I had to hand-write `x`/`y` on every node to get a comparison row:

```json
{ "frame": "terminal/landing",  "x": 0,    "y": 980, "w": 1280, "h": 3000 },
{ "frame": "editorial/landing", "x": 1360, "y": 980, "w": 1280, "h": 3000 },
{ "frame": "product/landing",   "x": 2720, "y": 980, "w": 1280, "h": 3000 }
```

`x`/`y` are not documented in `AGENTS.md` at all — only `w`/`h` are ("add
`w`/`h` on a node to pin a size"). I inferred `x`/`y` from reading the
auto-generated `design/boards/all-scenes.json`.

**Cost:** ~15 minutes and a doc-to-source round trip for the single most
important thing an agent does on this tool: put variants next to each other.

**Fix I'd want:** tidy should lay a board out in a row (or a wrap-grid) rather
than a column — comparison is the documented use case, and tall landing pages
are the common case. Failing that, document `x`/`y` in `AGENTS.md` next to
`w`/`h`, since an agent writing a comparison board needs them every time.

---

## 🟡 17. `marver serve` crashes with a raw Node stack trace on a busy port

`marver dev` handles this gracefully:

```
Port 5199 is in use, trying another one...
  marver canvas → http://localhost:5200/
```

`marver serve` on a busy port does this:

```
node:events:497
      throw er; // Unhandled 'error' event
      ^
Error: listen EADDRINUSE: address already in use :::4199
    at Server.setupListenHandle [as _listen2] (node:net:1941:16)
    …
    at serve (…/dist/serve-BPNmWeJx.mjs:118:9)
```

Two commands in the same CLI, opposite behavior for the identical condition, and
the one that fails does it with an unhandled `error` event and a stack trace
into the tool's own bundled internals. The first time I hit it I assumed I had
broken the build, not that a previous `serve` was still holding the port.

**Fix I'd want:** the same retry-or-friendly-message path `dev` already has.

---

## 🟡 18. `marver serve` prints nothing at all on success

After the EADDRINUSE fix I ran `npx marver serve --port 4250` and got **zero
output**. No "serving at http://localhost:4250", no board name, nothing. I had
to `curl` the port to find out whether it had started.

`marver build` ends by telling you `serve it:  npx marver serve` — so the very
next command the tool recommends gives no indication that it worked. Print the
URL, the board, and the gate state (`MARVER_PASSWORD` set / not set), the way
`dev` prints its URL.

---

## 🔴 19. There is no concept of "these frames are versions of the same thing"

This is the biggest missing idea in the product, and it took a human staring at
the canvas to name it.

**The situation:** three landing pages, same content, different art direction.
This is the single most common design activity there is — and Marver's headline
example for boards is literally *"version A vs B vs C of a flow, side by side."*

**Expected:** a way to tell the tool "these three frames are the same surface,
different versions — keep them together, in this order, and label them."

**Happened:** there is no such concept anywhere. Not in `meta` (the scanner
reads only `title`, `viewport`, `theme` — `plugin-DB5t2WUl.mjs:60-66`; any other
key is silently dropped). Not in the board schema. Not in the sidebar. The only
tool available is hand-placed `x`/`y` on board nodes, and **that does not
survive**: the moment the human presses `1`–`5` for a device view or `t` to
tidy, the shell rewrites the board's `nodes` from its own layout engine and my
carefully-placed comparison row is gone.

That is exactly what happened here. My human switched to mobile view to check
responsiveness, and the comparison collapsed into a single scrolling column with
landings and docs pages interleaved — six near-identical thumbnails with no
indication of which was which. Their words: *"I like to have a very clear way to
identify three different landing pages … they need to be next to each other so I
can compare them. Right now it's not the case."*

The tool actively destroys the arrangement that its own documentation says
boards are for.

### The workaround (applied here, and it is a good one)

Frames sort by **frame id** (`plugin-DB5t2WUl.mjs:68`,
`a.id.localeCompare(b.id)`), and every auto-layout — tidy, device views —
walks that order. So id ordering *is* the grouping mechanism, undocumented.

The fix is to make the **scene the surface** and the **frame the variant**,
rather than the other way round. I originally had:

```
design/scenes/terminal/landing.tsx     → terminal/landing
design/scenes/editorial/landing.tsx    → editorial/landing
design/scenes/product/landing.tsx      → product/landing
```

…which sorts the three landings apart, interleaved with their docs pages.
Restructured to:

```
design/scenes/landing/a-terminal.tsx   → landing/a-terminal
design/scenes/landing/b-editorial.tsx  → landing/b-editorial
design/scenes/landing/c-product.tsx    → landing/c-product
design/scenes/docs/a-terminal.tsx      → docs/a-terminal
…
```

Now the three variants sort adjacently, the `a-`/`b-`/`c-` prefix forces the
intended A/B/C order rather than alphabetical-by-name, the sidebar groups them
as **Landing (3)**, and — the important part — the row *survives* tidy and
device views, because the layout engine places them in id order.

This is a real, durable answer to the question, and it generalizes: **variants
are sibling frames, exactly like states are** (`empty.tsx`, `error.tsx`). That
is already the documented convention for states; nobody wrote down that it is
also the convention for versions.

### What still needs to be a feature

The convention gets ~80% and is a prompt-level fix. The rest cannot be done from
the agent side, because the shell owns layout:

1. **Declare it, don't encode it in filenames.** Depending on lexical ordering
   of `a-`/`b-`/`c-` filename prefixes is a hack. The honest API is `meta`:

   ```tsx
   export const meta = {
     title: 'Landing',
     of: 'landing',        // the surface these are versions of
     variant: 'Terminal',  // this version's name
     order: 1,             // explicit, not alphabetical
   }
   ```

2. **A variant group as a layout unit.** Tidy and the device views should treat
   a group as one block: same width, same y, ordered by `order`, never split
   across rows and never interleaved with anything else. Today `t` and `1`–`5`
   are destructive to any comparison the agent set up.

3. **Label the group on the canvas.** A caption above the row — "Landing · 3
   variants" — with each frame's chrome showing `A · Terminal` rather than the
   human having to read the title bar of each thumbnail at 17% zoom. At mobile
   device view, six unlabeled thumbnails are indistinguishable.

4. **Switch variants in play mode.** The killer feature: walking the prototype
   and pressing `←`/`→` to swap direction A → B → C *on the current screen*,
   keeping your position in the flow. That is the actual review question ("which
   of these three is better *here*?") and today it needs three separate walks.

5. **Sidebar grouping.** Show `Landing` with a variant count and a variant
   switcher, not three sibling entries that happen to be adjacent.

6. **Make board layout durable.** Whatever the mechanism, an agent needs a way
   to express an arrangement that a human's device-view keypress will not
   silently destroy. Today `auto: false` boards are still relaid out and
   rewritten in place — `auto: false` reads like it should mean "hands off",
   and does not.

**Verdict on the human's question — "is this a prompt thing or a feature?"**
Both, and the split is clean. Grouping-by-id-order is a prompt/convention fix
and I have applied it; it should be documented in `AGENTS.md` as *the* way to do
versions. Group-aware layout, labels, and variant switching in play mode are
tool features, and they are the ones that turn "three files that happen to sort
next to each other" into an actual comparison workflow.

---

## 🔴 20. Renaming or moving a frame file bricks every open canvas — and only a NEW TAB recovers it

**Expected:** Marver's central promise is "everything hot-reloads; frames appear
on the canvas the moment the file lands." Moving a file is the same class of
event as creating one.

> **Update — this is not just renames.** It happened **three separate times** in
> one session, and the third had nothing to do with renaming:
>
> | # | Trigger | Result |
> |---|---|---|
> | 1 | Moved 6 frames (`terminal/landing` → `landing/a-terminal`) | every frame on every board failed |
> | 2 | Created 4 new frames (`hero/*`) | open canvas failed |
> | 3 | **Restarted `marver dev`** (no file change at all) | open canvas failed |
>
> Case 3 is the important one: simply restarting the dev server bricks every
> canvas that was already open. That is not an exotic operation — it is the
> documented remedy for #22, so a user following the fix for one bug walks
> straight into this one. Each time I verified the server was healthy
> (`/design/manifest.json` and the transformed `registry.ts` both correct and
> complete) and a clean browser rendered everything; only the pre-existing tab
> was broken.

**Happened:** I restructured the scenes (see #19), moving six frames:

```
design/scenes/terminal/landing.tsx  →  design/scenes/landing/a-terminal.tsx
…
```

The canvas my human had open went entirely red. Every frame, on every board:

```
frame failed
unknown frame id "landing/a-terminal"
design/scenes/landing/a-terminal.tsx
```

The sidebar was **correct** — it read `Landing 3 · A-terminal · B-editorial ·
C-product`, because the sidebar comes from `design/manifest.json`, which the
server had regenerated properly. Only the frames failed. So the UI confidently
listed frames it then refused to render, naming the exact file that exists on
disk two lines below the error.

**It is not a server problem.** I fetched the transformed registry module
directly from the running dev server:

```
GET /@fs/…/frame-host/registry.ts?v=625ef59d
→ frames = { …, "/design/scenes/landing/a-terminal.tsx": () => import(…), … }
```

Correct, complete, all six new paths present. Loading the same URL in a fresh
browser context rendered all frames with zero failures. **The already-open tab
was permanently stuck on a stale client-side glob map.**

`registry.ts` guards this with `import.meta.hot.accept(() => location.reload())`
and a comment explaining it is "the HMR boundary for glob-map invalidation
(frame files added/removed)". That mechanism did not save the open tab here.

### Every in-app recovery path failed. Only a new tab worked.

This is the part that makes it a 🔴, and I got it wrong on the first pass — I
told my human a hard reload would fix it. It did not.

| Recovery attempt | Result |
|---|---|
| `↻ reload` on the failed frame card | still broken |
| Normal reload | still broken |
| **Hard reload (⇧⌘R)** | **still broken** |
| Open the same URL in a new tab | works, instantly |

The `↻ reload` button is inert by construction: it reassigns the same
`iframe.src` (`FrameNode.tsx:161`), so the iframe re-requests an identical URL
and gets the identical stale registry. But a hard reload failing too means this
is **not** ordinary HTTP caching — something survives a full document reload and
is scoped to the tab.

I went looking for what, and could not pin it. Ruled out:

- **`localStorage`** — only `mv-view-theme` and the play-mode hint flags
  (`store.ts:55`, `Play.tsx:229`). Shared across tabs anyway, so it cannot
  explain "new tab works".
- **`sessionStorage`** — only `mv-pins-<board>` (`store.ts:127`), frame pins in
  published builds. Wrong shape, and not frame ids.
- **The URL hash** — carries board, selected node keys, and play state only
  (`hash.ts`). No frame ids. And the failing ids were *valid*.

So the stale thing is the frame-host iframe's module graph, persisting across a
hard reload of the parent document. I am reporting the behavior rather than the
mechanism, because I could not reproduce it from a clean context — which is
itself the nastiest property of this bug.

**Cost:** My human's entire canvas failed, they sent screenshots, I gave them a
fix that did not work, and they had to discover the new-tab workaround
themselves. Invisible to whoever caused it, total for whoever is looking at it.

**Fix I'd want:**

1. **The shell must own this.** It already receives the manifest update — it
   re-rendered the sidebar correctly while every frame failed. When a frame id
   appears or disappears, **or when the dev server reconnects after a restart**,
   the shell should force a full reload of itself and version-bust every iframe
   URL, rather than trusting each iframe to self-accept. Vite's HMR client
   already surfaces reconnection; that event alone would cover case 3.
2. **Version-stamp `frameUrl()`.** Add a manifest-revision param
   (`/__mv/frame/?id=…&r=<rev>`) so a changed manifest produces a genuinely new
   URL. That fixes `↻ reload` for free and makes the stale case unreachable.
3. **Never show a dead-end error.** `unknown frame id "landing/a-terminal"` is
   actively misleading — the server has that id and the file is on disk. It
   should read *"this frame moved or was renamed; the canvas is out of date"*
   with a button that actually recovers.
4. **Whatever the cache is, give it a bust.** If a hard reload cannot clear it,
   no user can be expected to. At minimum the shell needs a "reset canvas"
   action; better, it should never get into the state.

---

## 🟠 21. Marver's dev server watches `.next/` and storms on every app build

While diagnosing #20 I found this in the canvas log:

```
7:40:41 AM [vite] (client) page reload .next/server/app/_global-error.html
7:40:41 AM [vite] (client) page reload .next/server/app/_not-found.html
7:40:41 AM [vite] (client) page reload .next/server/app/index.html
7:40:41 AM [vite] (client) page reload .next/server/pages/404.html
7:40:41 AM [vite] (client) page reload .next/server/pages/500.html
…repeated
```

Running `npm run build` — the host app's own build, the most ordinary thing a
developer does in this repo — makes Marver's Vite watcher fire a burst of full
**page reloads** of the canvas, because it is watching the entire repo root
including Next's build output directory.

This is noisy on its own (your canvas randomly reloads while you are looking at
it) and it is my best guess at what pushed the open tab into the stale state in
#20: a storm of full-page reloads racing an in-flight glob invalidation.

**Fix I'd want:** ignore build output in the watcher — `.next/`, `dist/`,
`build/`, `out/`, `.turbo/`, `coverage/`, and `design/.dist/`. The plugin already
knows which directories it cares about (`plugin-DB5t2WUl.mjs:352` scopes the
manifest rescan to `design/scenes` and `design/components`); the watcher should
be scoped just as tightly.

---

## 🔴 22. New frame files get no Tailwind classes until you restart the dev server

The worst bug I have hit, because it is **silent and it lies**.

**Expected:** "Frames appear on the canvas the moment the file lands." If a new
frame shows up, it should look like the design I wrote.

**Happened:** I created four new hero variants (`design/scenes/hero/*.tsx`).
They appeared on the canvas instantly, rendered without error — and were
**visually wrong**. Variant A's `text-[4.25rem]` headline rendered at ~19px.
Variant D's `grid-cols-[minmax(0,0.85fr)_auto_minmax(0,1.15fr)]` and even a
plain `grid-cols-3` did not apply, collapsing a three-column diagram into a
vertical stack that looked like a broken form.

Meanwhile `text-lg`, `mb-5`, `flex`, `rounded-xl` all worked fine.

That split is the tell: the classes that worked were ones **already used
elsewhere in the repo**; the classes that failed appear **only in the new
files**. Tailwind never scanned the new files, so those utilities were never
generated.

**Proof:** no code change, no edit — I restarted `marver dev` and reloaded:

```
before restart:  getComputedStyle(h1).fontSize → "19.2px"   (class not generated)
after restart:   getComputedStyle(h1).fontSize → "68px"     (= 4.25rem, correct)
```

Same file, same classes. The only variable was the dev server's lifetime.

**Why this is the worst one:** every other bug in this file announces itself. A
red "frame failed" card is honest. This one renders a confident, complete,
plausible-looking design that is **not the design in the file** — in a tool
whose entire purpose is showing you what your design looks like. I nearly
"fixed" two frames that had nothing wrong with them.

And it is aimed squarely at the primary user. Marver is *agent-native*; the
core loop is an agent creating new frame files. New files are not an edge case
here, they are the product. Every genuinely new design — the first pass at any
variant, which is exactly when you are diverging and reaching for new type
scales and new grids — renders wrong until someone thinks to restart a server.

`design/theme.css` (generated by `init`) ends with:

```css
@source "./";
```

so Tailwind is told to scan `design/`. Whatever the mechanism —
`@tailwindcss/vite`'s scan set being computed once at startup, or the watcher
not registering new files under `design/scenes/` — the effect is that content
detection is fixed at boot while the frame registry is live.

**Cost:** ~25 minutes. I saw two "broken" designs, screenshotted them, started
debugging my own CSS, and only caught it because the failure pattern
(arbitrary values dead, shared utilities alive) pointed at content scanning
rather than at my markup.

**Fix I'd want:**

- Whatever makes the frame glob live (`registry.ts` HMR, the `design/scenes`
  watcher at `plugin-DB5t2WUl.mjs:352`) must also invalidate Tailwind's scan set
  when a frame file is created or removed. The plugin already watches exactly
  the right directories for the manifest — hook the same event.
- Failing that, **detect and warn loudly**: if a frame file's mtime is newer
  than the CSS build, show a banner in the canvas ("new frames since last CSS
  build — restart `marver dev`"). A visible warning beats a silent lie.
- This deserves a line in `AGENTS.md` until it is fixed. An agent writing new
  frames has no way to know its output is being misrendered, and screenshots it
  takes to check its own work will confirm the wrong thing.

---

## 🟠 23. The selection toolbar has no collision handling and can land on top of the frame

**Expected:** the floating device/theme bar for a selected frame sits *above* the
frame, clear of its content. That is what the code comment promises —
"Selection toolbar: screen-space overlay **above** the selected frame"
(`App.tsx:110`).

**Happened:** my human hit cases where the bar renders **on** the frame instead,
covering the design. In their screenshot the bar sits over the hero of
`Landing · B · Editorial`, obscuring the eyebrow and the top of the headline —
i.e. directly on top of the thing you selected the frame in order to look at.

**What the source says.** The position is a single unclamped expression
(`App.tsx:139-145`):

```js
left: `calc(var(--sh-tx, 0px) + var(--sh-s, 1) * ${(bx0 + bx1) / 2}px)`,
top:  `calc(var(--sh-ty, 0px) + var(--sh-s, 1) * ${by0}px - 52px)`,
```

with `.sh-ctx { position: absolute }` (`styles.css:252`). There is **no viewport
clamping, no flip-to-below, no collision detection of any kind** — the bar is
unconditionally 52px above the topmost selected node, wherever that lands.

Two consequences fall straight out of that formula:

- If the frame's top edge is off-screen (panned up, or a tall frame you have
  scrolled into), the bar is drawn off-screen too and simply disappears — the
  controls for the selected frame become unreachable without panning back.
- The anchor is the **topmost** selected node (`by0 = min(y)`) while the
  horizontal centre is the **whole selection's** bounding box
  (`(bx0 + bx1) / 2`). With a multi-selection spanning rows, the centre can land
  horizontally over a *different* frame than the one it is vertically anchored
  to — so the bar sits on a frame it is not describing.

**What I could and could not verify.** I measured the healthy case in a scripted
session: `barTop 452 / barBottom 490 / frameTop 504` — a clean 14px gap, correct.
I could **not** reproduce the overlap by panning (synthetic wheel events do not
drive `react-zoom-pan-pinch`), so I am reporting my human's screenshot as the
evidence and the missing clamp as the cause I can actually point at in source,
rather than claiming a trigger I did not observe.

**Fix I'd want:** standard floating-element treatment — clamp the bar into the
viewport, flip it below the frame's header when there is no room above, and
never let it overlap frame content. If the anchor frame is scrolled out of view,
pin the bar to the viewport edge rather than letting it drift off-screen. This
is the one piece of chrome that exists to act on the selected frame; it should
never be unreachable or sitting on the artwork.

---

## Appendix — minimal reproductions for the 🔴s

Each of these starts from a clean checkout of a Next.js + Tailwind v4 + shadcn
app, which is the combination `init` detects and reports as supported.

**#1 — `init` in an empty repo**

```bash
mkdir /tmp/empty && cd /tmp/empty && git init && npm init -y
npm i -D @marver-design/marver && npx marver init
```
Expected: refusal or a loud prompt. Actual: success, plus a generated
`design/AGENTS.md` instructing the agent to `import from @/components/ui` — a
path that does not exist.

**#2 — Tailwind v4 warning**

```bash
npx create-next-app@latest app --ts --tailwind --app --src-dir
cd app && npx shadcn@latest init --defaults && npm i -D @marver-design/marver
npx marver init && npx marver dev 2>&1 | grep -i tailwind
# [marver] tailwindcss v4 detected but @tailwindcss/vite not found in the host
```
Next installs `@tailwindcss/postcss`, never `@tailwindcss/vite`, so this fires
100% of the time on the blessed stack.

**#3 — dark mode**

Add any shadcn component to a frame, start the canvas, press `d`. Canvas chrome
flips; the component does not. `frame-host/main.tsx:15` sets
`documentElement.dataset.theme`; shadcn's generated `globals.css` declares
`@custom-variant dark (&:is(.dark *))`.

**#20 — stale canvas** (three triggers, all verified)

With the canvas open in a tab: (a) rename any frame file, (b) create a new frame
file, or (c) just restart `marver dev`. Every frame shows
`unknown frame id "<id>"`. `↻ reload`, reload, and hard-reload all fail; a new
tab works. Verify the server is fine meanwhile:

```bash
curl -s localhost:5199/design/manifest.json | grep '"id"'
curl -s "localhost:5199/@fs/$PWD/node_modules/@marver-design/marver/src/client/frame-host/registry.ts" \
  | grep -o '"/design/scenes/[^"]*"'
```

**#22 — new frames get no Tailwind classes**

Create a new frame using a utility that appears **nowhere else in the repo**
(e.g. `text-[4.25rem]`, `grid-cols-[minmax(0,0.85fr)_auto_minmax(0,1.15fr)]`).
It renders with the class missing and no error. Then restart `marver dev`:

```js
// before restart
getComputedStyle(document.querySelector('h1')).fontSize  // "19.2px"
// after restart, same file, no edit
getComputedStyle(document.querySelector('h1')).fontSize  // "68px"  (= 4.25rem)
```

Classes already used elsewhere keep working throughout, which is what makes it
look like a markup bug rather than a scanning bug.

---

## Things that were genuinely good

Worth recording, since the rest of this file is complaints:

- **`design/AGENTS.md` is the best part of the product.** It is written *to an
  agent*, not to a human hoping an agent reads it. The structure ladder (inline
  first → extract to `screens/` when a direction wins), the "frames import
  fixtures, never stores, never the network" rule, and the promotion section are
  real design-system opinions, not boilerplate. Setting aside #1, it told me
  what to do and I could do it.
- **`data-goto` is the right size for a prototype system.** One attribute, no
  imports, no state machine, no config file. It makes the walkable-flow feature
  cost nothing to adopt and nothing to remove.
- **Real iframes at real widths.** Dragging a frame edge and watching actual
  media queries fire is the thing every other design tool fakes.
- **`init` never overwrites.** Re-running it after scaffolding the app was safe
  and filled in exactly the gaps (`theme.css`, the shadcn-aware `AGENTS.md`).
  That is the correct behavior and it saved me here.
- **Uninstall really is `rm -rf design/`.** With the one asterisk in #3.
- **`build` → `serve` worked first try.** `marver build --boards prototype`
  correctly resolved 7 of 7 frames, told me the frame filter does not cover
  `public/` (an honest caveat I would not have thought to check), produced a
  696K static bundle, and served it with every frame and the board intact. For a
  publish path this young, that is impressive.
- **Play mode is the payoff.** `data-goto` → press `P` → frames swap in place
  inside one device. Walking hub → landing → docs → back, at real widths, in
  real components, is a genuinely better review artifact than any static mockup.
  This is the feature the product should lead with.
- **The `render`/token-override combination is powerful.** Because frames use
  the app's real shadcn components, overriding `--primary`, `--radius` and the
  font variables on a wrapper restyles entire directions without forking a
  single component. Three visually distinct landing pages share one component
  library. That is only possible because Marver insisted on real components.
