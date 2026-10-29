/**
 * The presenter (spec 28 A4.6 #22, #24, #25): the one file in main that constructs Electron's `Notification`, asks
 * whether notices are supported, or sets the Dock badge - test/unit/notices-guard.test.ts holds it, since Electron's
 * constructor cannot be wrapped in place. Electron has macOS ask when it first makes its notification presenter, so
 * notify.ts calls `create()` only once the person turned notices on, and nothing here runs before that.
 *
 * A notice has no `icon` option: macOS shows Marver's own, and the canvas's name is its title (#24). The default
 * sound stays. Its events say what Electron knows: `show` that macOS accepted the request, `failed` that it refused
 * to schedule it - never that a banner was seen (#25).
 *
 * Test builds get the fake presenter (testing/notices.ts) unless `MARVER_APP_REAL_NOTICES=1`, as effects.ts does: a
 * real call from the ad-hoc `Electron.app` Playwright runs could make macOS ask on the owner's screen.
 */
import { app, Notification } from 'electron'
import type { Presenter } from './notify.ts'
import { fakePresenter } from './testing/notices.ts'
import { testMode } from './testing/index.ts'

/** Electron's own: the system's presenter, created once, each posted notice wired to notify.ts's handlers. */
export function macPresenter(): Presenter {
  let made = false
  return {
    create() {
      if (made) return
      made = true
      Notification.isSupported()
    },
    post(n, on) {
      const x = new Notification({ title: n.title, body: n.body })
      x.on('show', () => on.onShow())
      x.on('failed', () => on.onFailed())
      x.on('click', () => on.onClick())
      x.on('close', () => on.onClose())
      x.show()
      return x
    },
    badge(n) { app.setBadgeCount(Math.max(0, Math.floor(n))) },
  }
}

/** The presenter this build uses: the system's, or in a test run the fake that journals instead. */
export function presenter(): Presenter {
  if (__MV_TEST__ && testMode() && process.env.MARVER_APP_REAL_NOTICES !== '1') return fakePresenter()
  return macPresenter()
}
