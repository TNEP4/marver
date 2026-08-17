# SPEC (intent): Prototype mode as a first-class review surface

High-level intent, aligned with Nic 2026-08-17. Not an implementation spec - the north star, the phased
scope, the agreed decisions, and the open questions. Phases 1-3 are this batch; Live Jam is the next spec.

## North star

Nic dogfoots marver primarily in **full-screen Prototype (Play) mode**. It should be a first-class
*point-and-shoot review surface* - the same power as the canvas (device switch, laser, comments) with
reliable chrome - so he can live in review and delegate. This culminates in **Live Jam**: an `@marver`
comment the coding agent acts on, so the user drives modifications from the canvas or the prototype
without touching the terminal.

## What's wrong today (grounding)

- The prototype menu is a **separate, fragile** custom toolbar (device buttons, no laser, no comment) with
  a 3-state chrome machine (`open`/`collapsed`/`hidden`) gated on `awake = !idle || over`. The `over` flag
  sticks true when the coach pill unmounts under the pointer (Play.tsx ~273) -> the "menu's gone/unreliable"
  bug. `hidden` is absolute (only H reveals) -> the "press H again" annoyance + the OK/don't-show pill.
- The **canvas toolbar is reliable** and the opposite design: explicit collapse (`pillOpen` + re-open FAB +
  Cmd/), no auto-fade, no hover magic. Controls: comment, laser, tidy, device dropdown, theme dropdown,
  zoom, play, collapse (App.tsx ~871-908).
- **Laser and comment can't work in prototype** - the Play "stage" is a different mount (stage/main.tsx)
  that imports the registry directly and does NOT run the frame-host bridge, so it never gets
  `sh:laser`/`sh:pick`.
- **Comments never lock the picked element.** In-frame highlight is hover-only (`[data-mv-hover]`, follows
  the mouse); click commits the anchor but pins no outline; opening a thread never re-highlights its element
  (the shell only asks for rects to place the pin). = bugs #4 and #5.

## Agreed decisions

- **Hide UI = one shared, binary feature (canvas + prototype).** A dedicated "Hide UI" button (custom icon)
  next to Collapse, and the **H** shortcut, toggle ALL chrome hidden <-> shown. **No auto-fade, no
  hover-reveal, no `over` tracking, no notification pill.** The Hide-UI button's TOOLTIP carries the
  instruction ("Hide all UI - press H to reveal"). **Hidden state resets on page refresh** (the safety net:
  a forgotten shortcut is recovered by reloading), so no re-open chip is needed. Collapse (pill -> FAB) stays
  as a separate, lesser control.
- **Share the toolbar components** (DeviceMenu, ThemeMenu, laser, comment) between canvas and prototype so
  they never drift. Prototype **excludes Tidy** (no canvas to tidy) and Play (already in it); the
  bottom-left navigator (restart / prev / i-of-N / next) stays prototype-only.
- **Comment #4/#5 fixes apply to canvas AND prototype** (they live in the shared bridge + comment layer).

## Phase 1 - Shared toolbar + clean Hide-UI (canvas + prototype)

- Refactor the canvas pill controls into shared pieces; render them in Play's top-right (device dropdown,
  theme, laser, comment; no tidy/play). Keep Play's bottom-left navigator.
- Replace Play's `open/collapsed/hidden` + auto-fade + `over` machine with the shared Hide-UI toggle. Add
  the "Hide UI" button (+ its tooltip) to the pill in both modes; wire **H** to it. Hidden = a body class,
  NOT persisted -> reset on reload. Remove the coach hint pill + its localStorage.

## Phase 2 - Laser + comment work in prototype

- Make the Play stage bridge-capable: laser (hover outline + crosshair), comment/pick (pick cursor,
  `sh:picked`, anchor resolution), and render the comment overlay (pins / threads / composer) over the
  stage. Comments anchor to the stage's current frame and follow the walk (prev/next).

## Phase 3 - Comment UX fixes (canvas + prototype)

- **#4 lock on pick:** on `sh:picked`, the bridge locks a persistent outline on the chosen element and
  suppresses the hover-follow while composing; the shell holds it until the draft is sent or cancelled,
  then releases (pointer active again). The picked element stays lit; the highlight stops chasing the mouse.
- **#5 highlight on open:** on `setActive(threadId)`, the shell tells the frame to re-highlight that
  thread's anchored element (the same locked outline); clear on close. Opening a thread shows its element.

## Phase 4 - Live Jam (NEXT spec, not this batch)

`@marver` in a comment -> a coding agent polling the published comment volume sees it -> acts -> replies on
the thread / asks back -> user notified, click to focus the comment. Point-and-shoot from canvas or
prototype; the agent behaves like a co-worker you tag. Hard problems to design then:
- **Viewport preservation:** when the agent edits, the user must not lose their place - stay in the same
  section, no viewport jump, seamless.
- **Thread re-anchoring:** after a change, element IDs shift; the agent pings the thread back on the new
  element id so follow-ups stay attached to the new version.
- **Infra:** publish the canvas + comment volume, kept in sync; the agent polls comments (by default or on
  request); the `@marver` mention is the gate (agent acts only on `@marver`); the notify -> focus loop.

## Open questions (resolve during Phase 2/3 detailed design)

- In prototype, the comment overlay is over ONE frame (the stage). Confirm pins/threads are per-frame and
  simply follow the walked frame (a thread on frame A is hidden while viewing frame B).
- Making the stage bridge-capable: inject the bridge's mode CSS/handlers into the stage mount, vs. reuse a
  real frame-host iframe for the stage. Pick the lighter path that keeps the single-frame swap behavior.
- Does Hide-UI in canvas also hide the left board sidebar, or just the floating chrome? (Assume: everything.)
