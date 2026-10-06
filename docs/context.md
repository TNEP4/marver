# Context

Code says what is implemented. **`context/`** says the rest - what is available and to whom, how each
capability works, why it was decided, what is next - with evidence, in files any agent reads. The
canvas reads the same files: every feature board wears the status they record.

```
context/
  INDEX.md                 routing only, under 800 words - read first
  shipped.md               the only place availability is written, every cell with its evidence
  product/<capability>.md  one current contract per capability
  map.json                 which code each capability lives in
  playbooks/<name>/        how we do things: steps with checks, traps, a run log
  feedback/                the inbox: one row per piece of feedback, with its state
  plans/                   proposals in flight - folded into their contract when they land
```

A fresh agent with no memory reads the index and at most two more files per question. On the first
project this was run on, a blind eval answered the same 16 questions correctly before and after - with
40% fewer tokens after, and answers that said which deploys were confirmed and which only reported.

## Start

```bash
npx marver context init
```

Creates `INDEX.md`, `shipped.md`, `map.json` and the two playbooks Marver maintains -
`reorganize-context` and `publish-canvas` - and adds one line to your root `AGENTS.md` routing every
agent to the index. It never overwrites; re-running it updates the playbooks you have not edited and
stages a new version beside any you have. `--kind knowledge` keeps a delivered record instead -
Project and Delivered columns - and a repository without a canvas gets the conventions themselves as
`context/README.md`.

Then ask your agent: *"Read design/instructions/context.md and set up our context."* It interviews
you first - who is involved, where each relationship happens, what is private - then drafts from
evidence: the shipped record from deploy runs and the changelog, the map from the code, contracts
for the capabilities that matter now. Where nothing proves a claim, it writes `unknown`.

**Context that exists but is scattered** - specs out of date, nobody sure what is live - is a job for
the `reorganize-context` playbook: on a branch, never deleting, truth first (the shipped record),
then authority (current contracts), then files, proven by a blind before-and-after eval.

## Evidence

Every availability claim in `shipped.md` carries a level and a citation:

- `confirmed` - observed in a system of record: the deploy job that ran for that service and
  succeeded, a ci run that executed the suite.
- `reported` - a written claim, cited: a changelog line, an ops note.
- `unknown` - neither, with the reason.

An environment marked "deployed" is not proof on its own, and commit ancestry says a change is
inside a revision, not that the revision is running.

## The check

```bash
npx marver context check            # exit 0 pass, 1 fail, 2 cannot determine
npx marver context check --base origin/main --body-file pr.md
npx marver context index            # regenerate the index's capability table from the map
```

It fails on:

- availability or a status line in a contract ("live since", "on production") - that is the
  shipped record's alone;
- "section 20 wins where it differs" - one answer per rule;
- an evidence cell without a level, or `confirmed` and `reported` without a citation;
- a link or a `path:line` citation that does not resolve;
- the index over 800 words, or its capability table out of step with `map.json`;
- a `restricted` file tracked by git, or a `team` file reachable from a published board;
- a feedback item `shipped` without a `confirmed` availability, or a state off its list;
- `"status": "done"` on a board - Done comes only from the record;
- on a pull request, a change to a contracted capability's code without its contract, unless the
  body says `no-contract-change: <capability> - <why>`.

It reports, without failing: playbooks gone stale since their last success, and source files the
map neither maps nor excludes (`"source"` in `map.json` names what counts).

In ci, with full history:

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- run: npx marver context check
```

On a pull request it reads the base, head and body from GitHub's event.

## On the canvas

Feature and project boards wear a status, read from these files - the first that matches wins:

| | When | Status |
|---|---|---|
| 1-3 | the board says `"status": "archived"`, `"paused"`, or `"blocked"` with a `"reason"` - by hand, or from the sidebar's **Change status…** | Archived · Paused · Blocked |
| 4 | the evidence cannot be read | Unknown |
| 5 | an open plan in `context/plans/` names the capability | In progress, filling by phase |
| 6 | `shipped.md` shows it available, `confirmed` - in a clause (one per `;`) with no negation or pending word ("nowhere", "not yet", "rolled back", "planned") and, for a product, no pre-production place (staging, preview, dev, local, testing) unless it also names production | Done |
| 7 | ... `reported` only | Done, reported |
| 8 | its contract is `state: current` | To do |
| 9 | anything else | Backlog |

A board finds its capability by its own name, or `"capability": "<slug>"`. The fill reads the
board's phase scenes - `<capability>-specs`, `-lofi`, then the capability itself - once each holds a
frame. The tooltip says what decided it. Change a file and the sidebar follows; no reload.
[Boards and folders](boards-and-folders.md) has the board types the status rides on.

## Audiences

`team` - everyone with the repository, the default; `publishable` - may appear on a published canvas;
`restricted` - never tracked by git (a gitignored `context/private/`). A frame that renders a `team`
file onto a published board fails the check, and a published build never carries a board's status,
reason or capability unless its publish row opts in with `"showStatus": true` - and then only rows
5 to 9, and only a status whose every source is publishable: a file under `context/` that says
`audience: publishable`, or a scene brief that does not say otherwise (it ships with its board).
