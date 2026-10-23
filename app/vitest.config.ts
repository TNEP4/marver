import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * The app's suite (spec 28 A2.10, A2.14 #27), apart from the package's (whose config excludes app/**).
 * test/global-setup.ts builds the dev flavour once and takes a block of ports of the run's own; every case
 * launches on temporary MARVER_HOME, MARVER_APP_USER_DATA and MARVER_SLOT_BASE (test/harness/env.ts).
 *
 * - unit: no Electron (bundles, tokens, timings).
 * - fake: the fake canvas on its own.
 * - pw:   Playwright's Electron driver against the dev build - the wiring and the DOM.
 * - prod: the production-switch harness - the real Electron binary, no Playwright switches, the control socket.
 * One file at a time: windows take focus, and the hang monitor and budgets want a quiet machine.
 */
// each project names it, by absolute path: a relative one resolves against the pnpm workspace's root - the
// package's own test/global-setup.ts
const SETUP = [join(import.meta.dirname, 'test', 'global-setup.ts')]

export default defineConfig({
  test: {
    // one file at a time, across projects too: two apps at once would fight over focus and the machine
    fileParallelism: false,
    projects: [
      { extends: true, test: { name: 'unit', globalSetup: SETUP, include: ['test/unit/**/*.test.ts'] } },
      { extends: true, test: { name: 'fake', globalSetup: SETUP, include: ['test/fake/**/*.test.ts'] } },
      { extends: true, test: { name: 'pw', globalSetup: SETUP, include: ['test/pw/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 } },
      { extends: true, test: { name: 'prod', globalSetup: SETUP, include: ['test/prod/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 60_000 } },
    ],
  },
})
