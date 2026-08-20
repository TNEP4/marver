# Layout - reading order, grouping, rhythm

Layout turns product priority into reading order. Diagnose the structural problem
before moving boxes.

## Diagnose first (against the rendered frame)

- **The squint test.** Blur your mental image of the frame: can you still identify
  the primary element, the secondary element, and the major groups in order? If not,
  the hierarchy fails regardless of how the details look.
- **Grouping.** Are related items CLOSE and distinct groups SEPARATED - or are
  containers and borders compensating for weak proximity? Proximity is the primary
  grouping tool; boxes are the fallback.
- **Rhythm.** Do tight and generous intervals alternate deliberately, or is one
  spacing value repeated until everything has equal weight? Monotone spacing is the
  most common layout defect in generated UI.
- **Structure.** Does the topology match the content, or is it a framework default?
  Repeated same-size cards imply the items are equivalent - are they?
- **Density.** Information per region should match use frequency and decision
  complexity, not a universal airiness.
- **Extremes.** Long content, empty states, overlays, sticky elements - do they
  break the structure?

## Set a spatial thesis before editing

Name in one or two sentences: the primary reading/task path; what belongs together
and what must separate; which element leads; the intended density. Then pick the
simplest structural model that expresses those relationships.

## Apply

- Group by meaning with proximity BEFORE adding containers or decoration.
- Create rhythm through deliberate contrast: tight inside groups, generous between
  them, more space above a heading than below it.
- Use a documented spacing scale; a 4px base gives useful middle steps an 8-only
  scale misses. One-off gap values are how rhythm dies.
- Hierarchy follows product priority, not framework defaults - the most important
  thing is the most visually weighted thing.
- `gap` on the parent beats per-child margins for sibling rhythm.
- Responsive behavior is STRUCTURAL: reorder, collapse, reveal based on what remains
  important at each width - not just shrinking everything. Feature amputation is not
  responsive design: every capability stays reachable at every supported width.
- Depth (shadow/elevation) only where it clarifies state or hierarchy.
- Repetition supports recognition; break it only when content or priority changes.
  Variation for its own sake reads as noise.

## Verify

Squint test passes; the task path is clear at every supported width; related content
groups without boxes; tight/generous rhythm is visible; long text and empty states
hold; DOM order agrees with visual order.
