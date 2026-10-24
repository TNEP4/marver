/**
 * Spies on what app 0.1 must never touch unasked (spec 28 A2.10 first launch, A2.12, A2.14 #27): notices,
 * the badge, microphone access, screen capture. Installed by main.ts right after the guard, before any
 * other line of the app runs, in a dev build launched with `MARVER_APP_TEST=1` and `MARVER_APP_SPY=1`.
 * The `spies` hook returns the counts; `installed` names what could be wrapped (a property Electron made
 * read-only is reported missing, never silently skipped).
 */
import { app, desktopCapturer, Notification, systemPreferences } from 'electron'
import { provide, testMode } from './index.ts'

const counts: Record<string, number> = {}
const installed: string[] = []

function wrap<O extends object>(owner: O, key: string, label: string): void {
  const o = owner as Record<string, unknown>
  const fn = o[key]
  if (typeof fn !== 'function') return
  try {
    o[key] = function (this: unknown, ...args: unknown[]) {
      counts[label] = (counts[label] ?? 0) + 1
      return (fn as (...a: unknown[]) => unknown).apply(this, args)
    }
    if (o[key] !== fn) installed.push(label)
  } catch { /* read-only: reported by its absence from `installed` */ }
}

export function installSpies(): void {
  if (!(__MV_TEST__ && testMode() && process.env.MARVER_APP_SPY === '1')) return
  wrap(Notification, 'isSupported', 'Notification.isSupported')
  wrap(Notification.prototype, 'show', 'Notification.show')
  wrap(app, 'setBadgeCount', 'app.setBadgeCount')
  wrap(app.dock ?? {}, 'setBadge', 'app.dock.setBadge')
  wrap(systemPreferences, 'askForMediaAccess', 'systemPreferences.askForMediaAccess')
  wrap(desktopCapturer, 'getSources', 'desktopCapturer.getSources')
  app.on('web-contents-created', (_e, wc) => wrap(wc, 'capturePage', 'webContents.capturePage'))
  provide('spies', () => ({ counts: { ...counts }, installed: [...installed] }))
}
