# M3 spec - comments, identity, access (CONTRACT, promoted 2026-08-13)

> **STATUS: CONTRACT.** Promoted from WIP after the 2026-08-13 design cycle (three
> research tracks + codex consult + Nic's decisions; see DECISIONS.md "M3 promoted").
> Where this and convenience disagree, this wins. The design rationale board lives in
> the pilot: `design/boards/m3-comments.json` (six content frames).

The thesis: comments close the design-review loop *inside* the agent-native story.
A reviewer drops a pin on a specific element of the published canvas; the event syncs
back to the repo; the agent reads it, forks the frame into a new variant, replies,
resolves. The Slack-copy-paste step of design feedback is the thing this milestone
deletes.

Guiding principle (Nic, stated twice): **lightweight, simple, elegant, not
over-engineered.**

---

## 0. Sequencing: two prototypes BEFORE feature code

1. **Frame isolation proof.** Frames currently render as same-origin, unsandboxed
   iframes. The moment serve exposes authenticated write APIs, arbitrary frame code
   could issue requests with the viewer's cookies. Prove frames run under
   `sandbox="allow-scripts"` (NO `allow-same-origin`) with the postMessage bridge
   intact, in dev and published. If opaque-origin sandboxing breaks module loading,
   the fallback is serving frames from a separate origin. Cookie-path tricks are NOT
   an acceptable answer - same-origin frame JS can always send authenticated
   requests.
2. **Anchor survival test.** Create anchors against pilot frames, have a coding
   agent genuinely rewrite them (restyle, reorder, extract components), measure what
   the resolution ladder (§5) recovers. This calibrates the fingerprint thresholds
   and decides how urgently lazy oid-stamping (§5, deferred) is needed.

## 1. Data model: comments are an append-only event log

Comments are never stored as mutable records. They are immutable events:

```
{ id, ts, type: create | reply | edit | resolve | reopen | react | profile,
  commentId, board, nodeKey, frame,          // node-scoped: a frame can sit on a board twice
  anchor,                                    // §5 - absent = frame-level comment
  author: { email, name, avatar },           // denormalized snapshot
  body,                                      // plain text in v1 - no unsanitized markdown
  addressedIn }                              // resolve events: the variant frame that answered it
```

- **Storage: JSONL, not SQLite (DECIDED 2026-08-13).** One file per board under the
  serve data dir; `design/comments/<board>.jsonl` in the repo is the synced mirror.
  Rationale: the merge rule IS the sync protocol - two logs merge by set union on
  event UUID; idempotent, order-independent, retry-safe, tolerant of the
  deploy-overlap double-writer window on Railway-class hosts, git-trackable, and the
  agent reads it with zero tooling. Comment volume is tens-to-hundreds of events per
  board. Upgrade trigger to `node:sqlite`: >10k events/board or cross-board search.
- Current state is derived by replaying events (last-writer-wins per field, ordered
  by ts then id).
- **Resolve is an appended typed event, never a flipped flag** (the Google Docs
  mechanic): free audit history, trivial reopen, and *orphaned* stays orthogonal to
  *resolved*. `resolve` events SHOULD carry `addressedIn` naming the variant frame
  that answered the feedback - the fork-don't-overwrite doctrine, auditable.
- **Threads are flat**: a root comment + one level of replies. Reactions (`react`
  events, one level, toggle semantics keyed on comment+user+emoji) ship in v1.1
  after the thread UI is stable.
- Client-generated event ids double as idempotency keys - a retried POST cannot
  duplicate a reply.

## 2. Sync: one merge rule, running continuously

- **Dev** renders pins from `design/comments/`, writes events through the dev
  server's existing write channel, broadcasts via the existing fs.watch rail.
- **`marver build`** embeds the current log as the *seed*.
- **`marver serve`** keeps its own copy (volume) initialized as **union of seed +
  whatever it already holds**. Republishing must never clobber feedback collected
  since the last deploy. This rule is load-bearing. Comments are keyed to the
  canvas, never to a bundle hash.
- **`marver dev` background-syncs two-way** with the publish target (~30s + on
  window focus): push local events, pull remote. **The browser never talks to the
  published host** - the local Vite process proxies (`/__mv/collab/*` → published
  `/__mv/api/*`) with a scoped bearer token from `marver comments connect <url>`,
  stored in `design/.local/collab.json` (gitignored). Same-origin locally, zero
  CORS, no cross-site cookies.
- **Live rail on the published side: SSE**, not WebSockets. Mutations are plain
  POSTs; SSE announces committed events. Monotonic event ids + `Last-Event-ID`
  resume; heartbeat ≤4min (Railway cuts idle streams at 5); `X-Accel-Buffering: no`.
- **Headless**: `marver comments sync` does one exchange (agent/CI path). The agent
  surface is JSON-first: `marver comments list --open --json`, `reply <id>`,
  `resolve <id> --addressed-in <frame>`.
- **Publish target: exactly ONE per repo** (decided 2026-08-12). `design/publish.json`
  holds the url; secrets come from env, never committed.
- Volume required for persistence; when collaboration is enabled serve REQUIRES an
  explicit `MARVER_DATA_DIR` and fails loudly without it. `marver comments export`
  ships in v1.

## 3. Access control (RESOLVED 2026-08-13)

**Password = read. Account = comment.** (Nic's call.)

- The existing gate password stays the outer boundary and alone grants READ of
  published boards. Casual viewers never create an account; anonymous viewing keeps
  working.
- Commenting requires a signed-in account. Accounts exist only for allowlisted
  emails, and are claimed through **single-use invite links**:
  1. The owner (or the agent, via CLI) adds an email to the allowlist and mints a
     high-entropy, expiring, single-use invite URL.
  2. The link travels over a channel the team already trusts (Slack, email, DM).
  3. The recipient opens it, sets password + display name + avatar. Done.
  This closes the "first person to type alice@co.com becomes Alice" hole without
  dragging SMTP into every deployment. Verified-mailbox identity remains hosted-tier
  territory.
- **Auth implementation: hand-rolled, extending the gate's own idiom.** Per-user
  random salt, scrypt (N=2^15+, r=8, p=1), `timingSafeEqual`; opaque 256-bit session
  tokens stored hashed; `HttpOnly; Secure; SameSite=Lax` cookie; sessions persist
  across restarts (unlike the gate's per-boot key). Generic sign-in errors, body
  size caps, IP+email rate limits, origin check + CSRF token on mutations. No auth
  framework - five tables and a migration CLI to serve ten people is the definition
  of over-engineered here.
- **Permissions resolve through one seam**: `can(user, board, 'read'|'comment'|'resolve')`.
  v1 derives it from the publish policy (§4) + membership; a per-user per-board ACL
  can replace the internals later without touching routes. The server enforces -
  hiding UI controls is not authorization.
- Token scopes are role-shaped: viewer session (read/comment), agent token
  (read/reply/resolve), owner/bootstrap (invite, revoke).

## 4. Publishing: default-closed, rights per board

`design/publish.json` grows a policy block and becomes REQUIRED for build:

```json
{ "url": "https://canvas.example.com",
  "boards": { "review": "comment", "archive": "read" } }
```

- A board absent from the policy is **not published**. `marver build` fails without
  a policy; publishing everything takes an unmistakable `--all-boards`. (`--boards`
  stays as an explicit override.) This reverses today's publish-everything default.
- Per board, two levels: `read` and `comment`. The policy is embedded in `.dist`
  and enforced server-side on the comment APIs.
- Comments belonging to a board dropped from a later publish stay in the store,
  inaccessible until republished - never deleted by a build.

## 5. Anchoring: the ladder, verified by fingerprint

A comment targets `board + nodeKey + frame` plus an **anchor bundle** - every rung
stored at creation, resolved top-down, each structural rung verified against the
content fingerprint before being trusted (the Hypothesis rule: cheap anchors are
only safe because the content check gates them):

```
anchor: {
  el:   { oid?, chain?, ordinal?,             // rung 0/1 - once stamping lands
          semantics: { tag, role, ariaLabel, testId, textHash, quote },
          cssPath,                            // rung 2 - structural fallback
          source: { file, component, line } },// metadata for agent routing, NEVER identity
  pos:  { fx, fy },                           // fractional, inside the element box
  region?: { fx0, fy0, fx1, fy1 } }           // drag-rect alternative to an element
```

- **v1 targets: one element, or one rectangle, or the whole frame.** No
  multi-element DOM ranges - a rectangle gives the visual meaning without inventing
  document-editing semantics.
- **Pin position is always fractional** (0-1 within the element/frame box) - the
  Vercel/tldraw convergence; survives responsive reflow by construction.
- **`file:line` is metadata, not identity.** A build plugin tags elements with
  ephemeral source-loc attributes for picking, laser tooltips, and agent handoff;
  anchors never depend on it.
- **Resolution ladder**: semantics match (component + stable attributes + text) →
  CSS path (fingerprint-verified) → fuzzy content match (Hypothesis-style scoring;
  below threshold = no match). Confidence is recorded per resolution.
- **Orphaning is graceful conversion, never deletion** (the tldraw mechanic): an
  anchor that dies converts the pin to a frame-relative point where it last sat,
  flagged `orphaned`, parked visibly with its stored quote; one-click re-anchor by
  picking a live element (which rewrites the bundle); low-confidence re-anchors ask
  for a one-click confirm. Never silently attach to a "similar" element.
- **Deferred, behind the survival prototype**: persistent `data-mv-oid` lazily
  written into the user's source when a comment is created (the Onlook mechanic -
  the only anchor an agent preserves *by editing it*). Ships when the prototype
  shows the semantic ladder alone drops too many anchors.

## 6. Surface: canvas-first, Google-Docs-shaped

- **Modes**: `C` = comment mode (laser outlines on, click an element / drag a rect,
  write, `Esc` out) · `Shift+C` = hide/show all comments · browse = default.
- **Inactive frame**: its open comments stack as an avatar/count indicator at the
  frame's top-right, in order. **Active frame**: pins render at their anchored
  positions. (Figma's cluster/pin duality, per-frame; hide-until-selected is
  rejected - Figma tried it and walked it back.)
- **Pins are screen-fixed size**; the indicator↔pins transition keys off frame
  activation, not zoom thresholds.
- **Deep links**: `?c=<commentId>` on the board hash. Thread id = root comment id.
  Opening one navigates to the board, activates the frame, reveals the pin. The
  gate already carries the full hash through auth.
- **Resolve archives visibly** - resolved threads sit one filter away, showing
  `addressedIn` when the agent answered with a variant. Never Figma's vanish.
- **Composer never loses work**: drafts auto-save locally (Miro mechanic).
- Author snapshots render name + avatar; avatar upload is client-side resize to
  128px WebP (~4KB, magic-byte validated, no SVG) stored as a data-URI in the
  profile event; fallback = initials on a deterministic color. No Gravatar - no
  external calls from a gated canvas.

## 7. Laser mode (inspect)

- A toggle like device/theme - canvas-wide or per-frame. `L` in v1.
- One injected stylesheet in the frame: `outline` only (never border - zero layout
  shift), **depth-based hue** stepping 60° per nesting level (cycling at 6). Nic:
  willing to try; single-accent is the fallback if the rainbow reads noisy.
- Hover: DevTools-style overlay box + label (tag/component + source file) for the
  element under the cursor, drawn by the same coordinate pipeline as comment pins.
- Comment mode turns laser on implicitly - picking IS inspecting.
- Known Mermaid-style trap: keep this a stylesheet + one overlay, not a rendering
  subsystem.

## 8. Boundaries and hosted-tier seam

- Gate password = outer boundary; accounts subdivide within it. Not fit for fully
  public canvases (rate limiting and moderation beyond the basics are out of scope).
- The hosted marver.design tier (future) owns: real OAuth, verified mailboxes,
  password reset, cross-project inboxes. This spec's formats are its sync target;
  the hosted tier is additive, never required.
- Frame content remains untrusted (§0). The comment UI lives in the shell, never
  inside frames.

## 9. v1 cut

In build order: publish policy → isolation proof → store + volume contract +
export → invited accounts/sessions/profiles → threads (frame + element + rect,
reply, resolve, idempotent) → SSE + dev proxy + scoped tokens → picking + laser →
collapsed stacks + pins + deep links → agent CLI with `--addressed-in`.

**Deferred**: reactions (v1.1, first), lazy oid stamping (behind prototype 2),
per-user board ACL UI, email verification/reset, multi-element ranges, presence,
WebSockets, notification channels (the SSE liveness + agent queue carry urgency
in v1).
