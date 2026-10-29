/**
 * Marks, notices and the badge (src/main/notify.ts; spec 28 A4.6 #17-#27, r1 #6), pure, over the tab model with fake
 * ports: the baseline once per workspace per run; a reconnect posting nothing old and an item born in the gap
 * posting; a canvas in front posting nothing and the same canvas on another tab posting while Marver is focused;
 * one notice per snapshot with "and N more"; the minute; stops and their acknowledgement; the badge; outcomes and the
 * missed pill; the offer; cut snapshots and the id cap; nothing of the presenter before Turn On.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveEvent, LiveItem, OpenItem } from '../../../src/shared/app-api.ts'
import type { Held } from '../../src/main/live.ts'
import { bodyOf, createNotify, cut, HELD_MAX, type Notify, type NoticeEvents, type NoticesFile } from '../../src/main/notify.ts'
import { allTabs, closeTab, onRegistry, openSettingsTab, setMarksSource, viewOf, type Tab } from '../../src/main/tabs.ts'
import { T } from '../../src/main/timings.ts'
import { entry, liveTab, show, world, type World } from './window-fakes.ts'

let w: World
let n: Notify
let held: Map<string, Held>
let cfg: { notifications?: boolean; dockBadge?: boolean }
let front: boolean
let state: NoticesFile
let fx: { journal: ({ op: 'create' } | { op: 'post'; title: string; body: string; on: NoticeEvents } | { op: 'badge'; n: number })[]; offers: boolean[]; missed: string[]; opens: { tab: string; item: OpenItem | null }[]; refreshes: number; turnOn: boolean; writes: Partial<NoticesFile>[] }

function make(o: { seenMax?: number } = {}): Notify {
  n?.close()
  n = createNotify({
    now: () => w.clock.now,
    presenter: () => ({
      create: () => { fx.journal.push({ op: 'create' }) },
      post: (x, on) => { fx.journal.push({ op: 'post', ...x, on }); return {} },
      badge: (k) => { fx.journal.push({ op: 'badge', n: k }) },
    }),
    held: (i) => held.get(i),
    config: () => ({ ...cfg }),
    turnOn: async () => { if (fx.turnOn) cfg.notifications = true; return fx.turnOn },
    inFront: () => front,
    state: () => ({ ...state }),
    setState: (p) => { fx.writes.push(p); state = { ...state, ...p } },
    offer: (on) => { fx.offers.push(on) },
    missed: (name) => { fx.missed.push(name) },
    refresh: () => { fx.refreshes += 1 },
    open: (tab, item) => { fx.opens.push({ tab, item }) },
  }, o)
  setMarksSource((t) => n.marksOf(t))
  return n
}

beforeEach(() => {
  w = world()
  held = new Map()
  cfg = { notifications: true, dockBadge: true }
  front = false
  state = { v: 1 }
  fx = { journal: [], offers: [], missed: [], opens: [], refreshes: 0, turnOn: true, writes: [] }
  make()
})
afterEach(() => { n.close(); setMarksSource(null); vi.useRealTimers() })

let k = 0
const ask = (o: Partial<LiveItem> = {}): LiveItem => { k += 1; return { id: `ask:${k.toString(16).padStart(20, '0')}`, kind: 'ask', board: 'main', title: `Question ${k}`, at: 1000 + k, thread: `t${k}`, msg: `m${k}`, ...o } }
const of = (kind: LiveItem['kind'], o: Partial<LiveItem> = {}) => ask({ kind, id: `${kind}:${(++k).toString(16).padStart(20, '0')}`, ...o })
/** a snapshot applied for the tab's instance: items newest first, counts exact */
function snap(t: Tab, items: LiveItem[], o: Partial<LiveEvent> & { stale?: boolean } = {}): void {
  const counts = { ask: 0, review: 0, failed: 0, stalled: 0 }
  for (const i of items) counts[i.kind] += 1
  const { stale, ...rest } = o
  const event: LiveEvent = { v: 1, instance: t.reg!.instance, seq: 1, jam: 'on', items, cut: 0, counts, unseen: 0, working: false, session: false, ...rest }
  held.set(t.reg!.instance, { instance: t.reg!.instance, ws: t.reg!.ws, name: t.name, event, stale: !!stale })
  n.onLive(t.reg!.instance, 'applied')
}
const posts = () => fx.journal.filter((l): l is Extract<typeof l, { op: 'post' }> => l.op === 'post')
const badges = () => fx.journal.filter((l): l is { op: 'badge'; n: number } => l.op === 'badge').map((l) => l.n)
/** a canvas tab, not active (Home is), its window away */
function canvas(o: { features?: string[]; ws?: string } = {}): Tab {
  const t = liveTab(w, { entry: { features: o.features ?? ['bridge', 'inset', 'live', 'open'], ...(o.ws ? { ws: o.ws } : {}) } })
  show('home')
  return t
}

describe('new ids (A4.6 #17, r1 #6)', () => {
  it('the first snapshot of a workspace adds its ids silently; a reconnect posts nothing old; an item born in the gap posts', () => {
    const t = canvas()
    const a = ask()
    snap(t, [a])
    expect(posts()).toEqual([])
    snap(t, [a])   // a reconnect's first snapshot, the same ids
    expect(posts()).toEqual([])
    const b = ask({ title: 'Which blue?' })
    snap(t, [b, a])   // born while the stream was down: first seen now
    expect(posts().map((p) => [p.title, p.body])).toEqual([[t.name, 'Asks you: Which blue?']])
  })

  it('a new instance of the same workspace (a restart) keeps the set: nothing old posts', () => {
    const t = canvas()
    const a = ask()
    snap(t, [a])
    held.delete(t.reg!.instance)
    onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'closing' })
    onRegistry({ kind: 'entry', entry: entry({ ws: t.reg!.ws, slot: t.reg!.slot, port: t.reg!.port, features: ['bridge', 'live'], instance: 'restarted' }) })
    const t2 = allTabs().find((x) => x.reg?.instance === 'restarted')!
    snap(t2, [a])
    expect(posts()).toEqual([])
  })

  it('an id that flaps posts once; the set is a union', () => {
    const t = canvas()
    snap(t, [])
    const a = ask()
    snap(t, [a])
    snap(t, [])
    w.clock.now += T.noticeEveryMs
    snap(t, [a])
    expect(posts()).toHaveLength(1)
  })

  it('130 asks at launch post nothing; the newest 100 resolved bring the older 30 into view and post nothing; a new ask after posts', () => {
    const t = canvas()
    const all = Array.from({ length: 130 }, () => ask()).reverse()   // newest first
    snap(t, all.slice(0, 100), { cut: 30, counts: { ask: 130, review: 0, failed: 0, stalled: 0 } })
    expect(posts()).toEqual([])
    expect(n.marksOf(t)!.needs).toBe(130)   // exact past the cap (#19)
    snap(t, all.slice(100))   // the older 30, cut 0: a baseline too
    expect(posts()).toEqual([])
    snap(t, [ask({ title: 'One more' }), ...all.slice(100)])
    expect(posts().map((p) => p.body)).toEqual(['Asks you: One more'])
  })

  it('a cut snapshot\'s new id posts nothing, and neither does the first full one after it', () => {
    const t = canvas()
    snap(t, [ask()])
    snap(t, [ask(), ask()], { cut: 3 })
    snap(t, [ask()])
    expect(posts()).toEqual([])
    snap(t, [ask()])
    expect(posts()).toHaveLength(1)
  })

  it('the set\'s cap: the oldest id not in the latest snapshot goes, and posts again if it returns; one listed never goes', () => {
    make({ seenMax: 5 })
    const t = canvas()
    const keep = ask()
    const [a, b, c, d, e, f] = Array.from({ length: 6 }, () => ask())
    snap(t, [keep])
    for (const x of [a, b, c, d, e, f]) { w.clock.now += T.noticeEveryMs; snap(t, [x!, keep]) }
    expect(posts()).toHaveLength(6)
    expect(n.dump().seen[t.reg!.ws]).toBe(5)
    w.clock.now += T.noticeEveryMs
    snap(t, [keep])   // keep, listed in every snapshot, was never evicted: nothing posts
    expect(posts()).toHaveLength(6)
    w.clock.now += T.noticeEveryMs
    snap(t, [a!, keep])   // evicted (5 newer ids): it posts again - the one exception to "posts once"
    expect(posts()).toHaveLength(7)
  })
})

describe('when a notice posts (A4.6 #23, #24)', () => {
  it('a canvas in front posts nothing and its id joins the set; the same canvas on another tab posts while Marver is focused', () => {
    const t = canvas()
    snap(t, [])
    show(t.id); front = true
    const a = ask()
    snap(t, [a])
    expect(posts()).toEqual([])
    show('home')   // Marver still focused, another tab active
    snap(t, [a])
    expect(posts()).toEqual([])   // a's id was taken in front
    const b = ask()
    snap(t, [b, a])
    expect(posts()).toHaveLength(1)
  })

  it('the active tab with the window away (hidden, minimised, unfocused, the screen locked: inFront false) posts', () => {
    const t = canvas()
    snap(t, [])
    show(t.id); front = false
    snap(t, [ask()])
    expect(posts()).toHaveLength(1)
  })

  it('one notice per snapshot: the newest item\'s words and "and N more"; each kind\'s words; the canvas\'s name first', () => {
    const t = canvas()
    snap(t, [])
    snap(t, [of('review', { title: 'Hero banner' }), ask(), of('failed')])
    expect(posts().map((p) => [p.title, p.body])).toEqual([[t.name, 'Ready to review: Hero banner · and 2 more']])
    for (const [kind, words] of [['ask', 'Asks you: X'], ['failed', 'Failed: X'], ['stalled', 'Stalled: X - choose what to do']] as const) {
      w.clock.now += T.noticeEveryMs
      snap(t, [of(kind, { title: 'X' })])
      expect(posts().at(-1)!.body).toBe(words)
    }
    expect(bodyOf('Stopped', 0)).toBe('Stopped')
    expect(cut('a'.repeat(59) + '😀', 60)).toBe('a'.repeat(59))   // never inside a pair
  })

  it('the minute: a new id inside it is not posted and nothing is summed after; one after it posts', () => {
    const t = canvas()
    snap(t, [])
    snap(t, [ask()])
    w.clock.now += T.noticeEveryMs - 1
    snap(t, [ask()])
    expect(posts()).toHaveLength(1)
    w.clock.now += 1
    snap(t, [ask({ title: 'Later' })])
    expect(posts().map((p) => p.body)).toEqual(['Asks you: Question ' + (k - 2), 'Asks you: Later'])
  })

  it('notices off, or the tab closed: nothing posts and the ids join the set', async () => {
    const t = canvas()
    snap(t, [])
    cfg.notifications = undefined
    const a = ask()
    snap(t, [a])
    cfg.notifications = true
    snap(t, [a])
    expect(posts()).toEqual([])
    t.retained = false
    await closeTab(t.id)
    snap(t, [ask(), a])
    expect(posts()).toEqual([])
  })

  it('a click opens its tab with the item, its words left out; the notice is let go', () => {
    const t = canvas()
    snap(t, [])
    snap(t, [ask({ title: 'Secret words', board: 'b2', thread: 'th', msg: 'mm', cards: ['c1'] })])
    posts()[0]!.on.onClick()
    expect(fx.opens).toEqual([{ tab: t.id, item: { id: `ask:${k.toString(16).padStart(20, '0')}`, kind: 'ask', board: 'b2', thread: 'th', msg: 'mm', cards: ['c1'] } }])
    expect(n.dump().posted).toBe(0)
  })

  it('posted notices are held until clicked or closed, 50 at most', () => {
    const tabs = Array.from({ length: HELD_MAX + 3 }, () => canvas())
    for (const t of tabs) { snap(t, []); snap(t, [ask()]) }
    expect(posts()).toHaveLength(HELD_MAX + 3)
    expect(n.dump().posted).toBe(HELD_MAX)
    posts().at(-1)!.on.onClose()
    expect(n.dump().posted).toBe(HELD_MAX - 1)
  })
})

describe('marks (A4.6 #19)', () => {
  it('needs is every need, exact; unseen, working, session; stale; only local tabs; hidden ones keep theirs', () => {
    const t = canvas()
    snap(t, [ask(), of('review')], { counts: { ask: 3, review: 1, failed: 2, stalled: 1 }, unseen: 4, working: true, session: true, stale: true })
    expect(n.marksOf(t)).toEqual({ needs: 7, unseen: 4, working: true, session: true, stale: true })
    t.view = 'unloaded'
    expect(viewOf(t, false, '/Users/nic').marks).toMatchObject({ needs: 7 })
    expect(viewOf(allTabs().find((x) => x.kind === 'home')!, true, '/Users/nic').marks).toBeUndefined()
    expect(viewOf(openSettingsTab(false), false, '/Users/nic').marks).toBeUndefined()
    const quiet = canvas()
    expect(viewOf(quiet, false, '/Users/nic').marks).toBeUndefined()   // no snapshot, no stop: no marks
    expect(fx.refreshes).toBeGreaterThan(0)
  })
})

describe('stops (A4.6 #20)', () => {
  const gone = (t: Tab, why: 'pid' | 'closing' | 'removed' = 'pid') => {
    held.delete(t.reg!.instance)
    onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why })
    n.onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why })
  }

  it('a crash of an open canvas is stopped:<instance>: one "Stopped" notice, 1 in needs and the badge, until its tab is shown in front', () => {
    const t = canvas()
    const inst = t.reg!.instance
    gone(t)
    expect(posts().map((p) => p.body)).toEqual(['Stopped'])
    expect(n.dump().stops).toEqual([`stopped:${inst}`])
    expect(n.marksOf(t)).toMatchObject({ needs: 1 })
    expect(n.total()).toBe(1)
    show(t.id)      // shown, the window away: still counted
    n.onCompose()
    expect(n.total()).toBe(1)
    front = true
    n.onFront()
    expect(n.total()).toBe(0)
    expect(n.marksOf(t)).toBeUndefined()
  })

  it('a Ctrl-C (closing) or a removed file makes nothing; nor a crash of a closed tab', async () => {
    const a = canvas(); gone(a, 'closing')
    const b = canvas(); gone(b, 'removed')
    const c = canvas()
    c.retained = false
    await closeTab(c.id)
    gone(c)
    expect(n.dump().stops).toEqual([])
    expect(posts()).toEqual([])
  })

  it('acknowledged when its tab closes, when a new instance of its workspace is ready, or when its notice is clicked', async () => {
    const a = canvas(); gone(a)
    a.retained = false
    await closeTab(a.id)
    n.onCompose()
    const b = canvas(); gone(b)
    n.onRegistry({ kind: 'entry', entry: entry({ ws: b.reg!.ws, instance: 'back', features: ['bridge', 'live'] }) })
    const c = canvas()
    w.clock.now += T.noticeEveryMs
    gone(c)
    expect(n.dump().stops).toEqual([`stopped:${c.reg!.instance}`])
    posts().at(-1)!.on.onClick()
    expect(n.dump().stops).toEqual([])
    expect(fx.opens.at(-1)).toEqual({ tab: c.id, item: null })
  })

  it('a crash seen in front is acknowledged as it happens', () => {
    const t = canvas()
    show(t.id); front = true
    gone(t)
    expect(n.dump().stops).toEqual([])
    expect(posts()).toEqual([])
  })
})

describe('the badge (A4.6 #21, #22)', () => {
  it('the sum of every open canvas\'s needs, at each change', () => {
    const a = canvas(); const b = canvas()
    snap(a, [ask(), ask()])
    snap(b, [of('failed')])
    expect(badges().at(-1)).toBe(3)
    snap(b, [])
    expect(badges().at(-1)).toBe(2)
    const len = badges().length
    snap(a, [ask(), ask()])   // the same number: not set again
    expect(badges()).toHaveLength(len)
  })

  it('never called while notices are off and have not been on; Turn On: create once, the badge, again after badgeRetryMs and at each focus', () => {
    vi.useFakeTimers()
    cfg = { dockBadge: true }
    make()
    const a = canvas(); const b = canvas()
    snap(a, [ask()]); snap(b, [ask(), ask()])
    n.onFront()
    expect(fx.journal).toEqual([])
    cfg.notifications = true
    n.onConfig()
    expect(fx.journal.map((l) => l.op)).toEqual(['create', 'badge'])
    expect(badges()).toEqual([3])
    vi.advanceTimersByTime(T.badgeRetryMs)
    expect(badges()).toEqual([3, 3])
    n.onFront()
    expect(badges()).toEqual([3, 3, 3])
    n.onConfig()   // nothing changed: no second create
    expect(fx.journal.filter((l) => l.op === 'create')).toHaveLength(1)
  })

  it('either key off: badge(0) once if a number was showing; dockBadge back on applies it again', () => {
    const a = canvas()
    snap(a, [ask()])
    expect(badges()).toEqual([1])
    cfg.dockBadge = false
    n.onConfig()
    expect(badges()).toEqual([1, 0])
    snap(a, [ask(), ask()])
    n.onFront()
    expect(badges()).toEqual([1, 0])
    cfg.dockBadge = true
    n.onConfig()
    expect(badges()).toEqual([1, 0, 2])
    cfg.notifications = false
    n.onConfig()
    expect(badges()).toEqual([1, 0, 2, 0])
    cfg.notifications = undefined
    n.onConfig()
    expect(badges()).toEqual([1, 0, 2, 0])
  })

  it('found on at launch: the badge from the first snapshot, the presenter made at the first post', () => {
    const a = canvas()
    n.onFront()
    expect(fx.journal).toEqual([])
    snap(a, [])
    expect(fx.journal).toEqual([{ op: 'badge', n: 0 }])
    snap(a, [ask()])
    expect(fx.journal.map((l) => l.op)).toEqual(['badge', 'create', 'post', 'badge'])
  })

  it('found on at launch: a stop before any snapshot - a canvas without live, or one killed before its first - is in the badge', () => {
    const t = canvas({ features: ['bridge', 'inset'] })
    n.onCompose()
    expect(fx.journal).toEqual([])
    held.delete(t.reg!.instance)
    onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })
    n.onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })
    expect(n.total()).toBe(1)
    expect(fx.journal.map((l) => l.op === 'post' ? `post:${l.body}` : l.op === 'badge' ? `badge:${l.n}` : l.op)).toEqual(['create', 'post:Stopped', 'badge:1'])
    front = true
    show(t.id)
    n.onFront()
    expect(badges().at(-1)).toBe(0)   // acknowledged in front: the badge follows
  })

  it('a closed tab\'s needs are not in the badge', async () => {
    const a = canvas(); const b = canvas()
    snap(a, [ask()]); snap(b, [ask(), ask()])
    b.retained = false
    await closeTab(b.id)
    n.onCompose()
    expect(badges().at(-1)).toBe(1)
  })
})

describe('outcomes (A4.6 #25)', () => {
  it('show is accepted, failed is failed and raises the missed pill; written only on a change', () => {
    const t = canvas()
    snap(t, [])
    snap(t, [ask()])
    posts()[0]!.on.onShow()
    posts()[0]!.on.onShow()
    expect(fx.writes).toEqual([{ lastOutcome: 'accepted' }])
    w.clock.now += T.noticeEveryMs
    snap(t, [ask()])
    posts()[1]!.on.onFailed()
    expect(state.lastOutcome).toBe('failed')
    expect(fx.missed).toEqual([t.name])
  })
})

describe('the offer (A4.6 #26)', () => {
  beforeEach(() => { cfg = { dockBadge: true }; make() })

  it('raised at the first foreground observation of a need - at focus for a mark received in the background - once; offeredAt written once', () => {
    const t = canvas()
    snap(t, [ask()])
    expect(fx.offers).toEqual([])   // received in the background
    front = true
    n.onFront()
    expect(fx.offers).toEqual([true])
    expect(state.offeredAt).toBe(w.clock.now)
    snap(t, [ask()])
    n.onFront()
    expect(fx.offers).toEqual([true])
    expect(fx.writes.filter((x) => 'offeredAt' in x)).toHaveLength(1)
  })

  it('a snapshot while in front raises it; none without a need, with notifications set false, or once dismissed', () => {
    front = true
    const t = canvas()
    snap(t, [])
    expect(fx.offers).toEqual([])
    cfg.notifications = false
    snap(t, [ask()])
    expect(fx.offers).toEqual([])
    cfg.notifications = undefined
    state.dismissedAt = 1
    snap(t, [ask()])
    expect(fx.offers).toEqual([])
    state.dismissedAt = undefined
    snap(t, [ask()])
    expect(fx.offers).toEqual([true])
  })

  it('Turn On: notifications true as Settings writes it, the offer down; a refused write leaves it up', async () => {
    front = true
    const t = canvas()
    snap(t, [ask()])
    fx.turnOn = false
    expect(await n.offerTurnOn()).toBe(false)
    expect(fx.offers).toEqual([true])
    fx.turnOn = true
    expect(await n.offerTurnOn()).toBe(true)
    expect(fx.offers).toEqual([true, false])
    n.onConfig()   // config.ts's change: create, then the badge
    expect(fx.journal.map((l) => l.op)).toEqual(['create', 'badge'])
  })

  it('Not now writes dismissedAt and it never returns; Settings choosing first takes it down', () => {
    front = true
    const t = canvas()
    snap(t, [ask()])
    n.offerDismissed()
    expect(state.dismissedAt).toBe(w.clock.now)
    snap(t, [ask()])
    n.onFront()
    expect(fx.offers).toEqual([true, false])
    // another run: never dismissed, Settings turns notices on while it shows
    state = { v: 1 }
    make()
    snap(t, [ask()])
    expect(fx.offers).toEqual([true, false, true])
    cfg.notifications = true
    n.onConfig()
    expect(fx.offers).toEqual([true, false, true, false])
  })
})
