<!-- marver:managed fd51134280f47c579b6e7cae5403cb95a2f41383a578234e26363e2ea056d564 - edit freely: init preserves your edits and stages upstream updates at design/.local/latest/ for you to merge. Delete this line to detach this file from updates entirely. -->
# States - production resilience for every surface

A screen is not designed until its whole state space is. This file covers the states
themselves and the stress inputs that break them.

## The state inventory (per screen)

- **Loading**: skeletons in the content's own shape, not a spinner centered in a
  void. Name the real operation when the wait is meaningful; never invent progress.
- **Empty** - five distinct states, each with its own copy and next action:
  1. first use (emphasize value, offer a template or starting action)
  2. user cleared it (light touch - they did this on purpose)
  3. no results (suggest a different query, offer to clear filters)
  4. no permission (explain why, and how to get access)
  5. failed to load (what happened + retry)
  An empty state TEACHES the interface; "nothing here" teaches nothing.
- **Error**: field-level near the field, page-level with recovery. See
  reference/copy.md for the anatomy.
- **Success**: proportional to consequence - routine saves feel certain, milestones
  may celebrate.
- **Disabled**: visually distinct AND explains itself (tooltip or inline hint on
  why, when discoverable).
- **Partial/degraded**: some data loaded, some failed - never all-or-nothing when
  the content has independent parts.

## Stress inputs (run these against wireframes AND hi-fi)

- A 120-character name, an email at max length, a title with no spaces.
- Emoji in every text field; RTL text; CJK text (no word breaks).
- 0 items, 1 item, 1000 items.
- Numbers at boundaries: 0, negative, 999999999, 0.001.
- Rapid double-submit; back-button mid-flow; refresh mid-form.
- Offline and slow-3G: what does the user see in second 1, 3, 10?

In frames, these are FIXTURES: add a `stress` export to `_fixtures.ts` alongside the
happy-path data, and a sibling frame that renders it. A design that only ever met
its demo data is undesigned.

## First-run and onboarding moments

- Show, don't tell: the interface demonstrates itself through a guided first action,
  not a tour of tooltips over an empty screen.
- Time-to-value is the metric: the shortest path from arrival to the product's core
  worth, everything else deferred.
- Onboarding is optional when possible, skippable always, and never gates a
  returning user.
- Context over ceremony: teach a feature at the moment it becomes relevant, not in
  a welcome carousel.
