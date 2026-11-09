/**
 * What the app does outside itself when a page asks (spec 28 A2.7, A2.11, A2.12): put a command on the clipboard,
 * open a folder in Finder. One place, so a test run never writes to the clipboard of whoever is at the Mac nor
 * opens a Finder window on their screen: in a dev build launched with `MARVER_APP_TEST=1` both are recorded instead
 * (the `effects` hook), unless `MARVER_APP_REAL_EFFECTS=1` asks for the real ones.
 *
 * Folders open with `shell.openPath()`: `showItemInFolder` selects a dot-folder inside `~`, where Finder hides it
 * (A2.14 #24). A file inside one - a flash's picture (A3.8 #13) - is selected with `showItemInFolder`: Finder opens
 * the folder holding it.
 *
 * A4 (A4.6 #27): Settings' Open System Settings opens the Notifications pane through `shell.openExternal`, recorded
 * the same way (`external` in the hook's answer, once there is one).
 *
 * A5 (A5.1 #28): the performance report's save panel and its failure's alert. A test build never shows either: the
 * panel's default path is recorded (`saves`) and it answers what the case set with `effects:save` - a path in the
 * case's own temporary folder, or null (cancelled, also when nothing was set), so a test never writes to the real
 * `~/Downloads`; an alert's words are recorded (`alerts`).
 */
import { clipboard, dialog, shell, type BaseWindow } from 'electron'
import { provide, testMode } from './testing/index.ts'

/** what a test build recorded; `shown`, `external`, `saves` and `alerts` are in the hook's answer only once there is one, so A2's `{ copies, opened }` answers keep their shape */
const recorded = { copies: [] as string[], opened: [] as string[], shown: [] as string[], external: [] as string[], saves: [] as string[], alerts: [] as { message: string; detail: string }[] }
/** test builds: what the stubbed save panel answers (`effects:save`); null cancels */
let saveAnswer: string | null = null
/** macOS's Notifications pane in System Settings (A4.6 #27) */
export const NOTIFICATION_SETTINGS = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
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
  /** A4: Settings' Open System Settings, on the Notifications pane */
  openNotificationSettings(): void {
    if (__MV_TEST__ && fake()) { recorded.external.push(NOTIFICATION_SETTINGS); return }
    void shell.openExternal(NOTIFICATION_SETTINGS).catch(() => { /* macOS answers nothing to the app */ })
  },
  /**
   * A5: the report's save panel on `defaultPath` (a sheet on the window when it shows, else on its own); the path
   * chosen, or null. macOS's panel asks before replacing a file of that name.
   */
  async savePanel(defaultPath: string, parent: BaseWindow | null, kind: 'json' | 'pdf' = 'json'): Promise<string | null> {
    if (__MV_TEST__ && fake()) { recorded.saves.push(defaultPath); return saveAnswer }
    const filter = kind === 'pdf' ? { name: 'PDF', extensions: ['pdf'] } : { name: 'JSON', extensions: ['json'] }
    const o = { defaultPath, filters: [filter], properties: ['createDirectory' as const, 'showOverwriteConfirmation' as const] }
    const r = parent ? await dialog.showSaveDialog(parent, o) : await dialog.showSaveDialog(o)
    return r.canceled || !r.filePath ? null : r.filePath
  },
  /** A5: an alert (the report's failure): its words, and OK */
  alert(message: string, detail: string, parent: BaseWindow | null): void {
    if (__MV_TEST__ && fake()) { recorded.alerts.push({ message, detail }); return }
    const o = { type: 'warning' as const, message, detail, buttons: ['OK'] }
    void (parent ? dialog.showMessageBox(parent, o) : dialog.showMessageBox(o)).catch(() => { /* dismissed with the window */ })
  },
}

let effectHooks = false
/** Test builds: the `effects` hook returns (and with `{ clear: true }` empties) what was recorded. Once, whoever calls first (views.ts and config.ts both do). */
export function provideEffectHooks(): void {
  if (!__MV_TEST__ || effectHooks) return
  effectHooks = true
  provide('effects', (a) => {
    const out = {
      copies: [...recorded.copies], opened: [...recorded.opened], ...(recorded.shown.length ? { shown: [...recorded.shown] } : {}), ...(recorded.external.length ? { external: [...recorded.external] } : {}),
      ...(recorded.saves.length ? { saves: [...recorded.saves] } : {}), ...(recorded.alerts.length ? { alerts: recorded.alerts.map((x) => ({ ...x })) } : {}),
    }
    if ((a as { clear?: unknown } | null)?.clear === true) {
      recorded.copies.length = 0; recorded.opened.length = 0; recorded.shown.length = 0; recorded.external.length = 0; recorded.saves.length = 0; recorded.alerts.length = 0
    }
    return out
  })
  // A5: what the stubbed save panel answers next (a path in the case's own folder, or null to cancel)
  provide('effects:save', (a) => { const p = (a as { path?: unknown } | null)?.path; saveAnswer = typeof p === 'string' ? p : null; return true })
}
