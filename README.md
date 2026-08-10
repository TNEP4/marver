# Marver

The agent-native design canvas. A `design/` folder in your repo, one command, and a canvas of live frames built from your app's real components and theme. Your coding agent designs by writing files; the tool ships no AI.

```bash
npx marver init   # scaffolds design/ (detects shadcn, Tailwind, your router)
npx marver dev    # canvas at localhost:5199
```

Then, to your agent:

> Read design/AGENTS.md. Build an onboarding scene - welcome, form, done - mobile-first, using our components.

- **Frames** are plain TSX/HTML files - zero imports from this package required.
- **Everything hot-reloads**; frames appear on the canvas the moment the file lands.
- Drag a frame's edge and the real breakpoints fire - each frame is a true iframe viewport.
- `data-goto="scene/frame"` on any element links frames into a walkable prototype.
- Uninstall: delete `design/`, remove the dependency. (If `init` patched your tsconfig `exclude`, revert that one line.)

The implementation contract is [SPEC.md](./SPEC.md). Deviations live in [DECISIONS.md](./DECISIONS.md).

Working name; private; TNEP4.
