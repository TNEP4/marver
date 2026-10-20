# Live Jam

Tag `@marver` in a canvas comment while `npx marver dev` is running. The dev server spawns
your own coding-agent CLI headless with that one job, the frame lights up with a working
glow, the agent edits the real frame source, and its reply lands back in the same thread.
No round trip to the terminal. Marver ships no AI: the agent that acts is the one you
already run and pay for.

**Only a tag starts work** (since 0.26). A plain reply in a thread - even one answering Marver -
is conversation: it starts nothing, and `npx marver marks` lists it under "answered by you"
for your chat agent. Each tag is a card, answered in its own thread; your agent works on up to
`jam.concurrency` of them at once, never two on the same frame.

To talk through the canvas instead of typing - point, click through the prototype, say what
is wrong - use a capture (`S` ... `E`) or a whole session (`J`): see
[Jam sessions and captures](jam-session.md).

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
| `capture` | `"confirm"` | A capture waits for its read-back, or `"at-once"` queues at `E` ([captures](jam-session.md#configuration)) |
| `chime` | `true` | A soft chime when a capture is ready to review |
| `names` | `true` | Name each capture with Claude Haiku through Claude Code - its words go to Anthropic (Claude Code only) |
| `loc` | `true` | Stamp design elements with `data-mv-loc` (file and line, dev only) so the agent goes straight to the source |

Shorthands: `jam: "codex"` names the agent and takes the rest of the defaults, `jam: true`
is the default block, and **`jam: false` is the off switch**.

A named agent is never quietly swapped for another. If `jam.agent` names something marver
cannot spawn, or names a CLI that is not on PATH, Live Jam turns off with a printed reason
rather than answering your comments with a tool you did not choose. A `design/config.ts`
that fails to parse also leaves jam off, since it may have been the file that said
`jam: false`.

## What the agent may do

Be clear-eyed about what this is. The real protection is not a sandbox - it is that the
agent doing the work is **your own**, running on **your machine**, and **every change it
makes is a diff you review** before anything is resolved. On top of that, marver removes the
one tool that would turn a prompt-injected comment into silent damage: an unrestricted
**shell**. Each CLI is spawned so the model can read and edit files but cannot open a shell
(or, for Codex and Cursor, only a shell the OS sandbox contains and cuts off from the
network):

| | How it is spawned |
|---|---|
| **Claude Code** | `claude -p --permission-mode acceptEdits` with an allowlist of Read, Edit, Write, Glob, Grep, WebSearch, WebFetch - and `--disallowedTools Bash`, so there is no shell |
| **Codex** | `codex exec -s workspace-write`, its own OS sandbox, which bounds what commands touch and blocks network egress, but still lets the model run shell commands |
| **Cursor** | `cursor-agent -p --sandbox enabled --trust` - cursor's print mode carries a shell, so like Codex it runs inside the OS sandbox (verified: network egress is blocked); `--trust` only answers the workspace-trust prompt for the repo you already run `marver dev` in, and `--force` is never passed |
| **droid** | `droid exec --auto low` for file edits, with `--disabled-tools` removing the shell (`Execute`), the delegation tools (`Task`, missions), and the Slack/connector tools |
| **opencode** | `opencode run --pure` (no external plugins) with a per-run DEFAULT-DENY `OPENCODE_PERMISSION` grant - read/edit/search/web/task allowed by name, everything else (bash included) denied - never its all-approving `--auto` flag |
| **grok** | `grok -p --tools read_file,search_replace,list_dir,grep,todo_write` - an ALLOWLIST of read/edit tools only, so the shell, web, and subagents are simply absent (a deny-list is a footgun: it can miss a tool's real name); `--permission-mode acceptEdits` auto-applies the edits |
| **pi** | `pi -p --tools read,edit,write,grep,find,ls --no-extensions --no-skills` - pi has no runtime permission system, so the tool allowlist IS the jail, and bash is not on it |

The honest limits: file tools that take a path (Read/Edit/Write, and their equivalents) are
not themselves jailed to `design/` - on the CLIs without an OS sandbox they can, if a
comment talks the model into it, touch a file elsewhere in the repo or the machine. And Web
access, where a CLI keeps it, can carry data outward. This is the same boundary Claude Code
has always run under, and it is why the two rules above still do the real work: it is your
agent, and you review the diff. Do not point Live Jam at a repo, or run it on a machine, you
would not hand that same agent directly.

Web access stays on where the CLI offers it (Claude Code, Codex, opencode): reference sites
and real brand SVGs are how a frame stops looking like a placeholder. The agent never
resolves a thread; you do that after reviewing.

The missing sense that no-shell used to cost - "does my frame actually RENDER?" - is a
server capability instead, rendered in the machine's own headless Chrome (no bundled
browser; CDP over Chrome's debugging pipe, so the browser lives exactly as long as the
shot) and written as a PNG under
`design/.local/shots/`. Two transports reach it, because the no-shell jail rules out the
obvious one:

- **The file-drop inbox** (works for every agent, including Claude Code, which has no shell
  and whose WebFetch refuses localhost). The agent writes
  `design/.local/shots/<slug>.request.json` with `{"frame":"<id>","theme":"<t>"}` - or
  `{"scene":"<name>"}`, `{"frames":[...]}`, `{"all":true}` for a batch; the dev server renders
  and writes `<slug>.result.json` with the PNG path or an error (a batch: `results`, one entry
  per frame), which the agent Reads.
- **`npx marver shot <frame ...> | --scene <name> | --all [--scale 1-4] [--json]`** /
  `GET /api/shot?frame=<id>&theme=<t>&scale=<n>` / `POST /api/shots {frames|scene|all, theme,
  scale}` for humans and shell-ful agents - the same renderer, one line. A batch is ONE
  operation: one headless browser, `MARVER_SHOT_CONCURRENCY` frames at a time inside it
  (default up to 6, sized to the machine), so a scene costs about what a frame does. Default
  2x; `--scale 4` for a print-quality still (a 1280×720 slide comes back 5120×2880). A frame too tall
  for the asked scale steps down and says so in `note`; the file name carries the scale
  actually used (`…@4x.png`). A frame that ran out of settle budget still ships, marked
  `unsettled` with a note.
- **The browser's life.** The headless Chrome exists only while an operation runs - it is
  driven over Chrome's own debugging pipe, so it dies with the dev server however the server
  dies (Ctrl-C, a closed terminal, `kill -9`), and none is kept between shots. `MARVER_CHROME`
  picks the binary; pointing it at a Chrome for Testing or Chromium build makes the shot
  browser a different app from your own, which some people prefer on macOS.
  The canvas's **copy as image** (`i` / `⇧i`, the images-square toolbar button) is this same
  renderer with `format=png`, so what a designer pastes and what an agent shoots is one picture.

- **Pictures that are what the frame shows** (0.26.1). Headless Chrome could copy its view before resizing it for the
  picture and tile the old copy across the image. Each picture now has a window of its own (a fixed frame's or a
  slide's sized to the picture first), and every picture is checked for that tiling: one that shows it is taken again
  (`recaptures` in `--json` says how many times), and one that never comes out right fails with "stale surface"
  rather than shipping.
- **Inside a sandbox** (Codex blocks the network, localhost included), `marver shot` cannot reach the dev server: it
  then drops the same request in the file inbox itself and waits for its answer - the same output, the same exit code.

The generated jam instructions tell every agent to shoot and LOOK before replying "done".
A frame that never mounts, or a dev server that isn't reachable, comes back as an honest
`{"ok":false,"error":...}` carrying the real cause - never a blank that reads as success.

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

## Notes from your chat agent

Live Jam answers comments; the same voice works the other way. An agent you are chatting with leaves
a note where it needs you - `npx marver comments new <scene/frame> --body "..." --on "<words on
screen>"` pins it on the element showing those words (`--at "<data-testid or selector>"` for one
without words) - and answers your threads with `npx marver comments reply`. With `marver dev`
running the note is checked in the rendered frame first: words the frame does not show are
refused with what it does show, and several matches need `--nth`. A follow-up joins its thread
(`comments new --thread <id>`), and a misplaced note moves (`comments move <thread> --on ...`).
Notes and replies post as Marver, with the same provenance, land on your canvas
at once, and raise the bottom-right pill with a ping - Marver's replies on one board fold into a
single notice ("2 replies", View walks through them), a message that asks (a note, unless the
agent wrote `--fyi`; a reply with `--ask`; a jam reply opened with ```` ```marver-reply ask ````)
stands on its own, and the frame wears the orange question
bubble in the sidebar until the thread is resolved. A plain reply in a note starts nothing - only
a tag does: tag `@marver` in your reply and it is a jam job, with the note in its brief; while
the chat agent still has that frame lit (`marver work start`), the job waits for it. Your plain
answers are listed by `npx marver marks` ("answered by you") for your chat agent. Notes stay on your machine for now, like jam replies; a reply to a
collaborator's thread keeps your voice, the one that reaches them on the published canvas.

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
- **It has to tag `@marver`.** Since 0.26 a plain reply starts nothing, even in a thread
  Marver started - tag it in the reply.
- **One canvas per folder.** A second `marver dev` in the same folder stops with "a canvas
  already runs here" and its link, so two servers never run the same jobs twice.
- **The first boot after upgrading to 0.9.0 rebaselines the job journal**, because an
  existing journal predates the device stamp. Any `@marver` left unprocessed while the
  server was down is marked seen instead of run. Re-comment to pick it up.
- **Check the boot line.** `marver dev` prints `jam: on (<agent>)` when it is armed, and
  prints the reason when it is not.
- **Read the raw run log.** Every job's full agent output lands in
  `design/.local/jam-logs/` (last 10 kept) - an auth failure or permission refusal
  explains itself there. The generated `design/instructions/jam.md` carries the full
  troubleshooting drill, written for your agent to run: it checks the boot line, the log,
  and the CLI's own headless auth, fixes what belongs to the workspace, and files what
  belongs to marver at [github.com/TNEP4/marver/issues](https://github.com/TNEP4/marver/issues) -
  with the patch, when it found one while debugging.

`npx marver comments list --open --json` reads the same threads without the live loop, for
catching up or for a one-off answer.
