# Live Jam

Tag `@marver` in a canvas comment while `npx marver dev` is running. The dev server spawns
your own coding-agent CLI headless with that one job, the frame lights up with a working
glow, the agent edits the real frame source, and its reply lands back in the same thread.
No round trip to the terminal. Marver ships no AI: the agent that acts is the one you
already run and pay for.

## It arms itself

Live Jam is on by default (since 0.9.0). Marver speaks seven agent CLIs - `claude`,
`codex`, `cursor`, `droid` (Factory), `opencode`, `grok`, and `pi` - which also covers the
apps built on them: Factory drives `droid`, Cursor drives `cursor-agent`, Conductor drives
`claude`. Marver looks for one in this order:

1. **The tool running the process wins.** Most CLIs export env markers into what they spawn
   (`CLAUDECODE` for Claude Code, `CODEX_SANDBOX` for Codex, `CURSOR_AGENT` for Cursor,
   `OPENCODE` for opencode, `PI_CODING_AGENT` for pi), and `marver init` is usually run by
   the agent itself. That is evidence, not a guess. droid and grok set no marker in the
   shells they spawn, so this step cannot see them - name them in config or let PATH decide.
2. **Otherwise, whatever is on PATH**, in the order above - `claude` first.

That second step is a guess, so the answer is made visible rather than clever: `init` prints
the agent it chose and writes it into `design/config.ts` in plain sight, and `marver dev`
names it at boot (`jam: on (claude)`). One word to correct, once per repo.

The candidate has to be executable on `PATH` under its bare name, because the daemon spawns
it without a shell. A shell alias or function is invisible to it. Cursor is the one agent
whose binary differs from its config name: marver spawns `cursor-agent`, never the bare
`agent` - both Cursor and grok install an `agent` name, so the short one is a coin flip.

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
| `agent` | detected | The CLI the daemon spawns: `"claude"`, `"codex"`, `"cursor"`, `"droid"`, `"opencode"`, `"grok"`, or `"pi"` |
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

Every agent is confined to the workspace and every change is a diff you review, but each
CLI is locked down with its own controls. The principle is the same everywhere: edits yes,
shell no (or sandboxed) - the job packet embeds untrusted comment text, and a shell is a
one-line exfiltration channel:

| | How it is spawned |
|---|---|
| **Claude Code** | `claude -p --permission-mode acceptEdits` with an allowlist of Read, Edit, Write, Glob, Grep, WebSearch, WebFetch - and `--disallowedTools Bash`, so there is no shell at all |
| **Codex** | `codex exec -s workspace-write`, its own OS sandbox, which bounds what commands can touch but still lets the model run them |
| **Cursor** | `cursor-agent -p --sandbox enabled` - cursor's print mode carries a shell, so like codex it runs inside the OS sandbox; `--force` (blanket command approval) is never passed |
| **droid** | `droid exec --auto low` for file edits, with `--disabled-tools` removing the shell (`Execute`), the delegation tools (`Task`, missions), and the Slack/connector tools outright |
| **opencode** | `opencode run` with a per-run DEFAULT-DENY `OPENCODE_PERMISSION` grant - read/edit/search/web/task allowed by name, everything else (bash included) denied - never its all-approving `--auto` flag |
| **grok** | `grok -p --no-subagents --disallowed-tools run_terminal_cmd`, removing the shell tool entirely, then `--yolo` so the remaining read/edit tools never stall on a prompt |
| **pi** | `pi -p --tools read,edit,write,grep,find,ls --no-extensions --no-skills` - pi has no runtime permission system, so the tool allowlist IS the jail, and bash is not on it |

Web access stays on where the CLI offers it: reference sites and real brand SVGs are how a
frame stops looking like a placeholder. The agent never resolves a thread; you do that
after reviewing.

One prerequisite marver cannot arrange: **the CLI has to be logged in** (`droid` and
`cursor-agent login` and `grok login` each have their own flow; opencode and pi can also
read provider API keys from the environment). An unauthenticated CLI fails the job; the
daemon retries once, then replies that it could not finish - the dev log and
`design/.local/jam-logs/` say why.

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

Every jam reply is stamped with who acted: your dev user, the harness that ran, and the
model when the agent names one. Claude Code, Cursor, droid, grok, and pi report their model
in the stream; `codex exec` and `opencode run` report none, so their replies carry the
harness without a model rather than a guessed one.

## Parallelism

Two knobs stack, and they are not the same thing. `jam.concurrency` is how many jobs the
daemon runs at once - different frames, different comments. `jam.subagents` is fan-out
*inside* one job, one subagent per frame, which is what makes a five-frame ask land
together instead of in series. Claude Code, Codex, and opencode fan out (opencode's
subagents verifiably inherit the jail); pi has no subagent tool, and droid and grok have
theirs removed in the spawn itself (`--disabled-tools Task`, `--no-subagents`) until a
child is proven to inherit the parent's confinement. Their jobs simply run the frames in
sequence - the prompt only ever says the agent MAY fan out.

Two honest caveats in the same spirit as the config-execution one above: cursor's own
permission rules (`~/.cursor/cli-config.json`, a repo's `.cursor/cli.json`) and a repo's
own `opencode.json` agent block can widen what those CLIs allow - that is your
configuration speaking, and marver does not override it.

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
