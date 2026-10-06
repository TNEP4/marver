<!-- marver:managed cdd8d0a2cd742dfa9015bba753981c4ded3090ad8f07a13c07cad42944a5491b - edit freely: init preserves your edits and stages upstream updates at design/.local/latest/ for you to merge. Delete this line to detach this file from updates entirely. -->
# Context - what the product is, kept true

The project's knowledge lives in `context/`, beside `design/`. Code says what is implemented;
`context/` says what is available, how it works, why, and what is next - with evidence. The canvas
reads the same files: every feature and project board wears the status they record.

## At the start of a session

Read `context/INDEX.md`, then at most two more files per question. The index routes; it never
explains. If there is no `context/`, see "Setting up" below before you invent answers.

## The files

| Path | What it holds |
|---|---|
| `INDEX.md` | routing only, under 800 words; its capability table is generated from `map.json` |
| `shipped.md` | **the only place availability is written** - services by environment, capabilities by who has them; for knowledge work, what was delivered to whom |
| `product/<capability>.md` | one current contract per capability |
| `map.json` | which code each capability lives in - the pull-request rule reads it |
| `playbooks/<name>/PLAYBOOK.md` | how we do things - steps with checks, traps, a run log |
| `feedback/` | the inbox: one row per piece of feedback, with its state |
| `plans/` | proposals in flight - a plan folds into its contract when it lands |

## Evidence has levels

Every availability claim in `shipped.md` carries one, with a citation:
- `confirmed` - observed in a system of record: the deploy job that ran for that service and
  succeeded, a ci run that executed the suite. Not an environment marked "deployed" - some
  pipelines mark it when the run stood down.
- `reported` - a written claim, cited: a changelog line, an ops note.
- `unknown` - neither, with the reason. An honest unknown is a correct answer.

Never upgrade a level because a claim sounds sure. Commit ancestry says a change is inside a
revision, not that the revision is running.

## A contract

```yaml
---
state: current            # current | proposed | historical
capability: quote-intake  # the same slug as its feature board
audience: team            # team | publishable | restricted
reviewed: { revision: 606ad4e, scope: "apps/quote, db schema", method: "read code and tests" }
---
```

Then: what it does and its limits; who can use it and when; how it works; what it touches (frontend,
backend, database, workers, integrations); invariants; code and tests; decisions; its frames
(`scene/frame` ids - say which are designed but not built); the PRs that built it; what is still
proposed; and `## Availability` pointing at its row in `shipped.md`.

- **Read the code to write it.** Cite `path:line` for every behaviour; a test file's existence is
  not a run.
- **No status line, no availability** ("live", "on production", "since 30 Sep") - that is
  `shipped.md`'s alone. The check fails on both.
- **One answer per rule.** When a plan amends a rule, write the amended rule - never "section 20
  wins where it differs".
- **When code and an accepted document disagree,** the contract says what the code does and the
  conflict goes to the human. Never decide what was intended.

## When you change things

- **Behaviour** - update its contract in the same change. A change that leaves behaviour alone says
  `no-contract-change: <capability> - <why>` in the pull request body.
- **A deploy** - write its row in `shipped.md` with the run that proves it (`playbooks/` usually
  has the release recipe).
- **A decision** - in the project's decision log, numbered, with what it applies to.
- **Feedback** - one row per item: source, who, when, what they said, theme, state (`new`,
  `triaged`, `proposed`, `planned`, then `shipped` or `declined`), and what resolved it. An item is
  `shipped` only when `shipped.md` shows its fix `confirmed` where it was raised; a `reported`
  deploy leaves it `planned`, saying what is missing. On closing, draft - never send - a note back.

## Status on the canvas

Feature and project boards wear a status read from these files (the first that matches wins):
the board's own `"status"` - `archived`, `paused`, or `blocked` with a `"reason"`; Unknown when the
evidence cannot be read; In progress when an open plan in `plans/` names the capability (filling by
phase: `<cap>-specs`, `<cap>-lofi`, `<cap>`); Done when `shipped.md` shows it `confirmed` in an
availability clause (one per `;`) with no negation or pending word ("nowhere", "not yet", "rolled
back", "planned") and no pre-production place (staging, preview, dev, local, testing) unless it also
names production; Done, reported when only `reported`; To do when its contract is `state: current`; else Backlog.
**Done is never set by hand** - `"status": "done"` fails the check. A board finds its capability by
its own name, or `"capability": "<slug>"` in its JSON.

## Audiences

`team` - everyone with the repository (the default); `publishable` - may appear on a published
canvas; `restricted` - never tracked by git (keep it under a gitignored `context/private/`). A
frame that renders a `team` file onto a published board fails the check. A digest of restricted
material is restricted, however it is labelled.

## Setting up - when there is no `context/`

Context starts with people. Ask, in one message:
1. Who is involved - the team and their roles; clients, users, partners?
2. Where does each relationship happen - channels, email, recorded meetings, docs, in-product
   feedback, canvas comments?
3. What is private, and who may see what?
4. How is this project named in shared spaces - keywords, tags?

Then `npx marver context init`, record the answers in `context/people.md`, and draft from evidence:
the shipped record from deploy runs and the changelog (`unknown` where nothing proves it), a map from
the code, contracts for the capabilities that matter now. **Context that exists but is scattered**
- specs out of date, nobody sure what is live - is a job for
`context/playbooks/reorganize-context/PLAYBOOK.md`, not for a rewrite.

## The check

`npx marver context check` - availability only in `shipped.md`, a level and a citation on every
evidence cell, citations and links that resolve, the index under budget and equal to the map,
audiences, feedback and contract states, playbook freshness; with `--base <ref>` (or in ci on a pull
request) a contract change or a stated reason for every mapped change. Exit 0 pass, 1 fail, 2 cannot
determine (fetch full history - `fetch-depth: 0`). `npx marver context index` rewrites the index's
generated table after you change the map.
