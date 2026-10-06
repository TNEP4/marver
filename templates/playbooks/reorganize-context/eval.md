# Context eval - can a fresh agent answer from the repo alone?

The reorganization is judged by one thing: a fresh agent, with no memory and no chat history,
answering real questions about the product correctly and cheaply. Run it **before** and **after**,
the same way both times.

This file is the protocol and the questions. The **answer key is a separate file**
(`answer-key-<project>.md`) and never enters the worktree the agent reads.

## Isolation - check before each pass

- The agent runs in the worktree (`../<repo>-context`), a fresh process per question.
- No agent memory for that path: Claude Code keys memory by project path, so
  `~/.claude/projects/<worktree-slug>/memory/` must not exist. Codex keeps none by default.
- No hook injects project context for that path (a vault feed keyed by path, a knowledge inbox).
- The answer key, the reorg notes kept outside the worktree, and earlier pass results are not in
  the worktree. Before the first pass, `context/` does not exist yet.
- **A clean profile.** Global instructions also count as injected context: Claude Code loads
  `~/.claude/CLAUDE.md`, Codex loads its global `AGENTS.md`. Launch with an empty config home and
  only credentials in it - Claude Code: `CLAUDE_CONFIG_DIR=<empty dir>` with an API key; Codex:
  `CODEX_HOME=<dir holding only auth>`. Confirm from the transcript's first event that no user or
  global instruction file was loaded.
  - *Learned on the first run:* without an API key, Claude Code cannot run clean - `--bare` needs one,
    and a plain run loads the auto-memory that worktrees of one repository share. Codex with a
    `CODEX_HOME` holding a copy of `auth.json` works; check `codex features list` shows `memories`
    off, and keep each pass's session rollouts out of that home before the next pass. Copy the auth
    only when its `last_refresh` is recent, and delete the copy after.
- **Read-only.** Claude Code with read tools only (`--allowedTools Read,Grep,Glob`); Codex with
  `--sandbox read-only`.
- Same CLI, same model, same prompt, both passes.

## The prompt

> Answer this question using only files in this repository: <question>. Give the answer, the
> files you used, and your confidence. If the repository cannot settle it, say "cannot tell" and
> why. Do not run the app, query a database, call an API, or read outside this directory.

## The measurement - one metric, per question

Run each question as its own invocation with a machine-readable transcript (Claude Code:
`claude -p "<prompt>" --output-format stream-json --verbose`; Codex: `codex exec --json`). From the
transcript record:

- **result** - correct / partial / wrong / cannot-tell, judged against the answer key;
- **confident wrong** - a wrong answer given with high confidence, counted separately;
- **bytes read** - the summed size of every tool result returned to the agent (file reads, searches,
  listings). Measure what the model saw, not what the command printed: Codex truncates long output
  (each result carries its `original_token_count`), so read the session rollout's tool outputs, not
  `exec --json`'s `aggregated_output`. Record the session's **input tokens** beside it;
- **tool calls**;
- **out of bounds** - any read outside the worktree. One voids that answer.

"Cannot tell" with the right reason counts as correct where the key says the repository genuinely
does not hold the answer.

## Pass

- no confident wrong answer after;
- more correct answers after than before - or, if the before pass was already perfect, equal;
- fewer total bytes read after.

A capable agent may already answer everything before - the first run's before pass was 16 / 16 at
medium effort, the traps notwithstanding. Then the pass is decided on cost, and a weaker or cheaper
profile is worth a second pair of passes to see whether the reorganization moves correctness.

## The six kinds of question

Write 10-16, at least one of each, from Phase 2 evidence, with the key signed off by the human where
Phase 8 asked:

1. **Shipped** - is X available, where, for whom, since when?
2. **Behaviour** - how does surface Y work today?
3. **Interfaces** - what runs behind action Z: jobs, mails, data written?
4. **Why** - why was decision N taken, and does it still apply?
5. **Next** - what is being built next, and what counts as done?
6. **Receipts** - what did someone say about T, and where is it recorded?

Include **traps**: questions where a stale spec, a design frame, or a wrong instruction gives a
confident wrong answer today. They are the point.

## Your project's questions

Write them before the before pass, from Phase 2's evidence, and keep the key out of the worktree:

| # | Kind | Question | Trap |
|---|---|---|---|

## Report format

| # | Before: result | Before: bytes / calls | After: result | After: bytes / calls |
|---|---|---|---|---|

Write the before column before Phase 1 begins - not from memory afterwards.
