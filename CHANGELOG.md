# Changelog

Notable changes to `@marver-design/marver`. Format follows [Keep a Changelog](https://keepachangelog.com); versions follow semver.

## 0.7.0 - 2026-08-17

Prototype mode becomes a first-class review surface. The prototype (Play) now carries the same toolbar
as the canvas, laser and comments work INSIDE it, and every comment wears the colour of the element it
points at - the groundwork for tagging a coding agent from anywhere you review.

### Added

- **The prototype is a review surface, not just a viewer.** Play's top-right toolbar is now the SAME
  controls as the canvas - device switch, theme, laser, comment - built from one shared set of
  components so the two can never drift. Laser and comment work inside the running prototype: the stage
  runs the same element inspector the canvas frames do, so you can point at, highlight, and comment on
  the live app while you walk a flow. The bottom-left navigator (restart / prev / i-of-N / next) stays.
- **Hide UI (H).** One binary toggle hides all chrome for a clean point-and-shoot frame, shared by the
  canvas and the prototype. No auto-fade, no hover magic; a page refresh always brings the chrome back
  (the safety net for a forgotten shortcut). It replaces the prototype's old three-state auto-hiding bar.
- **Comments wear their element's colour.** Comment mode reuses laser's per-element depth hue: the
  element you hover, the composer, the pin, the thread card, and the active-element highlight all take
  that specific element's colour - a comment on a blue heading reads blue, on a green button green. The
  avatar keeps the commenter's own colour; filled buttons use a hue-aware shade so the glyph stays legible.
- **The commented element lights up.** Picking an element locks a persistent outline on it (the highlight
  stops chasing the mouse while you compose), and opening a thread re-lights its anchored element - so
  everyone sees exactly which element a comment is about. It clears on close.

### Changed

- **Prototype chrome is discreet and reliable.** The prototype's floating toolbar wears the same quiet
  dark skin as the bottom-left navigator, so it recedes into the stage instead of reading as a bright
  slab; and it no longer auto-hides or sticks under the cursor - it behaves exactly like the canvas pill
  (explicit collapse, Hide-UI, no surprises).
- **Prototype is an action, not a menu item.** The Prototype-view button moved into the canvas pill's
  action group (beside comment, laser, tidy), leaving the far right purely for UI management (Hide UI,
  collapse).
- **The element label reads clearer.** The laser/comment element tooltip now sits below-left of the
  cursor with a gap - clear of the element you are pointing at - and slides in from the edge instead of
  being clipped.
- **Escape exits laser mode**, matching comment mode.

### Fixed

- **Canvas comment highlight is now reliable.** A frame hosting an open thread or a draft shows its LIVE
  app rather than the frozen lean snapshot, so the active-element highlight appears, updates, and clears
  in real time - it used to be intermittently missing, or frozen after close, depending on snapshot
  timing. A clean snapshot rebuilds once the thread closes.
- **Highlights only show while a thread is active.** Closing a thread or hiding pins (Shift+C) clears the
  element highlight; a remotely-resolved thread no longer strands one.
- **Prototype comment overlay positions faster** after a walk and never renders behind the frame or off
  screen. Element-hue values, message origins, and stage-swap timing are all validated.

## 0.6.0 - 2026-08-17

Image-heavy boards, done right. A board full of high-resolution screenshots now zooms fast and stays
crisp, images render in FULL instead of cropped, content frames size themselves to their content, and
the switcher opens on a tight landing board instead of loading every frame at once.

### Added

- **Client-side image level-of-detail (LOD).** A board of 150+ high-res screenshots used to jank hard
  on zoom - the real cost was decoded memory, not file size (a 2708x1610 PNG is ~17MB decoded, so 174 of
  them held ~3GB of bitmaps the browser resampled every frame). Each `Img` now decodes STRAIGHT to its
  on-screen size via `createImageBitmap` and paints on a canvas; bitmaps freeze during a pan/zoom and
  re-pick resolution only when the gesture settles (the tldraw pattern). Result on a 174-image board:
  ~26MB decoded at overview vs ~3GB before (~100x less), lag-free zoom, crisp detail when you stop.
  Falls back to a plain `img` where `createImageBitmap` is unavailable.
- **Board ranking and a fast landing board.** Boards carry an `"order"` field; the switcher ranks curated
  boards by it and always sinks the auto `all-scenes` everything-board to the BOTTOM. A fresh open now
  lands on the FIRST curated board - a tight, fast board and a good first impression - instead of
  rendering every frame at once. Rank boards deliberately; the first is what people see first. `order`
  survives the shell's autosaves.

### Changed

- **Reference images show in FULL.** `Img` no longer cover-crops to a fixed height (that sliced the
  sides off every screenshot). Each image fills its column at its natural aspect ratio - never cropped,
  never letterboxed - so same-aspect screenshots line up on their own and the frame auto-heights to fit.
  Size an image by how many share its `Row` (fewer = bigger), not by a fixed height; `h` is accepted for
  back-compat but no longer constrains size. A clean inset hairline (grayscale, light + dark) sits on the
  image's own edge, overriding a screenshot's ragged or baked-in border instead of framing it twice.
- **Content frames fit their content when you resize.** A manual WIDTH resize now keeps the HEIGHT auto:
  the frame reflows and refits to show everything, instead of freezing at a stale height (only an explicit
  device viewport locks it). The content-frame height cap was raised so a long reference doc renders in
  full rather than clipping, and zoom now reaches 500% for inspecting screenshot detail.
- **Authoring doctrine updated to match.** The scaffolded instructions now teach sizing images by row
  grouping instead of cropping, and ranking boards with `order` (first = landing, `all-scenes` is heavy
  and auto-last).

### Fixed

- **No jiggle on zoom.** An image's display aspect-ratio is pinned on first decode, so an LOD resolution
  switch changes only the pixels, never the layout box - frames no longer drift as you zoom.
- **Fast zoom no longer stalls frames.** The LOD re-decode is debounced past the gesture and drops queued
  work when a new gesture starts, so oscillating zoom-in/out never stacks decode waves and times frames
  out to a ready-timeout.

## 0.5.0 - 2026-08-15

The performance & fidelity release (SPEC-M5): the canvas stops jiggling. Moving around a board no
longer swaps between two documents on every pan/zoom - each passive frame renders as a lean DOM
snapshot that IS what you see, and the real live app takes over the moment you interact with it.

### Added

- **Lean-primary rendering.** Every passive frame shows a **DOM snapshot** - a self-contained static
  copy of the frame (real DOM + real CSS, zero JavaScript) served in a `sandbox="allow-same-origin"`
  iframe. It reflows on resize with the browser's own layout engine and carries the app's exact colors
  (no rasterisation), so panning, zooming, and device-sweeping a board is smooth and pixel-honest. The
  full live app sits underneath and swaps in instantly when you focus a frame (double-click), or in
  laser/comment mode. This replaces the earlier screenshot facade, which invented colors and jittered.
- **Publish parity.** The lean tier now works in published builds (`marver build` → `marver serve`),
  not just dev - captured client-side from the bundled same-origin frames, no build-time renderer.
- **Faster first paint.** Leans capture bounded-parallel and viewport-first, so the frames you're
  looking at appear first and a big board settles in seconds instead of tens of seconds.
- **Content-frame color families.** Tag a diagram node with a built-in family - `HQ:::blue`,
  `Carriers:::orange`, `Drivers:::purple` (also `green red gray`) - and it gets a filled, on-brand
  color with a legible border in both themes, no `classDef` boilerplate. The same six names work in
  `Md` prose as `:blue[the shipper's world]`, so a sentence and the diagram beside it read as one
  color language.
- **`Head :: gloss` diagram labels.** A node label written `Head :: gloss` renders the head bold on
  top with the gloss lighter and smaller below - a box scans as label-then-detail, no run-on.
- **Authoring doctrine that ships with the tool.** The scaffolded instructions
  (`instructions/shape.md`, `instructions/reference/color.md`) now teach an agent these conventions -
  the `::` label hierarchy, the `:::family` / `:blue[…]` palette, and "pick one family per concept and
  hold it" - so diagrams and highlighted prose come out consistent by default instead of hand-rolled
  hex and one-off `classDef`s.

### Changed

- **Sidebar header** shows the humanized repo name (`marver-pilot` → "Marver Pilot", ellipsed if
  long); the logo links to marver.design.
- **Sidebar board/scene labels** are humanized - kebab filenames render Title Case (`tms-specs` →
  "Tms Specs"), dropping the dashes, while an explicit `meta.title` is honored verbatim.
- **App cursor** is the marver arrowhead - tilted, rounded, small, soft-shadowed, and theme-adaptive
  (black-on-light / white-on-dark); reverts to a normal pointer in interact/prototype and keeps the
  pin/crosshair in comment/laser mode.
- **Copy-file-path shortcut** moved to `Shift+P` (was a mislabeled `C`).

### Fixed

- The canvas "jiggle" - text shifting ~1-2px when you click or zoom a frame - is gone; there is no
  longer a per-gesture document swap to shift it.
- Mermaid diagrams no longer pop in/out or flash the wrong theme during zoom (async render is awaited;
  a diagram's baked colors re-capture on theme change; the cover's color-scheme is pinned to the
  frame theme, not the viewer's OS).
- A frame you've scrolled, typed into, or themed re-captures faithfully; agent edits (HMR) drop the
  stale snapshot and rebuild; slow data that lands shortly after load triggers one bounded re-capture
  (data that changes much later shows live the moment you focus the frame, and the lean rebuilds when
  you leave it).

### Known limitations

- Memory targets typical authoring boards (~15-20 frames); dozens of heavy production apps need the
  bounded-residency milestone. A frame the serializer can't render faithfully (canvas/video/open- or
  script-created-closed shadow-DOM/nested-iframe/cross-origin-CSS/blocked-CSP/oversized) degrades to
  live automatically. (One narrow edge: a declarative closed shadow root can't be detected and may
  render stale - rare in practice.)

## 0.4.0 - 2026-08-14

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
- **Gate v2: one credential per persona.** The gate on a collaboration canvas has
  three doors: guests pay the canvas password (read-only), members sign in with
  their OWN password (their session IS gate passage - they never touch the shared
  secret), and an invite link (`<url>/#/i/<token>`) opens straight into the claim -
  email shown as an INVITED chip, profile-picture picker (client-side 128px
  downscale), display name, password. Sign-in/claim endpoints sit in front of the
  gate (rate-limited, non-enumerating); rotating the canvas password only ever
  affects guests. Primary buttons stay disabled until their mandatory fields are
  filled, with a tooltip naming what's missing. The boards payload carries the
  owner's display name, so a read-only refusal says who to ask. Static canvases
  keep the single-field gate untouched.
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

### Durability & concurrency

- Comment appends and auth writes are `fsync`'d before they are acknowledged - a
  comment or account confirmed to the client survives a crash or volume interruption,
  not just the page cache.
- `auth.json`'s read-modify-write is guarded by a cross-process lock (stale-stolen
  after 10s, never deadlocks) so a deploy overlap or an accidental second instance
  cannot resurrect a revoked account or drop an invite. The comment log needs no lock:
  append-only + id-keyed union is conflict-free by construction (and git merges it
  with `merge=union`). Two honest v1 limits, documented not hidden: thread ordering
  uses client timestamps (a badly-skewed clock can mis-order a resolve/reopen race -
  re-resolve to fix), and comment logs have no hard size ceiling (fine at the design-
  review scale marver targets; a per-board cap is a later concern).

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
