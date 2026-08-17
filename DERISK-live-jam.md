# Live Jam — de-risking complete, build plan

**Read this to start building.** Branch `feat/live-jam` (off 0.7.0). Spec: `SPEC-live-jam.md` v10.1.
Overnight run: 10+ spikes with real agents + 3 Codex review rounds. 12 commits, 109 tests green, main
untouched.

---

## TL;DR

The risky unknown is retired: **the loop works** (proven with real `claude -p`/`codex exec` editing
real marver frames in parallel, replies replayed by marver). The architecture got three important
corrections. Every safety contract now has a validated design. The **event-model foundation is already
built and tested on the branch.** What remains is **implementation** (the daemon + ledger + batch
journal + UI), not design. **Confidence in a clean P1: ~65-70%** (up from ~25-35% pre-night); the loop
itself ~80%.

---

## The architecture to build (final, validated)

One loop, one page:

```
 owner comment (@marver, ledgered)          the marver dev server = the daemon
        │                                    ┌───────────────────────────────────────┐
        ▼                                    │ 1 watch design/comments/*.jsonl         │
 design/comments/<board>.jsonl  ───────────▶ │ 2 owner-gate via device ledger (by id)  │
        ▲                                    │ 3 BATCH pending mentions → 1 durable job │
        │ daemon appends                     │ 4 spawn ONE headless agent for the batch │
 reply + reanchor events                     │ 5 agent edits frames / fans out subagents│
 (owner-authored + agent:true + agentMeta)   │ 6 capture {reply,reanchors[],status}     │
        │                                    │ 7 append results in-process; mark done   │
        ▼                                    └───────────────────────────────────────┘
 client polls → renders reply + live frame            spawned agent = claude -p / codex exec /
 update + "working" glow + notification                cursor-agent … (one flag adapter each)
```

**The decisions that define it:**
- **The daemon is the marver dev server** (already long-lived, owns the log). No new infra.
- **Owner auth = a device-bound ledger.** When the dev POST accepts a local browser write, it records
  that **event id** in `design/.local/jam-ledger` (gitignored, never synced). Trigger = a new
  `create`/`reply` whose id is in the ledger and whose body has `@marver`. (A synced `origin` field
  can NOT gate — it copies byte-for-byte; proven RCE.)
- **Daemon-spawn-per-batch, not a pull loop.** No agent sustains a self-driven loop. The daemon
  **batches the currently-pending owner mentions into ONE orchestrated job** and spawns one headless
  agent. Parallelism = **subagents within the batch** (one per frame) → several frames build at once
  (the UX). Batches serialize (mid-batch arrivals form the next batch).
- **The daemon posts the reply** — it captures the agent's structured `{reply, reanchors[], status}`
  and writes reply + reanchor events in-process (owner-authored + `agent:true` + `agentMeta`). Portable
  across every agent (a model-invoked reply CLI isn't — Codex blocks network, Antigravity blocks shell).
- **Recovery = fence + goal-phrased re-run.** Files stay valid under a kill (atomic edits); re-running
  the goal-phrased batch reconciles partial state. So: kill the process group before reclaim; phrase
  jobs as goals, not diffs; completion = captured `{status:ok}` + a reply per member.
- **CLI-agnostic.** `jam.agent` picks the adapter; one flag differs per agent. GUI harnesses
  (Conductor, t3.code, Cursor IDE) are orthogonal — the daemon spawns the CLI underneath.
- **Instructions ship as `design/AGENTS.md`** (read natively by Codex/Cursor/OpenCode/Factory) + a
  root `CLAUDE.md` that `@`-imports it (Claude reads CLAUDE.md). `marver init` already scaffolds
  `design/AGENTS.md`.
- **Provenance:** every agent event carries `agentMeta {devUser, harness, model, effort}` → tooltip on
  the Marver avatar. The `claude -p` JSON already exposes `canonicalModel`.

---

## What's proven (evidence)

| Spike | Result | Where |
|---|---|---|
| Headless edit (Claude + Codex) | ✅ edit files, no prompt, session id captured | `spike-runtime` |
| Daemon-spawn parallel loop (the crux) | ✅ 2 `claude -p` in parallel, both frames, 14s | `spike-loop` |
| Real-marver integration | ✅ comment → agent edit → reply → `marver comments list` replay | `marver-test` |
| Dev server serves the reply | ✅ `GET …/comments` returns the `agent:true` reply | `marver-test` |
| CLI-swap | ✅ same daemon, `JAM_AGENT=codex`, 2 parallel edits | `spike-loop` |
| Same-frame parallel | ⚠️ a **race** (both landed only by luck) → serialize | `spike-loop` |
| Crash recovery | ✅ file stays valid; goal-phrased re-run reconciles | `spike-crash` |
| Owner-auth ledger | ✅ defeats the synced-`origin` RCE spoof | `spike-auth` |
| Session-resume continuity | ✅ context carried across two spawned runs | `spike-resume` |
| Instruction delivery | ✅ root `CLAUDE.md` `@import` delivers `design/AGENTS.md` | `marver-test` |

---

## Already built on the branch (done + tested)

- **Event model** (`src/shared/events.ts`): `reanchor` type; `agent` / `agentMeta` / `origin` fields;
  `replay` carries `agent`/`agentMeta` onto root + replies and applies `reanchor` to the thread anchor.
- **Published validator** (`src/server/collab.ts`): accepts + validates `reanchor` (root target,
  non-null anchor, author-owned); **rejects client-set `agent`/`agentMeta`** (anti-forge).
- **Dev POST** (`src/server/api.ts`): strips client-set `agent`/`agentMeta`/`origin`.
- **Sync** (`src/server/sync.ts`): filters `agent:true` events out of the push set (dev-local in v1).
- Tests: `test/unit.test.ts` covers agent/agentMeta passthrough, `reanchor` re-pin, null-anchor guard.
  **109 pass, typecheck clean.**

---

## P1 build plan (ordered, file-grounded)

1. **Config** (`src/server/config.ts`): add `jam.agent` (`claude|codex|cursor|opencode|droid`),
   `jam.concurrency`, `jam.subagents` (default on), `jam.proactive` (default off).
2. **The auth ledger** (`src/server/api.ts` POST): after `appendEvents` fsyncs a locally-accepted
   event, record its id to `design/.local/jam-ledger` (append+fsync; event-first, fail-closed). A tiny
   `ledger.ts` helper (has/record). Client provenance stripping is already done.
3. **The daemon** — a new `src/server/jam/` module wired into the long-lived dev server
   (`src/server/dev.ts`) alongside the existing sync loop:
   - **watch** `design/comments/` (dir watch + ~5s rescan; Vite already ignores this dir).
   - **durable batch journal** `design/.local/jam-jobs.json` (atomic temp+rename+fsync):
     `{ batchId, memberEventIds[] frozen at spawn, state pending→claimed→done|failed, leaseUntil,
     attempts, agentSessionId (memory only) }`. Activation baseline on first init (don't replay old).
     Single daemon per repo via flock.
   - **spawn adapter** (one per agent, a flag map) → capture the structured result → **append reply +
     reanchor events in-process** via `appendEvents` (`src/server/comments.ts`) stamping owner-author +
     `agent:true` + `agentMeta`. Fence the process group on reclaim.
   - concurrency = subagents within a batch; batches serialize.
4. **Instructions**: extend `marver init`'s `design/AGENTS.md` with the jam playbook (§15/§16 of the
   spec) + ship a root `CLAUDE.md` that `@`-imports it.
5. **UI** (client):
   - **Composer** (`src/client/shell/Comments.tsx`): `<input>`→auto-grow `<textarea>`; Enter send /
     Shift+Enter newline / Cmd-Enter send; IME + preventDefault + pending guards; send-button `Tip`.
   - **`@marver` render + tooltip** (`Comments.tsx` `.cm-body` → `renderBody` parser; `styles.css`
     `.cm-at`): owner bold-accent, non-owner plain + the teaching tooltip.
   - **Notification** (`store.ts` `Toast`; `App.tsx` + `Play.tsx` render; `styles.css`): bottom-right
     glass pill, event-id dedup, active-board, View → `revealThread`, marver avatar.
   - **Working glow** (`store.ts` `Node.status` add `'working'`; `FrameNode.tsx` render branch;
     `styles.css` `.sh-node.working` monochrome orbit → accent when selected), driven by an in-memory
     activity channel (dev endpoint + ~2.5s client poll, canvas-only).
   - **agentMeta avatar tooltip** (`Comments.tsx` ThreadCard avatar).
6. **Q7 live-render smoke test**: with a real jam running, confirm the reply appears and the frame
   updates live without the camera moving (the code map confirms the foundation is friendly; guard the
   two gaps — in-frame scroll on edit, prototype/stage full-reload — as P2).

Build order rationale: 1-2 unblock the trigger; 3 is the heart (validated in throwaway form already);
4 makes the agent competent; 5 is the felt experience; 6 verifies the "live" promise.

---

## Agent adapter matrix

| CLI | Command shape | Note |
|---|---|---|
| **Claude Code** | `claude -p <goal> --permission-mode acceptEdits --allowedTools Read,Edit,Bash --output-format json` | subagents; reads CLAUDE.md |
| **Cursor** (primary) | `cursor-agent -p --force --output-format json` | AGENTS.md+CLAUDE.md; needs `CURSOR_API_KEY` |
| **Codex** | `codex exec --json -s workspace-write --skip-git-repo-check -o <msg>` | sequential (no subagents); reads AGENTS.md |
| **OpenCode** | `opencode run --agent marver` | AGENTS.md; subagents |
| **Factory Droid** | `droid exec --auto low --output-format json` | AGENTS.md; MCP; worktree parallel |
| Antigravity `agy` | `agy -p --output-format json` | allowlist the reply cmd OR daemon posts |
| Conductor / t3.code | — | GUI wrappers → daemon drives the underlying claude/codex CLI |

---

## Honest residuals + open decisions (not blockers)

- **Within-batch file non-overlap is orchestrator-assigned, not OS-enforced.** If the main agent hands
  two subagents the same file it can still race; the goal-phrased re-run recovers. Enforcing it needs
  per-subagent filesystem allowlists — **P2/P3**.
- **Live parallel glow is harness-conditional** — subagent-capable agents (Claude/Cursor/OpenCode/
  Factory) light up several frames; Codex is correct but sequential. Surface this in the UI.
- **Publishing agent replies is P3** (v1 = dev-local; the client validator rejects agent provenance by
  design; publishing needs a trusted sync path).
- **Q7 live render** is the one thing spikes couldn't prove (needs the UI built); low-risk on the
  existing camera-preservation foundation.

---

## The non-obvious lessons (the insight worth keeping)

These surprised us and shaped the design — worth remembering during the build:
1. **No coding agent sustains a self-driven pull loop.** The daemon must spawn. (Killed the intuitive
   "agent watches the queue" design.)
2. **The daemon should post the reply, not the model** — a model-invoked reply CLI isn't portable
   (Codex blocks network, Antigravity blocks shell).
3. **Auth can't ride a synced field.** `origin:'local'` syncs byte-for-byte → a device-bound ledger is
   the only safe gate.
4. **"Serialize independent jobs" would kill the parallel UX.** Batch instead — parallelism lives
   *inside* one orchestrated job, not across racing jobs.
5. **Goal-phrased jobs are the idempotency mechanism.** Because the agent re-reads state, a re-run of a
   goal ("make it say X") reconciles a crash; a diff wouldn't.
6. **Live Jam targets a CLI, not a harness.** This is why every GUI (Cursor IDE, Conductor, t3.code) is
   supported — the daemon spawns the CLI underneath.

---

_Spec: `SPEC-live-jam.md` v10.1. Raw run log: `scratchpad/NIGHT-LOG.md`. Throwaway harnesses:
`scratchpad/spike-{runtime,loop,auth,crash,resume}/`, `scratchpad/marver-test/`._
