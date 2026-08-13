# Changelog

Notable changes to `@marver-design/marver`. Format follows [Keep a Changelog](https://keepachangelog.com); versions follow semver.

## 0.3.0 - 2026-08-13

The co-thinking release: the canvas now holds the thinking, not just the screens.

### Added

- **Content frames (SPEC-026).** Specs, Mermaid diagrams, and mood boards as ordinary frames beside UI frames - import `Doc`, `Row`, `Col`, `Space`, `Md`, `Diagram`, `Img` from `@marver-design/marver/content`. Works in a repo with no app at all: idea first, design second.
  - `Doc` auto-sizes the frame to its content (measurement protocol; auto sizes are session-transient, manual resize and device views still win). Published canvases keep parity.
  - `Diagram` is first-class Mermaid, lazily loaded - a workspace with no diagrams ships zero mermaid bytes. Source theme overrides are stripped; parse errors show an in-frame card and heal live.
  - `Md` renders theme-aware markdown; `[label](goto:scene/frame)` links jump the canvas. Raw HTML is inert, images are local-only.
  - `Img` shows `design/assets/` imagery with captions; `h={n}` cover-crops a mixed-aspect row to one height so it reads aligned.
  - Zero-external-request boundary: URLs are rejected in diagram source, rendered SVG is sanitized, published builds copy only referenced local assets.
- **The marver diagram theme.** Full Apple system palette (12 series colors + systemGray ramp, exact HIG light/dark pairs), system font stack, accent-washed nodes by default - a plain flowchart is never gray-on-gray. Label typography rides inside the SVG (measured, not post-styled).
- **Frame intent.** Content frames declare `intent` (`diagram` | `spec` | `moodboard` | `notes`); the sidebar shows a glyph per row - every row leads with an icon, variant groups carry the flask.
- **Sidebar tells the canvas's story.** Rows and scene groups order by canvas position, not file order.
- **The onboarding fork (SPEC-025 amendment).** Both first-session paths - empty repo and existing app - now stop and ask what the highest priority is: think the idea through together on the canvas, or go straight to screens.
- **Shape & Iterate doctrine.** `instructions/shape.md` (feature-story boards: specs → lo-fi → hi-fi with graduated spacing) and `instructions/iterate.md` (fork-don't-overwrite, letter variants, the archive ritual).
- **Craft doctrine hardened.** Real assets are binding (Phosphor icons by default, actual brand logos, fetched imagery). Interactive means visibly interactive at every fidelity - cursor + hover on every clickable target, component-library gaps (shadcn on Tailwind v4 ships `cursor: default` buttons) fixed at the design-system base layer.

### Changed

- Markdown typography moved to the HIG scale: 16px body on 1.65, tightened heading tracking, contained Notion-style tables, re-asserted list markers (Tailwind preflight strips them in host apps).

## 0.2.4 - 2026-08-13

- Onboarding as a conversation (SPEC-025): setup flow asks what you're building, proposes a stack (a recommendation, not a requirement), hosted tour canvas as the waiting room, local canvas as the reveal. Two dogfood rounds folded in.

## 0.2.3 - 2026-08-12

- Hardening release: codex P1s (live-JOIN adjacency, same-directory group invariant, tsx-only inference) and a P2 sweep (extractor boundaries, sceneRows dedupe, play-mode chrome fixes, extreme-zoom badge fade).

## 0.2.2 - 2026-08-12

- Update discovery: glass pill + stdout notice + daily registry check (opt out with `MARVER_NO_UPDATE_CHECK=1`). `design/` collision guard on init.

## 0.2.1 - 2026-08-12

- The dogfood friction release: all 23 logged friction issues triaged; bugs fixed.

## 0.2.0 - 2026-08-11

- First public release on npm as `@marver-design/marver`, Apache-2.0. The agent-native design canvas: `design/` folder, live frames from your app's real components, boards, device sweeps, play mode, published canvases with a password gate.
