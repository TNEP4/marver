import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Builds the CLI once, rather than letting two server suites race each
    // other's output. See test/global-setup.ts.
    globalSetup: ['./test/global-setup.ts'],
    // ...and gives every test file the suite's own ~/.marver (MARVER_HOME) and slot ports
    // (MARVER_SLOT_BASE), checked before the file loads. See test/setup-home.ts.
    setupFiles: ['./test/setup-home.ts'],
    // a dozen suites drive a real Chrome and a dev server each; at one worker per core they starve
    // one another (the folders suite fails its file-write races under that load, never alone)
    maxWorkers: 4,
    // agent worktrees live inside the repo (.claude/worktrees/): their copies of the suite are theirs;
    // the Mac app (app/) has its own suite and config (app/vitest.config.ts)
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', 'app/**'],
  },
})
