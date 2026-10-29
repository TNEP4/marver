/**
 * Nothing of notices before Turn On (spec 28 A4.6 #22): Electron's `Notification` constructor cannot be wrapped in
 * place, so the source holds it - notify-mac.ts is the one file in main that constructs a `Notification`, asks
 * `isSupported`, or sets the badge, and notify.ts calls its `create()` only once notices are on (notify.test.ts).
 * live.ts and notify.ts import no Electron at all. And the release bundle never carries the fake presenter's switch.
 * window.ts's windowInFront reads the screen's lock (#23): its rule and watchLock are tested in notify.test.ts, and
 * their wiring - the window's setup, which needs a real window - is held here.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TEST_SENTINELS } from '../../scripts/build.mjs'

const MAIN = resolve(import.meta.dirname, '..', '..', 'src', 'main')
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : [])

describe('the notices guard', () => {
  it('only notify-mac.ts constructs a Notification, asks isSupported or sets the badge', () => {
    const hits: string[] = []
    for (const f of files(MAIN)) {
      const text = readFileSync(f, 'utf8')
      for (const pat of [/new\s+Notification\b/, /isSupported\s*\(/, /setBadgeCount\s*\(/, /dock\.setBadge\s*\(/]) if (pat.test(text)) hits.push(`${relative(MAIN, f)} ${pat.source}`)
    }
    expect(hits.sort()).toEqual(['notify-mac.ts isSupported\\s*\\(', 'notify-mac.ts new\\s+Notification\\b', 'notify-mac.ts setBadgeCount\\s*\\('])
  })

  it('live.ts and notify.ts import no Electron', () => {
    for (const f of ['live.ts', 'notify.ts']) expect(readFileSync(join(MAIN, f), 'utf8'), f).not.toMatch(/from 'electron'/)
  })

  it('windowInFront reads inFrontOf with watchLock\'s lock, watched on powerMonitor with the window\'s front at the unlock', () => {
    const text = readFileSync(join(MAIN, 'window.ts'), 'utf8')
    expect(text).toMatch(/export const windowInFront = [^\n]*\n\s*&& inFrontOf\(\{[^}]*\blocked: locked\(\) \}\)/)
    expect(text).toMatch(/\n\s+locked = watchLock\(powerMonitor, front\)\n/)
  })

  it('MARVER_APP_REAL_NOTICES is a test sentinel: the release bundle must not hold it', () => {
    expect(TEST_SENTINELS).toContain('MARVER_APP_REAL_NOTICES')
  })
})
