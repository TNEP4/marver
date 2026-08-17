# White-flash on heavy boards — full investigation archive

**Status: UNSOLVED. Branch archived, work paused 2026-08-17.** Pick this back up when there is time for a
real solution (see "Where to go next"). Everything we tried and learned is below so we never re-run a dead end.

**Branch:** `fix/backdrop-white-flash-zoom` (26 commits ahead of main). Pushed to origin + tagged
`archive/white-flash-2026-08-17`. Contains M6 pool + M7 artifacts (committed, working) + this flash
investigation (the flash fix FAILED; M6/M7 are good).

---

## The problem

On **heavy boards** (marver-site: 16 tall Next.js landing frames) the **whole viewport - canvas, frames,
AND the app chrome - flashes WHITE during zoom.** Light boards (tms-broker: markdown/mermaid/image) do NOT
flash. The flash is intermittent and depends on zoom speed/level. It is the headline blocker.

## Root cause (CONFIRMED on Nic's GPU)

**GPU compositor eviction, off the main thread.** We instrumented the real app with a `long-animation-frame`
attribution tool (`__mvDiag.flashReport()`, in `src/client/shell/diag.ts`). Verdict across two runs:
**~20/40 stalls are pure 🟥 GPU/compositor** (big *visual* stall via rAF gap, **main-thread = 0ms**),
including a **5,483ms (5.5s) freeze**. Script rows are noise (one-time module load, MessagePort, a 16ms
onwheel). Style+layout rows exist but the dominant, decisive signal is off-main-thread GPU.

Mechanism: too much **raster surface** (16 heavy landing pages: gradients, shadows, big images, internal
blurs) re-rasterizing at zoom scale exceeds this GPU's tile budget -> Chromium evicts the whole layer tree
(chrome included) to white while it rebuilds.

## What we TRIED, and why each failed (do not repeat)

1. **Backdrop-filter blur drop during camera** (`body.sh-cam` drops all blur). VERIFIED WORKING
   (`__mvDiag.layers()` / `stillBlurredDuringCam: []`) but the flash persists -> blur is NOT the cause.
2. **Fewer live iframes (M6 pool + M7 crisp artifacts).** Cut live apps to 1, frames became crisp files.
   Flash persists -> live-app count is not the driver; the passive lean iframes still rasterize.
3. **Standalone A/B harness** (`/tmp` / archived `harness/zoom-ab-tpl.html`, 16 real artifacts, iframe vs
   shadow, zoomable). **NEVER flashed, even with 16 iframes** — because its `#stage` had
   `will-change: transform` (accidentally promoted). This *looked* like proof that promotion fixes it...
4. **Promote `.sh-content`** (`__mvDiag.churn(true)` / `will-change: transform`). On the real app: the
   **whole-viewport white-out STOPS (chrome renders) but the nested `<iframe>`s go BLANK** — exactly the
   regression `styles.css` line ~152 already documented. So the code was stuck: un-promoted = white-out,
   promoted = blank frames.
5. **Shadow-DOM leans + promote** (SPEC-M8, the big attempt — see below). Moved the 16 lean iframes to
   Shadow DOM hosts (0 nested iframes), then promoted `.sh-content`. Fidelity/theme/interact/images all
   worked headlessly (0 lean iframes, layer promoted, 22/22 images, 144 tests green). **BUT on Nic's GPU it
   STILL flashed** — flashReport under `?pool&shadow` still ~20/40 🟥 GPU/compositor. **FAILED.**

## Why the shadow-DOM fix failed (the key learning)

A promoted layer caches for **panning**, but **Blink still re-rasterizes on zoom-IN** to keep content
crisp — promotion does not give a free zoom. And the total content of 16 heavy landing pages exceeds this
GPU's tile budget at high zoom **regardless of iframe vs Shadow DOM, promoted or not**. Removing the
iframes was necessary-but-not-sufficient. The raster surface itself is the wall.

## Where to go next (untried, the real solution class)

The flash is fundamentally "too much crisp raster surface at once during a transform." The known fixes are
about **reducing raster work during motion**, which we have NOT built:
- **Rasterize-to-bitmap during motion, crisp DOM at rest.** During an active gesture, show a cheap cached
  bitmap of each frame (a single texture, no re-raster); on settle, swap back to the crisp DOM. Zero jiggle
  because rest is always the crisp DOM. This is the standard canvas answer and the most promising. (Nic was
  wary of "images" — but this is motion-only, not at-rest LOD.) NOTE: this is essentially the same
  low-res-during-motion / sharpen-on-settle trick as the image-LOD work we are pivoting to; solving it for
  images first may hand us the pattern for frames.
- **Cap visible frame count / virtualize** — don't rasterize 16 heavy pages at once.
- **Per-frame `content-visibility`** — skip off-viewport rasterization (helps pan, not zoom-out-all).
- **Board-level workaround (Nic's plan):** one board = one big web app instead of many. Sidesteps it.

## The instrument to reuse (already in the branch, keep it)

`src/client/shell/diag.ts` — `__mvDiag.debug()` (HUD + rAF stall log), `__mvDiag.flashReport()` (LoAF
attribution: GPU/compositor vs style+layout vs script), `.churn(true/false)` (promote A/B), `.layers()`,
`.noBlur/.solid/.leanOnly/.disableFix`. This is how you MEASURE the flash on real hardware. Invaluable.

## What is GOOD and works on this branch (M6 + M7 — do not lose)

- **M7 persisted-artifact pipeline, end-to-end + live-verified**: server compiles each frame's crisp lean
  to a content-addressed FILE (playwright-core + system Chrome), served immutable, cached. Browser loads the
  FILE. Both themes precompiled -> instant theme flip. Auto-recompile on file edit -> ws push. ~16s cold /
  instant warm for 42 frames. Cold-load blank fixed (placeholder from first paint). No jiggle (crisp DOM).
- **M6 pool** (Live-Lease Arbiter cap-3, Passive-Artifact Lifecycle) — only active frames run live.
- **SPEC-M8 shadow-lean** (`src/client/shell/canvas/shadow-lean.ts`, `?shadow` flag) — renders a lean into
  Shadow DOM. Works, just doesn't fix the flash. Kept behind the flag.
- 144 tests green, typecheck clean.

All behind flags (`?pool`, `?shadow`) — default (no flags) = original canvas behavior.

## Pilots / repro
- **marver-site** (heavy Next.js, reproduces the flash): `cd ~/marver-site && node ~/marver/dist/cli.mjs dev --port 5362` -> `localhost:5362/?pool&shadow`
- **tms-broker** (images/markdown/diagrams, the image-slowness problem, NOT the flash) — the next branch's target.
- **marver-pilot** (42 frames, both themes).
