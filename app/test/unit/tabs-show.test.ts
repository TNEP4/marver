/**
 * A `marver://` link into a tab already open (spec 31 D1; tabs.ts `showForLink`): the tab is shown, and the place goes
 * to its document over the bridge - held until that document is admitted, trusted and has said hello, sent once,
 * replaced by a later link, dropped when another tab is shown. Main never loads it, reloads it or acts on it through the
 * guard: whatever the page holds - a draft, unsaved edits - stays (the shell decides, show.ts). A canvas before 0.31
 * (no `show` feature) is only shown. Pure, with fake ports.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ShowTarget } from '../../../src/shared/deep-link.ts'
import { activeTab, onCommit, onReport, setShowSender, showForLink, type Tab } from '../../src/main/tabs.ts'
import { liveTab, show, world, type World } from './window-fakes.ts'

const SHOW = ['bridge', 'inset', 'live', 'open', 'capture', 'show']
const T1: ShowTarget = { board: 'main', f: ['demo/one'] }
const T2: ShowTarget = { board: 'other', n: ['demo/two@390'] }
const hello = (t: Tab) => onReport(t.id, t.doc!.doc!, { hello: { version: '0.31.0', board: 'main', page: 'PAGE_0123456789' } })

let w: World
let sent: { tab: string; doc?: string; target: ShowTarget | 'landing' }[]
beforeEach(() => {
  w = world()
  sent = []
  setShowSender((t, target) => { sent.push({ tab: t.id, doc: t.doc?.doc, target }); return true })
})
afterEach(() => { setShowSender(null) })

describe('showForLink (spec 31 D1)', () => {
  it('a document that said hello gets the place at once, once - and nothing loads, reloads or asks the guard', () => {
    const t = liveTab(w, { entry: { features: SHOW }, busy: { unsaved: true, why: ['typing'] } })
    hello(t)
    show('home')
    expect(showForLink(t.id, T1)).toBe('sent')
    expect(activeTab()).toBe(t)
    expect(sent).toEqual([{ tab: t.id, doc: t.doc!.doc, target: T1 }])
    expect([w.loads, w.reloads, w.acts, w.sheets]).toEqual([[], [], [], []])
    hello(t)
    expect(sent).toHaveLength(1)
  })

  it('held for a document still booting: sent after its hello, to that document alone; a later link replaces it', () => {
    const t = liveTab(w, { entry: { features: SHOW } })
    show('home')
    expect(showForLink(t.id, T1)).toBe('held')
    expect(showForLink(t.id, T2)).toBe('held')
    expect(sent).toEqual([])
    hello(t)
    expect(sent).toEqual([{ tab: t.id, doc: t.doc!.doc, target: T2 }])
    expect(w.loads).toEqual([])
  })

  it('a newer document takes it, never the one it was held for when that one went', () => {
    const t = liveTab(w, { entry: { features: SHOW } })
    showForLink(t.id, T1)
    onCommit(t, { gen: 2, url: `${t.reg!.origin}/`, attributed: true, admitted: 'doc-next' })
    hello(t)
    expect(sent).toEqual([{ tab: t.id, doc: 'doc-next', target: T1 }])
  })

  it('another tab shown first drops it: the place was for the tab the link showed', () => {
    const t = liveTab(w, { entry: { features: SHOW } })
    const u = liveTab(w, { entry: { features: SHOW, slot: 4, port: 4808 } })
    showForLink(t.id, T1)
    show(u.id)
    hello(t)
    expect(sent).toEqual([])
    expect(w.logs.some((l) => l.topic === 'show' && l.data.dropped === 'another tab')).toBe(true)
  })

  it('a canvas before 0.31 (no `show`): shown, its page left alone - never a hash replaced under it', () => {
    const t = liveTab(w, { entry: { features: ['bridge', 'inset', 'live', 'open', 'capture'] } })
    hello(t)
    show('home')
    expect(showForLink(t.id, T1)).toBe('no-show')
    expect(activeTab()).toBe(t)
    expect([sent, w.loads, w.acts]).toEqual([[], [], []])
  })

  it('the canvas\'s own board (`landing`, a link whose place the app could not take) goes over the bridge too', () => {
    const t = liveTab(w, { entry: { features: SHOW } })
    hello(t)
    expect(showForLink(t.id, 'landing')).toBe('sent')
    expect(sent).toEqual([{ tab: t.id, doc: t.doc!.doc, target: 'landing' }])
    expect(w.loads).toEqual([])
  })

  it('no place (mv:front): the tab shown, nothing sent', () => {
    const t = liveTab(w, { entry: { features: SHOW } })
    hello(t)
    show('home')
    expect(showForLink(t.id, null)).toBe('shown')
    expect(activeTab()).toBe(t)
    expect(sent).toEqual([])
  })
})
