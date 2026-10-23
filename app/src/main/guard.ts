/**
 * The debugging guard (spec 28 A2.1, A2.14 #30; spike X7, 22 Oct). The FIRST import of main.ts:
 * synchronous, before the single-instance lock and before anything else of the app runs.
 *
 * In the release flavour, a `remote-debugging-port` or `remote-debugging-pipe` switch on the command line
 * ends the process with exit code 3. Before ready that is immediate - nothing after it runs and no helper
 * starts (X7: 0 of 150 guarded runs connected, every argument form included: `--x=p`, `--x p`, `-x=p`,
 * after a positional, through `open --args`). Checked once `whenReady` has fired it leaks (X7's variant L):
 * the DevTools endpoint answers before the check. Keyed on a build-time constant, never `app.isPackaged`,
 * which a copy of the binary named `electron` reads as false.
 *
 * `--inspect` is closed by the `EnableNodeCliInspectArguments` fuse alone: the inspector listens before
 * this file runs. The packaged smoke (test/smoke/smoke.mjs) checks every case, and exit code 3 tells the
 * guard's refusal from a launch that met another instance's lock.
 */
import { app } from 'electron'

export const GUARD_EXIT = 3
export const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe'] as const

if (__MARVER_RELEASE__ && DEBUG_SWITCHES.some((s) => app.commandLine.hasSwitch(s))) app.exit(GUARD_EXIT)
