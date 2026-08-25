import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Builds the CLI once, rather than letting two server suites race each
    // other's output. See test/global-setup.ts.
    globalSetup: ['./test/global-setup.ts'],
  },
})
