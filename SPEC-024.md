# SPEC-024: Lane-flow board layout (two scopes)

Status: LOCKED 2026-08-12 (drive session). Ships in 0.2.3 with SPEC-023.

Agents (and people) compose a board by writing a **layout recipe** in the board JSON.
One grammar, applied at two scopes. Decision record: six approaches were surveyed
(fixed pixel blocks, bare spacer strings, area grid, nested stacks, constraint
relations, named columns); lane flow won on authoring simplicity + column alignment
without a grid engine. Precedent: flex-direction + kanban lanes.

## 1. Grammar

```
Flow  := { "rows":    [Lane | Space, ...] }
       | { "columns": [Lane | Space, ...] }
Lane  := [Atom | Space, ...]
Space := { "space": positive_integer }
```

Board field:

```json
"layout": {
  "columns": [
    ["hero", { "space": 2 }, "archive"],
    { "space": 4 },
    ["variants"]
  ],
  "scenes": {
    "hero": { "rows": [["overview", "detail", "proof", { "space": 3 }, "directions"]] }
  }
}
```

- The board scope is `layout` itself: exactly one of `rows` / `columns`; atoms are
  **scene names**.
- The scene scope is `layout.scenes.<scene>`: the same Flow shape; atoms are **frame
  basenames** within that scene; a **variant-group name** (the group directory's name)
  is one atom and expands to the indivisible, variant-sorted run.
- `rows`: lanes stack vertically, atoms flow left-to-right, atoms in a lane share a
  Y origin. `columns`: lanes sit left-to-right, atoms flow top-to-bottom, atoms in a
  lane share an X origin (this is the column alignment).
- `{"space": n}` between two atoms (or two lanes) replaces the ordinary boundary gap
  with n adaptive units for that scope + axis. Ordinary adjacency = 1 unit.

## 2. Units (adaptive, never pixels)

One unit is the proportional gutter already computed by tidy, measured from the
touching content:

| Boundary | Unit |
|---|---|
| frame-frame within a scene (X) | `max(140, w * 0.12)` |
| frame lanes within a scene (Y) | `max(96, h * 0.16)` |
| scene-scene across a lane (X) | `max(280, w * 0.2)` |
| scene lanes (Y) | `max(96, h * 0.16)` |

`w`/`h` = the larger of the two touching sides' **characteristic frame size** -
the largest single FRAME in the touching content, never the box extent. A
three-frame scene box 6000px wide must not create a 1200px gutter beside it;
gaps follow the visual rhythm of frames, not footprints. Blocks therefore scale
with content: ~384px next to a monitor frame, 280px next to phones.

## 3. Semantics of tidy (two-pass box layout)

1. **Scene pass**: for each scene, apply its Flow (or the default single row in node
   order when no recipe), producing relative frame positions and the scene's bounding
   box. Variant runs are indivisible and variant-sorted, as in SPEC-023.
2. **Board pass**: apply the board Flow to the scene boxes, then translate each
   scene's frames.
3. tidy stays **pure and positions-only** - the nodes array is never reordered
   (iframe law G-1); dragging afterwards is free.

## 4. Recipe re-application on resize

A board WITH a `layout` treats the recipe as the living arrangement:

- **Global device switch** (toolbar viewport change) and **frame resize gesture end**
  re-run tidy automatically - sizes changed, so gaps and lane tracks recompute and
  the composition holds instead of tearing.
- Plain drags never trigger re-tidy; manual positions survive until a size change or
  an explicit tidy.
- Boards without `layout` keep today's behavior (tidy is always explicit).

## 5. Edge cases (all warn via console + toast, never blank the board)

| Case | Rule |
|---|---|
| both `rows` and `columns` in one scope | invalid: warn, fall back to plain tidy |
| leading / trailing / consecutive / non-positive spacer | warn, treat as one ordinary gap |
| scene or frame listed twice | first occurrence wins |
| unlisted scenes | append as trailing lanes (below in rows mode, right in columns mode), alphabetical |
| unlisted frames in a recipe'd scene | append after the recipe atoms, node order |
| unknown name | warn and skip |
| duplicate node instances of one frame | the atom expands all instances in node order |
| frame vs group name collision inside a scene | warn; the frame wins the atom, the group's members append as an unlisted run |
| partial variant group on board | expand the members present, variant-sorted |
| `sceneRows` present | legacy shorthand for a plain `rows` layout; `layout` wins if both exist (warn) |

## 6. Teaching (the method)

- `design/instructions/boards.md`: grammar reference + a worked composed board
  (hero lane with parked archive, variants lane far right, within-scene big gap).
- `AGENTS.md` embedded summary: one bullet - compose boards with `layout`
  rows/columns lanes and `{"space": n}` tokens; details routed to boards.md.

## 7. Acceptance

- Unit: lanes X/Y origins shared, spacer multiplication, scene-scope flows, every
  edge-case row above, sceneRows legacy path, round-trip save.
- Drive: the repro canvas gets a composed board exercising columns + scene recipe;
  verified in-browser at multiple zooms; resize + device-switch re-apply verified.
- Codex build review before it reaches Nic's drive loop.
