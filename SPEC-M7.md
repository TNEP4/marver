# SPEC-M7 — Persisted lean artifacts: the DOM snapshot is a built file

Status: **v1 — PROPOSED.** Follows the M6 pool dogfood: compiling the DOM snapshot (the "lean") in the
browser, one frame at a time, at runtime, is slow (43 frames ≈ a minute, stalls) and ephemeral (an in-memory
`Map`, so a reload or board switch recompiles everything). M7 makes the lean a **durable, content-addressed
BUILD ARTIFACT** produced by a **server-owned headless browser**, served as a file, cached across reloads and
boards, rebuilt incrementally on file change, and shipped by publish. The browser becomes the artifact's
CONSUMER, not its factory. This supersedes M6 §4's in-browser/in-memory artifact and **removes the M6
background-compile lease** (compilation leaves the canvas + arbiter entirely). The pool (≤3 live apps) is
unchanged. Based on the codex artifact-architecture review (2026-08-16); speed decisions in §3.

## 0. Why (the failure this fixes)

| Symptom | Cause | M7 |
|---|---|---|
| `?pool` slow to load (43 frames) | 43 sequential in-browser `serializeDoc` compiles, each waiting fonts/paint/DOM-quiet | Prebuilt files: load = fetch static HTML in parallel |
| Breaks down / stalls mid-load | one-compiler-at-a-time in the UI thread | compile is off the UI thread, concurrent, incremental |
| Board switch reloads from scratch | artifact is in-memory only | artifact is a file on disk - board switch is instant |
| No caching of the loaded state | `byNode` Map, ephemeral | content-addressed immutable files, HTTP-cached |
| Publish boots every app on first view | no pre-baked artifacts | same compiler bakes them at build time |

## 1. Invariants (adds to M6)

- **A1 — The passive representation is a file.** A ready frame's lean is a durable artifact on disk, loaded by
  setting the lean iframe `src` to its URL. No runtime `serializeDoc` on the shell thread for a cached frame.
- **A2 — Fast cold, instant warm.** First build compiles off the UI thread (concurrent). A reload or board
  switch performs **zero** in-shell serialization and **zero** live boots for cached frames.
- **A3 — Never stale-as-fresh.** `desiredArtifactKey` vs `admittedArtifactKey`; a frame is `ready` only when
  they match. A stale artifact may cover only marked stale, and reconverges.
- **A4 — Clean-boot only, never session state.** Durable artifacts are deterministic clean-boot renders. The
  serializer bakes in live form/input/checkbox/select state ([serialize.ts](src/client/frame-host/serialize.ts));
  that value is a PRIVACY hazard on disk. In-browser serialization is kept ONLY for an ephemeral, memory-only
  session snapshot at interaction demotion - never written to disk, never published.

## 2. Artifact model

Reuse Marver's existing generated-state locations (no new `.marver/` root):
```
design/.local/artifacts/v1/     # dev cache, gitignored
  manifest.json                 # frameId -> { revision, variants{ key,href,status,bytes,profile } }
  objects/<key>.html            # immutable, content-addressed
  objects/<key>.json            # metadata (degraded[], profile, deps)
design/.dist/artifacts/v1/      # publish output (same shape)
```
- **Key** = `sha256(schemaVersion + frameRevision + globalEnvRevision + themeKey + viewportKey +
  serializerVersion + browserEngineVersion)`.
  - `frameRevision` = hash of the frame's **transitive source dependency set** (NOT `node.nav` - that's
    node-local and resets across sessions, so it can't validate a disk artifact).
  - `globalEnvRevision` = theme/config/compiler inputs not mappable to one frame (bumped on unmapped change).
  - `viewportKey` = `fluid` for proven CSS-responsive frames; an exact width for JS-responsive ones.
  - `themeKey` exact initially; proven theme-pure frames may later use `any`.
- **Immutable + atomic:** write a temp object, atomic-rename, then update the manifest LAST. Never overwrite a
  live object. GC unreferenced objects later.
- **Portable URLs (serializer change, load-bearing):** the serializer absolutizes url() and injects the
  frame's `doc.URL` as `<base>` - persisting that bakes `http://localhost:<port>` in. Before persist: rewrite
  same-origin absolute URLs to **root-relative**, store a portable root-relative `<base>`, treat `blob:` as
  non-persistable → incompatible.

## 3. The compiler — the FASTEST faithful path (§ goal: lean, fast, powerful)

A real browser is required for faithful fidelity (real CSS layout, computed styles, mermaid SVG); Node DOMs
(jsdom/happy-dom) can't render layout/mermaid. So: a **server-owned headless browser, optimized for speed**:

1. **Lean dependency: `playwright-core` driving the SYSTEM Chrome** (`channel: 'chrome'`) - NO 300MB bundled
   Chromium download in dev. Publish/CI uses a pinned Playwright Chromium (cached), whose identity enters
   `browserEngineVersion`.
2. **Persistent + warm:** one long-lived browser + context, launched **lazily on the first missing artifact**
   (cold cost once per dev session, not per frame). Vite's module cache is warm/shared across compile pages.
3. **Concurrent page pool** (the biggest lever): `min(cores-1, 6)` compile pages boot N frames in parallel →
   43 frames in ~43/N settle-times, not sequentially. A server-side compile-concurrency limit, **separate
   from the client live-lease arbiter** (the compiler is not a canvas live doc).
4. **Explicit settle signal (kills the real bottleneck):** the frame bridge posts `sh:snapshot-ready` when the
   app has mounted + fonts.ready + images decoded + mermaid/diagrams rendered - the compiler waits for THAT,
   not a 2.5s `domQuiet` guess. Bounded fallback to the existing heuristics if a frame never signals.
5. **Incremental:** only (re)compile a frame whose `frameRevision` changed (usually one on an edit). The
   serialize itself is ~5ms; cost is app-boot+settle, so incremental + concurrency dominate.
6. **Content-addressed cache:** a valid on-disk object for the key is reused instantly - no recompile.

Per job: navigate a clean context to the real same-origin frame-host URL (`?id&theme&width&r=rev`) → await
`sh:snapshot-ready` (bounded) → run the SAME `serializeDoc` in that document → portable-URL rewrite → write
atomically → emit `sh:artifact-ready {frameId,key,variant}` over the dev socket. Do NOT use `networkidle`
(sockets/polling break it). *(Future speed lever, noted not built: a Node fast-path — SSR/happy-dom — for
profiled static/markdown frames that need no browser; browser only for mermaid/JS-layout. Tiered compile.)*

## 4. Dev flow

Vite server owns an `ArtifactCompiler`:
1. Serve immediately; validate the manifest by rehashing each entry's recorded deps.
2. Launch Chrome lazily on the first miss/stale; keep it alive.
3. The shell sends visible/current-board frame IDs → the queue prioritizes them; background-fill the rest.
4. On file change: extend `affectedFrameIds` ([manifest.ts](src/server/manifest.ts)) - known-affected → stale +
   enqueue; imported shared source → reverse-walk Vite's module graph; unknown dep → bump `globalEnvRevision`
   (invalidate all); coalesce concurrent edits to the newest key. Persist each artifact's resolved dep
   list+hashes for restart-safe identity.

## 5. Serving & speed

- The lean iframe `src` = the artifact URL directly (NOT fetch→srcdoc): parallel browser fetch, HTTP/immutable
  caching, no giant HTML strings in the shell heap, a natural load event for admission, same
  `sandbox="allow-same-origin"`.
- Headers: `manifest.json` = `no-store` (dev) / ETag; objects = `Cache-Control: public, max-age=31536000,
  immutable`.
- Warm board = fetch manifest → attach visible/near-viewport artifact URLs in parallel → parse/style/fonts →
  admit. Not literally free (43 docs still parse), so: visible-first, prefetch the rest, don't instantiate
  offscreen iframes. If repeated inlined (Tailwind-sized) CSS dominates parse → externalize identical CSS into
  content-addressed stylesheet files (a second optimization).

## 6. Composition with the M6 pool

- A valid disk artifact → the frame initializes **directly `ready`** (loads the file); **no hidden compile
  iframe, no compile lease.** The M6 background-compile machinery is removed.
- A disk miss → `missing/waiting` (placeholder) while the server compiler works; `sh:artifact-ready` admits it.
- The arbiter now governs ONLY real live docs: interact (`active`), Play (stage), `incompatible` fallback,
  `handoff-out`. `compile` as a client lease kind is retired.
- Demotion of an interacted frame: serialize that ONE live frame to an in-memory session snapshot (A4) for the
  two-phase handoff; never persisted; discarded on source invalidation.
- Incompatible frames (canvas/video/shadow/oversized/blob) → still a counted live lease while visible.

## 7. Publish / CI (unified pipeline)

Same compiler + artifact format, against the BUILT site (dev-transformed URLs/DOM ≠ production bundle):
1. Vite production build → 2. temp static server over `design/.dist` → 3. compile every frame×variant
referenced by published boards → 4. write `design/.dist/artifacts/v1/*` → 5. per-frame failure = `incompatible`
/`liveFallback` (never fails the whole build) → 6. stop the temp server. A failure to LAUNCH the compiler
fails `marver build` unless `--allow-live-fallback`. Compile only variants actually referenced (avoid a blind
theme×device Cartesian product) - `fluid` for CSS-responsive, exact widths only for JS-responsive/presets.

## 8. Staleness & correctness

`desiredArtifactKey`/`admittedArtifactKey` (A3); invalidation flips desired, the old artifact stays only as a
marked `stale` cover with a subtle "Updating…" veil; admit the replacement only after its URL loads + the
`--mv-lean-ok` sentinel resolves + fonts/images settle + two paints; generation-check every callback. Dynamic
frames: TTL + idle rebuild, or an explicit deterministic capture hook, or `incompatible`/live-fallback. Mermaid
publish uses pinned Chromium + declared webfonts; a missing font → degraded, not a silent fallback-font SVG.

## 9. First implementation increment (prove the seam)

One vertical slice, no throwaway:
1. Real `revision` on `FrameEntry` (transitive-dep hash).
2. `design/.local/artifacts/v1` - immutable objects + atomic manifest + a dev serving route (`/__mv/artifacts/*`).
3. A single persistent headless compiler (`playwright-core` + system Chrome): TSX frames, one theme, `fluid`
   width, current board; concurrent pages; `sh:snapshot-ready` settle signal; portable-URL rewrite.
4. `affectedFrameIds` invalidation on direct frame edits (immediate stale + coalesced rebuild).
5. `FrameNode`/`snapshots.ts`: load the exact disk artifact via iframe `src` BEFORE any in-browser compile;
   keep the client serializer only as the miss-fallback + demotion/session path.
6. Prove on the 43-frame pilot board: cold build runs OFF the UI thread; a reload does **zero** in-shell
   `serializeDoc`; a board switch does **zero** live boots for cached frames; one frame edit rebuilds one
   artifact; a provider/layout edit rebuilds the expected fanout; a stale artifact never reports `ready`; live
   count never exceeds 3.

Then: make the headless compiler the sole baseline producer, add shared-dep/global invalidation, and run the
identical pipeline after `marver build`.

## 10. Open decisions for codex
- Q1: `playwright-core` + system Chrome (dev) vs bundling a pinned Chromium always - dependency weight vs
  determinism. Is driving the user's Chrome safe/robust enough for dev, or will version drift bite?
- Q2: the explicit `sh:snapshot-ready` contract - what exactly must a frame await (fonts, images, mermaid,
  route-settle) and the bounded fallback when it never fires? Does this belong in the shared bridge?
- Q3: concurrency ceiling + memory - N compile pages each boot a full app; what's the safe N on a laptop, and
  does the compiler need its own memory watermark?
- Q4: the Node fast-path (SSR/happy-dom for static frames) - worth it for speed, or does the classifier +
  two-path fidelity risk outweigh the browser-with-concurrency baseline?
- Q5: restart-safe `frameRevision` from Vite's module graph - is reverse-walking the graph reliable across dev
  restarts, or is a content-hash of the resolved file set safer?

*M7 = the M6 passive artifact becomes a durable, content-addressed, incrementally-built file produced by a
lean+fast+concurrent headless compiler (playwright-core + system Chrome + explicit settle signal). Browser =
consumer, server = factory. Unifies dev + publish. Removes the M6 in-browser background compile.*
