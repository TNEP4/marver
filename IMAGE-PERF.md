# Image performance on image-heavy boards (TMS) — research + plan

Branch: `perf/image-lod-zoom` (off main). Goal: lag-free, snappy zoom on boards with 150+ high-res
screenshots. Research: web (tldraw/web.dev) + our code + a codex consult, 2026-08-17.

## The real problem (this reframes everything)

It is NOT the 1.5MB file size. It is **decoded memory**. A 2708x1610 PNG decodes to RGBA =
**~17.4 MB in memory**. 150 of them = **~2.6 GB of decoded bitmaps** before texture overhead. The
browser holds full-size decodes for every on-screen image and resamples them each zoom frame. That is
the jank and the memory pressure. The fix is to **never hold a full-size decode when the image is shown
small** - decode straight to display size.

## The quick win (do first): two-level client-side image LOD

Confirmed by both tldraw's approach and codex. Inside each frame's iframe:
- Decode each image to a **downscaled bitmap** via `createImageBitmap(blob, {resizeWidth, resizeQuality:'high'})`,
  drawn into a correctly-sized `<canvas>` (or a blob URL). Two buckets to start: **thumb ~1024px** and
  **original** (only when the settled on-screen size warrants it).
- On-screen size = `frameCssWidth * zoomScale * devicePixelRatio`. Pick the smallest bucket that covers it.
- **Keep the current bitmap during motion** (`#sh-world.sh-camera`); recompute + sharpen only **on settle**
  (the 160ms debounce). Quantize thresholds + hysteresis so adjacent zoom levels don't swap-thrash.

### Signalling (cheap): broadcast transitions, not frames
The shell messages each frame over the existing bridge ONLY on transitions:
`{type:'sh:camera', moving:true}` on gesture start, `{type:'sh:camera', moving:false, scale}` on settle.
NEVER per animation frame (150 postMessages/frame is its own jank). Frame recomputes buckets on `moving:false`.

### Hard gotchas (from codex — do not skip)
- **Decode concurrency**: cap at 2-4 simultaneous `createImageBitmap` jobs; never launch 150. Global queue.
- **Release memory**: `bitmap.close()` on replaced bitmaps; revoke old object URLs; do NOT keep a hidden
  full-size `<img>` or cached full bitmap (that defeats the whole saving).
- **Peak decode**: some engines briefly decode the full PNG before resizing - concurrency cap bounds the peak.
- **CORS**: `fetch -> blob -> createImageBitmap` + canvas export need same-origin/CORS-clean images. TMS
  assets are same-origin (served by marver), so fine; flag if any image is cross-origin.
- **Do NOT promote images** (`will-change`/`translateZ` on 150 imgs = 150 big layers = worse). Avoid.
- **`image-rendering`**: negligible - changes sampling quality, not source texture size. Skip.
- Compositor: real downscaling cuts decoded memory + texture upload + sampling + eviction (the win). It does
  NOT cut screen fill-rate; if raster persists during zoom after this, it's iframe-layer churn (separate).

## Sequence (effort -> impact)

| Step | Technique | Effort | Impact |
|---|---|---|---|
| 1 | Two-level client LOD (createImageBitmap resize, freeze-during-motion, sharpen-on-settle) | Low-med | **Very high** |
| 2 | `content-visibility:auto` + `contain-intrinsic-size` on shell frame wrappers | Very low | High (off-screen only; zero when all 150 visible) |
| 3 | Trace one bad zoom in Chrome perf (raster tasks, tile eviction, GPU mem, iframe layer count) | Low | Diagnostic - confirms what's left |
| 4 | 3-4 quantized LOD buckets + a small global decode queue | Medium | High |
| 5 | Server-generated thumbnails (durable, avoids client decode peaks) | Med-high | Highest/cleanest - the eventual proper solution |

Out of scope (bigger rebuild, note for later): explicit iframe virtualization; a Canvas/WebGL tile
renderer (highest ceiling, full rebuild).

## Reference
- tldraw LOD by on-screen size, debounced resolution swap: https://tldraw.dev/sdk-features/performance
- createImageBitmap resize: https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap
- content-visibility: https://web.dev/articles/content-visibility
- codex consult (2026-08-17): confirmed the memory reframe + the ranking above.
