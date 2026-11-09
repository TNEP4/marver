/**
 * A4's frozen contracts (spec 28 A4.6 #56), without Electron: the names, bounds and wire every A4 stream builds
 * against, and their shapes held by the typecheck - each `@ts-expect-error` below must stay an error, so a contract
 * that loosens fails `tsc --noEmit`. The live proof's check is proof.test.ts's; the fake canvas's stream is
 * fake-canvas.test.ts's.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  BOUNDS, CANVAS_CHANNELS, CAPTURE_WHY, FEATURE, LIVE_BOUNDS, LIVE_KINDS, LIVE_WIRE, OPEN_RESULTS,
  type CaptureAnswer, type LiveEvent, type LiveItem, type LiveKind, type MarverAppV1, type OpenItem, type OpenResult,
} from '../../../src/shared/app-api.ts'
import { CH, INVOKES, RECEIVES, SENDERS, type AppPageKind, type LinkOpenAnswer, type PillView, type SettingsView, type TabKind, type TabView } from '../../src/shared/channels.ts'
import type { Bridge } from '../../src/main/bridge.ts'
import { overrideTimings, T } from '../../src/main/timings.ts'

describe('the features a slot file lists (A4.6 #2)', () => {
  it('eight names, each its own: bridge and inset, A4\'s live, open and capture, and spec 31\'s show, resolve-all and pdf', () => {
    expect(FEATURE).toEqual({ bridge: 'bridge', inset: 'inset', live: 'live', open: 'open', capture: 'capture', show: 'show', resolveAll: 'resolve-all', pdf: 'pdf' })
  })
})

describe('the live stream (A4.6 #8, #11, #14)', () => {
  it('four kinds on the wire, never stopped; the bounds and the wire as frozen', () => {
    expect(LIVE_KINDS).toEqual(['ask', 'review', 'failed', 'stalled'])
    expect({ ...LIVE_BOUNDS, id: String(LIVE_BOUNDS.id) }).toEqual({ items: 100, title: 140, note: 140, ref: 128, cards: 8, eventBytes: 65_536, id: '/^(ask|review|failed|stalled):[0-9a-f]{20}$/' })
    expect(LIVE_WIRE).toEqual({ path: '/__mv/app/live', type: 'text/event-stream', event: 'live', heartbeat: ': hb', heartbeatMs: 30_000, clients: 4, slowBytes: 65_536 })
    // main's idle cut-off sits past two missed heartbeats (A4.6 #16)
    expect(T.liveIdleMs).toBeGreaterThan(2 * LIVE_WIRE.heartbeatMs)
  })
  it('an id is the kind and 20 hex, nothing else - stopped is main\'s own, never on the wire', () => {
    for (const k of LIVE_KINDS) expect(LIVE_BOUNDS.id.test(`${k}:0123456789abcdef0123`)).toBe(true)
    for (const bad of ['stopped:0123456789abcdef0123', 'ask:0123456789abcdef012', 'ask:0123456789abcdef01234', 'ask:0123456789ABCDEF0123', ' ask:0123456789abcdef0123']) {
      expect(LIVE_BOUNDS.id.test(bad), bad).toBe(false)
    }
  })
  it('the event and its items, by shape', () => {
    const item: LiveItem = { id: 'stalled:0123456789abcdef0123', kind: 'stalled', board: 'home', title: 'Hero', at: 1, cards: ['c-1'], batch: 'b', gen: 2, occ: 1 }
    const ev: LiveEvent = { v: 1, instance: 'i', seq: 3, jam: 'on', items: [item], cut: 0, counts: { ask: 0, review: 0, failed: 0, stalled: 1 }, unseen: 0, working: false, session: false }
    // @ts-expect-error stopped is main's, never a LiveKind
    const stopped: LiveKind = 'stopped'
    // @ts-expect-error an event says how many the cap left out
    const uncut: LiveEvent = { v: 1, instance: 'i', seq: 3, jam: 'on', items: [], counts: { ask: 0, review: 0, failed: 0, stalled: 0 }, unseen: 0, working: false, session: false }
    // @ts-expect-error Jam is on or off, never unknown
    const maybe: LiveEvent = { ...ev, jam: 'unknown' }
    expect([ev.items[0].occ, stopped, uncut, maybe]).toHaveLength(4)
  })
})

describe('opening the exact item (A4.6 #29, #30, r1 #1)', () => {
  it('the channels, and the five answers', () => {
    expect([CANVAS_CHANNELS.open, CANVAS_CHANNELS.opened, CANVAS_CHANNELS.capture]).toEqual(['mv:open', 'mv:opened', 'mv:capture'])
    expect(OPEN_RESULTS).toEqual(['handled', 'stale', 'missing', 'busy', 'dropped'])
  })
  it('an OpenItem is the item without its words, its counter kept; the answers are the five', () => {
    const p: OpenItem = { id: 'review:0123456789abcdef0123', kind: 'review', board: 'home', cards: ['c-1'], batch: 'b', occ: 2 }
    // @ts-expect-error the click's copy carries no words: the shell reads afresh
    const worded: OpenItem = { ...p, title: 'Hero' }
    // @ts-expect-error `later` is not an answer
    const later: OpenResult = 'later'
    expect([p.occ, worded, later]).toHaveLength(3)
  })
  it('the bridge offers openItem and onCapture; the shell\'s two methods are optional', () => {
    const keys: (keyof Bridge)[] = ['openItem', 'onCapture']
    const old: MarverAppV1 = { v: 1, topInset: 0, reopen: false, hello() {}, theme() {}, busy() {}, menu() {}, onAppState: () => () => {}, onMenuClick: () => () => {} }
    expect([keys, old.onOpen, old.capture]).toEqual([['openItem', 'onCapture'], undefined, undefined])
  })
})

describe('live pictures (A4.6 #35)', () => {
  it('the bounds and the reasons', () => {
    expect([BOUNDS.captureLong, BOUNDS.captureMs]).toEqual([4096, 1500])
    expect(CAPTURE_WHY).toEqual(['hidden', 'busy', 'bounds', 'empty', 'timeout', 'stale', 'untrusted'])
  })
  it('the answer: bytes as a Uint8Array with their size, or a reason', () => {
    const yes: CaptureAnswer = { ok: true, png: new Uint8Array(8), width: 1, height: 1 }
    // @ts-expect-error an answer with no bytes
    const empty: CaptureAnswer = { ok: true, width: 1, height: 1 }
    // @ts-expect-error a reason outside the seven
    const odd: CaptureAnswer = { ok: false, why: 'denied' }
    expect([yes.ok, empty, odd]).toHaveLength(3)
  })
})

describe('the app\'s channels (A4.6 #19, #26, #27, #39, #40, #47)', () => {
  it('settings:action from Settings alone, a send; shared to Home', () => {
    expect([CH.settingsAction, CH.shared]).toEqual(['settings:action', 'shared'])
    expect(SENDERS[CH.settingsAction]).toEqual(['settings'])
    expect((INVOKES as readonly string[]).includes(CH.settingsAction)).toBe(false)
    expect(RECEIVES.home).toContain(CH.shared)
    expect(Object.keys(RECEIVES).sort()).toEqual(['home', 'settings', 'strip', 'tabpage'])
    expect(Object.values(SENDERS).some((kinds) => (kinds as readonly string[]).includes('remote'))).toBe(false)
  })
  it('the shapes: marks on a tab, a remote tab, the offer pill, Settings\' notices, no `later`', () => {
    const tab: TabView = { id: 't1', kind: 'local', name: 'TMS', state: 'live', verified: true, open: true, marks: { needs: 2, unseen: 0, working: false, session: true, stale: true } }
    const remote: TabKind = 'remote'
    const offer: PillView['kind'] = 'offer'
    const notices: SettingsView['notices'] = { outcome: 'failed' }
    // @ts-expect-error marks always say needs, unseen, working and session
    const half: TabView = { ...tab, marks: { needs: 1 } }
    // @ts-expect-error a shared link opens a tab: `later` is gone
    const later: LinkOpenAnswer = { ok: false, why: 'later' }
    // @ts-expect-error an outcome outside the three
    const shown: SettingsView['notices'] = { outcome: 'shown' }
    // @ts-expect-error a remote view is no app page
    const page: AppPageKind = 'remote'
    expect([tab.marks?.needs, remote, offer, notices.outcome, half, later, shown, page]).toHaveLength(8)
  })
})

describe('A4\'s timings (A4.6 #28, #44)', () => {
  const was = { ...T }
  afterEach(() => { Object.assign(T, was) })
  it('the names and their starting values', () => {
    expect({ liveBackoffMs: T.liveBackoffMs, liveBackoffMaxMs: T.liveBackoffMaxMs, liveIdleMs: T.liveIdleMs, noticeEveryMs: T.noticeEveryMs, badgeRetryMs: T.badgeRetryMs, openWaitMs: T.openWaitMs, onlinePollMs: T.onlinePollMs })
      .toEqual({ liveBackoffMs: [1000, 2000, 4000, 8000, 16_000], liveBackoffMaxMs: 30_000, liveIdleMs: 75_000, noticeEveryMs: 60_000, badgeRetryMs: 10_000, openWaitMs: 15_000, onlinePollMs: 1000 })
  })
  it('MARVER_APP_TIMINGS shortens them as it does the others, and refuses a wrong type', () => {
    overrideTimings(JSON.stringify({ liveBackoffMs: [10, 20], liveIdleMs: 300, openWaitMs: 200 }))
    expect([T.liveBackoffMs, T.liveIdleMs, T.openWaitMs]).toEqual([[10, 20], 300, 200])
    expect(() => overrideTimings(JSON.stringify({ liveBackoffMs: 10 }))).toThrow(/liveBackoffMs must be an array of numbers/)
    expect(() => overrideTimings(JSON.stringify({ noticeEveryMs: [1] }))).toThrow(/noticeEveryMs must be a number/)
  })
})
