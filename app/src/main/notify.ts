/**
 * Marks, notices and the Dock badge (spec 28 A4.2, A4.6 #17-#27, r1 #6): every rule, no Electron. What waits on the
 * owner comes from live.ts's snapshots and main's own stops; the presenter (notify-mac.ts, or the test build's fake,
 * testing/notices.ts) posts and sets the badge; main.ts installs the ports.
 *
 * - **Marks** (#19): a local tab with a snapshot or a stop has `{ needs, unseen, working, session, stale? }` -
 *   `needs` the event's exact `counts` summed, plus 1 for a stop not yet acknowledged. tabs.ts's `viewOf` reads
 *   `marksOf`; a mark refreshes the strip's feed alone, never a compose.
 * - **New ids** (#17, r1 #6): each workspace keeps the ids it has seen this run. Its first snapshot adds them
 *   silently; every later one - after a reconnect, a Vite restart or a new instance - posts only ids not in the set.
 *   A snapshot with `cut` above 0, and the first full one after it, add theirs silently. The set is a union, at most
 *   `SEEN_MAX` per workspace; when full, the oldest id the latest snapshot does not list goes.
 * - **Stops** (#20): a `gone` with `why: 'pid'` for a local canvas whose tab is open is `stopped:<instance>`, counted
 *   until acknowledged: its tab shown with the window in front, the tab closed, a new instance of its workspace
 *   ready, or its notice clicked.
 * - **When a notice posts** (#23): `notifications === true`, that canvas not in front (not the active tab, or the
 *   window not in front), its tab open, and no notice from it in the last `noticeEveryMs`. One per snapshot: the
 *   newest item's words, "and N more" when several; a new id inside the minute is not posted and nothing is summed.
 *   The title is the canvas's own name (#24), never the stream's words.
 * - **The badge** (#21): the sum of open tabs' `needs`, only while `notifications === true` and `dockBadge !== false`;
 *   applied again `badgeRetryMs` after Turn On and at each window focus; `badge(0)` once when either key turns off.
 *   Never called while notices are off and have not been on this run.
 * - **Nothing before Turn On** (#22): the presenter's `create()` runs once, when `notifications` turns true while the
 *   app runs, or at the first post when it was found true at launch.
 * - **Outcomes** (#25): `show` is `accepted`, `failed` is `failed` (written to notices.json only on a change); a
 *   `failed` raises the strip's `notice-missed` confirmation. Each posted notice is held (50 at most) until its click
 *   or close: one garbage-collected leaves Notification Center.
 * - **The offer** (#26): at the first foreground observation of a need - each snapshot, a window focus, a compose -
 *   while `notifications` is unset and notices.json holds no `dismissedAt`: the pill's `offer`. Its first raise writes
 *   `offeredAt`; Turn On sets `notifications: true` as Settings would; Not now writes `dismissedAt`.
 */
import type { LiveItem, OpenItem } from '../../../src/shared/app-api.ts'
import type { TabMarks } from '../shared/channels.ts'
import type { Held, LiveChange } from './live.ts'
import type { RegistryEvent } from './registry.ts'
import { activated, appCmd, waitNotice, withAppCmd } from './commands.ts'
import { activeTab, allTabs, getTab, isActive, type Tab } from './tabs.ts'
import { T } from './timings.ts'

/** state/notices.json (A4.6 #27). */
export interface NoticesFile { v: 1; offeredAt?: number; dismissedAt?: number; lastOutcome?: 'accepted' | 'failed' }

/** What a notice says (#24): the canvas's name, then the item's words. */
export interface Notice { title: string; body: string }
export interface NoticeEvents { onShow(): void; onFailed(): void; onClick(): void; onClose(): void }
/**
 * The presenter (#22): notify-mac.ts, the one file that may touch Electron's `Notification` and the badge, or the
 * test build's fake. `create()` has macOS ask; `post` answers the object to hold until its click or close.
 */
export interface Presenter {
  create(): void
  post(n: Notice, on: NoticeEvents): unknown
  badge(n: number): void
}

export interface NotifyPorts {
  now(): number
  /** the presenter, made at its first use - never before notices are on */
  presenter(): Presenter
  /** live.ts's held snapshot of an instance */
  held(instance: string): Held | undefined
  /** config.json's keys as in force */
  config(): { notifications?: boolean; dockBadge?: boolean }
  /** `settings:set config notifications true`, as Settings would (#26): true when it was written */
  turnOn(): Promise<boolean>
  /** window.ts windowInFront(): shown, not minimised, focused, the screen not locked */
  inFront(): boolean
  /** state/notices.json as read, and a change to it (written debounced) */
  state(): NoticesFile
  setState(patch: Partial<NoticesFile>): void
  /** the pill's offer up or down (pill.ts `setCondition('offer', ...)`) */
  offer(on: boolean): void
  /** a notice macOS refused: the strip's `notice-missed` confirmation */
  missed(name: string): void
  /** the strip's feed again (window.ts refreshTabs) */
  refresh(): void
  /** a notice's click: the window forward, its tab shown and the item held for its document (null: a stop's) */
  open(tabId: string, item: OpenItem | null): void
  log?(topic: string, data: unknown): void
}

export interface Notify {
  /** a tab's marks (tabs.ts viewOf) */
  marksOf(t: Tab): TabMarks | undefined
  /** live.ts's change for an instance */
  onLive(instance: string, why: LiveChange): void
  /** a registry event, after the tabs heard it */
  onRegistry(e: RegistryEvent): void
  /** config.json changed what is in force */
  onConfig(): void
  /** the window came to the front (focus, show, restore, the screen unlocked) */
  onFront(): void
  /** after each compose: a tab shown, closed or switched */
  onCompose(): void
  /** the offer's Turn On and Not now (pill.ts) */
  offerTurnOn(): Promise<boolean>
  offerDismissed(): void
  /** the sum the Dock shows (test view) */
  total(): number
  dump(): { seen: Record<string, number>; stops: string[]; posted: number; badge: number | null; created: boolean; offered: boolean }
  /** stops every timer (tests) */
  close(): void
}

/** At most this many ids kept per workspace (r1 #6); tests pass a smaller one. */
export const SEEN_MAX = 5000
/** Posted notices held at once (#25). */
export const HELD_MAX = 50
const NAME_MAX = 60

const WORDS: Record<LiveItem['kind'], (title: string) => string> = {
  ask: (t) => `Asks you: ${t}`,
  review: (t) => `Ready to review: ${t}`,
  failed: (t) => `Failed: ${t}`,
  stalled: (t) => `Stalled: ${t} - choose what to do`,
}

/** One line, cut at `max` UTF-16 units, never inside a surrogate pair. */
export function cut(s: string, max: number): string {
  if (s.length <= max) return s
  let n = max
  const c = s.charCodeAt(n - 1)
  if (c >= 0xd800 && c <= 0xdbff) n -= 1
  return s.slice(0, n)
}

/** A notice's body (#23, #24): the newest item's words, and how many more came with it. */
export function bodyOf(first: string, more: number): string {
  return more > 0 ? `${first} · and ${more} more` : first
}

/** The item a click hands the shell: the stream's, its words left out (OpenItem). */
export function openItemOf(i: LiveItem): OpenItem {
  const o: OpenItem = { id: i.id, kind: i.kind, board: i.board }
  for (const k of ['thread', 'msg', 'batch', 'gen', 'occ'] as const) if (i[k] !== undefined) (o as Record<string, unknown>)[k] = i[k]
  if (i.cards) o.cards = [...i.cards]
  return o
}

interface Seen { ids: Set<string>; started: boolean; afterCut: boolean }
interface Stop { instance: string; id: string; ws: string }

export function createNotify(ports: NotifyPorts, o: { seenMax?: number } = {}): Notify {
  const seenMax = o.seenMax ?? SEEN_MAX
  const log = (data: Record<string, unknown>) => ports.log?.('notices', data)
  const seen = new Map<string, Seen>()
  const lastPost = new Map<string, number>()
  const stops = new Map<string, Stop>()
  const posted = new Map<number, unknown>()
  let postN = 0
  let pres: Presenter | null = null
  let created = false
  /** notifications turned true while the app runs (#21, #22) */
  let turnedOn = false
  /** a snapshot or a stop seen this run: found on at launch, the badge starts at the first (#21) */
  let observed = false
  let badgeShown: number | null = null
  let offered = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let was = { ...ports.config() }

  const presenter = (): Presenter => (pres ??= ports.presenter())
  const createOnce = () => { if (created) return; created = true; presenter().create(); log({ create: true }) }
  const notices = () => ports.config().notifications === true
  const inFront = (t: Tab) => isActive(t) && ports.inFront()
  const tabOf = (instance: string): Tab | undefined => allTabs().find((t) => t.kind === 'local' && t.reg?.instance === instance)

  function marksOf(t: Tab): TabMarks | undefined {
    if (t.kind !== 'local' || !t.reg) return undefined
    const h = ports.held(t.reg.instance)
    const stop = stops.has(t.id)
    if (!h && !stop) return undefined
    const c = h?.event.counts
    const m: TabMarks = {
      needs: (c ? c.ask + c.review + c.failed + c.stalled : 0) + (stop ? 1 : 0),
      unseen: h?.event.unseen ?? 0, working: h?.event.working ?? false, session: h?.event.session ?? false,
    }
    if (h?.stale) m.stale = true
    return m
  }

  /** What the strip cannot show, the Dock does not count (#19, #54): open tabs only. */
  const total = (): number => allTabs().reduce((n, t) => n + (t.kind === 'local' && t.open ? (marksOf(t)?.needs ?? 0) : 0), 0)

  function badgeNow(force: boolean): void {
    const c = ports.config()
    if (!(c.notifications === true && c.dockBadge !== false)) {
      // off: cleared once if a number was showing; never called otherwise (#21)
      if (badgeShown) { presenter().badge(0); badgeShown = 0; log({ badge: 0 }) }
      return
    }
    if (!turnedOn && !observed) return
    const n = total()
    if (!force && n === badgeShown) return
    presenter().badge(n)
    badgeShown = n
    log({ badge: n, force })
  }

  /** The offer (#26): the first foreground observation of a need, while notices are unset and never dismissed. */
  function offerCheck(): void {
    if (offered || ports.config().notifications !== undefined || ports.state().dismissedAt !== undefined) return
    if (!ports.inFront() || total() === 0) return
    offered = true
    ports.offer(true)
    if (ports.state().offeredAt === undefined) ports.setState({ offeredAt: ports.now() })
    log({ offer: true })
  }
  function offerDown(): void {
    if (!offered) return
    offered = false
    ports.offer(false)
  }

  /** Stops acknowledged by what the person sees now (#20): the tab shown in front, closed, or gone from the model. */
  function ackStops(): boolean {
    let changed = false
    for (const [id, s] of stops) {
      const t = getTab(id)
      if (!t || !t.open || inFront(t)) { stops.delete(id); changed = true; log({ ack: s.id, tab: id }) }
    }
    return changed
  }

  const outcome = (o: 'accepted' | 'failed') => { if (ports.state().lastOutcome !== o) ports.setState({ lastOutcome: o }) }

  /** One notice (#23-#25), or nothing and why. */
  function post(t: Tab, ws: string, words: string, more: number, item: OpenItem | null): void {
    const why = !notices() ? 'off' : !t.open ? 'closed' : inFront(t) ? 'front'
      : ports.now() - (lastPost.get(ws) ?? -Infinity) < T.noticeEveryMs ? 'minute' : null
    if (why) { log({ tab: t.id, held: item?.id ?? 'stop', why }); return }
    lastPost.set(ws, ports.now())
    createOnce()
    const n = ++postN
    const title = cut(t.name, NAME_MAX)
    const release = () => { posted.delete(n) }
    const handle = presenter().post({ title, body: bodyOf(words, more) }, {
      onShow: () => outcome('accepted'),
      onFailed: () => { outcome('failed'); ports.missed(title) },
      onClick: () => {
        release()
        if (!item) { stops.delete(t.id); ports.refresh() }
        log({ click: item?.id ?? `stop:${t.id}`, tab: t.id })
        // spec 30's notice-open: with an item, the shell's answer ends it, or its drop in main; a stop's, its tab shown
        const h = appCmd('notice-open', { via: 'click', in: 'main', tab: t.id })
        if (!getTab(t.id)) h.noop('no-tab')                          // closed since it was posted: nothing to show
        else if (item) waitNotice(h, item.id)
        withAppCmd(h, () => { ports.open(t.id, item); if (!item) activated(h, t.id) })
      },
      onClose: release,
    })
    posted.set(n, handle)
    // the oldest let go past 50 (#25)
    for (const k of posted.keys()) { if (posted.size <= HELD_MAX) break; posted.delete(k) }
    log({ post: n, tab: t.id, item: item?.id ?? 'stop', more })
  }

  /** A snapshot applied (#17, r1 #6): its new ids, against the workspace's set; one notice at most. */
  function diff(instance: string): void {
    const h = ports.held(instance)
    if (!h) return
    const ev = h.event
    let s = seen.get(h.ws)
    if (!s) { s = { ids: new Set(), started: false, afterCut: false }; seen.set(h.ws, s) }
    const fresh = ev.items.filter((i) => !s!.ids.has(i.id))
    const silent = !s.started ? 'first' : ev.cut > 0 ? 'cut' : s.afterCut ? 'after-cut' : null
    s.started = true
    s.afterCut = ev.cut > 0
    for (const i of fresh) s.ids.add(i.id)
    if (s.ids.size > seenMax) {
      const keep = new Set(ev.items.map((i) => i.id))
      for (const id of s.ids) { if (s.ids.size <= seenMax) break; if (!keep.has(id)) s.ids.delete(id) }
    }
    if (!fresh.length) return
    if (silent) { log({ ws: h.ws, silent, ids: fresh.length }); return }
    const t = tabOf(instance)
    if (!t) { log({ ws: h.ws, held: fresh.length, why: 'no-tab' }); return }
    const first = fresh[0]!   // items come newest first
    post(t, h.ws, WORDS[first.kind](first.title), fresh.length - 1, openItemOf(first))
  }

  const after = () => { ports.refresh(); badgeNow(false); offerCheck() }

  return {
    marksOf,
    onLive(instance, why) {
      if (why === 'applied') { observed = true; diff(instance) }
      after()
    },
    onRegistry(e) {
      if (e.kind === 'gone') {
        if (e.why !== 'pid') return
        const t = tabOf(e.instance)
        if (!t || !t.open || !t.reg) return
        const s: Stop = { instance: e.instance, id: `stopped:${e.instance}`, ws: t.reg.ws }
        // seen as it happens, in front: acknowledged at once
        if (inFront(t)) { log({ ack: s.id, tab: t.id, front: true }); return }
        stops.set(t.id, s)
        // a canvas without live, or one killed before its first snapshot: the stop is what the badge first counts
        observed = true
        log({ stop: s.id, tab: t.id })
        post(t, s.ws, 'Stopped', 0, null)
        after()
        return
      }
      if (e.entry.state !== 'ready') return
      // a new instance of its workspace is ready: the stop is over
      let changed = false
      for (const [id, s] of stops) if (s.ws === e.entry.ws && s.instance !== e.entry.instance) { stops.delete(id); changed = true; log({ ack: s.id, tab: id, ready: e.entry.instance }) }
      if (changed) after()
    },
    onConfig() {
      const c = ports.config()
      const before = was
      was = { ...c }
      if (c.notifications === true && before.notifications !== true) {
        // turned on while the app runs (#22): the presenter once, then the badge, again after badgeRetryMs (#21)
        turnedOn = true
        createOnce()
        badgeNow(true)
        if (retry) clearTimeout(retry)
        retry = setTimeout(() => { retry = undefined; badgeNow(true) }, T.badgeRetryMs)
        ;(retry as { unref?: () => void }).unref?.()
      } else if (c.dockBadge !== before.dockBadge || c.notifications !== before.notifications) badgeNow(true)
      if (c.notifications !== undefined) offerDown()
    },
    onFront() {
      if (ackStops()) ports.refresh()
      if (notices()) badgeNow(true)
      offerCheck()
    },
    onCompose() {
      if (ackStops()) ports.refresh()
      badgeNow(false)
      offerCheck()
    },
    async offerTurnOn() {
      const ok = await ports.turnOn().catch(() => false)
      log({ turnOn: ok })
      // a refused write leaves the offer up (#26); config.ts's change does the rest (#22)
      if (ok) offerDown()
      return ok
    },
    offerDismissed() {
      offered = false
      ports.setState({ dismissedAt: ports.now() })
      ports.offer(false)
      log({ offer: 'dismissed' })
    },
    total,
    dump: () => ({
      seen: Object.fromEntries([...seen].map(([ws, s]) => [ws, s.ids.size])), stops: [...stops.values()].map((s) => s.id),
      posted: posted.size, badge: badgeShown, created, offered,
    }),
    close() { if (retry) clearTimeout(retry); retry = undefined },
  }
}
