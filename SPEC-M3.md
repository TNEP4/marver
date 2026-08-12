# M3 spec - comments, identity, access (WIP, 2026-08-12)

> **STATUS: WIP - design conversation captured, not yet contract.** Nothing here is
> build-ready; the access-control section in particular has open questions marked
> UNRESOLVED. Promote to contract (drop the WIP banner, resolve the open questions,
> record choices in DECISIONS.md) before writing any M3 code. Same contract rules as
> SPEC-M2 once promoted: where this and convenience disagree, this wins.

The thesis: comments close the design-review loop *inside* the agent-native story.
A reviewer drops a pin on the published canvas; the event syncs back to the repo as a
file; the agent reads it, fixes the frame, replies, resolves. The Slack-copy-paste
step of design feedback is the thing this milestone deletes.

---

## 1. Data model: comments are an append-only event log

Comments are never stored as mutable records. They are immutable events:

```
{ id, ts, type: create | reply | edit | resolve | reopen,
  commentId, board, frame, pos,            // pos is frame-relative so pins survive canvas rearrangement
  author: { name, email, avatarUrl },      // denormalized snapshot, see §4
  body }
```

One file per board: `design/comments/<board>.jsonl`. Current comment state is derived
by replaying events (last-writer-wins per field, ordered by ts then id).

Why: **merging two event logs is set union.** Every event has a UUID; sync between dev
and published is "send events the other side lacks." Idempotent, order-independent,
retry-safe. No conflict-resolution machinery because there are no conflicts by
construction. Comment data is tiny (tens to low hundreds of events per board);
files, not a database. Git tracks the log, so comment history travels with the repo
and the agent reads it with zero new tooling.

## 2. Sync: one merge rule, running continuously

- **Dev** renders pins from `design/comments/`, writes events through the dev server's
  existing write channel, broadcasts via the existing fs.watch rail.
- **`marver build`** embeds the current log as the *seed*.
- **`marver serve`** keeps its own copy (volume for persistence) initialized as
  **union of seed + whatever it already holds**. Republishing must never clobber
  feedback collected since the last deploy. This rule is load-bearing.
- **`marver dev`** background-syncs two-way with the publish target (~30s + on window
  focus): push local events, pull remote. Authenticates with the gate password -
  honest, because anyone who can view can comment. On pull, the jsonl updates,
  fs.watch fires, tabs refresh. Same rails as board sync.
- **Headless**: `marver comments sync` does one exchange (agent/CI path, no dev
  server running). That is the whole CLI surface.

**Publish target: exactly ONE per repo (DECIDED 2026-08-12).** Config lives in
`design/publish.json` (url; password sourced from env, never committed).
Multi-environment sync is out of scope for M3.

Out-of-sync analysis: single format, single merge rule, sync runs whenever dev is
open. The only offline gap is "published collected comments while dev was closed,"
which self-heals on next dev start or `comments sync`.

## 3. Access control (UNRESOLVED - the WIP core)

Direction from Nic (2026-08-12): greenlight specific **emails** for specific access
levels - READ vs READ+COMMENT - stored in the same store. Viewer flow: enter canvas
password, then email; if the email is on the allowlist and new, set display name +
profile picture.

Sketch:

- Allowlist lives with the comment store (e.g. `design/access.json` or an event type
  in the same log): `{ email, role: read | comment }` (+ future: admin?).
- Gate becomes two-step: password (existing scrypt gate) -> email. Unknown email =
  read-only or rejected (which? open).
- First visit of an allowed email -> profile setup (name + avatar), persisted as a
  profile event so it propagates to all viewers.

**Open questions - resolve before promoting:**

1. **Verification.** Password + typed email is honor-system identity: anyone holding
   the password can claim any allowlisted email. Options: (a) accept honor-system for
   v1 (teams/clients behind a shared password - probably fine); (b) magic-link email
   verification (real identity, but drags in email-sending infra: an SMTP/API key per
   deployment - heavy for self-hosters); (c) defer verified identity to the hosted
   tier (OAuth, one client, marver.design's problem). Current lean: (a) now, (c)
   later; keep the author-snapshot format compatible so hosted-verified authors slot
   in unchanged.
2. **Does READ-only even need an email?** If the password alone grants READ and email
   only unlocks COMMENT, the flow is simpler and anonymous viewing keeps working.
   Alternatively email-gate everything for an audit trail. Undecided.
3. **Unknown email behavior**: silent read-only vs explicit "ask the owner for
   access" screen.
4. **Where the allowlist is edited**: file in the repo (agent/owner edits, ships with
   build - simple, but adding a viewer requires a redeploy or a sync) vs mutable on
   the server via an owner credential (no redeploy, but needs an owner role above the
   gate password). Undecided.
5. **Avatar upload** means blob storage - creep. v1 ladder stays: explicit URL ->
   Gravatar(email) -> generated initials. Upload is hosted-tier territory.

## 4. Profiles: denormalized author snapshots

No user table. Each event carries `{name, email, avatarUrl}` at write time. Display
name + email set once per client (localStorage), avatar resolves: explicit URL ->
Gravatar hash -> initials + deterministic color. Profile changes affect future events
only - acceptable at this scale. If §3 lands profile-setup-on-first-visit, a profile
event type can propagate updates; keep it optional.

## 5. Boundaries and hosted-tier seam

- Gate password = the outer security boundary; email roles subdivide *within* it.
  Not fit for fully public canvases (rate limiting, moderation) - out of scope.
- Volume required on the serve host for comment persistence; publish docs must say so
  loudly. No volume = comments live until redeploy (softened by auto-sync back to repo).
- The hosted marver.design tier (future) owns: real OAuth (Google/Microsoft), verified
  author snapshots, avatar upload, cross-project inboxes. This spec's formats are the
  sync target; the hosted tier is additive, never required. Open-source core stays
  auth-free beyond the gate + allowlist.

## 6. Sequencing

After the marver-site dogfood friction log is triaged (it may reshape 0.3.0 scope and
may surface comment-adjacent needs). Promote this spec in the same sitting.
