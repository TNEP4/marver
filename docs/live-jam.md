# Live Jam

Tag `@marver` in a canvas comment while `npx marver dev` is running. The dev server spawns
your own coding-agent CLI headless with that one job, the frame lights up with a working
glow, the agent edits the real frame source, and its reply lands back in the same thread.
No round trip to the terminal. Marver ships no AI: the agent that acts is the one you
already run and pay for.

## It arms itself

Live Jam is on by default (since 0.9.0). Marver looks for an agent CLI in this order:

1. **The tool running the process wins.** Claude Code and Codex each export env markers into
   what they spawn (`CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SANDBOX` /
   `CODEX_THREAD_ID`), and `marver init` is usually run by the agent itself. That is
   evidence, not a guess.
2. **Otherwise, whatever is on PATH**, `claude` before `codex`.

That second step is a guess, so the answer is made visible rather than clever: `init` prints
the agent it chose and writes it into `design/config.ts` in plain sight, and `marver dev`
names it at boot (`jam: on (claude)`). One word to correct, once per repo.

The candidate has to be executable on `PATH` under its bare name, because the daemon spawns
it without a shell. A shell alias or function is invisible to it.

With no agent CLI installed, jam stays off and both `init` and `marver dev` say so instead
of going quiet. Workspaces created before 0.9.0 need no re-init; they resolve the same way
at every dev boot.

## The config block

```ts
// design/config.ts
jam: { agent: "claude", concurrency: 6 },
```

| Key | Default | What it does |
|---|---|---|
| `agent` | detected | `"claude"` or `"codex"` - the CLI the daemon spawns |
| `concurrency` | `6` | Frames worked on at once (1-16). The same frame never gets two agents |
| `subagents` | `true` | Inside one job, fan out one subagent per frame |

Shorthands: `jam: "codex"` names the agent and takes the rest of the defaults, `jam: true`
is the default block, and **`jam: false` is the off switch**.

A named agent is never quietly swapped for another. If `jam.agent` names something marver
cannot spawn, or names a CLI that is not on PATH, Live Jam turns off with a printed reason
rather than answering your comments with a tool you did not choose. A `design/config.ts`
that fails to parse also leaves jam off, since it may have been the file that said
`jam: false`.

## What the agent may do

Both agents are confined to the workspace and every change is a diff you review, but the
two CLIs are locked down differently, because they offer different controls:

| | How it is spawned |
|---|---|
| **Claude Code** | `--permission-mode acceptEdits` with an allowlist of Read, Edit, Write, Glob, Grep, WebSearch, WebFetch - and `--disallowedTools Bash`, so there is no shell at all |
| **Codex** | `codex exec -s workspace-write`, its own sandbox, which bounds what commands can touch but still lets the model run them |

Web access stays on for both: reference sites and real brand SVGs are how a frame stops
looking like a placeholder. The agent never resolves a thread; you do that after reviewing.

## The trust boundary

Only comments written on the owner's machine can start work. A mention becomes eligible
solely by way of the local dev server's owner-gated endpoint (a CSRF double-submit cookie
plus an Origin allowlist), which appends it to `design/.local/jam-ledger`. The daemon runs
a job only for an event id that is already in that ledger, so a drive-by comment on a
published canvas cannot trigger one, and neither can a collaborator comment that arrived
through `marver comments sync`.

The ledger and the job journal both carry a device stamp, because gitignore is a convention
and not provenance: a repo can force-add its own `.local/`. Jam state that arrived with a
clone is read as absent. The stamp is derived from the machine rather than stored, so
marver still writes nothing outside `design/`.

The larger caution is unchanged and worth stating plainly: `marver dev` imports and executes
`design/config.ts`, so running a dev server in a repo you do not trust is already running
that repo's code. Live Jam adds no new hole to that; it does not make it safe.

## Provenance

Every jam reply is stamped with who acted: your dev user, the harness that ran
(`claude` / `codex`), and the model when the agent names one. Claude Code reports its model
in the stream; `codex exec` reports none, so codex replies carry the harness without a
model rather than a guessed one.

## Parallelism

Two knobs stack, and they are not the same thing. `jam.concurrency` is how many jobs the
daemon runs at once - different frames, different comments. `jam.subagents` is fan-out
*inside* one job, one subagent per frame, which is what makes a five-frame ask land
together instead of in series. Both CLIs support it: `codex exec` carries
`collaboration.spawn_agent` the way Claude Code carries its Task tool.

## When a mention does nothing

- **It has to be your machine, your repo, with `marver dev` running.** That is the trust
  boundary above, working as intended.
- **The first boot after upgrading to 0.9.0 rebaselines the job journal**, because an
  existing journal predates the device stamp. Any `@marver` left unprocessed while the
  server was down is marked seen instead of run. Re-comment to pick it up.
- **Check the boot line.** `marver dev` prints `jam: on (<agent>)` when it is armed, and
  prints the reason when it is not.

`npx marver comments list --open --json` reads the same threads without the live loop, for
catching up or for a one-off answer.
