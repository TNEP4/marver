/**
 * The presenter (src/main/notify-mac.ts; spec 28 A4.6 #22, #24, #25), in node with Electron mocked: `create()` asks
 * `isSupported` once; a post constructs one `Notification` with the title and body alone - no icon, the default
 * sound - wires show, failed, click and close to notify.ts's handlers, and shows it; the badge is `setBadgeCount`.
 * A unit run is no test build (`MARVER_APP_TEST` unset), so `presenter()` is the system's. And Settings' Open
 * System Settings (effects.ts) opens the Notifications pane.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const el = vi.hoisted(() => ({
  made: [] as { opts: Record<string, unknown>; on: Map<string, () => void>; shown: number }[],
  supported: 0,
  badges: [] as number[],
  external: [] as string[],
}))
vi.mock('electron', () => {
  class Notification {
    static isSupported() { el.supported += 1; return true }
    rec: { opts: Record<string, unknown>; on: Map<string, () => void>; shown: number }
    constructor(opts: Record<string, unknown>) { this.rec = { opts, on: new Map(), shown: 0 }; el.made.push(this.rec) }
    on(ev: string, fn: () => void) { this.rec.on.set(ev, fn); return this }
    show() { this.rec.shown += 1 }
  }
  return {
    Notification,
    app: { setBadgeCount: (n: number) => { el.badges.push(n); return true }, getName: () => 'Marver Dev', getVersion: () => '0.3.0', getPath: () => '/nowhere', commandLine: { hasSwitch: () => false }, isReady: () => true },
    shell: { openExternal: async (u: string) => { el.external.push(u) }, openPath: async () => '', showItemInFolder: () => {} },
    clipboard: { writeText: () => {} },
  }
})

beforeEach(() => { el.made.length = 0; el.supported = 0; el.badges.length = 0; el.external.length = 0 })

describe('the system presenter', () => {
  it('create asks isSupported once; nothing is constructed until a post', async () => {
    const { presenter } = await import('../../src/main/notify-mac.ts')
    const p = presenter()
    expect(el.made).toEqual([])
    p.create(); p.create()
    expect(el.supported).toBe(1)
    expect(el.made).toEqual([])
  })

  it('a post: the title and body alone, its four events wired, shown once', async () => {
    const { macPresenter } = await import('../../src/main/notify-mac.ts')
    const heard: string[] = []
    const x = macPresenter().post({ title: 'Pilot', body: 'Asks you: Which logo?' }, {
      onShow: () => heard.push('show'), onFailed: () => heard.push('failed'), onClick: () => heard.push('click'), onClose: () => heard.push('close'),
    })
    expect(el.made).toHaveLength(1)
    expect(el.made[0]!.opts).toEqual({ title: 'Pilot', body: 'Asks you: Which logo?' })   // no icon, no silent: Marver's icon, the default sound
    expect(el.made[0]!.shown).toBe(1)
    expect(x).toBeTruthy()
    for (const ev of ['show', 'failed', 'click', 'close']) el.made[0]!.on.get(ev)!()
    expect(heard).toEqual(['show', 'failed', 'click', 'close'])
  })

  it('the badge is setBadgeCount, a whole number never below 0', async () => {
    const { macPresenter } = await import('../../src/main/notify-mac.ts')
    const p = macPresenter()
    p.badge(3); p.badge(0); p.badge(-1)
    expect(el.badges).toEqual([3, 0, 0])
  })
})

describe('Open System Settings (A4.6 #27)', () => {
  it('opens the Notifications pane', async () => {
    const { effects, NOTIFICATION_SETTINGS } = await import('../../src/main/effects.ts')
    effects.openNotificationSettings()
    expect(NOTIFICATION_SETTINGS).toBe('x-apple.systempreferences:com.apple.Notifications-Settings.extension')
    expect(el.external).toEqual([NOTIFICATION_SETTINGS])
  })
})
