<!-- marver:managed 697d6ac000e88f2b13e0998a5c81f4fb10466f10406c30f4fca3bbf4c85d02f2 - edit freely: init preserves your edits and stages upstream updates at design/.local/latest/ for you to merge. Delete this line to detach this file from updates entirely. -->
# Operate - dense product UI depth

For app UIs, dashboards, settings, tables, tools - surfaces where the user is IN a
task. The bar is **earned familiarity**: a category-fluent user should trust the
interface immediately. Product UI's failure mode is not flatness - it is strangeness
without purpose: over-decorated buttons, invented affordances for standard tasks,
display fonts on labels. The tool should disappear into the task.

## What Operate surfaces are ALLOWED that brand surfaces are not

- System fonts and familiar sans defaults.
- Standard navigation: top bar + side nav, breadcrumbs, tabs, command palettes.
- Density - tables with many rows, panels with many labels, when users need it.
- Consistency over surprise: the same vocabulary screen to screen is a virtue;
  delight is saved for moments, not pages.

## The rules

- **Typography**: one family; fixed rem scale by default (fluid sizing needs a
  proven container reason); tighter ratio (1.125-1.2) - see reference/typography.md.
- **Color**: restrained is the floor. Accent spends only on primary actions, current
  selection, and state. A second neutral layer separates chrome (sidebars, toolbars)
  from content. Standardize the full state vocabulary: hover, focus, active,
  disabled, selected, loading, error, warning, success, info.
- **Components**: every interactive component ships the states that apply to it
  (see reference/states.md). Same button shape, same form-control vocabulary, same
  icon stroke everywhere - if "save" looks different in two places, one is wrong.
- **Overlays escape their container**: an absolute dropdown inside overflow-hidden
  gets clipped; reach for a portal, `position: fixed`, or the dialog/popover APIs.
- **Motion**: 150-250ms, state-conveying only, no page-load choreography.
- **Modals are usually laziness**: exhaust inline and progressive alternatives first.
  A modal earns its interruption or does not exist.

## Never

Decorative motion; display fonts in UI labels or data; reinvented standard
affordances (custom scrollbars, weird form controls, nonstandard modals) for flavor;
heavy saturation on inactive states; a different component vocabulary per screen.
