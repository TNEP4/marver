/**
 * The frozen contracts' shapes (spec 28 A2.14 #32, v1.14 r3 #2, #3), held by the typecheck: each
 * `@ts-expect-error` below must stay an error, so a contract that loosens fails `tsc --noEmit`.
 */
import { describe, expect, it } from 'vitest'
import type { TabPageView } from '../../src/shared/channels.ts'
import type { GuardAction, GuardAllAction, GuardConsent } from '../../src/main/tabs.ts'

describe('the guard\'s action (v1.14 r3 #2)', () => {
  it('is a value, and a load carries its URL', () => {
    const actions: GuardAction[] = [
      { kind: 'close' }, { kind: 'quit' }, { kind: 'update' }, { kind: 'reload' }, { kind: 'forceReload' },
      { kind: 'tryAgain' }, { kind: 'load', url: 'http://127.0.0.1:4805/' },
    ]
    // @ts-expect-error a load without its URL
    const noUrl: GuardAction = { kind: 'load' }
    // @ts-expect-error the old string form
    const bare: GuardAction = 'close'
    // @ts-expect-error guardAll takes a quit or an update alone
    const notAll: GuardAllAction = { kind: 'close' }
    const consent: GuardConsent = { tab: 't1', commit: 3, doc: 'd', action: { kind: 'quit' } }
    expect(actions.map((a) => a.kind)).toEqual(['close', 'quit', 'update', 'reload', 'forceReload', 'tryAgain', 'load'])
    expect([noUrl, bare, notAll, consent.action.kind]).toHaveLength(4)
  })
})

describe('A3\'s guard action and tab page (A3.8 #39, #43)', () => {
  it('an unload names its reason; the operation carries done; reopening carries when and whether the camera comes back', () => {
    const u: GuardAction = { kind: 'unload', reason: 'critical' }
    // @ts-expect-error an unload without its reason
    const bare: GuardAction = { kind: 'unload' }
    // @ts-expect-error a reason outside the three
    const odd: GuardAction = { kind: 'unload', reason: 'idle' }
    // @ts-expect-error guardAll never takes an unload
    const all: GuardAllAction = { kind: 'unload', reason: 'warn' }
    const page: TabPageView = { rev: 1, name: 'Tidewell', since: 0, page: 'reopening', unloadedAt: 5, cameraKept: false }
    // @ts-expect-error reopening without cameraKept
    const half: TabPageView = { rev: 1, name: 'Tidewell', since: 0, page: 'reopening', unloadedAt: 5 }
    expect([u.kind, page.page]).toEqual(['unload', 'reopening'])
    expect([bare, odd, all, half]).toHaveLength(4)
  })
})

describe('the tab page\'s failure states (v1.14 r3 #3)', () => {
  it('carry retained and the probe on stopped, unverified and unreachable alike', () => {
    const base = { rev: 1, name: 'TMS broker', since: 0, retained: true, probe: { state: 'answers', lastAt: 5 } } as const
    const views: TabPageView[] = [
      { ...base, page: 'stopped', command: 'npx marver dev' },
      { ...base, page: 'unverified', origin: 'http://127.0.0.1:4805' },
      { ...base, page: 'unreachable', origin: 'http://127.0.0.1:4805' },
    ]
    // @ts-expect-error unverified without retained and probe
    const bare: TabPageView = { rev: 1, name: 'x', since: 0, page: 'unverified', origin: 'http://127.0.0.1:4805' }
    // @ts-expect-error a probe state outside the four
    const odd: TabPageView = { ...base, page: 'unreachable', origin: 'o', probe: { state: 'ok', lastAt: null } }
    expect(views.every((v) => 'retained' in v && 'probe' in v)).toBe(true)
    expect([bare, odd]).toHaveLength(2)
  })
})
