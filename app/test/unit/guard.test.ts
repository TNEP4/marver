/**
 * The guard (spec 28 A2.2, A2.14 #15, #16, v1.12 r1 #2, #3, v1.13 r2 #1, #2, #4, v1.14 r3 #1, #2), on the pure
 * model with fake ports: every replacement path, one serialized operation per tab bound to its document, a fresh
 * unsaved refused at once, a record not fresh asking first, the rule of r3 #1 read after every wait, consent that
 * never transfers, and guardAll's shared step 1 and sheet with trust lost mid-quit.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  activeTab, closeTab, closeView, guard, guardAll, onCommit, onFail, onRegistry, sheetText, type GuardAction, type Tab,
} from '../../src/main/tabs.ts'
import { deferred, liveTab, report, show, world, type World } from './window-fakes.ts'

let w: World
beforeEach(() => { w = world() })

const ACTIONS: GuardAction[] = [
  { kind: 'close' }, { kind: 'quit' }, { kind: 'update' }, { kind: 'reload' }, { kind: 'forceReload' }, { kind: 'tryAgain' },
  { kind: 'load', url: 'http://[::1]:40100/#/b/other' },
]

/** a page reloads itself: its new document commits (trusted), so the commit count moves */
function selfReload(t: Tab): void {
  onCommit(t, { gen: (t.doc?.gen ?? 1) + 1, url: `${t.reg!.origin}/`, attributed: true, admitted: `doc-${t.id}-${(t.doc?.commits ?? 0) + 1}` })
}

/** the canvas stops: trust is revoked, the record goes stale */
function stop(t: Tab): void { onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' }) }

describe('step 1: a fresh record that says unsaved refuses at once, asking nothing', () => {
  for (const a of ACTIONS) {
    it(`${a.kind}: refused, no sheet, no act, the unsaved pill's hold set`, async () => {
      const t = liveTab(w, { busy: { unsaved: true, why: ['capture-unsent'] } })
      expect(await guard(t, a)).toBe('refused')
      expect(w.sheets).toHaveLength(0)
      expect(w.acts).toHaveLength(0)
      expect(t.held?.action).toBe(a.kind)
      expect(t.replacing).toBeUndefined()
    })
  }

  it('a page whose unsaved work came with no gesture is refused by main\'s own record (A2.14 #16)', async () => {
    const t = liveTab(w, { busy: { unsaved: false } })
    report(t, true, ['heights'])
    expect(await closeView(t)).toBe('refused')
    expect(w.acts).toHaveLength(0)
  })
})

describe('a fresh, clean record goes straight to the act', () => {
  for (const a of ACTIONS) {
    it(`${a.kind}: the act runs once with the action captured at the start`, async () => {
      const t = liveTab(w)
      const action = { ...a } as GuardAction
      const p = guard(t, action)
      if (action.kind === 'load') (action as { url: string }).url = 'http://evil.example/'   // the caller's object changing later changes nothing
      expect(await p).toBe('done')
      expect(w.sheets).toHaveLength(0)
      expect(w.acts).toEqual([{ tab: t.id, action: a }])
    })
  }
})

describe('a record not fresh asks one sheet first, Cancel the default (r1 #2, r2 #1, #15)', () => {
  it('unknown: a document not yet heard since its commit - a page that reports unsaved and hangs before admission asks first', async () => {
    const t = liveTab(w, { busy: null })
    expect(t.reports.safety).toBe('unknown')
    w.askWith = () => false
    expect(await closeView(t)).toBe('refused')
    expect(await guard(t, { kind: 'reload' })).toBe('refused')
    expect(w.sheets.map((s) => s.tabs[0]!.why)).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }])
    expect(w.acts).toHaveLength(0)   // Cancel keeps it
  })

  it('a canvas without the bridge (0.27.0) stays unknown and is named for it', async () => {
    const t = liveTab(w, { entry: { features: [], version: '0.27.0' }, busy: null })
    w.askWith = () => true
    expect(await closeView(t)).toBe('closed')
    expect(w.sheets[0]!.tabs[0]!.why).toEqual({ kind: 'no-bridge', version: '0.27.0' })
    expect(sheetText(w.sheets[0]!).detail).toContain('runs Marver 0.27.0, which can\'t tell the app about unsaved work.')
  })

  it('stale: trust gone while the document lives - the sheet names what it last held', async () => {
    const t = liveTab(w, { busy: { unsaved: true, why: ['board-unsaved', 'capture-unsent'] } })
    stop(t)
    expect(t.reports.safety).toBe('stale')
    expect(w.states).toContainEqual({ tab: t.id, s: 'untrusted' })
    w.askWith = () => true
    expect(await closeView(t)).toBe('closed')
    expect(w.sheets[0]!.tabs[0]!.why).toEqual({ kind: 'stale', stopped: true, held: ['board-unsaved', 'capture-unsent'] })
    const words = sheetText(w.sheets[0]!)
    expect(words.message).toBe(`Close ${t.name} anyway?`)
    expect(words.detail).toBe(`When ${t.name} stopped, it held edits not yet saved and a capture not yet sent.\n\nWhat it hasn't saved is lost.`)
    expect(words.buttons).toEqual(['Cancel', 'Close'])
  })

  it('a stopped page whose work was then dropped closes after the sheet; its own beforeunload may still refuse', async () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    stop(t)
    w.askWith = () => true
    w.actWith = () => 'refused'   // the page's beforeunload, a best-effort extra veto (r2 #4)
    expect(await closeView(t)).toBe('refused')
    expect(t.held).toBeTruthy()
    w.actWith = () => 'done'
    expect(await closeView(t)).toBe('closed')
  })

  it('the sheet\'s words follow the action', () => {
    const tabs = [{ id: 't1', name: 'TMS broker', why: { kind: 'unknown' as const } }]
    expect(sheetText({ action: { kind: 'reload' }, tabs }).message).toBe('Reload TMS broker anyway?')
    expect(sheetText({ action: { kind: 'tryAgain' }, tabs }).buttons).toEqual(['Cancel', 'Reload'])
    expect(sheetText({ action: { kind: 'load', url: 'x' }, tabs }).message).toBe('Open the link in TMS broker anyway?')
    expect(sheetText({ action: { kind: 'quit' }, tabs: [...tabs, { id: 't2', name: 'Tidewell', why: { kind: 'stale', stopped: false, held: [] } }] }).detail)
      .toBe('TMS broker hasn\'t told the app yet whether it holds unsaved work.\nThe app can\'t hear Tidewell any more: it may hold work made since.\n\nWhat they haven\'t saved is lost.')
  })
})

describe('one operation per tab, bound to its document, read again after every wait (r2 #2, r3 #1)', () => {
  it('a second ⌘W, or a link, while the sheet is open is refused at once, with no second sheet', async () => {
    const t = liveTab(w, { busy: null })
    const sheet = deferred<boolean>()
    w.askWith = () => sheet.promise
    const first = closeView(t)
    expect(await closeView(t)).toBe('refused')
    expect(await guard(t, { kind: 'load', url: 'http://[::1]:1/' })).toBe('refused')
    expect(w.sheets).toHaveLength(1)
    sheet.resolve(false)
    expect(await first).toBe('refused')
  })

  it('the page reloads itself while the sheet is open: "Close it anyway" closes nothing', async () => {
    const t = liveTab(w, { busy: null })
    const sheet = deferred<boolean>()
    w.askWith = () => sheet.promise
    const p = closeView(t)
    selfReload(t)
    sheet.resolve(true)
    expect(await p).toBe('refused')
    expect(w.acts).toHaveLength(0)
  })

  it('an unknown page\'s first report says unsaved while the sheet is open: nothing replaced, the pill shown', async () => {
    const t = liveTab(w, { busy: null })
    const sheet = deferred<boolean>()
    w.askWith = () => sheet.promise
    const p = guard(t, { kind: 'reload' })
    report(t, true)
    sheet.resolve(true)
    expect(await p).toBe('refused')
    expect(w.acts).toHaveLength(0)
    expect(t.held?.action).toBe('reload')
  })

  it('a fresh, clean page goes on after the sheet only when consent covers it, or it is clean now', async () => {
    // unknown when asked, fresh and clean by the time the person confirms: it goes on
    const t = liveTab(w, { busy: null })
    const sheet = deferred<boolean>()
    w.askWith = () => sheet.promise
    const p = closeView(t)
    report(t, false)
    sheet.resolve(true)
    expect(await p).toBe('closed')
  })

  it('consent never transfers: not to another action, nor another document, nor another tab', async () => {
    const a = liveTab(w, { busy: null })
    const b = liveTab(w, { busy: null, show: false })
    w.askWith = () => true
    w.actWith = () => 'refused'   // the page keeps itself each time, so each operation ends and the next asks anew
    await guard(a, { kind: 'reload' })
    await guard(a, { kind: 'close' })
    selfReload(a)
    report(a, false)
    stop(a)   // stale again, a new document
    await guard(a, { kind: 'close' })
    await guard(b, { kind: 'close' })
    expect(w.sheets.map((s) => [s.action.kind, s.tabs[0]!.id])).toEqual([['reload', a.id], ['close', a.id], ['close', a.id], ['close', b.id]])
  })
})

describe('not guarded: no live document that was shown (r1 #3)', () => {
  it('a tab with no view, a crashed one, an error page: the act runs without a question', async () => {
    const w2 = w
    const t = liveTab(w2)
    onFail(t, { why: 'unreachable', code: -102, errorPage: true })   // an error page committed: the document is gone
    expect(t.retained).toBe(false)
    expect(await guard(t, { kind: 'tryAgain' })).toBe('done')
    expect(w2.sheets).toHaveLength(0)
  })

  it('a failure that may have left the page alive keeps it retained: Try Again asks first', async () => {
    const t = liveTab(w)
    onFail(t, { why: 'unreachable', code: -102, errorPage: false })
    expect(t.retained).toBe(true)
    expect(t.reports.safety).toBe('stale')
    w.askWith = () => false
    expect(await guard(t, { kind: 'tryAgain' })).toBe('refused')
    expect(w.sheets).toHaveLength(1)
  })

  it('closing an unguarded tab keeps it as a closed run when its canvas still runs', async () => {
    const t = liveTab(w)
    expect(await closeTab(t.id)).toBe('closed')
    expect(t.open).toBe(false)
    expect(activeTab()?.id).toBe('home')
  })
})

describe('guardAll: one operation per canvas tab, one shared step 1 and sheet (r2 #2, r3 #1)', () => {
  it('a fresh unsaved tab anywhere refuses the quit before any sheet; that tab comes forward', async () => {
    const a = liveTab(w)
    const b = liveTab(w, { busy: { unsaved: true, why: ['capture-recording'] } })
    show(a.id)
    w.askWith = () => true
    expect(await guardAll({ kind: 'quit' })).toBe('refused')
    expect(w.sheets).toHaveLength(0)
    expect(w.acts).toHaveLength(0)
    expect(activeTab()?.id).toBe(b.id)
    expect(b.held?.action).toBe('quit')
  })

  it('a refused quit shows the window: its tab comes forward where the person can see it (a quit may start hidden)', async () => {
    const a = liveTab(w)
    const b = liveTab(w, { busy: { unsaved: true, why: ['board-unsaved'] } })
    show(a.id)
    expect(await guardAll({ kind: 'quit' })).toBe('refused')
    expect(w.forwards).toBeGreaterThan(0)
    // a page that refuses its close too
    w.forwards = 0
    const c = liveTab(w)
    report(b, false)
    w.actWith = (t) => t.id === c.id ? 'refused' : 'done'
    expect(await guardAll({ kind: 'update' })).toBe('refused')
    expect(w.forwards).toBeGreaterThan(0)
    // a clean close that goes through brings nothing forward
    w.forwards = 0
    const d = liveTab(w)
    w.actWith = () => 'done'
    expect(await closeView(d)).toBe('closed')
    expect(w.forwards).toBe(0)
  })

  it('one sheet names every tab not fresh; Cancel cancels the quit and closes nothing', async () => {
    liveTab(w, { busy: null })
    liveTab(w, { entry: { features: [] }, busy: null })
    liveTab(w)
    w.askWith = () => false
    expect(await guardAll({ kind: 'quit' })).toBe('refused')
    expect(w.sheets).toHaveLength(1)
    expect(w.sheets[0]!.tabs).toHaveLength(2)
    expect(w.acts).toHaveLength(0)
  })

  it('trust lost during another tab\'s close: the second is not closed, the quit cancelled, it comes forward', async () => {
    const a = liveTab(w)
    const b = liveTab(w)
    show(a.id)
    const first = deferred<'done' | 'refused'>()
    w.actWith = (t) => t.id === a.id ? first.promise : 'done'
    const quit = guardAll({ kind: 'quit' })
    await Promise.resolve()
    stop(b)   // b's canvas stops while a's close waits
    first.resolve('done')
    expect(await quit).toBe('refused')
    expect(w.acts.map((x) => x.tab)).toEqual([a.id])
    expect(activeTab()?.id).toBe(b.id)
    expect(b.held).toBeUndefined()   // no unsaved work known: forward, without the pill
  })

  it('trust lost during the shared sheet: a fresh, clean tab the sheet does not name loses trust - nothing is closed', async () => {
    const stale = liveTab(w, { busy: { unsaved: false } })
    stop(stale)
    const clean = liveTab(w)
    const sheet = deferred<boolean>()
    w.askWith = () => sheet.promise
    const quit = guardAll({ kind: 'quit' })
    expect(w.sheets[0]!.tabs.map((x) => x.id)).toEqual([stale.id])
    stop(clean)
    sheet.resolve(true)
    expect(await quit).toBe('refused')
    expect(w.acts).toHaveLength(0)
  })

  it('a quit whose shared sheet sees one tab change document is cancelled', async () => {
    const t = liveTab(w, { busy: null })
    liveTab(w)
    const sheet = deferred<boolean>()
    w.askWith = () => sheet.promise
    const quit = guardAll({ kind: 'quit' })
    selfReload(t)
    sheet.resolve(true)
    expect(await quit).toBe('refused')
    expect(w.acts).toHaveLength(0)
  })

  it('a page that refuses its close stops the whole: the tabs after it stay as they are', async () => {
    const a = liveTab(w)
    const b = liveTab(w)
    const c = liveTab(w)
    show(a.id)
    w.actWith = (t) => t.id === b.id ? 'refused' : 'done'
    expect(await guardAll({ kind: 'quit' })).toBe('refused')
    expect(w.acts.map((x) => x.tab)).toEqual([a.id, b.id])
    expect(w.acts.some((x) => x.tab === c.id)).toBe(false)
    expect(activeTab()?.id).toBe(b.id)
    expect(b.held?.action).toBe('quit')
  })

  it('every fresh, clean tab: each closed in order, once', async () => {
    const tabs = [liveTab(w), liveTab(w), liveTab(w)]
    expect(await guardAll({ kind: 'update' })).toBe('done')
    expect(w.acts.map((x) => [x.tab, x.action.kind])).toEqual(tabs.map((t) => [t.id, 'update']))
  })

  it('a tab with an operation in flight refuses the quit, with no second sheet', async () => {
    const t = liveTab(w, { busy: null })
    const sheet = deferred<boolean>()
    w.askWith = () => sheet.promise
    const close = closeView(t)
    expect(await guardAll({ kind: 'quit' })).toBe('refused')
    expect(w.sheets).toHaveLength(1)
    sheet.resolve(false)
    await close
  })

  it('a tab that comes to hold a live document during the quit was named by no step: the quit stops', async () => {
    const a = liveTab(w)
    const first = deferred<'done' | 'refused'>()
    w.actWith = () => first.promise
    const quit = guardAll({ kind: 'quit' })
    await Promise.resolve()
    const late = liveTab(w, { show: false })
    first.resolve('done')
    expect(await quit).toBe('refused')
    expect(w.acts.map((x) => x.tab)).toEqual([a.id])
    expect(activeTab()?.id).toBe(late.id)
  })
})
