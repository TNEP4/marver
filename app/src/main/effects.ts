/**
 * What the app does outside itself when a page asks (spec 28 A2.7, A2.11, A2.12): put a command on the clipboard,
 * open a folder in Finder. One place, so a test run never writes to the clipboard of whoever is at the Mac nor
 * opens a Finder window on their screen: in a dev build launched with `MARVER_APP_TEST=1` both are recorded instead
 * (the `effects` hook), unless `MARVER_APP_REAL_EFFECTS=1` asks for the real ones.
 *
 * Folders open with `shell.openPath()`: `showItemInFolder` selects a dot-folder inside `~`, where Finder hides it
 * (A2.14 #24). A file inside one - a flash's picture (A3.8 #13) - is selected with `showItemInFolder`: Finder opens
 * the folder holding it.
 */
import { clipboard, shell } from 'electron'
import { provide, testMode } from './testing/index.ts'

const recorded = { copies: [] as string[], opened: [] as string[], shown: [] as string[] }
const fake = (): boolean => __MV_TEST__ && testMode() && process.env.MARVER_APP_REAL_EFFECTS !== '1'

export const effects = {
  copy(text: string): void {
    if (__MV_TEST__ && fake()) { recorded.copies.push(text); return }
    clipboard.writeText(text)
  },
  openPath(dir: string): void {
    if (__MV_TEST__ && fake()) { recorded.opened.push(dir); return }
    void shell.openPath(dir)
  },
  /** A3: a file selected in Finder (a flash's picture) */
  showItem(file: string): void {
    if (__MV_TEST__ && fake()) { recorded.shown.push(file); return }
    shell.showItemInFolder(file)
  },
}

/** Test builds: the `effects` hook returns (and with `{ clear: true }` empties) what was recorded. */
export function provideEffectHooks(): void {
  if (!__MV_TEST__) return
  provide('effects', (a) => {
    const out = { copies: [...recorded.copies], opened: [...recorded.opened], shown: [...recorded.shown] }
    if ((a as { clear?: unknown } | null)?.clear === true) { recorded.copies.length = 0; recorded.opened.length = 0; recorded.shown.length = 0 }
    return out
  })
}
