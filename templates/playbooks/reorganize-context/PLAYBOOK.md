---
name: reorganize-context
description: Reorganize an existing project's accumulated context - specs, changelogs, roadmaps, transcripts, research, boards, agent memory - so a fresh agent can answer what is available to users, how it works, why, and what is next, from the repo alone. Builds a shipped record with evidence levels, writes current contracts for a bounded first batch, adds a checker, reconciles only what that batch covers, and proves the result with a blind before/after eval. Works on a branch and never deletes. Use when specs are out of date, nobody can say what is on production, or context is scattered.
last_success: none
depends_on: []
---

# Reorganize a project's context

`design/instructions/context.md` defines the target - the files under `context/`, what each holds,
the evidence levels. This is how an agent gets an existing project there. Marver maintains it: it
was first run on a client project in October 2026 (16 of 16 questions answered before and after,
with 40% fewer tokens after), and each rule exists because that project, or an earlier draft of this
playbook, broke it. Record your project's runs in the run log at the end.

**The order matters: truth first, then authority, then files.** Moving documents before you know
which one is right only relocates the contradiction.

## Done means

A fresh agent with no memory reads `context/INDEX.md` and at most two more files per question, and
answers correctly - or says "unknown" with the reason - what each production service runs, whether a
capability is available and to whom, how it works, why, and what is next. Every artifact that
existed before has a recorded disposition. A blind before/after eval proves it.

## Hard rules

1. **Worktree and branch.** Never main. Never touch the original checkout's uncommitted changes.
2. **Never delete.** Originals are preserved; superseded ones get a header pointing at their
   replacement. Delete only proven disposable output, listed in the report.
3. **Code says what is implemented, not what is intended.** When code and an accepted requirement
   disagree, record both on the exception list - do not pick a winner silently.
4. **Evidence has levels.** `confirmed`: observed in a system of record. `reported`: a written claim,
   cited - a changelog line, an ops note, agent memory. `unknown`: neither. Never upgrade a level
   because a claim sounds sure. Commit ancestry says a change is inside a revision, not that the
   revision is running.
5. **Stable paths stay stable.** Frame ids, board and scene slugs, URLs, comment anchors and asset
   paths are identities. Do not move them in this pass.
6. **Read-only outside the repo.** You may read deploy records (`gh`, a provider's status command).
   You never deploy, migrate, query a production database, or edit agent memory. A read that needs
   credentials you were not given is an exception-list item, not a workaround.
7. **No secrets; mind the audience.** Never copy credentials. Record sensitive files by path and
   hash only.
8. **History is not rewritten.** Old changelog entries stay as written.
9. **Bounded scope.** This pass rewrites only what the first batch of capabilities needs. Everything
   else is inventoried and marked `deferred` - never superseded on a guess.

## Phase 0 - baseline, in this order

1. **The original checkout first.** In `context/reorg/start.md` (written later into the worktree,
   from notes kept outside it): the revision, every dirty and untracked path with the hash of its
   **working** file (`shasum`), and the tracked hashes (`git ls-files -s`).
2. **The worktree.** `git worktree add ../<repo>-context -b context/reorganize <revision>` and work
   only there from now on. Note that the original's dirty files are not in it.
3. **Preimages.** Hash every context-bearing file in the worktree. This list is what Phase 9
   compares against: untouched files must match; edited files must appear on the edit list with
   their preimage hash and the reason.
4. **The eval, blind.** Follow `eval.md` (beside this file). The questions go into the evaluated
   agent's prompt; the **answer key never enters the worktree**. Run the before pass now.

## Phase 1 - inventory, bounded

`context/reorg/inventory.md`:
- **Every** context-bearing path at file or folder level - docs, plans, changelogs, roadmaps,
  feedback lists, READMEs inside apps, research, `design/` (boards, briefs, sticky notes, content
  frames, comments), asset indexes, sync logs, `CLAUDE.md` / `AGENTS.md`, CI and scripts that
  encode procedure, and the agent's project memory (Claude Code:
  `~/.claude/projects/<path-slug>/memory/`). Size, last change, one-line role.
- **Section by section** only for documents that touch the first batch (Phase 4).
- Everything else gets disposition `deferred`.

Classes: current contract · proposed · historical evidence · decision · release/validation evidence ·
operational procedure · receipt · generated view · convention · tool state.

Flag, with file and line: status lines in prose; supersession inside a current file ("section 20
wins"); double homes ("the board is canonical, this file is its digest"); conventions pointing at
paths that no longer exist; design status phrased as product status; hand-kept counts.

Start `context/reorg/exceptions.md` now and keep adding to it in every phase.

## Phase 2 - the shipped record

`context/shipped.md`, two tables, every cell with an evidence level and a citation.

**Services × environments** - discover the services first (deploy workflow, Dockerfiles, provider
config), then for each: revision, deployed at, how (pipeline / by hand), evidence level + citation,
migrations applied.
- `confirmed` needs the run that deployed **that service** and succeeded - the job inside the deploy
  workflow, or the provider's own deploy status - not an environment record, which some pipelines
  mark "deployed" even when the run stood down.
- Hand deploys leave only prose: `reported`, cite the line.
- A health endpoint that reports no revision cannot confirm one - note the gap.
- An API you cannot reach: `unknown`, with the error.

**Capabilities** - implemented (code reference); verified (a test or recorded walk: revision,
environment, date, scope - a test file's existence is not a run); available (which environment, and
for which tenants - a flag or setting is separate evidence from the deploy, usually `reported`
unless someone with access confirms it); contract link.

## Phase 3 - the implementation map

`context/map.json`, machine-readable because the checker reads it:

```json
{ "capabilities": { "quote-intake": { "paths": ["apps/quote/app/**"], "tests": [] } },
  "excluded": [{ "path": "apps/run/app/preview/**", "reason": "generated from the canvas" }] }
```

Enumerate from the code: routes and actions, domain commands, tables and SQL functions, migrations
(every mechanism - a second app may keep its own schema), queued jobs and schedules, integrations,
config, tests. Map or exclude each, with a reason. Shared files may map to several capabilities. The
map is routing, not proof that anything is documented.

## Phase 4 - contracts, the first batch

Pick 5-7 capabilities where the evidence showed contradictions or no contract. For each,
`context/product/<capability>.md`:

```yaml
state: current
capability: quote-intake
audience: team            # team | publishable | restricted
reviewed: { revision: 606ad4e, scope: "apps/quote, db schema", method: "read code and tests" }
```

Then: what it does and its limits; who can use it and when; how it works; what it touches -
frontend, backend, database, workers, integrations; invariants; code and test references; decisions;
its lo-fi and hi-fi frames and the PRs that built it; what is still proposed. Read the code to write
it. Apply the plan's amendments - one answer per rule. Shared rules go once in `context/system/`.

The contracts are independent: one agent each, in parallel, from one shared brief (the rules, the
format, "no availability, no status lines", and a report back of every code-vs-document conflict and
the exact sections it now covers, `full` or `part`). Then a second model reviews the batch against
the code before anything relies on it - on its first run it found 18 overstated or mis-cited claims.
A shared file maps to every contract whose behaviour it changes, or the pull-request rule misses it.

## Phase 5 - the checker, before reconciling anything

`scripts/context-check.mjs` (or the project's language), wired into existing CI. Inputs: front
matter, `context/map.json`, `context/shipped.md`, the publish configuration and what it pulls in, and
on a pull request the changed paths (`git diff --name-only <base>...<head>`, base and head from the
CI event) and the PR body (from the event payload).

Audiences decide where a file may go: `restricted` is never tracked by git and never published;
`team` may be committed in a private repo but never published; `publishable` may appear in a
publish. "Published" means everything a canvas build carries: the boards in its publish config, the
frames on them, and every markdown import, image, note and asset those frames pull in.

| Rule | Result |
|---|---|
| a `state: current` doc has a status line (`^\s*\**status\**\s*:`) - lines, not domain words like a bank account's `verified` | fail |
| a current doc carries supersession markers ("wins where it differs", "overrides section") | fail |
| a shipped cell has no evidence level, or `confirmed` / `reported` with no citation | fail |
| a dead relative link, `?raw` import or asset reference under `context/` or in a frame that renders it | fail |
| `INDEX.md` over 800 words | fail |
| a `restricted` file tracked by git, or a `team` or `restricted` file reachable from what a publish carries | fail |
| a PR changes mapped paths without its contract, and without `no-contract-change: <capability> - <reason>` in the PR body | fail on pull requests |
| an `unknown` evidence cell | pass - honest unknowns are the right answer |
| a rule it cannot evaluate (no git history, API unreachable) | exit 2, "cannot determine", printed |

Exit 0 pass, 1 fail, 2 cannot determine. In CI, 2 blocks like 1 - fix the cause (fetch full history,
grant the read). During this pass, Phase 6 may start on exit 0, or on exit 2 when every
"cannot determine" is on the exception list with its reason.

## Phase 6 - reconcile, first batch only

For each document that the first batch's contracts now supersede, **only the sections they cover**:

| Material | Action |
|---|---|
| amendment-stacked spec | its covered sections get "Superseded by `context/product/x.md`"; the file stays as history; uncovered sections stay `deferred` |
| mixed spec | covered contract → `product/`; review diary stays; open items → backlog |
| dated feedback lists | covered items get a resolution: contract + shipped row, or `open` |
| roadmap in two homes | one editable source; the board renders it (`?raw`) |
| README with contradictions | fix the covered contradiction; keep run instructions by the app |
| changelog | untouched; its release lines are cited from `shipped.md` |
| sync log | keep cursors and pending failures; drop "agent memory" as a target |
| agent memory | project facts the batch needs land in their repo home; `context/reorg/memory-trim.md` proposes the rest |
| wrong binding instructions | correct them - an agent will obey them |

Diff duplicate prose before merging; check inbound references after every move.

**Line citations move when you insert.** Every note added to an old document shifts the lines that
contracts cite. Either reconcile before the contracts cite those documents, or remap every citation
once, mechanically, from the base revision's lines to the new ones - and verify by content (the cited
line still says what the citation claims). Never run a remap twice. Prefer line-neutral edits where a
document is cited heavily.

## Phase 7 - entry point and index

- Root `AGENTS.md` is the shared entry point; tool files route to it. Keep existing binding routes
  (for example to `design/AGENTS.md`).
- `context/INDEX.md`, **at most 800 words**, counted by the checker: the product in five lines; the
  capabilities with their contract and shipped row; where each role lives, including healthy homes
  left in place; the rules (status only in `shipped.md`; a behaviour change updates its contract or
  says `no-contract-change`; every deploy writes the record; plans fold into contracts when they
  land; changelog lines start with kind and capability: `[product:quote]`, `[design:board]`,
  `[infra]`, `[decision 41]`). Generated parts sit between `<!-- generated -->` fences.

## Phase 8 - the exception list, asked once

Everything collected since Phase 1: `unknown` availability that matters, code-vs-intent conflicts,
disputed capability boundaries, audience and retention calls, reads that need credentials. Ask in
one numbered batch now - or immediately, only if an item blocks the next step.

| The human decides | The agent decides from evidence |
|---|---|
| intended behaviour where code and an accepted requirement conflict | what the code implements |
| access, audiences, retention, redaction | inventory, hashes, references |
| priorities, commitments, pilot scope | what is done vs still proposed |
| disputed capability boundaries | the initial grouping (reversible) |

## Phase 9 - verify

`context/reorg/report.md`:

| Check | Passing result |
|---|---|
| Preservation | untouched files match their preimage; every edited file is on the edit list with preimage and reason |
| Disposition | every inventoried path is unchanged, edited, superseded (covered sections only) or `deferred` |
| The checker | exit 0, or exit 2 with each "cannot determine" explained |
| Release honesty | every availability claim carries a level and a citation, or says `unknown` |
| Reconciliation | no Phase 1 contradiction inside the first batch survives as competing current text |
| The eval | the after pass beats the before pass, per `eval.md` |

Then stop. The report lists what moved, what was decided without asking, the open exceptions, what
was deferred, and the memory-trim proposal. The human reviews the branch; nothing merges on its own.

## Run log

| Date | Revision | Who | Batch | Outcome |
|---|---|---|---|---|
