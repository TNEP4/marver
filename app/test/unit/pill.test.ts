/**
 * The strip's one pill (spec 28 A2.2, A2.14 #33): its order, its lifetimes and its revs, with a fake clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRegistry, type Tab } from '../../src/main/tabs.ts'
import { crashReloaded, currentPill, onPillAction, onVisibility, recompute, setCondition } from '../../src/main/pill.ts'
import { liveTab, report, show, world, type World } from './window-fakes.ts'

let w: World
beforeEach(() => { vi.useFakeTimers(); w = world() })
afterEach(() => { vi.useRealTimers() })

const tick = (ms: number) => { w.clock.now += ms; vi.advanceTimersByTime(ms) }
const gone = (t: Tab) => onRegistry({ kind: 'gone', file: t.reg!.file, instance: t.reg!.instance, why: 'pid' })
const held = (t: Tab) => { t.held = { at: w.clock.now, action: 'close' }; recompute() }

describe('the order: the active tab\'s own state, a confirmation, the files, an offer', () => {
  it('not responding, then unsaved work, then stopped - each with a short form (a hung page outranks its own hold)', () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    t.hung = true
    gone(t)
    held(t)
    // the hung page cannot save anyway: its Reload, which asks first, shows over "Unsaved work here"
    expect(currentPill()).toMatchObject({ kind: 'not-responding', short: 'Not responding', button: { label: 'Reload' } })
    t.hung = false; recompute()
    expect(currentPill()).toMatchObject({ kind: 'unsaved', lead: 'Unsaved work here', short: 'Unsaved work' })
    t.held = undefined; recompute()
    expect(currentPill()).toMatchObject({ kind: 'stopped', lead: 'Stopped', short: 'Stopped', button: { label: 'npx marver dev', style: 'cmd' } })
    expect(currentPill()!.tooltip).toMatch(/^cd ~\/repo-\d+ && npx marver dev$/)
    t.hung = true; recompute()
    expect(currentPill()).toMatchObject({ kind: 'not-responding' })
    t.hung = false
    onRegistry({ kind: 'entry', entry: { ...{ file: t.reg!.file, key: Buffer.alloc(32), pid: 1, slot: t.reg!.slot, port: t.reg!.port, origin: t.reg!.origin, url: '', root: t.root!, name: t.name, version: '0.27.1', features: ['bridge'], ws: t.reg!.ws, startedAt: 1 }, state: 'ready', instance: 'back' } })
    expect(currentPill()).toBeNull()
  })

  it('⌘R refused on a hung page with fresh unsaved work: the pill stays Not responding with its Reload, no switch needed', () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    t.hung = true; recompute()
    const r = currentPill()!.rev
    expect(currentPill()).toMatchObject({ kind: 'not-responding' })
    held(t)   // the guard refused the reload: main's own fresh record says unsaved
    expect(currentPill()).toMatchObject({ kind: 'not-responding', rev: r })
  })

  it('a confirmation below tier 1, the files below that, a dismissible offer last', () => {
    show('home')
    setCondition('test', { text: 'Get a notice when a canvas needs you', short: 'Turn On Notices', dismissible: true })
    expect(currentPill()?.kind).toBe('test')
    setCondition('files', { lead: 'Settings not applied', text: 'config.json', short: 'Settings not applied' })
    expect(currentPill()?.kind).toBe('files')
    const t = liveTab(w)
    crashReloaded(t)
    expect(currentPill()).toMatchObject({ kind: 'confirmation', text: 'Reloaded after a crash', short: 'Reloaded', icon: 'check' })
  })

  it('every pill has a short form - never an empty capsule below 960 px', () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    const seen: string[] = []
    held(t); seen.push(currentPill()!.short)
    t.held = undefined; t.hung = true; recompute(); seen.push(currentPill()!.short)
    t.hung = false; crashReloaded(t); seen.push(currentPill()!.short)
    setCondition('files', { lead: 'Files not saved', text: '', short: 'Files not saved' })
    for (const s of seen) expect(s.length).toBeGreaterThan(0)
  })
})

describe('lifetimes (v1.10 r1 #16, A2.14 #33)', () => {
  it('the unsaved pill lasts while the page says unsaved; a record not fresh, 10 s; its tab no longer active ends it', () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    held(t)
    tick(60_000)
    expect(currentPill()?.kind).toBe('unsaved')
    report(t, false)
    recompute()
    expect(currentPill()).toBeNull()
    const s = liveTab(w, { busy: null })
    held(s)
    tick(9_000)
    expect(currentPill()?.kind).toBe('unsaved')
    tick(1_100)
    expect(currentPill()).toBeNull()
    held(s)
    show('home')
    expect(currentPill()).toBeNull()
    show(s.id)
    expect(currentPill()).toBeNull()
  })

  it('a confirmation shown under an unsaved pill waits, then shows its full 4 s', () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    held(t)
    crashReloaded(t)
    tick(10_000)
    expect(currentPill()?.kind).toBe('unsaved')
    report(t, false); recompute()
    expect(currentPill()?.kind).toBe('confirmation')
    tick(3_900)
    expect(currentPill()?.kind).toBe('confirmation')
    tick(200)
    expect(currentPill()).toBeNull()
  })

  it('pushed off part-way, it keeps what it has left', () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    crashReloaded(t)
    tick(3_000)
    held(t)
    tick(5_000)
    report(t, false); recompute()
    expect(currentPill()?.kind).toBe('confirmation')
    tick(900)
    expect(currentPill()?.kind).toBe('confirmation')
    tick(200)
    expect(currentPill()).toBeNull()
  })

  it('one not shown within 30 s is dropped; its record stays', () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    held(t)
    t.crash.count = 1
    crashReloaded(t)
    tick(31_000)
    report(t, false); recompute()
    expect(currentPill()).toBeNull()
    expect(t.crash.count).toBe(1)
  })

  it('counts down only while the window is seen', () => {
    const t = liveTab(w)
    crashReloaded(t)
    w.visible = false; onVisibility()
    tick(20_000)
    w.visible = true; onVisibility()
    expect(currentPill()?.kind).toBe('confirmation')
    tick(4_100)
    expect(currentPill()).toBeNull()
  })

  it('a newer confirmation of the same kind replaces the waiting one', () => {
    const t = liveTab(w, { busy: { unsaved: true } })
    held(t)
    crashReloaded(t)
    tick(1000)
    crashReloaded(t)
    report(t, false); recompute()
    tick(4_100)
    expect(currentPill()).toBeNull()
  })
})

describe('revs: a click acts on main\'s own record of that rev (v1.10 r1 #10)', () => {
  it('the Stopped button copies the pill\'s own tab\'s command; after a switch the old rev is refused', () => {
    const a = liveTab(w)
    gone(a)
    const rev = currentPill()!.rev
    expect(onPillAction(rev, 'button')).toBe(true)
    expect(w.copies).toEqual([a.id])
    const b = liveTab(w)
    gone(b)
    expect(onPillAction(rev, 'button')).toBe(false)
    expect(w.copies).toEqual([a.id])
  })

  it('the same pill keeps its rev; a different one gets a new rev', () => {
    const a = liveTab(w)
    gone(a)
    const r1 = currentPill()!.rev
    recompute(); recompute()
    expect(currentPill()!.rev).toBe(r1)
    a.hung = true; a.held = { at: w.clock.now, action: 'close' }; recompute()
    expect(currentPill()!.rev).toBeGreaterThan(r1)
  })

  it('a dismissible pill closes with its × (or Esc) and stays closed; a pill that is not dismissible ignores it', () => {
    show('home')
    setCondition('files', { lead: 'Settings not applied', text: '', short: 'Settings not applied' })
    expect(onPillAction(currentPill()!.rev, 'dismiss')).toBe(false)
    setCondition('files', null)
    setCondition('test', { text: 'Offer', short: 'Offer', dismissible: true })
    expect(onPillAction(currentPill()!.rev, 'dismiss')).toBe(true)
    expect(currentPill()).toBeNull()
    setCondition('test', { text: 'Offer', short: 'Offer', dismissible: true })
    expect(currentPill()).toBeNull()
  })
})
