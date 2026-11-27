/**
 * The draw host's sync (spec 38, review r1 #1-#3, #8, #11, #12): saves acknowledge only what they sent; revs apply in
 * order; protected elements keep the server's later state aside and apply it once the protection lifts; a full
 * snapshot replaces; nothing is lost before the engine is ready; drain waits for the last save.
 */
import { describe, expect, it } from 'vitest'
import { DrawSync, type SyncEngine } from '../src/client/draw-host/sync.ts'
import type { DrawElement, DrawPatch } from '../src/shared/draw-protocol.ts'

const el = (id: string, version: number, extra: Record<string, unknown> = {}): DrawElement => ({ id, type: 'rectangle', version, versionNonce: version, x: 0, y: 0, ...extra })

class FakeEngine implements SyncEngine {
  els = new Map<string, DrawElement>()
  constructor(initial: DrawElement[]) { for (const e of initial) this.els.set(e.id, { ...e }) }
  elements() { return [...this.els.values()] }
  appState() { return { selectedElementIds: {} } }
  files() { return {} }
  applyRemote(ups: DrawElement[], dels: { id: string; version: number }[], protect: Set<string>) {
    for (const u of ups) if (!protect.has(u.id)) this.els.set(u.id, { ...u })
    for (const d of dels) if (!protect.has(d.id)) { const m = this.els.get(d.id); if (m) this.els.set(d.id, { ...m, isDeleted: true, version: d.version }) }
  }
  /** the person edits */
  edit(id: string, patch: Record<string, unknown> = {}) { const e = this.els.get(id)!; this.els.set(id, { ...e, ...patch, version: e.version + 1 }) }
}

function harness(initial: DrawElement[], opts: { rev?: number } = {}) {
  const eng = new FakeEngine(initial)
  const puts: { body: any; resolve: (a: { rev: number; patches?: DrawPatch[] }) => void }[] = []
  const sinces: { rev: number; resolve: (a: { rev: number; patches: DrawPatch[] }) => void }[] = []
  let ready = true
  const sync = new DrawSync(() => (ready ? eng : null), {
    put: (body) => new Promise((resolve) => { puts.push({ body: JSON.parse(JSON.stringify(body)), resolve }) }),
    since: (rev) => new Promise((resolve) => { sinces.push({ rev, resolve }) }),
  }, opts.rev ?? 0, initial, true)
  return { eng, sync, puts, sinces, setReady: (r: boolean) => { ready = r } }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('the draw host sync', () => {
  it('acknowledges only the versions a save actually sent (r1 #1)', async () => {
    const { eng, sync, puts } = harness([el('a', 1)])
    eng.edit('a', { x: 10 })                  // v2
    void sync.flush()
    expect(puts[0].body.upserts[0].version).toBe(2)
    eng.edit('a', { x: 20 })                  // v3, while the save is in flight
    puts[0].resolve({ rev: 1, patches: [{ frame: 'f', rev: 1, by: 'owner', upserts: [el('a', 2, { x: 10 })], deletes: [] }] })
    await tick(); await tick()
    expect(eng.els.get('a')!.x).toBe(20)      // the newer edit stays
    // and it is saved next: still dirty
    void sync.flush()
    await tick()
    expect(puts[1]?.body.upserts[0]).toMatchObject({ id: 'a', version: 3, x: 20 })
  })

  it("keeps an agent's change to a protected element aside and applies it once the save is confirmed (r1 #2)", async () => {
    const { eng, sync, puts, sinces } = harness([el('a', 1)])
    eng.edit('a', { x: 10 })
    void sync.flush()
    // while the PUT waits: the owner rev comes back, then the agent's CLI edit of the same element
    sync.receive({ frame: 'f', rev: 1, by: 'owner', upserts: [el('a', 2, { x: 10 })], deletes: [] })
    sync.receive({ frame: 'f', rev: 2, by: 'agent', upserts: [el('a', 3, { x: 99 })], deletes: [] })
    expect(eng.els.get('a')!.x).toBe(10)      // not under the person while protected
    // RC 0.39: a drawing confirms it shows an edit only once nothing is kept aside - not while the agent's waits
    const before = sync.confirm()
    await tick()
    sinces.at(-1)!.resolve({ rev: 2, patches: [] })
    expect(await before).toBe(false)
    puts[0].resolve({ rev: 2, patches: [] })
    await tick(); await tick()
    expect(eng.els.get('a')!.x).toBe(99)      // the agent's later change, applied after
    const after = sync.confirm()
    await tick()
    sinces.at(-1)!.resolve({ rev: 2, patches: [] })
    expect(await after).toBe(true)
  })

  it('confirm is false when the catch-up fails, and waits for a fresh one when one is already running (RC 0.39)', async () => {
    const { sync, sinces } = harness([el('a', 1)], { rev: 3 })
    sync.resync()                             // a catch-up already under way, from before the ask
    const c = sync.confirm()
    await tick()
    sinces[0].resolve({ rev: 3, patches: [] })
    await tick(); await tick()
    expect(sinces.length).toBe(2)             // a fresh one for the confirm
    sinces[1].resolve({ rev: 4, patches: [{ frame: 'f', rev: 4, by: 'agent', upserts: [el('b', 1)], deletes: [] }] })
    expect(await c).toBe(true)
    // the server unreachable: it cannot tell, so it says no
    const harness2 = harness([el('a', 1)])
    const failing = new (sync.constructor as any)(() => harness2.eng, { put: async () => ({ rev: 0 }), since: async () => { throw new Error('offline') } }, 0, [el('a', 1)], true)
    expect(await failing.confirm()).toBe(false)
  })

  it('applies revs in order, holding an early one until the gap closes (r1 #3)', () => {
    const { eng, sync } = harness([el('a', 1)])
    sync.receive({ frame: 'f', rev: 2, by: 'agent', upserts: [el('a', 3, { x: 2 })], deletes: [] })
    expect(eng.els.get('a')!.x).toBe(0)
    sync.receive({ frame: 'f', rev: 1, by: 'agent', upserts: [el('a', 2, { x: 1 })], deletes: [] })
    expect(eng.els.get('a')!.x).toBe(2)
    expect(sync.rev).toBe(2)
  })

  it('a full snapshot replaces what is not protected, deleting what it does not hold (r1 #11)', () => {
    const { eng, sync } = harness([el('a', 1), el('b', 1)])
    sync.receive({ frame: 'f', rev: 9, by: 'server', upserts: [el('a', 5, { x: 5 })], deletes: [], full: true })
    expect(eng.els.get('a')!.x).toBe(5)
    expect(eng.els.get('b')!.isDeleted).toBe(true)
    expect(sync.rev).toBe(9)
  })

  it('a rev that arrives before the engine is ready waits for it (r1 #12)', () => {
    const h = harness([el('a', 1)])
    h.setReady(false)
    h.sync.receive({ frame: 'f', rev: 1, by: 'agent', upserts: [el('a', 2, { x: 7 })], deletes: [] })
    h.setReady(true)
    h.sync.ready()
    expect(h.eng.els.get('a')!.x).toBe(7)
  })

  it('drain waits until the last save is done (r1 #6)', async () => {
    const { eng, sync, puts } = harness([el('a', 1)])
    eng.edit('a', { x: 1 })
    let drained = false
    void sync.flush().then(() => { drained = true })
    eng.edit('a', { x: 2 })                   // a second stroke while the first save waits
    await tick()
    expect(drained).toBe(false)
    puts[0].resolve({ rev: 1, patches: [] })
    await tick(); await tick()
    expect(drained).toBe(false)               // the second stroke is being saved now
    expect(puts[1]?.body.upserts[0]).toMatchObject({ x: 2 })
    puts[1].resolve({ rev: 2, patches: [] })
    await tick(); await tick()
    expect(drained).toBe(true)
  })

  it("a rev's version is acknowledged at once - a later edit by the person is still saved (r1 #8)", async () => {
    const { eng, sync, puts } = harness([el('a', 1)])
    sync.receive({ frame: 'f', rev: 1, by: 'agent', upserts: [el('a', 2, { x: 5 })], deletes: [] })
    eng.edit('a', { x: 6 })                   // v3, before any animation frame
    void sync.flush()
    await tick()
    expect(puts[0]?.body.upserts[0]).toMatchObject({ id: 'a', version: 3, x: 6 })
  })

  it('a kept-aside echo of an older save never rolls back a newer one (r2 #1)', async () => {
    const { eng, sync, puts } = harness([el('a', 1)])
    eng.edit('a', { x: 2 })                   // v2
    void sync.flush()
    sync.receive({ frame: 'f', rev: 1, by: 'owner', upserts: [{ ...eng.els.get('a')! }], deletes: [] })   // its echo, deferred
    eng.edit('a', { x: 3 })                   // v3 while the first save waits
    puts[0].resolve({ rev: 1, patches: [] })
    await tick(); await tick()
    void sync.flush()
    await tick()
    puts[1].resolve({ rev: 2, patches: [{ frame: 'f', rev: 2, by: 'owner', upserts: [el('a', 3, { x: 3 })], deletes: [] }] })
    await tick(); await tick()
    expect(eng.els.get('a')).toMatchObject({ version: 3, x: 3 })
  })

  it('an obsolete full snapshot is ignored and the rev never goes back (r2 #2)', () => {
    const { eng, sync } = harness([el('a', 1)])
    sync.receive({ frame: 'f', rev: 1, by: 'agent', upserts: [el('a', 2, { x: 9 })], deletes: [] })
    sync.receive({ frame: 'f', rev: 1, by: 'server', upserts: [el('a', 1, { x: 0 })], deletes: [], full: true })
    expect(eng.els.get('a')!.x).toBe(9)
    expect(sync.rev).toBe(1)
  })

  it('a failed save retries once, on a backoff - never in a loop (r2 #4)', async () => {
    const eng = new FakeEngine([el('a', 1)])
    let puts = 0
    const sync = new DrawSync(() => eng, { put: async () => { puts++; throw new Error('down') }, since: async () => ({ rev: 0, patches: [] }) }, 0, [el('a', 1)], true)
    eng.edit('a', { x: 1 })
    void sync.flush()
    for (let i = 0; i < 20; i++) await tick()
    expect(puts).toBe(1)
  })

  it("a rev touching what the person holds waits for pointer-up (r2 #5)", () => {
    const eng = new FakeEngine([el('a', 1)])
    eng.appState = () => ({ selectedElementIds: { a: true } })
    const sync = new DrawSync(() => eng, { put: async () => ({ rev: 0 }), since: async () => ({ rev: 0, patches: [] }) }, 0, [el('a', 1)], true)
    sync.pointer(true)
    sync.receive({ frame: 'f', rev: 1, by: 'agent', upserts: [el('a', 2, { x: 4 })], deletes: [] })
    expect(eng.els.get('a')!.x).toBe(0)       // held
    sync.pointer(false)
    expect(eng.els.get('a')!.x).toBe(4)       // applied at pointer-up
  })
})
