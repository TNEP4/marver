# SPEC-M6 — validation spike results (2026-08-16)

Codex's spec review (SPEC-M6 §11) required a spike proving three things against the **heaviest real
frames** before committing the refactor. Ran the spike (`spike/pool-spike.js`, injected into a live shell
via `browse eval`) against **tms-broker** — the image-rich board Nic reported as laggy, and the heavier of
the two at **30 frames** (marver-site is 15). marver-site itself could not be spiked cleanly: its dev server
is in constant HMR-reload churn from content errors (`SpecDoc`, `drone-history.tsx`) that wipe page globals
mid-run — a content-side instability, not an architecture signal. Testing the heavier board is the stronger
bar anyway.

**Environment caveat:** headless Chromium composites in *software*, so the one thing the spike cannot measure
is GPU frame-time under camera motion — that still needs on-device (Nic's) measurement. Everything below is
DOM-layout fact (proofs 1–2) or real CPU/byte cost (proof 3, conservative-high vs a GPU machine).

---

## Verdict: thesis VALIDATED; the producer is the one work item

The bounded-runtime-pool thesis passed both invariant proofs cleanly. Proof 3 says proxy production is
*viable but must adopt the §4.1 discipline* — and the spike surfaced the single-capture-role requirement as
a hard, observed constraint, exactly where codex predicted ("if proxy generation does not pass, revisit the
passive-artifact producer — not the bounded-runtime thesis").

| Proof | Result | Verdict |
|---|---|---|
| 1 — hard-cut, no blank, no reflow | `noReflow: true` (live layout width 760 == world width 760), `coverHeldAtCut: true` | **PASS** |
| 2 — 3-slot pool under stress | 400 ops · `liveMax 3` · **`capViolations: 0`** · `staleRejected: 7` · **`blanks: 0`** | **PASS** |
| 3 — proxy cost / fidelity / memory | light frames ~85 ms / 780 KB; image-rich ~1–1.4 s / 1.6–1.9 MB; ~36 MB for 30 | **VIABLE with §4.1** |

---

## Proof 1 — overlay hard-cut (§5.1 geometry)

Built the real overlay portal, mounted one real frame at **world viewport (`node.w × node.h`) + a local
`scale()` camera transform** (not screen-sized), covered it with a proxy on the exact rect, ran the
ready-gated hard-cut.

- **`noReflow: true`** — the live iframe's layout viewport width (760) equals the world width (760). This is
  the load-bearing §5.1 correction: sizing the iframe to the *world* box (not the screen rect) keeps its
  internal layout identical to the proxy, so the cut can't shift text. Confirmed.
- **`coverHeldAtCut: true`** — the proxy is still painted the instant the live surface is revealed; the cut
  only drops the cover on the next frame. No blank gap (R1). Confirmed.

## Proof 2 — RuntimePool discipline (the core invariant)

Minimal pool (cap 3) with leases + epochs + the three health axes + degradation ladder, driven through **400
rapid focus/promote/demote ops** with **30% injected capture failures** and **injected stale (superseded-
lease) messages**.

- **`capViolations: 0`** — live runtime count never exceeded 3, at any point in the run (asserted after every
  op, not just at the end). R3 holds under stress.
- **`staleRejected: 7`** — every stale/superseded-lease message was rejected by the generation guard; none
  mutated a current lease. The lease/epoch model works.
- **`blanks: 0`** — the degradation ladder always produced a paint-ready visual (placeholder when a capture
  failed and no artifact existed). R1 holds even on failure.

This is the strongest result: the invariants codex worried couldn't co-exist (hard cap + never-blank +
stale-safe) **do** co-exist under adversarial load.

## Proof 3 — proxy production (the flagged risk)

30 frames captured one-at-a-time via the real `sh:snapshot-request` → html-to-image path. Two findings:

1. **Cost is bimodal and acceptable through ONE role.** Light frames: **~77–96 ms, 660–890 KB**. Image-rich
   frames (the `flow-*/overview` scenes): **~1.0–1.4 s, 1.6–1.9 MB**. Total ~36 MB of proxy bytes for 30 —
   within the 96–192 MB CPU-cache budget. Serial capture of the heavy ones is ~1 s each: fine as a background
   role at idle, **unacceptable if it ever blocks a gesture or is duplicated**.

2. **The one-at-a-time guard is real and observed.** Half the requests returned an *instant* (0 ms)
   `sh:snapshot-error` — the frame's `capturingRaster` guard rejecting a second request while the shell's own
   raster coordinator was still capturing that frame. That is a **collision between two capture coordinators**,
   not a 50% failure rate — and it is direct evidence for SPEC-M6 §4.1's "one background capture role."
   Whoever owns capture must be the *sole* requester, with an internal queue.

**Producer implications (all already in SPEC-M6 §4.1, now evidence-backed):**
- One capture role, internally queued — never two requesters (the collision).
- The 1.6–1.9 MB proxies are base64 data URLs (~33% bloat); **Blob/object URLs** cut that and avoid holding
  encoded + decoded + compositor copies at once.
- Capture **one source resolution and derive** smaller buckets via `createImageBitmap`/`OffscreenCanvas`;
  **tile** the ~1.9 MB heavy proxies rather than one monolith.
- html-to-image at ~1 s on image-rich frames argues for the **out-of-band Playwright pre-bake** (§4.1) for
  deterministic screens, keeping in-page capture for transient state only.

---

## What still needs Nic's GPU (not spike-able headless)

- **Camera frame-time under motion** on a real board with the pool live (the §11 `p95 < 20 ms` gate).
- **The actual white-flash / lag disappearance** on marver-site + tms-broker with the pool as the residency
  owner (the software compositor here doesn't reproduce the GPU starvation).
- Real memory plateau over a 1-hour session with promote/demote churn.

## Recommendation

**Ship the architecture** — proofs 1 and 2 validate the bounded-runtime thesis and the tricky invariants, and
proof 3 puts the remaining risk entirely on the *producer*, which SPEC-M6 §4.1 already specs correctly. The
build order stands (§9, artifact-first): the producer work (one queued capture role, Blob storage,
derive-not-recapture, Playwright pre-bake) is Stage 2 and lands atomically with the runtime cap (Stage "1").
No change to the spec is required; this spike promotes §4.1 from "specced" to "evidence-backed", and adds one
concrete acceptance number to §11: **background capture role must never exceed ~1 concurrent in-flight
capture, and must not run during `body.sh-cam`.**

*Harness: `spike/pool-spike.js` (gitignored; injected via `browse eval` from `/private/tmp`). Board:
tms-broker @ localhost:5363, 30 frames, dev build of `fix/backdrop-white-flash-zoom`.*
