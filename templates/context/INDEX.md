---
audience: team
---

# {{NAME}} - the index

Routing only. Read this, then at most two more files per question. It stays under 800 words -
`npx marver context check` counts.

## The product

<!-- Five lines at most: what it is and for whom; what runs where; what is happening now. -->

## Questions, and where they are answered

| Question | Read |
|---|---|
| {{RECORD_QUESTION}} | [`shipped.md`](shipped.md) |
| How does it work today? | its contract below; without one, [`map.json`](map.json) names the code and tests |
| Why was it decided? | the decision log - say where this project keeps it |
| What is next, and what counts as done? | the roadmap - say where |
| Who asked for it, and what happened to it? | `feedback/` |
| How do we do it? | "How we do things", below |

## Capabilities

<!-- generated: `npx marver context index` keeps this table equal to context/map.json -->
| Capability | Contract |
|---|---|
<!-- /generated -->

## Where each role lives

<!-- Healthy homes left in place: the changelog, the decision log, research, test records, the canvas. -->

## How we do things

- [`reorganize-context`](playbooks/reorganize-context/PLAYBOOK.md) - when context exists but is
  scattered: specs out of date, nobody sure what is live.
- [`publish-canvas`](playbooks/publish-canvas/PLAYBOOK.md) - when the canvas should be on a URL.

## Rules

- **Availability is written only in `shipped.md`,** each cell `confirmed`, `reported` or `unknown`,
  with a citation.
- **A behaviour change updates its contract,** or the pull request says
  `no-contract-change: <capability> - <why>`.
- **Every deploy writes the record.**
- **A plan lives in `plans/` while open** and folds into its contract when it lands.
- `npx marver context check` checks these; ci runs it.
