# Changelog

Notable changes to `@marver-design/marver`. Format follows [Keep a Changelog](https://keepachangelog.com); versions follow semver.

## 0.4.0 - UNRELEASED

The collaboration release (SPEC-M3): the canvas becomes a place where colleagues,
the designer, and the coding agent close the feedback loop together.

### Added

- **Element-anchored comments.** `C` enters comment mode: click any element inside a
  frame (laser outlines guide you) and the thread pins to it - fractional position
  inside the element's box, so pins ride through responsive reflow. Threads are
  Google-Docs-shaped: root + one level of replies, resolve/reopen. Anchors survive
  agent edits via a verified ladder (semantics → CSS path → fuzzy quote match);
  a dead anchor parks the thread visibly at the frame edge, never silently deleted.
  Inactive frames collapse their open threads into a top-right avatar stack.
  `Shift+C` hides all pins; `?c=<thread>` deep-links a specific thread through the
  password gate (copy-link on every card).
- **Real commenter identity, no email infrastructure.** Viewers on a published canvas
  claim an account through a single-use invite link (owner mints it; the link travels
  over Slack/DM) - display name, password, avatar. Accounts are scrypt-verified with
  per-user salts; sessions survive restarts. The first account owns the canvas;
  `MARVER_OWNER_EMAIL` prints the owner's one-time claim link in the deploy logs.
  Avatars fall back to initials on a deterministic color.
- **One deploy, comments live everywhere.** `marver serve` grows a collaboration API
  (REST + SSE) when `MARVER_DATA_DIR` names a durable volume; the published canvas is
  the comments' home. `marver dev` two-way syncs every 30s (`marver comments connect
  <url>` once), so client feedback lands in `design/comments/<board>.jsonl` - a
  git-tracked, append-only event log the agent reads with zero tooling. Republishing
  never clobbers collected feedback (the store unions the bundle seed on boot).
- **The agent works the queue.** `marver comments list --open --json` / `reply` /
  `resolve --addressed-in <frame>` - resolving records which variant answered the
  feedback, making the fork-don't-overwrite doctrine auditable. `marver comments
  invite <email>` mints single-use invite links from the CLI (owner only), `revoke
  <email>` retires an account. `instructions/iterate.md` carries the
  comments-as-work-queue discipline; `instructions/publish.md` is the agent-facing
  deploy runbook (boards policy, gate, volume, accounts) and AGENTS.md routes to it.
- **Laser mode.** `L` (or the toolbar crosshair) outlines every element in every frame
  with depth-hued borders (60° per nesting level) plus a DevTools-style hover label.
  Zero layout shift - outlines only. Clicking an element copies its full address for
  the agent - frame source file + CSS path (+ JSX source location when stamped).
  Comment mode shows only the hover highlight (no full rainbow) and a chat-teardrop
  cursor, so picking an element to comment on stays calm.
- **Default-closed publishing.** `marver build` now requires a publish policy:
  `design/publish.json` names each published board with `read` or `comment` rights
  (enforced server-side, not just hidden in UI). `--boards a,b` stays as an explicit
  override; publishing everything takes a deliberate `--all-boards`.

### Changed

- **`c` is comment mode now** (the Figma/Miro convention). Copy-selected-file-paths
  moved from `c` to `y`.
- `marver build` without a publish policy fails with instructions instead of
  publishing everything - the privacy default flipped closed.

### Security

- Comment mutations are CSRF-protected (double-submit cookie + origin checks) and
  rate-limited; session and invite tokens are stored hashed; every pushed event is
  validated hard (author must match the session, thread ids cannot be hijacked,
  edits are owner-only, timestamps cannot come from the future) - and accepted
  events are never rewritten, so id-keyed sync converges byte-identically.
- v1 trust boundary, stated plainly: frame code in your design repo runs same-origin
  with the shell - review what you merge. Full frame sandboxing is the v1.1 follow-up
  (SPEC-M3 §0 records the probe results and the plan).

## 0.3.1 - 2026-08-13

### Fixed

- Play-mode variant chrome: the current variant's name was invisible (theme ink on the always-dark glass pill - now the pill's own light ink), and switching variants jiggled the controls. Redesigned: the letter chips now use the sidebar's exact badge language (20px, 7px-radius, one shape in every state) so the two surfaces read as one concept, they LEAD the cluster as the stable anchor, and the name trails at natural width (capped with ellipsis + a tooltip carrying the full title) - a name change grows the pill rightward without moving anything underfoot.

## 0.3.0 - 2026-08-13

The co-thinking release: the canvas now holds the thinking, not just the screens.

### Added

- **Content frames (SPEC-026).** Specs, Mermaid diagrams, and mood boards as ordinary frames beside UI frames - import `Doc`, `Row`, `Col`, `Space`, `Md`, `Diagram`, `Img` from `@marver-design/marver/content`. Works in a repo with no app at all: idea first, design second.
  - `Doc` auto-sizes the frame to its content (measurement protocol; auto sizes are session-transient, manual resize and device views still win). Published canvases keep parity.
  - `Diagram` is first-class Mermaid, lazily loaded - a workspace with no diagrams ships zero mermaid bytes. Source theme overrides are stripped; parse errors show an in-frame card and heal live.
  - `Md` renders theme-aware markdown; `[label](goto:scene/frame)` links jump the canvas. Raw HTML is inert, images are local-only.
  - `Img` shows `design/assets/` imagery with captions; `h={n}` cover-crops a mixed-aspect row to one height so it reads aligned.
  - Zero-external-request boundary: URLs are rejected in diagram source, rendered SVG is sanitized, published builds copy only referenced local assets.
- **The marver diagram theme.** Full Apple system palette (12 series colors + systemGray ramp, exact HIG light/dark pairs), system font stack, accent-washed nodes by default - a plain flowchart is never gray-on-gray. Label typography rides inside the SVG (measured, not post-styled).
- **Frame intent.** Content frames declare `intent` (`diagram` | `spec` | `moodboard` | `notes`); the sidebar shows a glyph per row - every row leads with an icon, variant groups carry the flask.
- **Sidebar tells the canvas's story.** Rows and scene groups order by canvas position, not file order.
- **The onboarding fork (SPEC-025 amendment).** Both first-session paths - empty repo and existing app - now stop and ask what the highest priority is: think the idea through together on the canvas, or go straight to screens.
- **Shape & Iterate doctrine.** `instructions/shape.md` (feature-story boards: specs → lo-fi → hi-fi with graduated spacing) and `instructions/iterate.md` (fork-don't-overwrite, letter variants, the archive ritual).
- **Craft doctrine hardened.** Real assets are binding (Phosphor icons by default, actual brand logos, fetched imagery). Interactive means visibly interactive at every fidelity - cursor + hover on every clickable target, component-library gaps (shadcn on Tailwind v4 ships `cursor: default` buttons) fixed at the design-system base layer.

### Changed

- Markdown typography moved to the HIG scale: 16px body on 1.65, tightened heading tracking, contained Notion-style tables, re-asserted list markers (Tailwind preflight strips them in host apps).

## 0.2.4 - 2026-08-13

- Onboarding as a conversation (SPEC-025): setup flow asks what you're building, proposes a stack (a recommendation, not a requirement), hosted tour canvas as the waiting room, local canvas as the reveal. Two dogfood rounds folded in.

## 0.2.3 - 2026-08-12

- Hardening release: codex P1s (live-JOIN adjacency, same-directory group invariant, tsx-only inference) and a P2 sweep (extractor boundaries, sceneRows dedupe, play-mode chrome fixes, extreme-zoom badge fade).

## 0.2.2 - 2026-08-12

- Update discovery: glass pill + stdout notice + daily registry check (opt out with `MARVER_NO_UPDATE_CHECK=1`). `design/` collision guard on init.

## 0.2.1 - 2026-08-12

- The dogfood friction release: all 23 logged friction issues triaged; bugs fixed.

## 0.2.0 - 2026-08-11

- First public release on npm as `@marver-design/marver`, Apache-2.0. The agent-native design canvas: `design/` folder, live frames from your app's real components, boards, device sweeps, play mode, published canvases with a password gate.
