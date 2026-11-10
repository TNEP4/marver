/**
 * A4's frozen contracts (spec 28 A4.6 #56), without Electron: the names, bounds and wire every A4 stream builds
 * against, and their shapes held by the typecheck - each `@ts-expect-error` below must stay an error, so a contract
 * that loosens fails `tsc --noEmit`. The live proof's check is proof.test.ts's; the fake canvas's stream is
 * fake-canvas.test.ts's.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  BOUNDS, CANVAS_CHANNELS, CAPTURE_WHY, FEATURE, LIVE_BOUNDS, LIVE_KINDS, LIVE_TITLES_MAX, LIVE_WIRE, OPEN_RESULTS,
  type CaptureAnswer, type ImmersiveAnswer, type LiveEvent, type LiveItem, type LiveKind, type MarverAppV1, type OpenItem, type OpenResult,
} from '../../../src/shared/app-api.ts'
import { MOTION } from '../../../src/shared/immersive.ts'
import { MODES } from '../../../src/shared/perf-records.ts'
import {
  CH, INVOKES, RECEIVES, SENDERS, type AppPageKind, type HomeAction, type HomeActionAnswer, type LinkOpenAnswer, type MenuAsk, type PillView, type SettingsView, type SharedLink,
  type TabActivate, type TabKind, type TabMenuPick, type TabMenuView, type TabView, type WindowView,
} from '../../src/shared/channels.ts'
import { ICON_NAMES } from '../../src/pages/dom.ts'
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

describe('spec 32\'s amendments (F1-F3b), frozen at the contract commit (G3)', () => {
  it('the live event: two optional fields, the titles bounded by LIVE_TITLES_MAX beside the frozen LIVE_BOUNDS', () => {
    expect(LIVE_TITLES_MAX).toBe(32)
    expect('titles' in LIVE_BOUNDS).toBe(false)
    const old: LiveEvent = { v: 1, instance: 'i', seq: 1, jam: 'on', items: [], cut: 0, counts: { ask: 0, review: 0, failed: 0, stalled: 0 }, unseen: 0, working: true, session: false }
    const now: LiveEvent = { ...old, work: { board: 'home', since: 5 }, titles: { home: 'Home' } }
    // @ts-expect-error work always says since when
    const sinceless: LiveEvent = { ...old, work: { board: 'home' } }
    expect([now.work?.since, sinceless]).toHaveLength(2)
  })
  it('the strip\'s menu: its channels from the strip alone, its view to the strip; tab:menu and tabs:more narrowed to the strip', () => {
    expect([CH.tabMenuView, CH.tabMenuPick, CH.tabMenuShown]).toEqual(['tab-menu', 'tab:menu-pick', 'tab:menu-shown'])
    for (const ch of [CH.tabMenu, CH.tabsMore, CH.tabMenuPick, CH.tabMenuShown]) expect(SENDERS[ch], ch).toEqual(['strip'])
    expect(RECEIVES.strip).toContain(CH.tabMenuView)
    for (const k of ['home', 'settings', 'tabpage'] as const) expect(RECEIVES[k]).not.toContain(CH.tabMenuView)
    for (const ch of [CH.tabMenuPick, CH.tabMenuShown]) expect((INVOKES as readonly string[]).includes(ch), ch).toBe(false)
    expect(Object.keys(RECEIVES).sort()).toEqual(['home', 'settings', 'strip', 'tabpage'])
  })
  it('the menu\'s shapes: icons by name only, a pick by id never by label, the ask two booleans', () => {
    const v: TabMenuView = { rev: 1, x: 10, y: 44, kind: 'tab', rows: [{ kind: 'item', id: 'close', label: 'Close tab', icon: 'x', enabled: true }, { kind: 'sep' }] }
    const pick: TabMenuPick = { rev: 1, id: null }
    const ask: MenuAsk = { key: false, hadFocus: true }
    // @ts-expect-error an icon is a name dom.ts draws, never a path
    const path: TabMenuView = { ...v, rows: [{ kind: 'item', id: 'x', label: 'X', icon: 'M0 0', enabled: true }] }
    // @ts-expect-error a pick names a row, never a label
    const label: TabMenuPick = { rev: 1, id: 'close', label: 'Close tab' }
    expect([v.rows.length, pick.id, ask.key, path, label]).toHaveLength(5)
  })
  it('the icon names, as dom.ts draws them (E3 adds to these)', () => {
    expect(ICON_NAMES).toEqual(['house', 'warning', 'link', 'gear', 'copy', 'x', 'check'])
  })
  it('immersive play: the two canvas channels, the optional methods, the motion and the recorder\'s mode', () => {
    expect([CANVAS_CHANNELS.immersive, CANVAS_CHANNELS.immersiveState]).toEqual(['mv:immersive', 'mv:immersive-state'])
    const old: MarverAppV1 = { v: 1, topInset: 0, reopen: false, hello() {}, theme() {}, busy() {}, menu() {}, onAppState: () => () => {}, onMenuClick: () => () => {} }
    expect([old.immersive, old.onImmersive]).toEqual([undefined, undefined])
    const keys: (keyof Bridge)[] = ['immersiveState']
    const a: ImmersiveAnswer = { n: 1, on: false, end: true }
    // @ts-expect-error `end` is true or absent
    const notEnd: ImmersiveAnswer = { n: 1, on: false, end: false }
    expect([keys, a.end, notEnd]).toHaveLength(3)
    expect(MOTION).toEqual({
      out: { strip: 240, pills: 160, stage: 320, ease: 'cubic-bezier(.4, 0, .9, .6)', stageEase: 'cubic-bezier(.2, .8, .2, 1)' },
      back: { strip: 260, pills: 200, stage: 300, ease: 'cubic-bezier(.15, .7, .2, 1)', stageEase: 'cubic-bezier(.2, .8, .2, 1)' },
    })
    expect(MODES).toContain('immersive')
    const wv: WindowView = { rev: 1, focused: true, fullScreen: false, immersive: true }
    expect(wv.immersive).toBe(true)
  })
  it('Home\'s inputs: cancel and keys on tab:activate, the card actions, why missing; a hung tab', () => {
    const cancel: TabActivate = { id: 't1', via: 'key', cancel: true }
    // @ts-expect-error cancel is true or absent
    const notCancel: TabActivate = { id: 't1', cancel: false }
    // @ts-expect-error a key is Enter or Space
    const esc: TabActivate = { id: 't1', keys: 'Escape' }
    const acts: HomeAction[] = [{ action: 'copy-link', id: 's_0123456789abcdef' }, { action: 'copy-path', id: 'r_x' }, { action: 'reveal', id: 't1', via: 'key', keys: 'Space' }]
    const missing: HomeActionAnswer = { ok: false, why: 'missing' }
    const hung: TabView = { id: 't1', kind: 'local', name: 'A', state: 'hidden', verified: true, open: true, hung: true }
    const shared: SharedLink = { url: 'https://a.example/', host: 'a.example', lastSeen: 1, id: 's_0123456789abcdef' }
    expect([cancel.cancel, notCancel, esc, acts.length, missing.why, hung.hung, shared.id]).toHaveLength(7)
  })
})
