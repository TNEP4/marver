# FRICTION — `@marver-design/marver@0.2.1`

> **Frozen.** Kept as the record of what 0.2.1 looked like. Do not add findings here.
> The current log is **[FRICTION-v0.2.2.md](./FRICTION-v0.2.2.md)**, which re-tests
> everything still open below.

A re-test of every issue from the 0.2.0 log, plus what 0.2.1 introduced.

The 0.2.0 log is frozen at **[FRICTION-v0.2.0.md](./FRICTION-v0.2.0.md)**. Read that
one for the full write-ups (expected → happened → cost → fix I'd want); this file
records **what 0.2.1 actually changed, whether I could confirm it, and what is left**.

Written by a coding agent (Claude) using the tool to build the real marver.design
marketing site. Every status below is either measured with a command whose output is
quoted, or explicitly marked as source-only — I do not claim a fix works because a
comment says it does.

## Environment

| | |
|---|---|
| Marver | `@marver-design/marver@0.2.1` — CLI self-reports `marver/0.2.1 darwin-arm64 node-v22.23.1` |
| Published | 0.2.0 → 2026-08-11T17:28Z · 0.2.1 → 2026-08-12T08:57Z |
| Stack | Next.js 16.3.0 · React 19.2.8 · Tailwind v4.3.3 · shadcn/ui 4.16.2 (`base-nova`, base-ui) |
| Node / npm | v22.23.1 / 10.9.8 |
| OS | macOS (darwin 25.6.0), Chrome |
| Repo | the marver.design site, built through the 0.2.0 log; upgraded in place to 0.2.1 |

## Headline

**0.2.1 is a direct response to the 0.2.0 log.** The shipped source cites it by entry
number — `friction log #1`, `#10/#11`, `#15`, `#20`, `#23` appear as code comments in
`dist/`. Of 23 entries, **16 are fixed, 4 are partially addressed, 3 need a live
canvas session to close.** Nothing regressed.

The two that mattered most are both fixed:

- **#22** — new frame files now get their Tailwind utilities without a dev-server
  restart. This was the one bug that *lied*: it rendered a confident, complete design
  that was not the one in the file. Measured below.
- **#1** — `init` in an empty repo now prints a NO APP DETECTED banner and writes a
  `STOP` instruction into `design/AGENTS.md`, so an agent cannot spend a session
  designing against a component library that does not exist. Measured below.

## If you ship one more release, ship these

Ordered by how much they cost per user, not by how hard they are.

1. **N5 — the empty state.** The first screen after `init`, and the only place the
   core loop can be taught. Currently a broken-looking list row. ~20 lines of TSX
   and CSS, and `init` already writes the perfect starter prompt to a terminal
   nobody is looking at.
2. **N3 — deleting a board is undone by an open tab.** The filesystem has to win in
   a tool whose premise is "your agent edits files". The board watcher already
   exists for `add`/`change`; it needs `unlink`.
3. **N2 — stamp the generator version into `design/AGENTS.md`.** The contract is
   generated, 0.2.1 changed what it says, and agents on a stale copy are following
   superseded instructions with no way to know. One line at `dev` boot fixes it.
4. **#19 — make versions first-class.** 0.2.1 adopted the naming convention, which
   was the right immediate move. The convention is silently load-bearing though: a
   rename re-sorts the comparison and nothing warns you.
5. **#16 — layout for comparison.** Boards still stack into a column, which is the
   opposite of what a board is for. Related to #19: "these N frames are one surface"
   is exactly the information a layout engine needs.

---

## Status of every 0.2.0 entry

Legend: **✅ fixed** (verified by me, on this machine) · **📦 fixed in source**
(the change is in the shipped bundle and I read it, but confirming it needs a live
canvas session) · **◐ partial** (improved, something specific still stands) ·
**🆕** new in 0.2.1.

| # | Sev (0.2.0) | Issue | Status | How I checked |
|---|---|---|---|---|
| [1](./FRICTION-v0.2.0.md#-1-init-succeeds-in-an-empty-repo-and-that-is-the-trap) | 🔴 | `init` succeeds in an empty repo | ✅ fixed | ran `init` in a fresh empty git repo |
| [2](./FRICTION-v0.2.0.md#-2-tailwind-v4--nextjs-is-broken-by-default-and-the-warning-is-buried) | 🔴 | Tailwind v4 + Next needs `@tailwindcss/vite` | 📦 fixed in source | bundled fallback added to `tailwind4Plugin` |
| [3](./FRICTION-v0.2.0.md#-3-dark-mode-does-not-reach-shadcn-components) | 🔴 | `data-theme` never meets shadcn's `.dark` | 📦 fixed in source | frame-host now sets both signals |
| [4](./FRICTION-v0.2.0.md#-4-designtsconfigjson-extends-a-file-that-init-does-not-create) | 🟠 | `design/tsconfig.json` extends a missing file | ✅ fixed | read the generated file in the empty repo |
| [5](./FRICTION-v0.2.0.md#-5-three-different-contradicting-answers-to-where-does-the-theme-go) | 🟠 | Contradicting answers on where the theme goes | ◐ partial | all three messages rewritten, still three places |
| [6](./FRICTION-v0.2.0.md#-6-agentsmd-tells-me-to-read-a-manifest-that-does-not-exist-yet) | 🟠 | `AGENTS.md` points at a manifest `init` never wrote | ✅ fixed | `design/manifest.json` now exists after `init` |
| [7](./FRICTION-v0.2.0.md#-7-readme-links-to-two-documents-nobody-can-read) | 🟡 | README links to unshipped SPEC.md / DECISIONS.md | ✅ fixed | README now links the GitHub repo instead |
| [8](./FRICTION-v0.2.0.md#-8-the-cli-reports-the-wrong-version) | 🟡 | CLI reported `0.1.0` | ✅ fixed | `npx marver --version` → `marver/0.2.1` |
| [9](./FRICTION-v0.2.0.md#-9---no-demo-default-true-is-unreadable) | 🟡 | `--no-demo (default: true)` unreadable | ◐ partial | help text clarified, `(default: true)` still printed |
| [10](./FRICTION-v0.2.0.md#-10-nextjs-support-is-partial-and-it-says-so-exactly-once) | 🟡 | "Next.js partial" said exactly once | ✅ fixed | now in README + `init` output + `design/AGENTS.md` |
| [11](./FRICTION-v0.2.0.md#-11-nextfont-silently-does-not-exist-inside-frames) | 🟡 | `next/font` silently absent in frames | ✅ fixed (documented) | AGENTS template now prescribes the fallback chain |
| [12](./FRICTION-v0.2.0.md#-12-sourcemap-noise-from-marvers-own-dependency) | 🟡 | ~35 lines of sourcemap noise per start | ✅ fixed | 0 lines, cold and warm start |
| [13](./FRICTION-v0.2.0.md#-13-module_typeless_package_json-warning-on-every-start) | 🟡 | `MODULE_TYPELESS_PACKAGE_JSON` every start | ✅ fixed | 0 occurrences, cold and warm start |
| [14](./FRICTION-v0.2.0.md#-14-stale-404-on-a-board-the-readme-says-is-auto-managed) | 🟡 | 404 on a fresh board in a clean console | ✅ fixed | API returns `200 {"board":null}` |
| [15](./FRICTION-v0.2.0.md#-15-the-auto-managed-board-keeps-dead-frames-forever) | 🟠 | Auto board keeps dead-frame tombstones | 📦 fixed in source | prune-on-load added to the store |
| [16](./FRICTION-v0.2.0.md#-16-boards-auto-lay-out-into-a-column-which-is-the-opposite-of-what-boards-are-for) | 🟠 | Boards auto-lay-out into a column | ◐ partial | `x`/`y` now documented; layout itself unchanged |
| [17](./FRICTION-v0.2.0.md#-17-marver-serve-crashes-with-a-raw-node-stack-trace-on-a-busy-port) | 🟡 | `serve` crashed with a raw Node stack | ✅ fixed | clean message, exit 1 |
| [18](./FRICTION-v0.2.0.md#-18-marver-serve-prints-nothing-at-all-on-success) | 🟡 | `serve` printed nothing on success | ✅ fixed — **and my report was wrong** | see below |
| [19](./FRICTION-v0.2.0.md#-19-there-is-no-concept-of-these-frames-are-versions-of-the-same-thing) | 🔴 | No concept of "versions of the same thing" | ◐ partial | convention now documented; still no feature |
| [20](./FRICTION-v0.2.0.md#-20-renaming-or-moving-a-frame-file-bricks-every-open-canvas--and-only-a-new-tab-recovers-it) | 🔴 | Renames/restarts brick every open canvas | 📦 fixed in source | four separate mitigations; needs a canvas session |
| [21](./FRICTION-v0.2.0.md#-21-marvers-dev-server-watches-next-and-storms-on-every-app-build) | 🟠 | Watcher storms on `.next/` | 📦 fixed in source | build dirs added to the ignore list |
| [22](./FRICTION-v0.2.0.md#-22-new-frame-files-get-no-tailwind-classes-until-you-restart-the-dev-server) | 🔴 | New frames render without Tailwind classes | ✅ fixed | sentinel-utility probe, no restart |
| [23](./FRICTION-v0.2.0.md#-23-the-selection-toolbar-has-no-collision-handling-and-can-land-on-top-of-the-frame) | 🟠 | Selection toolbar has no collision handling | 📦 fixed in source | viewport clamp added; needs a canvas session |
| N1 | 🟡 | NO APP DETECTED banner box is misaligned | 🆕 new | ran `init` in an empty repo |
| N2 | 🟠 | No changelog, no upgrade signal, no "your contract is stale" | 🆕 new | `npm pack` diff was the only way to learn what changed |
| N3 | 🟠 | Deleting a board file is undone by an open canvas | 🆕 new | deleted 4 boards; 2 came back with tombstones |
| N4 | 🟡 | `all-scenes` cannot be removed — never exactly one board | 🆕 new | `store.ts:39` |
| N5 | 🟠 | The empty state — first screen after `init` — is a broken-looking list row | 🆕 new | `App.tsx:611` + `styles.css:334` |

---

## Verified fixed — with the evidence

### ✅ #22 — new frames now get their Tailwind utilities live

The one that mattered most. `plugin.mjs` now invalidates and reloads the theme CSS
module whenever a file is added or unlinked under `design/scenes` or
`design/components`, so Tailwind rescans instead of serving the boot-time stylesheet.

Probe: with the dev server already running, write a **new** file containing three
utilities that appear nowhere else in the repo, and diff the served stylesheet.

```bash
curl -s 'http://localhost:5211/@id/virtual:sh-theme' > before.txt
cat > design/scenes/_zz-friction-probe.tsx <<'EOF'
export default function P() {
  return <div className="tracking-[0.4321em] text-[77px] bg-[#ab12cd]">probe</div>
}
EOF
sleep 3
curl -s 'http://localhost:5211/@id/virtual:sh-theme' > after.txt
```

| sentinel | before | after (no restart) |
|---|---|---|
| `0.4321em` | absent | **present** |
| `77px` | absent | **present** |
| `ab12cd` | absent | **present** |

Stylesheet grew 90,927 → 91,136 bytes. On 0.2.0 this required a full dev-server
restart, and until you did one the frame rendered silently wrong.

**Remaining nit:** the underscore-prefixed probe file is correctly excluded from the
manifest but still triggers the rescan, which is the right call — worth keeping.

### ✅ #1 / #4 / #6 — `init` in an empty repo

```bash
mkdir empty && cd empty && git init -q .
npx @marver-design/marver@0.2.1 init
```

Now prints, before anything else:

```
[marver] no theme CSS detected - create design/theme.css importing your app's
stylesheet when you have one (or set `theme` in design/config.ts).
```

and after the file list:

```
┌─ NO APP DETECTED ─────────────────────────────────────────────────────┐
│ This repo has no framework, no theme CSS, and no component library.   │
│ marver builds frames from YOUR components - with none, frames become │
│ hand-rolled CSS that cannot be promoted into an app later.            │
│ Set up the app first, then re-run init …                              │
└───────────────────────────────────────────────────────────────────────┘
```

`design/AGENTS.md` line 21 now opens with a hard stop rather than a fictional import
alias:

> STOP - this repo has no component library, no Tailwind, and no theme. Frames built
> from hand-rolled CSS cannot be promoted into an app later. Ask the human to set up
> the app first (framework + styling), then re-run `npx marver init` …

This is the fix. On 0.2.0 the same command handed me `import from @/components/ui`
in a repo with no `src/`, and I wrote three complete landing pages against it before
the human stopped me.

Same run also closes:

- **#4** — `design/tsconfig.json` no longer `extends` a root tsconfig that does not
  exist; `init` writes a standalone config when the host has none.
- **#6** — `design/manifest.json` is written by `init` (660 bytes, 3 demo frames), so
  the "read the manifest before exploring" instruction in `AGENTS.md` is true from
  the first second.

### ✅ #8 / #12 / #13 / #14 / #17 — the papercuts

| | 0.2.0 | 0.2.1 (measured) |
|---|---|---|
| #8 CLI version | `marver/0.1.0` | `marver/0.2.1 darwin-arm64 node-v22.23.1` |
| #12 sourcemap noise | ~35 lines per start | **0** — cold (`rm -rf node_modules/.vite`) and warm |
| #13 typeless warning | every start | **0** — cold and warm |
| #14 fresh board | `GET /__mv/api/boards/x` → 404 | `200 {"board":null}` |
| #17 `serve` busy port | unhandled `error`, raw stack | `[marver] port 4321 is already in use - another \`marver serve\` still running? Stop it, or pass --port <n>.` + exit 1 |

On #12/#13: my first restart after the upgrade still showed both warnings, which
briefly looked like the fix not working. It was not — that server was started from
the pre-upgrade install. Re-tested on a clean 0.2.1 process with the Vite dep cache
deleted: zero occurrences either way.

### ✅ #18 — fixed, and my original report was wrong

`serve` prints on success:

```
  marver serving design/.dist → http://localhost:4321/
  gate: off - set MARVER_PASSWORD to require a password
```

**But those two `console.log` calls are present in the 0.2.0 bundle too** — I diffed
them, they are unchanged context lines. So 0.2.0 was not silent by design. What
almost certainly happened is that my 0.2.0 run died of EADDRINUSE (#17) in a way that
swallowed the trace, and I logged the silence as its own bug. **#18 was #17 wearing a
hat.** Discount it in any triage.

Still true, and minor: the banner prints the URL and the gate state but not which
boards were published, which is the one thing you want to check after
`build --boards`.

### ✅ #7 / #10 / #11 — the docs

- **#7** — README no longer links `./SPEC.md` and `./DECISIONS.md` (which do not ship).
  It points at the GitHub repo. I have not opened that link from here, so I cannot
  confirm the repo is public — worth one check before release.
- **#10** — "Next.js is partial" is now in three places: the README (a full
  paragraph), the `init` output, and the generated `design/AGENTS.md`. On 0.2.0 it
  appeared once, in `init` stdout, which an agent never sees.
- **#11** — the AGENTS template now names the failure and prescribes the exact
  remedy I had to derive by hand: `--font-sans: var(--font-geist-sans, ui-sans-serif,
  system-ui, sans-serif)`. Frames still cannot use `next/font` — correctly, since
  they render outside Next — but nobody has to discover that by watching type render
  wrong.

---

## Fixed in source, needs a live canvas session to close

These four are real code changes in the shipped bundle that I read and can quote, but
confirming them means driving the canvas in a browser, which I have not done since
the upgrade. Flagging them as **unclosed**, not as fixed.

### 📦 #20 — bricked canvas after rename / restart

The single most-hit bug of the 0.2.0 session (three separate times), and 0.2.1
attacks it from four directions at once:

1. **Manifest revision stamped into every frame URL** (`store.ts`) — a new manifest
   bumps `manifestRev`, so frame iframes get genuinely new URLs and the browser
   cannot revive a pre-change document from cache.
2. **`cache-control: no-store` on the frame host**, `no-cache` on the frame-host
   registry module (`plugin.mjs`). Confirmed over the wire:
   `curl -I …/__mv/frame/` → `cache-control: no-store`.
3. **Renavigation nonce** (`FrameNode.tsx`) — the shell can force an errored iframe
   onto a fresh URL instead of reloading a poisoned one.
4. **Honest error copy** — the old message was `unknown frame id "hero/a-statement"`,
   which accuses the file. The new one says the registry is stale, not the id:
   *"…the file was likely just added or renamed. The canvas should recover on its
   own; if this card persists, reload it."*

That last change alone would have saved most of the time I lost, because the old
wording sent me hunting a file that was fine. Whether the recovery now happens
without opening a new tab is the thing to verify.

### 📦 #3 — dark mode reaching shadcn

`frame-host/main.tsx` and `bridge.js` now set **both** signals on every theme
apply — `documentElement.dataset.theme` *and* `classList.toggle('dark', …)` — with a
comment naming exactly why: `@custom-variant dark (&:is(.dark *))` never sees a data
attribute. This is the fix I had to hand-patch into our own `globals.css`; with it
upstream, that patch becomes unnecessary for new projects.

### 📦 #15 — dead-frame tombstones on the auto board

`store.ts` now prunes `missing` nodes when loading an auto-managed board, and marks
the board dirty so the prune persists to disk — otherwise a recreated frame id would
resurrect its stale node. The comment cites `friction log #15` and correctly
separates the concepts: tombstones are a *curated*-board feature, auto boards should
shed deleted frames.

### 📦 #23 — selection toolbar collision

`App.tsx` measures the toolbar with a `ResizeObserver` and clamps it into the
viewport on both axes (`clamp(8px, …, calc(100vw - w - 8px))`). This is the entry I
could never reproduce myself in 0.2.0 — I filed it from a screenshot and could only
point at the missing clamp in the source. The clamp now exists.

---

## Partially addressed — what still stands

### ◐ #19 — versions of the same thing

**0.2.1 adopted the convention.** The generated `AGENTS.md` now says, nearly verbatim
what the 0.2.0 log proposed:

> VERSIONS are sibling frames too - the scene is the surface, each frame one
> direction: `design/scenes/landing/a-terminal.tsx`, `landing/b-editorial.tsx`,
> `landing/c-product.tsx`. Layout and the sidebar follow frame-id order, so variants
> named under one scene with `a-`/`b-`/`c-` prefixes stay adjacent and ordered through
> tidy and every device view. Never spread versions across scenes.

That is a real improvement: the load-bearing fact (everything sorts by
`id.localeCompare`) is now written down instead of being something you learn by
reading `plugin.mjs`.

**What still stands:** it is a naming convention, not a feature. Nothing in the tool
*knows* that `landing/a-terminal` and `landing/b-editorial` are the same surface. So:

- No way to say "show me A vs B vs C of this surface" without hand-building a board.
- The prefix is load-bearing and silently so — rename `a-terminal` to `terminal` and
  the comparison quietly re-sorts.
- No diff, no lock-step scroll, no "these three should stay the same width".
- Nothing stops the set from drifting (variant C missing a section the others have).

A first-class `variants` concept — one surface, N frames, laid out as a row, ordered
explicitly rather than lexically — is still the feature I'd want.

### ◐ #16 — boards still auto-lay-out into a column

The docs got better: the AGENTS template now tells agents that `x`/`y` exist, that
they're for one-off setups, and that **frame-id order is the durable arrangement**
because tidy and the device views rewrite the board. That is honest and useful.

The behavior did not change. `tidy` still stacks by scene, so the natural result of
"put three landing directions on a board" is still a column unless you know the
naming trick or hand-place coordinates that the next `t` press discards.

### ◐ #9 — `--no-demo`

The description is fixed and now unambiguous:

```
--no-demo   Skip the demo scene (the demo ships unless this flag is passed) (default: true)
```

…except `cac` still appends `(default: true)` to a `--no-` flag, which is the exact
string that confused me in the first place. Now the line says both "skip the demo"
and "default: true" in the same breath. Suppressing the auto-default for negated
flags would finish this off.

### ◐ #5 — where the theme goes

All three messages were rewritten to say the same thing (`create design/theme.css`
importing the app's stylesheet, or set `theme` in `design/config.ts`), which removes
the contradiction I hit. Two answers in one sentence is still one more than
necessary, and the README, the `init` warning, and the in-canvas banner remain three
separate places to keep in sync.

---

## 🆕 New in 0.2.1

### 🟡 N1 — the NO APP DETECTED box is misaligned

The banner is the most important new output in the release and its borders do not
line up. Two rows close one column early:

```
│ This repo has no framework, no theme CSS, and no component library.   │
│ marver builds frames from YOUR components - with none, frames become │   ← short
│ design/AGENTS.md was generated with a STOP instruction so your agent  │
│ does not design against a component library that does not exist.     │   ← short
```

Both short rows are the ones that interpolate `${NAME}` or were padded for a
different string length. Cosmetic, but it is the first thing a new user sees when
they do the thing the release is trying to catch.

### 🟠 N2 — no changelog ships, no upgrade signal, and no "your contract is stale"

Three missing signals, in increasing order of how much they cost.

**1. No changelog.** 0.2.1 fixes 16 logged issues, rewrites the generated `AGENTS.md`
contract, and changes dev-server behaviour. There is no `CHANGELOG.md` in the
package, `npm view` shows no release notes, and the GitHub repo is the only place
they might exist. The entire "what changed" section of this document was produced by:

```bash
npm pack @marver-design/marver@0.2.0 @marver-design/marver@0.2.1
diff -r v020/package v021/package
```

That is a reasonable thing for me to do once, as the person writing the friction log.
It is an absurd thing to expect of a user who just wants to know whether the bug that
wasted their afternoon is fixed. I nearly filed two false regressions along the
way — the sourcemap and typeless warnings (#12/#13) looked broken until I realised
the server I was reading had been started from the pre-upgrade install.

**2. No upgrade signal.** A running `marver dev` never mentions that a newer version
exists. We only found out we were on 0.2.1 because I happened to check the version
for an unrelated reason. Everything in this document could have gone unnoticed
indefinitely.

**3. No "your contract is stale" — the one that actually matters.** `design/AGENTS.md`
is *generated*, and 0.2.1 changed what it tells agents to do (the versions-as-sibling-
frames rule, the Next.js caveats, the STOP for app-less repos). An agent reading a
0.2.0-generated contract on a 0.2.1 install is following superseded instructions and
has no way to know.

The mechanism for this already exists and is good: `init` is idempotent and
regenerates `AGENTS.md` when its marker comment is intact. Nothing tells you to run
it. The marker line could carry the version that wrote it, and `marver dev` could say
one line at boot:

```
  design/AGENTS.md was generated by 0.2.0 - run `npx marver init` to update it
```

**Fix I'd want, in priority order:** (1) stamp the generator version into the
`AGENTS.md` marker and warn at `dev` boot when it trails the installed version;
(2) ship a `CHANGELOG.md` in the package — for a tool whose users are agents that
read files, a changelog on disk is worth more than a GitHub release page; (3) a
one-line "newer version available" on `dev` boot.

### 🟠 N3 — deleting a board file is silently undone by any open canvas

Hit while resetting this repo to a single board. With `marver dev` running and the
canvas open in a browser tab:

```bash
rm design/boards/{all-scenes,directions,hero,prototype}.json
ls design/boards/     # → all-scenes.json  hero.json   ...back, same second
```

`directions.json` and `prototype.json` stayed deleted. `all-scenes.json` and
`hero.json` came back immediately, because those were the two boards the open tab had
loaded — the shell holds them in memory and writes them back. Worse, the resurrected
`hero.json` was the *full* 718-byte board, with nodes for four frames I had just
deleted from disk, so it came back as tombstones.

**Expected:** the filesystem is the source of truth for a tool whose whole premise is
"your agent edits files". Deleting a board file deletes the board.

**Happened:** the browser tab is the source of truth, and it silently overwrites the
agent. There is no warning, no toast, no conflict — the board file just reappears.
The only reliable sequence is stop the dev server → delete → restart → **open a new
tab**, which is uncomfortably close to #20's remedy.

This matters more in 0.2.1 than it would have in 0.2.0, because #15's fix means the
shell now legitimately writes boards back on load (to prune tombstones). That is the
right behavior; the missing half is noticing that the file it is about to write was
deleted underneath it.

**Fix I'd want:** watch `design/boards/` for `unlink` (the watcher is already there
for `add`/`change`) and drop the board from the shell when its file goes away —
same as frames. At minimum, do not re-create a board file that was deleted while the
canvas was idle.

### 🟡 N4 — you cannot have only one board

`all-scenes` is unconditionally prepended to the switcher in dev
(`store.ts:39`), whether or not the file exists:

```ts
return ['all-scenes', ...list.map((b) => b.name).filter((n) => n !== 'all-scenes').sort()]
```

So "give me one board" is not expressible. I deleted every board file and wrote a
single `website.json`, and the switcher still shows **All scenes** plus **Website**.
For a repo with one curated board that is permanent, unavoidable noise — and the
reserved board is the *first* item, so the one board you care about is never the
default-looking one.

Published builds get this right (`DATA.names` — "all-scenes only when actually
published"). Dev should match: show the aggregate board when there is something to
aggregate, or let `design/config.ts` turn it off.

**Related, and good:** `auto: true` *does* work on a custom board —
`if (typeof board?.auto === 'boolean') boardAuto = board.auto` (`store.ts:189`)
overrides the `boardName === 'all-scenes'` default. That is what makes a single
self-maintaining exploration board possible at all, and it is not documented
anywhere; the AGENTS template only says `auto: false` boards show exactly their list
and that `all-scenes` is "the auto-managed one", which reads as *the* auto board
rather than *a default*.

### 🟠 N5 — the empty state is the worst-looking thing in the product, and it is the first thing you see

`App.tsx:611`:

```tsx
{frames.length === 0 && <div className="sub dim">no frames yet - ask your agent<br />(design/AGENTS.md)</div>}
```

It renders as a ragged three-line block, indented under a **Scenes** heading that
labels nothing, in the style of a disabled list row. It reads as *something is
broken*, not as *you're at the start*.

**Why it looks that way** — it reuses `.sub`, which is the class for a **frame list
row**, for prose:

```css
.sh-panel .sub      { display: flex; align-items: center; height: 28px; padding: 0 8px 0 31px }
.sh-panel .sub.dim  { height: auto; line-height: 1.4; padding-top: 4px; padding-bottom: 4px }
```

So two sentences get laid out as a single flex item, indented 31px to align with
frame names that do not exist, with a hard-coded `<br />` that breaks at a point
unrelated to the panel width. The `.dim` override patches the height but not the box
model it inherited. Nobody designed this; it inherited a list row and hoped.

**Why it matters more than a cosmetic nit:**

1. It is the **first screen after `init`** — the exact moment 0.2.1 spent a whole
   release making better in the terminal (the NO APP DETECTED banner, the STOP in
   `AGENTS.md`). All that care stops at the edge of the canvas.
2. It is the **only** place the product can teach its core loop — *your agent writes
   a file, it appears here* — and it spends that moment on a lowercase fragment and a
   bare filepath that is not a link.
3. It is not rare. It is every fresh install, every reset, and every filtered board
   that happens to be empty.

**What I'd ship instead.** A real empty state, not a list row — full panel width, no
indent, no `<br />`, and the `Scenes` heading suppressed when there are no scenes:

```
┌──────────────────────────────┐
│  No frames yet               │   ← 13px, ink-1, 600
│                              │
│  Your agent writes a file    │   ← 12px, ink-3, 1.5 line-height
│  and it appears here.        │
│                              │
│  design/scenes/landing/      │   ← mono 11px, in a subtle token box
│    a-hero.tsx                │
│                              │
│  [ Copy starter prompt ]     │   ← the one thing to actually DO
│  Read the frame contract →   │   ← opens design/AGENTS.md
└──────────────────────────────┘
```

The **Copy starter prompt** button is the piece I would fight for. `init` already
composes exactly the right prompt and prints it to stdout:

> then, to your agent: "Read design/AGENTS.md. Build an onboarding scene - welcome,
> form, done - mobile-first, using our components."

…in a terminal the human has probably already scrolled past, in a workflow where the
next thing they do is switch to the browser. The empty canvas is where that prompt
belongs, one click from the clipboard. Right now the canvas knows the user has zero
frames and says the least useful possible thing about it.

**Fix I'd want:** a dedicated `.sh-empty` block (its own padding, `display: block`,
`text-wrap: pretty`, no inherited indent), the heading suppressed when its group is
empty, sentence-case copy that names the mechanism, and the starter prompt as a copy
button. Roughly 20 lines of TSX and CSS for the first impression of the product.

---

## Method note

Version comparison was done by unpacking both releases and diffing them:

```bash
npm pack @marver-design/marver@0.2.0 @marver-design/marver@0.2.1
diff -r v020/package v021/package
```

Runtime checks ran against `npx marver dev --port 5210/5211` in this repo and a
throwaway empty git repo for the `init` paths. Where a check needed the canvas
itself, it is marked 📦 rather than ✅.

---

## Still good

Everything the 0.2.0 log praised still holds — frames as plain files with a three-key
`meta`, `data-goto` as the entire prototype system, boards as readable JSON, and the
fact that the tool ships no model and makes no attempt to be the designer.

Worth adding for 0.2.1: **the turnaround.** A friction log written on a Tuesday came
back as a release on a Wednesday, with the entry numbers cited in the source
comments. That is the loop the log exists for.
