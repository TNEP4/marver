# FRICTION: 0.2.3 cold-start dogfood (marver-site, 2026-08-13)

First true zero-state test: empty repo, one-sentence prompt ("install
@marver-design/marver, npx marver init, follow the instructions"). The agent
executed the whole pipeline flawlessly - and that was the problem.

## 1. The stack was never the human's decision 🔴

setup.md prescribed "the blessed stack" (Next.js + Tailwind + shadcn) and the
agent followed it to the letter: scaffolded a full Next 16 app without asking
what was being built or what stack the human wanted. Mechanically perfect,
humanly mute: no philosophy pitch, no "what are we building?", no tour at the
end - the human watched files appear and got a bare localhost at best.

**Resolution: SPEC-025** - setup.md rewritten as a conversational flow (pitch,
two hard STOPs, stack consent, first-draft quality bar, guided tour), new
instructions/welcome.md for both entry paths.

## 2. Write-once files survive the no-app -> app transition 🔴 (codex find)

The no-app init writes design/tsconfig.json (standalone - no paths) and
providers.tsx shaped by blind detection; both are write-once, so after
scaffolding they stayed wrong - the standalone tsconfig means every `@/` alias
import 500s in frames. The 0.2.3 run only avoided visible breakage because the
generic demo doesn't import `@/`.

**Resolution: SPEC-025 / init.ts** - on the setup->app transition init now
refreshes those files when byte-pristine (never touching edited ones).

## 3. Smaller notes

- Agent had to `npm init -y` before installing (empty repo has no
  package.json) - fine, it narrated it; setup.md's merge notes assume the
  package.json exists, which then holds.
- Next scaffold's globals.css had `--font-sans: var(--font-sans)` (circular,
  Geist never bound); agent caught and fixed it. Not marver's bug, but the
  setup flow's "verify the dev server renders" step exists to catch this class.
- shadcn init prompted despite --yes (predicted by the template; agent handled
  it with defaults).
- The generic demo (welcome/form/done) was called "underwhelming" by Nic - the
  first draft now replaces it with ~4 tailored, craft-bar frames (SPEC-025).
