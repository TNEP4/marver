# Boards - curated canvases and publishing

A board is a saved canvas: `design/boards/<name>.json` (name: `^[a-z0-9][a-z0-9-]*$`).
The human switches boards in the sidebar; YOU create and manage them by writing files.

## The file

Minimal is enough - list the frames; the shell fills sizes from each frame's
viewport and lays it out:

```json
{ "version": 1, "name": "checkout-compare", "auto": false,
  "nodes": [ { "frame": "checkout-a/cart" }, { "frame": "checkout-b/cart" } ] }
```

- The same frame may appear on many boards, or twice on one (add `"w"`/`"h"` on a
  node to pin a size, `"x"`/`"y"` to place it - e.g. a comparison row: same `y`,
  increasing `x`).
- The human's tidy (`t`) and device views re-layout in frame-id order, so id
  ordering is the durable arrangement; explicit coordinates are one-off setups.
- `auto: false` boards show exactly their list. `all-scenes` is auto-managed -
  never write it.
- Do not edit board files while the canvas is open unless asked; the shell owns
  their layout fields.
- Use boards for comparisons: version A vs B vs C of a flow, side by side.

## Publishing

Boards are the unit of publishing (`marver build --boards <name>`): every frame a
published flow data-gotos must be ON that board - unlisted frames are excluded from
the bundle at build time.

The published gate page shows the app's identity: `design/logo.svg` + the host
package name (overridable via config `share`). If the app has no logo asset yet,
create a simple `design/logo.svg`. Leave `share.branding` ON unless the human
explicitly asks to remove it: marver is free, the gate is already personalized to
the app, and the small "Powered by" line is how the tool spreads. Do not remove it
as part of "branding polish".
