# Live Jam — overnight de-risking report

Branch `feat/live-jam` (off 0.7.0 `7601b8b`). Run: 2026-08-17 night, autonomous.
Goal: turn the risky assumptions into evidence so we can nail Live Jam end to end.
Nothing pushed or merged; main untouched; all spikes throwaway in scratchpad; the one
real code change (`events.ts`) is committed on this branch with tests.

## Bottom line

**The execution loop works — proven with real agents editing real files. The safety contracts
do not yet, and that's the honest headline.** The single biggest *execution* unknown (does the
daemon→agent→edit→reply loop hold?) is now a green spike, and the runtime model got one important
correction (daemon-spawn-per-job). But a Codex adversarial review of the v8 spec found that the
**authorization, concurrency, and crash-recovery contracts are not safe to build yet** — exactly the
parts a happy-path spike can't touch. So:

- **Confidence the loop/execution works: high (~80%)** — spiked, real agents, real marver.
- **Confidence in "build P1 as currently specified": NOT yet** — three contracts must be nailed
  first (below). Pre-night I'd have said ~25-35% on a blind one-shot; the night's real result is
  better than that number implies (the core is proven) *and* more sobering (the spec's safety
  contracts need a design pass before code). We now know precisely what to fix, which was the goal.

## What was proven (spikes, real agents, real files)

| # | Question | Result |
|---|----------|--------|
| Q1 | Headless edit works? | **YES.** `claude -p … --permission-mode acceptEdits --allowedTools … --output-format json` and `codex exec --json -s workspace-write -o <msg>` both edit files with no prompt hang; session/thread id + final message captured. |
| Q2 | The daemon-spawn loop holds? (the crux) | **YES.** A real daemon spawned **2 `claude -p` in parallel** on disjoint frame files; both edited correctly; daemon captured + posted `agent:true` replies. **14s for two parallel jobs.** |
| Q8 | Real-marver integration? | **YES.** Real `marver init` project: real `design/comments/…jsonl` → daemon → `claude -p` edited a real `design/scenes/demo/welcome.tsx` → real reply event → **`marver comments list` replayed it**. |
| Q8b | Dev server serves the reply? | **YES.** `GET /__mv/api/comments/<board>` returned the daemon-written reply with `agent:true` intact — the client will get it on poll. |
| Provenance | Can we show who orchestrated? | **YES.** `claude -p` JSON carries `canonicalModel` (`claude-opus-5`); the daemon stamped `agentMeta{devUser,harness,model,effort}` for the avatar tooltip. |
| Q4/Q5 | Event-model extensions integrate? | **YES.** `events.ts` now has `reanchor` + `agent`/`agentMeta`/`origin`, carried through `replay`; **108 tests pass, typecheck clean** (committed `e07f249`). |

## The architecture correction (the most valuable finding)

**Daemon-spawn-per-job, not a main-agent pull loop.** No coding agent — Claude Code, Codex,
Cursor, OpenCode, Factory — sustains a self-driven `marver jam next` pull loop; all are
one-shot headless. So the daemon owns the loop and **spawns one headless agent per job**; the
spawned run is the "main agent" (decides, edits, and — Claude Code / Cursor / OpenCode /
Factory — spawns subagents). And **the daemon posts the reply** (captures the agent's final
output) as the portable default, because Codex `workspace-write` blocks network and Antigravity
soft-denies shell, so a model-invoked reply CLI is not portable. Nic's intent (daemon → powerful
main agent that decides + fans out subagents) is preserved; only the delivery changed. The spec's
"VALIDATED ARCHITECTURE" block captures this and supersedes the earlier pull-loop model.

## Agent compatibility matrix

**Reframing (corrected after review): Live Jam integrates with a CLI, not a harness.** The daemon
spawns an agent CLI itself; it never hooks into the user's GUI or running session. So the only real
requirement is **a local, spawnable, file-editing agent CLI, installed and authed**. That reframes the
two "won't work" rows: Conductor and t3.code are GUI *wrappers around exactly these CLIs* (Conductor
spawns the real `claude` binary; t3.code is built on the Codex CLI), and CLI auth is machine-level and
shared. So **a Conductor / t3.code / Cursor-IDE user is fully supported** — Live Jam spawns the CLI
underneath, orthogonal to whatever GUI they use for manual work. The *only* genuinely out-of-scope case
is a **purely-cloud agent with no local file access** — and that's physics (it can't edit your local
files), not a Live Jam limitation. So the matrix below is really "which CLI does the daemon spawn,"
selected by one `jam.agent` config line.

| Agent CLI | Verdict | Shape / note |
|---|---|---|
| **Claude Code** | ✅ WORKS | `claude -p` per job. Subagents work (AGENTS.md→CLAUDE.md import). Reads CLAUDE.md. |
| **Cursor** (primary) | ✅ WORKS | `cursor-agent -p --force --output-format json`. Reads AGENTS.md+CLAUDE.md. MCP. Needs `CURSOR_API_KEY` (paid). Watch: `--force` unattended; forum bug "CLI doesn't release terminal" → validate exit. |
| **Codex** | ✅ WORKS | `codex exec --json -s workspace-write -o <msg>`. Reads AGENTS.md. **workspace-write blocks network** → daemon posts reply. Parallel needs care (no work isolation). |
| **OpenCode** | ✅ WORKS | `opencode run --agent …`; native AGENTS.md; MCP; first-class subagents; `serve`/`--attach` for warm. |
| **Factory Droid** | ✅ WORKS (best drop-in) | `droid exec … --auto low --output-format json`; native AGENTS.md; MCP; worktree parallel. |
| **Antigravity** (`agy`) | ⚠️ WORKS-with-tweak | `agy -p … --output-format json`; shell soft-denied headless → allowlist reply cmd OR daemon posts. AGENTS.md support unverified. |
| **Conductor** user | ✅ via CLI | Conductor is a GUI that spawns the real `claude` binary; the daemon spawns `claude -p` directly. The user is supported; Conductor is orthogonal. |
| **t3.code** user | ✅ via CLI | Built on the Codex CLI; the daemon spawns `codex exec` directly (same auth/subscription). Supported; t3.code is orthogonal. |
| _(pure-cloud agent, no local CLI)_ | ❌ | Can't edit local files at all → out of scope by physics, not a Live Jam gap. |

All the ✅ ride ONE contract (daemon-spawn-per-job + daemon-posts-reply); per-agent differences
are a single adapter of flags (e.g. Codex needs `--skip-git-repo-check` outside a git dir; Factory
needs `--auto low`). **Instructions ship as `design/AGENTS.md`** — which `marver init` already
scaffolds, so Live Jam extends an existing convention rather than inventing one.

## What is NOT yet proven (the remaining risk, ranked)

1. **Live in-browser render + working glow without losing camera (Q7).** The data + server paths
   are proven; the visual "watch it build live, frame glows, camera holds" needs the client
   changes + a browser test. Lower risk (built on existing marver HMR + camera-preservation that
   the earlier code map showed is friendly), but unproven tonight.
2. **Durable job queue edge cases (Q6).** Activation baseline, per-frame lease, flock, atomic
   write, crash-mid-edit recovery. Ordinary code, designed in the spec, not spiked. Medium risk.
3. **Same-tree parallelism beyond disjoint frames.** Two frames importing one shared component,
   or `package.json`, must serialize under a per-path lease. Proven for disjoint files; the
   shared-file path needs the lease implementation. Codex is riskiest (no work isolation).
4. **Cursor live smoke test.** Verdict is from docs; needs a real `cursor-agent -p` run (and the
   "terminal not released" bug check) before we claim Cursor parity.

## Codex review of v8 — the safety contracts to nail (before P1)

Codex reviewed the v8 spec + the `events.ts` change adversarially. It confirmed the happy path but
raised six [P1]s. These are correct and mostly things this run introduced or left contradictory:

1. **[P1] Owner authorization can't be a synced event field.** `origin:'local'` is stamped on *any*
   accepted local POST (a same-origin frame just asks the server to add it — no forgery needed), and
   sync carries `origin` byte-for-byte, so another checkout pulls an event still marked `local`. Fix:
   a **daemon-local authorization ledger keyed by event id** (or a device-bound marker that never
   syncs) — not a persisted `origin` field. *(This invalidates the v3 origin design.)*
2. **[P1] Proactive pickup reopens the RCE boundary.** Under daemon-spawn there is no persistent
   human orchestrator; an idle tick acting on non-owner text = mechanically spawning a privileged
   model because remote text exists. Model judgment + after-the-fact diff review ≠ owner
   authorization. Fix: non-owner comments are **context only**; acting on one requires **explicit
   owner promotion/approval**. *(Constrains Nic's "proactive" to: read freely, act autonomously only
   on the owner's own backlog, never on others' text without a click.)*
3. **[P1] Per-path leases are unenforceable a priori.** The daemon can't know which files a model
   will touch (shared components, `package.json`, config) before it decides. The two-file spike only
   proves *that* disjoint run. Fix: **serialize unknown/shared writes**, or give each process an
   **enforced write allowlist** with daemon-mediated lease expansion. Optimistic per-file leasing is
   not safe on its own. **Tested tonight:** two parallel jobs on the *same* frame both landed — but
   only because Claude's Edit is surgical and the writes interleaved cleanly. That is a **race, not a
   guarantee** (same-line edits / a whole-file-rewrite agent / different timing would clobber) — the
   dangerous kind of pass. So **serializing same-frame jobs is non-negotiable**; the only open question
   is shared-file-across-frames.
4. **[P1] Retry is neither idempotent nor fenced.** FS edits aren't idempotent because the prompt
   says so; a lease expiry doesn't stop the old process. Fix: **kill/fence the process group before
   reclaim**, record **pre/post file hashes**, and classify no-edits / edits-applied-output-lost /
   safe-to-retry.
5. **[P1] The reply/reanchor contract is self-contradictory.** §3.3 still has the pull loop, §3.4/§7
   call the token endpoint the only/general writer, §11/§15 require CLI reanchor — all contradicting
   the VALIDATED "daemon captures final output." Fix: **one portable structured result
   `{ reply, reanchors, status }`** the daemon captures; token CLI optional (progress only).
6. **[P1] The event change isn't fully integrated.** `reanchor` is in the shared union but the
   **published validator rejects unknown types** (`collab.ts:36`), and the **dev POST still preserves
   client-set `agent`/`agentMeta`/`origin`** (`api.ts:178`), contrary to daemon-only provenance. Ship
   type + validation + stripping + sync + daemon-only writer together. *(Partially addressed on the
   branch tonight — see below.)*
   Plus [P2]s: reanchor should validate target-is-root + anchor schema (reject `anchor:null`); reject
   `agent:true` on a create; carry or document `origin` on derived shapes; a pre-existing replay
   clock-skew gap for edits-before-replies; and a §7-vs-Non-goals sync contradiction.

**The three things to nail first (Codex's synthesis, and I agree):**
(a) a non-replayable **owner-authorization rail** with no autonomous action on non-owner context;
(b) **enforced write isolation + fenced crash recovery** (not prompt-level leases/idempotence);
(c) **one daemon-owned result/event contract** covering reply, reanchor, validation, provenance, sync.

## Contract-closing round (v8 → v10, trial-and-error)

After the v8 review I spiked the safety contracts and sharpened the spec through two more Codex
passes. State now:
- **Owner auth (v9 #1): CLOSED by spike + design.** `origin` can't gate (syncs — proven RCE); a
  **device-bound ledger** of locally-POSTed event ids does. Precise semantics added (keys on the
  @marver-carrying event id; edits re-authorize; agent events never ledgered; fail-closed atomicity).
- **Crash recovery (v9 #4): CLOSED by spike.** Files stay valid under a mid-job kill (atomic edits);
  **fence the process group + re-run the goal-phrased job** reconciles partial state (proven). Added a
  deterministic **completion predicate** (captured `{status:ok}` + a reply per batched thread) and
  **target set** (the batch's thread ids).
- **Parallelism / write isolation (v9 #3 + the UX contradiction): CLOSED by design.** The daemon
  **batches pending mentions into ONE orchestrated job**; parallelism is subagents *within* a batch
  (restores the drop-several-watch-several UX) and batches serialize (no blind cross-orchestrator
  race). Same-file parallel proven a race. **Residual (honest): within-batch non-overlap is
  orchestrator-assigned, not OS-enforced** — a P2/P3 filesystem-allowlist hardening.
- **Proactive (v9 #2): CLOSED.** Acts only on the owner's ledgered backlog (opt-in); non-owner needs a
  click. §1 aligned with §3.7.
- **Result contract (v9 #5): CLOSED.** One daemon-captured `{reply, reanchors[], status}`; pull loop
  dropped; token CLI optional (interim only).
- **Event integration (v9 #6): mostly CLOSED (code).** Published validator rejects client
  `agent`/`agentMeta` and unauthenticated reanchors; dev POST strips them; replay guards null anchors.
  109 tests green. Open: whether agent replies ever publish (v1 = dev-local, decided).
- **Also proven this round:** CLI-swap (Codex via the same daemon), session-resume continuity, and the
  instruction-delivery mechanism (root `CLAUDE.md` `@`-imports `design/AGENTS.md`).

**Revised confidence:** the "not safe to build" gate is largely **lifted** — every contract has a
validated direction/mechanism, most spiked. Full P1, clean and safe: **~65-70%** (up from 55-60%),
with the remainder being *ordinary implementation* (build the daemon + ledger per spec) plus one
stated residual (OS-enforced within-batch isolation) and the unbuilt live-render UI (Q7).

## Recommended build order for P1 (de-risked)

1. **Event model** — done (`e07f249`). 
2. **The daemon** — watch `design/comments/*.jsonl`, durable job store (activation baseline,
   per-frame lease, flock, atomic write), spawn one agent per job via a one-file adapter
   (`claude -p` first, the proven path), capture output, post the reply in-process (owner-authored
   + `agent:true` + `agentMeta`). This is the spiked shape; hardening the queue is the work.
3. **The POST provenance** — stamp `origin:'local'` on dev-owner writes; strip client `agent`/`origin`.
4. **`design/AGENTS.md`** jam section (the playbook + reply contract) — extend the scaffold.
5. **UI** — composer (textarea + keys), `@marver` render + tooltip, glass notification, working
   glow + `agentMeta` avatar tooltip. Then the live-render smoke test (Q7).
6. **Second agent adapter** (Cursor) + live smoke test.

## Confidence (revised after the Codex review)

- **Execution loop (daemon-spawn → edit → capture → reply), incl. parallel disjoint frames: ~80%** —
  spiked with real agents against real marver.
- **Contained UI + event-model schema: ~85%** — schema landed with tests; the POST/validator wiring
  is small but must be done together (finding 6).
- **The safety contracts (owner-auth rail, write isolation + fenced recovery, one result contract):
  NOT yet safe to build** — they need a design pass first. This is the gate, not the loop.
- **Full P1, clean and safe: ~55-60%** as specified today, held down by the three contracts — but the
  path to raise it is now concrete (nail the three contracts, then the loop is proven under them).
- What would push it up fastest: the owner-authorization ledger design, a write-isolation decision
  (serialize-by-default vs enforced allowlist vs worktree-for-shared), and the fenced-recovery spike —
  then the Q7 live-render smoke test.

**Net:** the risky *unknown* (does the loop even work?) is retired. What remains is *known, ordinary,
but non-trivial* safety engineering that a night of happy-path spikes correctly could not validate —
and Codex named it precisely. Good place to be for a morning design session.

_See `scratchpad/NIGHT-LOG.md` for the raw run log and `scratchpad/spike-loop/`,
`scratchpad/marver-test/` for the throwaway harnesses._
