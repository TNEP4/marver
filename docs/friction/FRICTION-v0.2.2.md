# FRICTION — `@marver-design/marver@0.2.2`

The current friction log. One log per published version; earlier ones are frozen:

| File | Version | State |
|---|---|---|
| **FRICTION-v0.2.2.md** (this) | `0.2.2` | current |
| [FRICTION-v0.2.1.md](./FRICTION-v0.2.1.md) | `0.2.1` | frozen |
| [FRICTION-v0.2.0.md](./FRICTION-v0.2.0.md) | `0.2.0` | frozen — the original 23 entries |

Every status is either measured with a command whose output is quoted, or explicitly
marked source-only. I do not claim a fix works because a comment says it does.

## Environment

| | |
|---|---|
| Marver | `@marver-design/marver@0.2.2` |
| Released | 0.2.0 → Aug 11 17:28Z · 0.2.1 → Aug 12 08:57Z · 0.2.2 → Aug 12 **12:49Z** |
| Stack | Next.js 16.3.0 · React 19.2.8 · Tailwind v4.3.3 · shadcn/ui 4.16.2 (`base-nova`) |
| Node / npm | v22.23.1 / 10.9.8 |
| OS | macOS (darwin 25.6.0), Chrome |

Three releases in 19 hours. That cadence is the context for everything below.

## Headline

**0.2.2 is the "managed files" release.** It closes the hardest part of N2 — the one
I argued for most — and does it more thoroughly than I proposed:

- **An update pill in the canvas**, fed by a new `/__mv/api/update` endpoint (one
  registry check a day, cached in `design/.local/`, `MARVER_NO_UPDATE_CHECK=1` to
  disable, and silent on published canvases so a shared review link never nags a
  viewer).
- **The command it hands you is `npm i -D marver@latest && npx marver init`** — with
  the source comment *"init rides along so managed files (AGENTS.md, instructions/)
  refresh with the code"*. That is exactly the stale-contract problem.
- **Content-hashed managed files.** `init` now stamps a hash of what it generated.
  Untouched file → updated silently. You edited it → your version is left alone and
  the new one is staged at `design/.local/latest/<file>` to merge. That is better
  than the version-stamp-and-warn I suggested.
- **`design/instructions/`** — 20 new files (`craft.md`, `wireframe.md`, `review.md`,
  `brand.md`, plus a `reference/` set covering colour, typography, layout, motion,
  states, copy, delight, critique, and one called `slop.md`). The agent contract went
  from one file to a small library.

**Still open and now conspicuous: N5, the empty state.** It is byte-identical —
`App.tsx:650`, same `<br />`, same repurposed `.sub dim` list-row class, same CSS.
Meanwhile this release added a *new* pill with bespoke glass, an entrance animation,
a hover state, and a dismiss affordance. The first screen every new user sees is now
the least designed surface in the product, and the gap widened.

---

## Status

Legend: **✅ fixed** (verified here) · **📦 fixed in source** (read, not yet exercised
on a live canvas) · **◐ partial** · **❌ open** · **🆕** new in 0.2.2.

| # | Issue | Status | How I checked |
|---|---|---|---|
| [N2](./FRICTION-v0.2.1.md) | No changelog / upgrade signal / stale contract | ✅ **mostly fixed** | `/__mv/api/update` → `{"latest":null,"current":"0.2.2"}`; still no `CHANGELOG.md` |
| [N1](./FRICTION-v0.2.1.md) | NO APP DETECTED box misaligned | ❌ open | rewrote the copy, box still off by one char |
| [N3](./FRICTION-v0.2.1.md) | Deleting a board undone by open canvas | ❌ open | boards watcher byte-identical to 0.2.1 |
| [N4](./FRICTION-v0.2.1.md) | `all-scenes` unremovable | ❌ open | `store.ts:42` unchanged |
| [N5](./FRICTION-v0.2.1.md) | Empty state is a broken-looking list row | ❌ open | `App.tsx:650` + `.sub.dim` both unchanged |
| [#19](./FRICTION-v0.2.0.md) | Versions not first-class | ◐ partial | convention documented, still no feature |
| [#16](./FRICTION-v0.2.0.md) | Boards auto-lay-out into a column | ◐ partial | layout unchanged |
| [#20](./FRICTION-v0.2.0.md) | Rename/restart bricks the canvas | 📦 | 0.2.1 mitigations, still unexercised |
| [#15](./FRICTION-v0.2.0.md) | Auto board keeps tombstones | 📦 | prune-on-load, still unexercised |
| [#23](./FRICTION-v0.2.0.md) | Toolbar collision | 📦 | clamp added in 0.2.1 |
| N6 | `init` re-scaffolds demo frames into a deliberately empty `design/scenes/` | 🆕 | hit it live |
| N7 | Upgrading is a two-command ritual you must not forget | 🆕 | design of the update pill |

Everything marked ✅ in the 0.2.1 log stayed fixed. Nothing regressed.

---

## ✅ N2 — the upgrade signal, mostly closed

The new endpoint, live on this repo:

```bash
$ curl -s localhost:5199/__mv/api/update
{"latest":null,"current":"0.2.2"}

$ ls design/.local/
update-check.json          # 45 bytes, the daily cache
```

`latest: null` because we are current. The design is careful in ways worth naming:
the check is skipped entirely on a published canvas (`if (PUBLISHED) return`), the
dismiss writes the *specific version* to `localStorage` so the pill returns only when
the next release lands, and the whole thing can be turned off with an env var.

**What remains:** still no `CHANGELOG.md` in the package. The pill tells you a new
version exists and hands you the command, but nothing tells you *what changed*. I
still had to `npm pack` both versions and diff them to write this file — the third
time in two days. For a tool whose users are agents that read files, a changelog on
disk is worth more than a release page. That is now the only piece of N2 outstanding,
and it is the cheapest of the three.

## 🆕 N7 — upgrading is a two-command ritual, and the second one is easy to skip

The pill hands you:

```
npm i -D @marver-design/marver@latest && npx marver init
```

Both halves matter — the second is what refreshes `AGENTS.md` and
`design/instructions/`. But nothing enforces it. Run only the first (which is what
anyone typing from muscle memory does, and what `npm update` does) and you get new
code with a stale contract: exactly the state 0.2.2 built the merge machinery to
prevent.

The dev server already knows both numbers — it compares them for the pill. It could
compare the managed-file hashes just as easily and say *"your design/instructions/
were generated by 0.2.1 — run `npx marver init`"*. The information is one hash away.

**Fix I'd want:** either make `dev` warn when managed files trail the installed
version, or run the managed-file refresh from `dev` boot and let `init` stay a
first-run command.

## 🆕 N6 — `init` re-scaffolds the demo into a deliberately empty scenes folder

Hit live. This repo's `design/scenes/` was emptied on purpose — the previous
exploration was cleared to start fresh, leaving only `_layout.tsx`. Running the
upgrade command put `design/scenes/demo/` (3 frames) straight back.

That is `init` doing what it says — the demo ships unless `--no-demo` — but the flag
is a *first-run* concept being applied on an *upgrade* path. The pill now recommends
`init` as routine maintenance, so this will happen to everyone, repeatedly, and it
lands worst on exactly the setup 0.2.2 encourages: an auto board picks the demo
frames up immediately, so they do not sit quietly in a folder, they appear on your
canvas next to your real work.

Compare it with how carefully the same release treats `AGENTS.md`: hash it, detect
edits, stage the new copy, never clobber. Scenes got none of that consideration.

**Expected:** on a repo that already has a `design/` workspace, `init` refreshes
managed files and leaves my content alone.
**Happened:** it also re-created example content I had deliberately deleted.
**Fix I'd want:** ship the demo on first init only — if `design/scenes/` exists,
never write into it. The "is this a first run?" signal already exists; `init` checks
`existsSync(design)` a few lines earlier to decide whether to refuse a non-Marver
folder.

## ❌ N5 — the empty state, unchanged, now the worst-looking thing in a nicer product

`App.tsx:650` in 0.2.2, byte-identical to 0.2.1:

```tsx
{frames.length === 0 && <div className="sub dim">no frames yet - ask your agent<br />(design/AGENTS.md)</div>}
```

`.sub` and `.sub.dim` in `styles.css` are unchanged too, so it is still prose laid
out inside a 28px flex list row, indented 31px to align with frame names that do not
exist, broken by a hardcoded `<br />`.

What makes it worth re-raising rather than repeating: **this release proves the team
can do this well.** The update pill got its own class, a glass recipe, an edge-light
ring, a cubic-bezier entrance, a hover transition, an ellipsis rule for long
commands, and a dismiss button with its own hover state. Roughly 20 lines of CSS,
written from scratch, for a pill most users will see a handful of times.

The empty state is seen by **every user on their first run**, is the only place the
core loop can be taught, and got nothing. The full proposal is in
[FRICTION-v0.2.1.md](./FRICTION-v0.2.1.md) N5 — including putting the starter prompt
that `init` prints to a terminal nobody reads onto the canvas as a copy button, now
that 0.2.2 has demonstrated exactly that pattern with the update command.

## ❌ N1 — the NO APP DETECTED box is still off by one character

Copy rewritten, alignment not fixed. Measured, `init` in an empty repo:

| line | width |
|---|---|
| top border | 75 |
| `│ No framework, no theme CSS, no component library. marver builds      │` | **74** |
| every other line | 75 |

One line, one character short, and it is the line interpolating the package name.
The padding is computed for a placeholder rather than the substituted value. Now
easier to fix than before, because it is down to a single line.

## ❌ N3 / N4 — untouched

- **N3** (deleting a board file is undone by an open canvas): the `fs.watch` block on
  `design/boards/` is byte-identical between 0.2.1 and 0.2.2 — still `add`/`change`
  only, no `unlink`. Note 0.2.2 *did* add `.tmp` cleanup on boot in the same
  function, so the file was open in an editor.
- **N4** (`all-scenes` cannot be removed): `store.ts:42` unchanged —
  `['all-scenes', ...list.filter(n => n !== 'all-scenes').sort()]`. Still impossible
  to have exactly one board.

---

## 🆕 Worth noting, not a complaint

Two 0.2.2 changes I want to record because they are good and easy to miss:

**`init` refuses to merge into a foreign `design/` folder.** If the directory exists
and looks nothing like a Marver workspace, it exits 1 with a clear explanation —
*"your files and marver's would interleave, and 'uninstall = delete design/' would
stop being safe"* — and points at the issue tracker for the `--dir` flag people will
want. That is a destructive-merge bug caught before anyone hit it.

**The managed-file three-way logic.** Unedited → update in place. Edited, release
unchanged → leave alone. Edited *and* release changed → keep yours, stage theirs at
`design/.local/latest/`, print a one-line note. This is the behaviour a generated-
contract system needs, and it arrived one release after the problem was described.

## If you ship one more release, ship these

1. **N5** — the empty state. Unchanged across three releases and the contrast with
   the new pill makes it louder every time.
2. **N6** — stop re-scaffolding the demo on upgrade, now that upgrade means `init`.
3. **N2 remainder** — a `CHANGELOG.md` in the package.
4. **N7** — warn when managed files trail the installed version.
5. **N3** — the filesystem should win over an open browser tab.

## Method note

```bash
npm pack @marver-design/marver@0.2.1 @marver-design/marver@0.2.2
diff -r v021/package v022/package
```

Runtime checks ran against `marver dev` in this repo and a throwaway empty git repo
for the `init` paths. Live-canvas behaviour is marked 📦, not ✅.
