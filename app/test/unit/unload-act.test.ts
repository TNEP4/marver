/**
 * The unload's act on a webContents (spec 28 A3.8 #39, #44, r1 #2; unload-act.ts), on a fake webContents: Chromium's
 * events are emitted by the case, `destroyed` included, so each state of the close runs in order - the page's refusal,
 * `unsure` and main's own plain close, a refusal after it, a renderer gone while it closes, and the retries when
 * `destroyed` never comes - the webContents closed again until it goes, the tab, its queued load and a quit held
 * until then (code review r1 #1).
 * views.ts's forgetCanvas is the case's own `destroyed` listener, registered before the act as wireCanvas registers it.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guard, guardAll, onUnloaded, viewlessAct, type GuardAction, type GuardAnswer, type Tab } from '../../src/main/tabs.ts'
import { T } from '../../src/main/timings.ts'
import { actUnload, resetActs, takeAct, unloadGone, type ActPorts, type UnloadActState } from '../../src/main/unload-act.ts'
import { flush, liveTab, reopenOf, show, world, type World } from './window-fakes.ts'

class FakeWc extends EventEmitter {
  destroyed = false
  closes: ({ waitForBeforeUnload: boolean } | undefined)[] = []
  close(o?: { waitForBeforeUnload: boolean }): void { this.closes.push(o) }
  isDestroyed(): boolean { return this.destroyed }
  /** Electron's destroy, on its posted task */
  destroy(): void { this.destroyed = true; this.emit('destroyed'); this.removeAllListeners() }
}

const critical = { kind: 'unload', reason: 'critical' } as const

let w: World
let wc: FakeWc
let lines: { topic: string; data: Record<string, unknown> }[]
let unsure: string[]
let forgot: string[]
let taken: UnloadActState | undefined
let ports: ActPorts

/** views.ts's forgetCanvas, as the unload sees it: the act taken, the tab unloaded (once: the view is gone after). */
function forgetCanvas(t: Tab): void {
  if (forgot.includes(`view:${t.id}`)) return
  forgot.push(`view:${t.id}`)
  taken = takeAct(t.id)
  if (t.unload?.phase === 'closing' || t.unload?.phase === 'unsure') onUnloaded(t)
}

/** views.ts's act: the unload's on this webContents; any other action on a tab with no view, as its no-view path. */
function act(tab: Tab, a: GuardAction): Promise<GuardAnswer> | GuardAnswer {
  if (a.kind === 'unload') return actUnload(tab, wc, a, ports, { pid: 4242, born: 7 })
  if (tab.view !== 'live' && viewlessAct(tab, a) && tab.reg?.origin) { w.loads.push(tab.id); reopenOf(w, tab) }
  return 'done'
}

/** A candidate tab, its unload admitted through the guard with this file's act as views.ts's. */
function closing(): { t: Tab; answer: Promise<string> } {
  const t = liveTab(w)
  show('home')
  w.clock.now += T.unloadMinHiddenMs
  // forgetCanvas first, as wireCanvas registers it
  wc.on('destroyed', () => forgetCanvas(t))
  w.actWith = act
  const answer = guard(t, critical)
  return { t, answer }
}

beforeEach(() => {
  w = world()
  wc = new FakeWc()
  lines = []; unsure = []; forgot = []; taken = undefined
  ports = {
    log: (topic, data) => { lines.push({ topic, data }) },
    unsure: (t) => { unsure.push(t.id) },
    forget: (t) => { forgot.push(t.id); forgetCanvas(t) },   // the backstop's forgetCanvas, by hand
  }
  resetActs()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => { vi.useRealTimers(); resetActs() })

const baseline = () => ({ prevent: wc.listenerCount('will-prevent-unload'), destroyed: wc.listenerCount('destroyed') })

describe('the act (A3.8 #39, r1 #2)', () => {
  it('asks the page: close({ waitForBeforeUnload: true }), once; destroyed unloads the tab, the act taken by forgetCanvas', async () => {
    const { t, answer } = closing()
    expect(wc.closes).toEqual([{ waitForBeforeUnload: true }])
    expect(t.unload?.phase).toBe('closing')
    wc.destroy()
    expect(await answer).toBe('done')
    expect(t.view).toBe('unloaded')
    expect(taken).toEqual({ plain: false, gone: false, pid: 4242, born: 7 })
    expect(takeAct(t.id)).toBeUndefined()
  })

  it('the page refuses: kept, and every listener the act added goes with it - a kept page asked again gathers none', async () => {
    const t = liveTab(w)
    show('home')
    const before = baseline()
    for (let i = 0; i < 3; i++) {
      t.unloadRefused = undefined
      w.clock.now += T.unloadMinHiddenMs
      w.actWith = act
      const answer = guard(t, critical)
      expect(baseline()).toEqual({ prevent: before.prevent + 1, destroyed: before.destroyed + 1 })
      wc.emit('will-prevent-unload')
      expect(await answer).toBe('refused')
      expect(baseline()).toEqual(before)
      expect(takeAct(t.id)).toBeUndefined()
    }
    expect(t.view).toBe('live')
  })

  it('unsure at unloadActMs: its record, then main\'s own plain close, journaled before destroyed; a refusal after it changes nothing', async () => {
    const { t, answer } = closing()
    vi.advanceTimersByTime(T.unloadActMs - 1)
    expect(wc.closes).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(t.unload?.phase).toBe('unsure')
    expect(unsure).toEqual([t.id])
    expect(wc.closes).toEqual([{ waitForBeforeUnload: true }, undefined])   // the plain close: asking nothing
    expect(lines.filter((l) => l.topic === 'unload').map((l) => l.data)).toEqual([{ tab: t.id, phase: 'unsure' }, { tab: t.id, endClose: 'unsure' }])
    wc.emit('will-prevent-unload')   // the page's answer, too late: main has closed it
    await flush()
    expect(lines.some((l) => l.data.lateRefusal === true)).toBe(true)
    expect(t.unloadRefused).toBeUndefined()
    let settled = false
    void answer.then(() => { settled = true })
    await flush()
    expect(settled).toBe(false)   // only destroyed ends it now
    wc.destroy()
    expect(await answer).toBe('done')
    expect(t.view).toBe('unloaded')
    expect(taken?.plain).toBe(true)
  })

  it('a renderer gone while it closes: ours, the close finished a task later with a plain close; destroyed ends it unloaded, the crash record untouched', async () => {
    const { t, answer } = closing()
    const crash = structuredClone(t.crash)
    expect(unloadGone(t)).toBe(true)
    expect(wc.closes).toHaveLength(1)   // not in the event's own turn
    await new Promise((r) => setImmediate(r))
    expect(wc.closes).toEqual([{ waitForBeforeUnload: true }, undefined])
    expect(lines.filter((l) => l.topic === 'unload').map((l) => l.data)).toEqual([{ tab: t.id, endClose: 'gone' }])
    wc.emit('will-prevent-unload')   // nothing left to ask: never a refusal now
    wc.destroy()
    expect(await answer).toBe('done')
    expect(t.view).toBe('unloaded')
    expect(t.crash).toEqual(crash)
    expect(taken).toMatchObject({ gone: true, plain: true })
    expect(unsure).toEqual([])
  })

  it('a renderer gone with no unload under way is not the unload\'s', () => {
    const t = liveTab(w)
    expect(unloadGone(t)).toBe(false)
  })

  it('destroyed never comes after main\'s own close: the unload keeps the tab, its view and its operation - the queued load and a quit wait - closing it again every unloadActMs, and only destroyed ends it (code review r1 #1)', async () => {
    const { t, answer } = closing()
    const load = guard(t, { kind: 'load', url: `${t.reg!.origin}/#/b/next` })   // waits on the unload's done
    const quit = guardAll({ kind: 'quit' })                                       // waits on every unload in flight
    const settled = { answer: false, load: false, quit: false }
    void answer.then(() => { settled.answer = true }); void load.then(() => { settled.load = true }); void quit.then(() => { settled.quit = true })
    vi.advanceTimersByTime(T.unloadActMs)   // unsure: the plain close, which here destroys nothing
    expect(wc.closes).toHaveLength(2)
    for (let k = 1; k <= 6; k++) {
      vi.advanceTimersByTime(T.unloadActMs)
      expect(wc.closes).toHaveLength(2 + k)   // closed again, asking nothing
      expect(wc.closes.at(-1)).toBeUndefined()
      await flush()
      expect(settled).toEqual({ answer: false, load: false, quit: false })
      expect(forgot).toEqual([])                // the view never taken out while its webContents lives
      expect(t.unload?.phase).toBe('unsure')
      expect(t.replacing?.action.kind).toBe('unload')
      expect(w.loads).toEqual([])
    }
    // journaled once, when the first retry went; the records say nothing yet
    expect(lines.filter((l) => l.data.stuck === true).map((l) => l.data)).toEqual([{ tab: t.id, stuck: true, destroyed: false }])
    expect(w.records.filter((r) => r.kind === 'unload' && (r.body as { phase?: string }).phase === 'done')).toEqual([])
    wc.destroy()
    expect(await answer).toBe('done')
    expect(lines.find((l) => l.topic === 'act' && l.data.answer)?.data).toMatchObject({ answer: 'done', why: 'destroyed' })
    expect(taken?.plain).toBe(true)
    // unloaded at its destroyed, its record saying main had to close it again; then the queued load took the tab
    expect(w.records.filter((r) => r.kind === 'unload').map((r) => r.body)).toEqual([{ phase: 'done', reason: 'critical', why: 'stuck' }])
    expect(await load).toBe('done')
    expect(w.loads).toEqual([t.id])
    vi.advanceTimersByTime(T.unloadActMs * 3)
    expect(wc.closes).toHaveLength(8)   // never closed again once it has gone
  })

  it('a webContents found destroyed with no destroyed event: the view taken out by hand then, never before', async () => {
    const { t, answer } = closing()
    vi.advanceTimersByTime(T.unloadActMs)
    wc.destroyed = true            // gone, its event never delivered
    wc.removeAllListeners()
    vi.advanceTimersByTime(T.unloadActMs)
    expect(forgot).toEqual([t.id, `view:${t.id}`])
    expect(await answer).toBe('done')
    expect(t.view).toBe('unloaded')
    expect(lines.find((l) => l.data.stuck === true)?.data).toEqual({ tab: t.id, stuck: true, destroyed: true })
    expect(wc.closes).toHaveLength(2)   // nothing closed again: it is gone
  })

  it('a renderer gone and then no destroyed: closed again from main\'s close the same way, never unsure, and still owned until destroyed', async () => {
    const { t, answer } = closing()
    unloadGone(t)
    await new Promise((r) => setImmediate(r))
    let settled = false
    void answer.then(() => { settled = true })
    vi.advanceTimersByTime(T.unloadActMs * 3)
    await flush()
    expect(wc.closes).toHaveLength(5)
    expect(forgot).toEqual([])
    expect(settled).toBe(false)
    // its end was its renderer's gone: the act's unloadActMs passing after it is no unsure, in the records or the journal
    expect(unsure).toEqual([])
    expect(lines.filter((l) => l.topic === 'unload' && (l.data.phase === 'unsure' || l.data.endClose === 'unsure'))).toEqual([])
    wc.destroy()
    expect(await answer).toBe('done')
    expect(t.view).toBe('unloaded')
    expect(taken).toMatchObject({ gone: true, plain: true })
  })
})
