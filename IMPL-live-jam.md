# IMPL — Live Jam — the build plan (testable milestones)

> **What this is.** The implementation companion to `SPEC-live-jam.md` (v10.1). The spec answers *what
> and why*; this answers *build it in this order, and prove each step*. Every milestone ends **green** —
> a named test that passes before the next begins. Ethos, unchanged: **lean code that works.**
>
> **Branch:** `feat/live-jam` (off 0.7.0). Foundation already built + tested: event model (`agent`,
> `agentMeta`, `origin`, `reanchor`), published validator, POST provenance-strip, sync filter, 109 tests.
>
> **Reviewed by Codex (2026-08-18).** This revision folds in its findings: the owner gate is now a real
> `Origin`/`Host` + dev-token check on the POST (not "trust every local write"); instructions moved ahead
> of the agent-behavior milestones (M4/M5 depend on them); presence rides the existing broadcast rail,
> not a new poll; adapters cut to the two proven ones; proactive / context-batch / owner-promotion are
> explicitly P2. Each milestone's exit test was expanded to actually prove its exit criteria.

---

## How we test as we go (three tiers)

Not everything is unit-testable; match the tier to the layer.

1. **Unit (`test/unit.test.ts`, `node --test`)** — pure logic: ledger `has/record` + fail-closed order,
   gate token/Origin check, config parse, batch state transitions, packet sanitization, adapter
   arg-building, notification id-dedup. Fast, deterministic, no spawned agent. **Most new logic lands here.**
2. **Jam integration harness (`test/jam-integ/`, opt-in, real agent)** — the loop the unit tier can't
   fake: a real `marver init` fixture, a real owner comment **posted through the real dev POST** (so the
   gate + ledger are on the tested path, never pre-seeded), the real daemon spawning a real `claude -p`,
   asserting the reply lands via `readLog`. Gated behind `MARVER_JAM_INTEG=1` (needs a local authed CLI +
   network) so CI stays green without it. This is the overnight spikes promoted to a checked-in harness.
3. **`/qa` browser pass** — the felt surface: composer keys, `@marver` styling + tooltip, the glass
   notification, the Marver avatar tooltip, the working glow, camera-stability on live edit. Verified in
   the real dev canvas.

**The rule:** a milestone is done when its stated test is green and `pnpm build` + `tsc --noEmit` +
`node --test` all pass. No milestone lands red or "we'll test it later."

**Shared adapter contract (defined once in M1, reused by M5).**

```
interface JamAdapter {
  name: 'claude' | 'codex'        // v1 ships these two; more are fast-follows (§M5)
  spawnArgs(packet: JobPacket): { cmd: string; args: string[] }  // goal-phrased, workspace-jailed
  parseResult(stdout: string): { members: MemberResult[] }       // { eventId, reply, reanchors[], status }
  supportsSubagents: boolean       // claude = true; codex = false (sequential frames)
}
```

M1 ships only `claude` behind this interface; M5 adds `codex` and proves the seam. Cursor / OpenCode /
Droid / Antigravity are **post-v1** — each needs its own adapter + contract test, not a bare flag map
(their result schemas, auth, and tool-permission shapes differ; §M5 residuals).

---

## Milestone 0 — Foundations: config + owner-gated ledger  *(pure, unit-tested)*

**Goal.** The trust boundary and the config the daemon reads — both provable with zero spawned agent.
Codex's critical finding #1: the current dev POST (`api.ts:163-192`) takes a caller-supplied `author`
and checks no session and no `Origin`, so "record every local write to the ledger" would let a drive-by
website POST an `@marver` event to `localhost` and self-authorize (CSRF → RCE). The ledger must key on a
**gated** write, not any write.

**Files.**
- `src/server/config.ts` — extend `ShConfig` with optional `jam` (validate like `validPort`/`validZoom`;
  unset `jam.agent` = off):
  ```
  jam?: { agent?: 'claude' | 'codex'; concurrency?: number; subagents?: boolean; proactive?: boolean }
  ```
  Defaults `concurrency:3`, `subagents:true`, `proactive:false`. **`proactive` is inert in v1** (parsed,
  reserved for P2 — see Deferred); documented as such so it is not config theater.
- `src/server/api.ts` — **the owner gate** on `POST /__mv/api/comments/<board>`:
  1. Reject unless `Origin`/`Host` is the dev server's own (defense in depth vs cross-origin drive-by).
  2. Require a **per-process dev token**: the dev server mints a random token at startup (in memory,
     never on disk), injects it into the served shell bootstrap, and the client sends it as an
     `x-mv-dev` header. A cross-origin page cannot read the token (it is in the localhost page's JS,
     same-origin-protected) and cannot guess it. Reject POSTs without a matching token.
  3. Only a POST that **passes the gate** is eligible to be ledgered. Provenance strip stays (`:182`).
- `src/server/jam/ledger.ts` (new) — `has(root,id)`, `record(root,id)` against `design/.local/jam-ledger`
  (append-only ids, gitignored, mode 0600, fsync on record, torn-line tolerant). `api.ts` calls
  `record` **after** `appendEvents` fsyncs (`:189`), for each gate-passing fresh `create`/`reply`.
  **Order is the contract:** event fsynced first, then ledger; a crash between leaves the event
  present-but-unauthorized (safe). **Agent-written events are never ledgered** (daemon-authored).

**Test (unit).**
- Gate: POST with no/foreign `Origin` → rejected; POST with no/wrong token → rejected; POST with the
  minted token + own Origin → accepted and its id ledgered.
- Ledger: `record` then `has` → true; unknown id → false; an `agent:true` event → never recorded.
- Fail-closed order: append-ok / record-skipped → `has` false (won't trigger), never the reverse.
- Ledger file mode is `0600`; torn trailing line + duplicate id tolerated on read.
- Config: `jam` absent → agent undefined (off); bad `agent` → undefined; defaults fill; `proactive`
  parsed but flagged inert.

**Exit.** Gate + ledger + config unit tests green. The trust boundary is real and tested at the POST.

---

## Milestone 1 — The walking skeleton: single-frame triggered loop  *(the spine; jam-integ)*

**Goal.** The whole trust-and-execution spine, one frame: owner tags `@marver` (through the gated POST)
→ daemon gates via ledger → spawns ONE `claude -p` → agent edits the frame → daemon captures the
structured result → appends the `agent:true` reply in-process → reply is readable. Prove the risky core
before any UI, presence, or parallelism rides on it.

**Files (new `src/server/jam/` module).**
- `jam/watch.ts` — dir-watch `design/comments/` **+ ~5s full rescan** (the correctness backstop); on wake
  `readLog` **all** boards, reconcile against the journal by event id, return unclaimed
  **owner-ledgered** (`ledger.has`) new `create`/`reply` events matching `/@marver\b/i`, excluding
  `agent:true`.
- `jam/journal.ts` — durable batch journal `design/.local/jam-jobs.json` (atomic temp+rename+fsync,
  torn-write tolerant, mode 0600). M1 uses **single-member batches**. Fields:
  `{ batchId, memberEventIds[], state: pending|claimed|done|failed, leaseUntil, attempts }`. Agent
  session id stays in memory, never on disk.
  - **Activation baseline:** first init with no journal → mark all existing events seen, execute none.
  - **Repo lock:** flock at startup; only the holder watches/claims (a second dev server runs jam-less).
- `jam/packet.ts` — the versioned untrusted `JobPacket` (SPEC §5): control-char/ANSI-strip, ~4KB cap,
  explicit author, `nearby` cluster, anchor, screenshot hint. **No `file:line`.**
- `jam/adapter/claude.ts` — the `JamAdapter` for `claude -p --permission-mode acceptEdits --allowedTools
  Read,Edit,Write,Bash --output-format json`; `parseResult` reads the JSON envelope, extracts
  `canonicalModel` → `agentMeta.model`.
- `jam/daemon.ts` — the loop: atomic claim → spawn adapter → capture → **write reply via `appendEvents`**
  stamped owner-author + `agent:true` + `agentMeta` (SPEC §7) → mark `done`. Lease + `attempts` backoff;
  terminal `failed` posts a short "couldn't do that." **Recovery = fence + goal-phrased re-run** (kill the
  process **group** before reclaim; jobs are goals, so re-run is idempotent).
- `src/server/dev.ts` — start the daemon as a sibling of the sync loop (`:144-160`), gated on
  `cfg.jam?.agent`. It *is* the dev server, so activity/URL are internal.

**Test (jam-integ, `MARVER_JAM_INTEG=1`; real POST, never pre-seeded ledger).**
1. **Happy path:** fixture project, owner `@marver` create **posted through the gated dev POST** on a
   real frame → daemon ticks → frame file changed AND `readLog` shows an `agent:true` reply with
   `agentMeta.harness='claude'`.
2. **Trust boundary (the RCE guard):** a `@marver` create that did NOT pass the gate (no token /
   simulated synced-in) → not ledgered → daemon ignores it, no spawn, no file change.
3. **Watcher + all-board scan:** create a new board file mid-run → its `@marver` is picked up by the
   rescan (not just the initial dir contents).
4. **Idempotent recovery:** kill the spawned process group mid-edit → re-run the batch → file correct,
   exactly one reply (event-id dedup holds).
5. **Journal (unit):** activation baseline (journal-absent over old `@marver` log → zero jobs); repo-lock
   (second daemon on same root does not claim); corrupt journal → treated as absent baseline, not a crash;
   lease reclaim after expiry; `attempts` bound → terminal failed posts one reply.
6. **Packet (unit):** control-char/ANSI stripped, 4KB cap enforced, author preserved, `file:line` absent.

**Exit.** All green. `claude` adapter only, single frame, single member. The spine is proven end to end.

---

## Milestone 2 — Agent instructions + reanchor  *(jam-integ; must precede M4/M5)*

**Goal.** Make the spawned agent competent, and keep threads attached when it moves an element. Codex #2/#3:
frame-first, camera-safety, and subagent briefing are **agent behaviors taught by the playbook** — M4 and
M5 test those behaviors, so the playbook has to exist first. `reanchor` replay is already built + unit-
tested; this ships the playbook and wires the daemon to emit `reanchor`.

**Files.**
- `src/cli/init.ts` — extend the scaffolded `design/AGENTS.md` with the jam playbook (SPEC §15/§16):
  untrusted-data framing, read the `nearby` cluster, locate by quote/testid/selector, capture a
  screenshot, **frame-first (scaffold stub → mark working → fill in)**, preserve tag/testid/text so pins
  self-heal, **re-pin the thread if the element moved**, reply voice (sharp, line breaks), **do not
  auto-resolve**, camera-safety (never switch boards / run tidy mid-work), subagent briefing = **same
  context as primary** (Marver instructions + repo `CLAUDE.md`/`AGENTS.md` + the frame packet). Ship a
  root `CLAUDE.md` that `@`-imports `design/AGENTS.md` (proven necessary — Claude reads CLAUDE.md).
  **Handle an existing root `CLAUDE.md`:** append the `@import` idempotently, never clobber.
- `jam/daemon.ts` — when a result's `reanchors[]` is non-empty, append `reanchor` events in-process
  (owner-author + `agent:true` → attributable, never re-triggers). Replay already re-pins the thread.

**Test (jam-integ).**
- Instruction delivery: a `claude -p` job with the shipped root `CLAUDE.md` **follows** `design/AGENTS.md`
  — asserts frame-first (a stub frame exists before the edit lands) AND does not auto-resolve the thread.
- Existing-CLAUDE.md safety (unit): `init` over a repo that already has a root `CLAUDE.md` → the `@import`
  is added once, prior content intact; run twice → no duplicate import.
- Reanchor round-trip: an owner `@marver` that renames a `data-testid` → agent returns a `reanchor` →
  a `reanchor` event is written AND `replay` re-pins the whole thread to the new anchor.

**Exit.** Agent follows the playbook; reanchor round-trip green; existing-CLAUDE.md is safe.

---

## Milestone 3 — The client felt surface  *(component + `/qa`; independent of daemon internals)*

**Goal.** What the human touches: multiline composer, owner-vs-plain `@marver` rendering + teaching
tooltip, the glass notification, **and the Marver identity + provenance tooltip** (Codex #9 — the
`agentMeta` avatar UI was stamped server-side but never rendered).

**Files.**
- `src/client/shell/Comments.tsx` + `styles.css` — composer `<input>` → auto-grow `<textarea>` (1–6 rows,
  internal scroll past 6): `Enter` send / `Shift+Enter` newline / `Cmd·Ctrl+Enter` send / `Esc` cancel;
  `preventDefault` on send; **IME guard** (`e.isComposing`); disable while submit in flight; `Tip` label
  `⏎ send · ⇧⏎ new line` (SPEC §6). Apply to **both** composers (root + reply).
- `Comments.tsx` `renderBody` + `.cm-at` — parse `@marver`: **owner-authored → bold accent-blue**,
  non-owner → plain muted + tooltip *"Read like any other comment. Marver won't act on this unless the
  owner promotes it."* Owner-vs-plain compares `author.email` to session owner, never string-matching.
- `Comments.tsx` ThreadCard — render `agent:true` events as **Marver** (name + logo avatar), and a
  **provenance tooltip on the avatar**: `Dev user · Harness · Model · Effort` from `agentMeta` (SPEC §7).
- `store.ts` `Toast` + `App.tsx`/`Play.tsx` + `styles.css` — `.sh-toasts` bottom-left → **bottom-right**;
  jam notification = compact glass pill, full radius, single row (avatar · "marver replied" · ellipsized
  preview · accent **View** · close); **event-id baseline dedup**; active-board only; View →
  `revealThread`; bounded stack (~3 + "+N more"); single portal above canvas + Play (SPEC §9).

**Test.**
- Unit: keybinding dispatch (send vs newline vs IME-suppressed vs Escape), submit-in-flight lock,
  `renderBody` owner-vs-plain classification, `agentMeta` → tooltip string, **notification dedup keyed on
  id-in-baseline-set (NOT timestamp)** — a newly-observed id notifies even with an old timestamp; an id
  present at baseline does not (Codex #4, aligns with SPEC §9).
- `/qa`: multiline send in both composers; owner `@marver` bold-blue, teammate's plain + tooltip; a Marver
  reply renders as Marver with the provenance tooltip; a reply fires exactly one bottom-right pill whose
  View reveals the thread; dismiss + stack cap + Play render + single portal (no duplicate).

**Exit.** Component units green; `/qa` confirms composer, both `@marver` styles, Marver identity +
tooltip, and the notification. No daemon dependency.

---

## Milestone 4 — The live-feel: presence + glow + camera-safety  *(jam-integ + `/qa`; needs M2)*

**Goal.** The canvas always shows what's being worked on, from the first second, without moving the
camera (SPEC §10, §13, §14). Depends on M2 (frame-first is an agent behavior).

**Files.**
- `store.ts` — widen `Node.status` with `'working'` (`:34`).
- `FrameNode.tsx` + `styles.css` — a `.sh-node.working` branch: reuse the interact orbit **motion** but
  monochrome (silver on dark); **selected-while-working → `--accent` blue**; human-interact magenta
  unchanged. Precedence for `working + interact + selected`; extend `prefers-reduced-motion`.
- **Presence over the existing broadcast rail, NOT a new poll** (Codex over-engineering catch). The dev
  server already pushes `sh:manifest` / `sh:frame-invalidated` to the client; add a `working` presence
  event on that same rail. In-memory presence keyed by `nodeKey`, per-session lease + heartbeat, ~90s
  auto-expire (never on disk). No `POST/GET /activity`, no 2.5s client poll — the push kills the
  "first-second" latency and the poll's lease-race surface.
- **Canvas-presence invariant (agent side is M2's playbook):** the agent scaffolds a stub frame file
  first → manifest regenerates → node appends camera-safe → **then** it is marked `working` (Codex #5: a
  net-new frame has no `nodeKey` to mark until it exists). The daemon marks `working` **for frames that
  already have a node**; net-new frames are marked by the agent right after scaffolding, via the playbook.
- Verify (don't regress) the camera-safety already in code: `applyManifest`/`invalidateFrames` never call
  `fit*`.

**Test.**
- Unit: presence lease/heartbeat/expire (one idle session can't clear another's glow); reduced-motion path;
  duplicate placements keyed by distinct `nodeKey` glow independently.
- `/qa`: start a jam → a **net-new** frame appears + is scaffolded, THEN wears the silver glow, fills in
  live, glow clears on done; an **existing** frame glows at batch start; **camera does not move** across
  scaffold + edit; a frame the user is mid-gesture on defers its update (`frameIsLeased`); selecting a
  working frame turns the glow blue.
- jam-integ: extend the M1 happy path to assert scaffold-before-edit and a `working` presence event on
  the rail before the reply.

**Exit.** Glow + presence green over the existing rail; net-new ordering correct; camera-stability and
lease-defer regression-guarded.

---

## Milestone 5 — Batch + parallelism  *(jam-integ; needs M2)*

**Goal.** The multi-frame UX: drop several `@marver` comments, watch several frames build at once —
subagents *within one batch*, batches serialized (SPEC §3.3, §12). Promotes M1's single-member journal to
real batches and adds the second proven adapter. Depends on M2 (subagent briefing is an agent behavior).

**Files.**
- `jam/journal.ts` — multi-member batch: `memberEventIds[]` **frozen at spawn**, **atomic multi-event
  claim** (all → `claimed` under one `batchId`, one journal write), per-member terminal states, per-member
  retry (goal-phrased → `done` members no-op on re-run). Mid-batch arrivals form the **next** batch.
- `jam/daemon.ts` — packet carries all members; result is per-member `{ eventId, reply, reanchors[],
  status }`; completion = every member `status:ok` + a reply; partial failure is per-member (ok members
  written + `done`, failed retried then get their own "couldn't do that" — never a blanket batch failure).
- `jam/adapter/codex.ts` — the second adapter (`codex exec --json -s workspace-write --skip-git-repo-check
  -o <msg>`); **no subagents → frames run sequentially in one exec** (correct, slower, no parallel glow).
- Subagent fan-out gated by `jam.subagents`.
- **Concurrency, stated honestly (Codex #11 / SPEC §12 residual).** The daemon enforces isolation **across
  batches** (serialize; same-frame non-negotiable). **Within** one batch, `jam.concurrency` and same-frame
  non-overlap are **orchestrator-assigned, not daemon-enforced** — one opaque agent run owns fan-out, so
  the daemon requests the cap via the packet/playbook, it does not police the agent's internal subagents.
  This is the documented residual (OS-enforced allowlists are P3), not a guarantee the plan pretends to make.

**Test (jam-integ).**
- Two owner `@marver` mentions on two frames → ONE batch (assert single `batchId`), both frames edited,
  two per-member `agent:true` replies.
- Frozen membership: a third mention arrives mid-batch → it is NOT in the first batch; forms the next.
- Cross-batch serialization: two batches never run concurrently (same-frame safety).
- Same-frame: two mentions on one frame → serialized within/across, never two writers at once.
- Partial failure: force one member to fail → the other is `done`, the failed one retried then gets its
  own reply.
- CLI-swap: the two-frame test under `jam.agent:'codex'` → frames edited sequentially, correct replies
  (proves the adapter seam).
- `jam.subagents:false` → multi-frame batch runs single-agent, still correct (slower); AND a
  `subagents:true` run actually fans out (assert >1 frame in `working` at once for the claude adapter).

**Exit.** Batch + per-member + frozen-membership + serialization + CLI-swap green. Parallelism is live and
honest about the within-batch residual.

---

## Deferred (P2/P3 — explicitly out of the milestones above)

**Codex flagged these as unbuilt; that is intentional — they are not the core loop, so v1 defers them
rather than shipping half-built machinery.**
- **Proactive pickup (SPEC §3.7) → P2.** Act on the owner's *untagged* ledgered backlog at idle /
  job-completion checkpoints. `jam.proactive` config exists in M0 but is **inert until this ships**.
- **Context batch (SPEC §3.6) → P2.** Hand the agent new/unresolved *untagged* comments from signed-in
  users as awareness (never a trigger). `nearby` (M1 packet) is per-frame cluster context, not this.
- **Owner promotion (SPEC §1, §3.7) → P2.** A "have Marver do this" affordance that writes an
  owner-ledgered event so a teammate's comment becomes a job. Until then non-owner comments are read-only
  context.
- **P2 (other):** in-frame scroll/form capture-restore across edits; prototype/stage scroll preservation;
  session-resume (`--resume`, spiked, works); finer sub-frame activity leasing; emoji reactions (rails are
  event-type-neutral, §17).
- **P3:** publishing agent replies (trusted dev-sync path); allowlisted collaborators beyond the owner;
  all-board inbox / cross-board notifications; **OS-enforced per-subagent filesystem allowlists** (the
  within-batch isolation residual); Cursor / OpenCode / Droid / Antigravity adapters (each with its own
  contract test); MCP server path.
- **Dropped:** the `marver jam working/idle` CLI (§16) — the daemon sets `working` over the broadcast rail
  directly (M4), and the agent scaffolds+marks net-new frames via the playbook (M2), so a separate CLI is
  redundant.

## Open decisions that surface during build (not blockers)

1. **Within-batch file isolation** stays orchestrator-trust in v1; OS-enforced allowlists are P3. If real
   jams show cross-file races, this promotes.
2. **`jam.concurrency` default (3)** and the ~90s presence lease are guesses to tune against a real
   multi-frame jam in M4/M5.
3. **The dev token transport** (injected into the served bootstrap + `x-mv-dev` header) is the v1 shape;
   if the shell already has a same-origin session primitive, reuse it instead of minting a second token.

---

_Design spec: `SPEC-live-jam.md` v10.1. De-risk evidence: `DERISK-live-jam.md`. Codex review: 2026-08-18
(session `01a0140b`). Spike harnesses: `scratchpad/spike-{runtime,loop,auth,crash,resume}/`,
`scratchpad/marver-test/` (promoted to `test/jam-integ/` in M1)._
