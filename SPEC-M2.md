# M2 spec revisited - play, publish, share (2026-08-11)

> Supersedes SPEC.md §11 (stage) and extends §12 (build). Written after the M1 UX pass,
> before any M2 code. Same contract rules: where this and convenience disagree, this wins;
> where it is silent, choose boring and record in DECISIONS.md.

The headline finding of the review: **the design-phase primitives carry into prototyping
and sharing unchanged.** Frames are states, `data-goto` is edges, fixtures are the data
layer, boards are the curation unit. Play mode and publishing are new *consumers* of
these primitives, not new concepts agents must learn. AGENTS.md gets additions, not
rewrites (§6).

---

## 1. Play mode (the prototype surface)

The canvas's interact mode stays what it is: a design-time inspection tool that navigates
*between* frames on the board. Play mode is the demo-time surface: one device, one mount,
the app experience.

**Entry.** `▶` in the pill or `P` (the shortcut reserved for this since M1) on the current
board. If frames are selected, the first selected node is the start frame; otherwise the
board's first node.

**Surface.** Full-window, near-black backdrop (`#0a0a0b` both themes). One device shell
centered, sized to the chosen viewport's exact CSS pixels, scaled to fit the window
(capped at 100%) - or **fill** (frame-corners chip, digit after the last device): the
frame IS the window, no backdrop, no device shell. Esc exits back to the canvas, landing
on the frame you ended at.

**Chrome.** Two floating pieces, same glass. Top-right bar: board switcher dropdown
(switching stays in play, keeps the chosen device, restarts at the new board's start) ·
device chips + fill · theme · hide · close. Bottom-left navigator: restart (`R`) · prev
(`←`) · position `i/N` · next (`→`) - the manual back arrow is the escape hatch when a
flow dead-ends. Chrome collapses to a chip with `⌘/` (same shortcut collapses the design pill; ⌘\\ stays the sidebar's), auto-hides when idle, and hides outright with `H`; hovering the
top-right or bottom-left corner always reveals it (in fill the stage reports those
hovers, since the iframe covers the window). Coarse pointers never auto-hide.

**One mount - this is the whole trick.** Unlike the canvas (one iframe per frame), play
mode mounts ONE frame host: `providers → memoized layout chain → <Frame/>`. `data-goto`
swaps only the innermost frame component in place. Because the chain identity is stable
(memoize the layout component array by path list), an app shell living in `_layout.tsx`
- nav bar, tab bar, sidebar - **persists across navigation like a real app**. Frames in
different subdirectories legitimately remount their differing inner layouts; that is
correct, not a bug.

**Animations.** `document.startViewTransition` when feature-detected, else a 200 ms
crossfade. The agent-native payoff: agents opt into shared-element transitions by writing
plain `view-transition-name` CSS in their frames and layouts - hero images, cards, titles
morph between screens with **zero imports from the tool**. This is the "proper navigation
and animations" answer and it costs us one wrapper call.

**Reachability.** `data-goto` may target any manifest frame, same as on canvas. The board
defines the start frame and the ←/→ walk order (for presenting states that have no
in-frame link). History stack; browser-back also works via the URL scheme (§3).

**What play mode is not.** It never mounts the host app's router or executes app code
outside the frame contract. The one-way arrow (design → app) holds. A frame *is* a real
React component, so multi-step interactions inside one frame (typing, tabs, wizards with
internal state) already work - granularity is the designer's choice.

**Implementation note.** `frame-host/main.tsx` already resolves registry → providers →
layout chain → frame. Play mode is a second entry (`src/client/stage/`) consuming the
same registry with swap-in-place instead of one-shot mount. Estimated surface: one html
entry, ~200 loc component, route in `routes.ts`.

## 2. Data: fixtures ARE the placeholder system

Reviewed against "replace data loading with placeholders for a true-to-life experience":
**nothing new to build.** The existing convention already is the answer:

- States are sibling frames (`empty / filled / error / success`) fed by `_fixtures.ts`.
- Frames never touch network, stores, or auth - so a published canvas is inert by
  construction, which is what makes publishing safe (§4).
- Loading realism is a *documented pattern*, not an API: a fixture module may export
  `export const slowOrders = () => new Promise(r => setTimeout(() => r(orders), 800))`
  and the frame renders its skeleton while awaiting. Plain React, zero tool imports.
- The promotion recipe (fixture props → live data) is unchanged and is the exit path.

AGENTS.md gets three lines teaching the delayed-fixture pattern (§6). Resist the
temptation to ship a `useFixture()` helper; the moment frames need our imports, the
"markup in, pixels out" contract dies.

## 3. Deep links - one hash scheme for dev and published

Hash-based so any static host works with zero server routes, and so a URL copied from
dev works verbatim on the published site (origin changes, hash survives).

| URL | Opens |
|---|---|
| `#/` | default board, fit all (current boot behavior) |
| `#/b/<board>` | that board, fit all |
| `#/b/<board>?n=<key,key>` | board with those nodes selected, camera fit to selection |
| `#/f/<nodeKey>` | focus mode (unchanged from SPEC.md) |
| `#/p/<board>` | play mode at the board's start frame |
| `#/p/<board>?at=<frame-id>&device=<viewport>&theme=<theme>` | play at a specific screen, device, theme |

Rules:
- The URL is a **projection of state**: the shell writes it with `history.replaceState`
  as board/selection/mode change, and parses it once on boot to restore. No router
  library; ~60 loc.
- Selection links use node keys - already stable, already persisted in board JSON, so
  links survive reloads and publishes. (One more reason G-1's key discipline was right.)
- Play-mode navigation pushes (`pushState`) so browser back walks the flow history.
- Camera intent is expressed as *fit semantics* (fit-all / fit-selection / focus), never
  raw x/y/scale - fit is viewport-relative and shares cleanly across window sizes.

## 4. Publish - build, serve, gate

Three layers, each independently useful. SPEC.md §12 stands as written; additions marked.

**4a. `marver build`** (unchanged + one flag). Static build → `design/.dist/`, read-only,
manifest + boards inlined as `virtual:sh-data`, `--base`-aware. New: **`--boards a,b`**
publishes a subset. The filter is applied at *build time* - only the listed boards and the
frame modules they reference are bundled. This is the privacy boundary: runtime hiding is
not security when the frames sit in the JS bundle. Rule to teach: if your flow `data-goto`s
a frame, put that frame on the board you publish. `all-scenes` is included only when
explicitly listed.

**4b. `marver serve`** (new, ~150 loc, zero deps). A static file server for `.dist` with
an optional gate:

- No `MARVER_PASSWORD` env var → plain static serving.
- With it → every route returns the gate page until the visitor authenticates. POST
  compares the password, sets an HMAC-signed cookie (key derived from the password;
  30-day expiry), then serves. **The bundle is never sent pre-auth** - a client-side
  password over static files would be theater.
- The gate page: near-empty screen, one centered card in the shell's glass language,
  project/board name, password field, and a `Powered by Marver → marver.design` footer.
  `share: { branding: false }` in `design/config.ts` removes it - default on, removable,
  goodwill over lock-in.
- Config declares intent, env holds the secret: `share: { gate: true }` + the password
  set on the host. Nothing secret is ever committed.

**4c. Cookbooks** (docs, not code). One page each:
- **Railway** (the headline recipe): connect the GitHub repo, root = the app directory,
  build `npm ci && npx marver build`, start `npx marver serve --port $PORT`, set
  `MARVER_PASSWORD`. Done - the repo itself is the deployable, nothing to export.
- **Docker** - a 6-line Dockerfile for everyone else (Fly, Render, a VPS).
- **Cloudflare Pages + Access** - for teams that want email/domain allowlists *today*:
  Access provides Google auth and per-email policies with zero code from us.

**Deferred, explicitly** (new ideas land here, not in code):
- Per-board passwords and in-tool email/domain allowlists - real demand signal needed;
  Cloudflare Access covers it meanwhile.
- OAuth in the self-hosted tool - every user would have to register their own Google
  OAuth app; that is the opposite of simple. Only sensible on hosted infra.
- **Hosted publishing on marver.design** (`marver publish` → we host, we manage auth) -
  this is the eventual SaaS story and the strongest reason the branding footer exists.
  Roadmap, not now: self-host-first keeps the wedge ("it's just your repo") honest.

## 5. Milestones

- **M2a - play + links** (immediately valuable, pre-publish): stage entry + swap-in-place
  + view transitions · URL scheme in the dev shell · `P`/`▶` wiring · Esc round-trip.
- **M2b - publish**: `build` with `--boards` · `serve` with gate + branding card ·
  Railway cookbook. Gate (from SPEC.md, unchanged): walk the demo flow on a phone from a
  published URL behind the password.

## 6. AGENTS.md deltas (teach, don't build)

1. Flows: "Every screen a `data-goto` points at should itself link somewhere (or be a
   terminal state). Play mode makes dead ends visible."
2. Loading states: the delayed-fixture pattern (three lines, §2).
3. Transitions: "Give an element the same `view-transition-name` in two frames and play
   mode morphs it between screens."
4. Publishing: "Boards are the unit of sharing. A flow you want to publish must have all
   its frames on one board."
