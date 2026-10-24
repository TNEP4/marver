import { afterEach, describe, expect, it, vi } from 'vitest'
import { UNSAVED_WHY, WHY } from '../src/shared/app-api.ts'
import { asksBeforeLeaving, busyWhen, busyWhy, guardLeaving, hasUnsavedWork, isUnsaved, leaveNow, onWorkChange, unsavedWhen, unsavedWhy, workChanged } from '../src/client/shell/unsaved.ts'

/**
 * The shell's one registry of unsaved work (spec 28 A2.9, A2.14 #18), without a page: its reasons are the contract's
 * enum, in its order; busy is any reason, unsaved any of the first five; a check that throws holds; a burst of changes
 * is heard once; and the one `beforeunload` asks for unsaved work alone, never for the page's own reload.
 */

const undo: (() => void)[] = []
const when = (...a: Parameters<typeof unsavedWhen>) => { const u = unsavedWhen(...a); undo.push(u); return u }
const busy = (...a: Parameters<typeof busyWhen>) => { const u = busyWhen(...a); undo.push(u); return u }
afterEach(() => { for (const u of undo.splice(0)) u(); vi.useRealTimers() })
const tick = () => new Promise<void>((r) => queueMicrotask(r))

describe('the reasons (A2.14 #18)', () => {
  it('are the contract\'s eight: five unsaved, then three busy and not unsaved', () => {
    expect([...UNSAVED_WHY]).toEqual(['capture-recording', 'capture-unsent', 'board-unsaved', 'heights', 'typing'])
    expect([...WHY]).toEqual([...UNSAVED_WHY, 'jam-session', 'microphone', 'agent'])
    for (const w of WHY) expect(isUnsaved(w), w).toBe((UNSAVED_WHY as readonly string[]).includes(w))
  })

  it('nothing registered: nothing held, nothing busy', () => {
    expect(busyWhy()).toEqual([])
    expect(unsavedWhy()).toEqual([])
    expect(hasUnsavedWork()).toBe(false)
  })

  it('each reason holds while one of its checks answers true, and is listed once, in the contract\'s order', () => {
    let dirty = false, words = false, more = false, mic = false
    when('typing', () => words)
    busy('microphone', () => mic)
    when('board-unsaved', () => dirty)
    when('typing', () => more)   // two checks of one reason (the page's fields and a Jam draft)
    expect(busyWhy()).toEqual([])
    mic = true
    expect([busyWhy(), unsavedWhy(), hasUnsavedWork()]).toEqual([['microphone'], [], false])
    dirty = true; more = true
    expect(busyWhy()).toEqual(['board-unsaved', 'typing', 'microphone'])
    expect(unsavedWhy()).toEqual(['board-unsaved', 'typing'])
    expect(hasUnsavedWork()).toBe(true)
    words = true; more = false
    expect(unsavedWhy()).toEqual(['board-unsaved', 'typing'])
    dirty = false; words = false
    expect([busyWhy(), hasUnsavedWork()]).toEqual([['microphone'], false])
  })

  it('a check that throws holds - what it guards is not known to be safe', () => {
    when('heights', () => { throw new Error('the store is gone') })
    expect(unsavedWhy()).toEqual(['heights'])
  })

  it('unregistered, a reason no longer holds', () => {
    const off = when('capture-unsent', () => true)
    expect(hasUnsavedWork()).toBe(true)
    off()
    expect(hasUnsavedWork()).toBe(false)
  })
})

describe('work changed', () => {
  it('a burst of changes is heard once, a microtask later; later bursts again', async () => {
    let heard = 0
    const off = onWorkChange(() => { heard++ })
    workChanged(); workChanged(); workChanged()
    expect(heard).toBe(0)
    await tick()
    expect(heard).toBe(1)
    busy('agent', () => true)   // registering is a change too
    await tick()
    expect(heard).toBe(2)
    off()
    workChanged()
    await tick()
    expect(heard).toBe(2)
  })

  it('a listener that throws never keeps the others from hearing it', async () => {
    let heard = 0
    const a = onWorkChange(() => { throw new Error('boom') })
    const b = onWorkChange(() => { heard++ })
    workChanged()
    await tick()
    expect(heard).toBe(1)
    a(); b()
  })
})

describe('the one beforeunload', () => {
  const leave = (t: EventTarget) => { const e = new Event('beforeunload', { cancelable: true }); t.dispatchEvent(e); return e.defaultPrevented }

  it('asks while anything unsaved is held - and never for busy alone (a session, the microphone, an agent)', () => {
    const page = new EventTarget()
    guardLeaving(page)
    let held: (typeof UNSAVED_WHY)[number] | null = null
    for (const w of UNSAVED_WHY) when(w, () => held === w)
    let mic = false, agent = false, session = false
    busy('microphone', () => mic); busy('agent', () => agent); busy('jam-session', () => session)
    expect(leave(page)).toBe(false)
    mic = agent = session = true
    expect(leave(page)).toBe(false)
    for (const w of UNSAVED_WHY) {
      held = w
      expect(leave(page), w).toBe(true)
      expect(asksBeforeLeaving(), w).toBe(true)
    }
    held = null
    expect(leave(page)).toBe(false)
  })

  it('the page\'s own reload goes through (leaveNow), and the guard is back a second later should it not have gone', () => {
    vi.useFakeTimers()
    const page = new EventTarget()
    guardLeaving(page)
    when('board-unsaved', () => true)
    let asked: boolean | null = null
    leaveNow(() => { asked = leave(page) })
    expect(asked).toBe(false)
    expect(leave(page)).toBe(false)
    vi.advanceTimersByTime(999)
    expect(leave(page)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(leave(page)).toBe(true)
  })
})
