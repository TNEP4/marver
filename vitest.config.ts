import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Builds the CLI once, rather than letting two server suites race each
    // other's output. See test/global-setup.ts.
    globalSetup: ['./test/global-setup.ts'],
    // a dozen suites drive a real Chrome and a dev server each; at one worker per core they starve
    // one another (the folders suite fails its file-write races under that load, never alone)
    maxWorkers: 4,
    // agent worktrees live inside the repo (.claude/worktrees/): their copies of the suite are theirs
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
  },
})
