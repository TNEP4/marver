import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DrawService, type LogEntry } from '../src/server/draw/service.ts'
import { emptyDoc, parseDrawFile, serializeDrawFile, wholeElement, type DrawDoc } from '../src/server/draw/file.ts'
import type { DrawElement } from '../src/shared/draw-protocol.ts'

const ID = 'checkout/flow'
const FILE = 'design/scenes/checkout/flow.excalidraw'
const el = (id: string, fields: Record<string, unknown> = {}) => wholeElement({ id, type: 'rectangle', index: 'a0', ...fields }, 'owner', 100)
let root: string, abs: string, service: DrawService, clock: number
const broadcast = vi.fn(), headerChanged = vi.fn()
const makeService = () => new DrawService({ root, fileOf: (id) => id === ID ? FILE : null, broadcast, headerChanged, now: () => ++clock })
const disk = () => parseDrawFile(readFileSync(abs, 'utf8'))
const log = (): LogEntry[] => {
  const dir = join(root, 'design/.local/draw')
  const path = readdirSync(dir).find((f) => f.endsWith('.jsonl'))!
  return readFileSync(join(dir, path), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
}
const writeAgent = (doc: DrawDoc) => {
  writeFileSync(abs, serializeDrawFile(doc))
  // Make the watcher signal deterministic, even on filesystems with a coarse mtime clock.
  const at = new Date(1_700_000_000_000 + ++clock * 1000)
  utimesSync(abs, at, at)
}
const save = (upserts: DrawElement[], seq: number, baseRev = seq - 1) => service.save(ID, { baseRev, upserts, deletes: [] }, 'tab', seq)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mv-draw-service-'))
  abs = join(root, FILE)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, serializeDrawFile(emptyDoc({ epoch: 'test-history' })))
  clock = 1000
  broadcast.mockClear(); headerChanged.mockClear()
  service = makeService()
})
afterEach(() => { service.stop(); rmSync(root, { recursive: true, force: true }) })

describe('DrawService', () => {
  it('saves one revision to the file and log, then broadcasts that same patch', async () => {
    const answer = await service.save(ID, { baseRev: 0, upserts: [el('cart')], deletes: [], header: { title: 'Cart', size: { w: 1200, h: 800 } } }, 'tab', 1)
    expect(answer.rev).toBe(1)
    expect(disk().header).toMatchObject({ rev: 1, epoch: 'test-history', title: 'Cart', size: { w: 1200, h: 800 } })
    expect(disk().elements.get('cart')).toMatchObject({ version: 1, customData: { mv: { by: 'owner' } } })
    expect(log()).toHaveLength(1)
    expect(log()[0]).toMatchObject({ rev: 1, by: 'owner', via: 'frame', ops: [{ id: 'cart', v: 1 }] })
    expect(answer.patches).toHaveLength(1)
    expect(broadcast).toHaveBeenCalledExactlyOnceWith('sh:draw', answer.patches[0])
    expect(headerChanged).toHaveBeenCalledExactlyOnceWith(ID)
  })

  it('drops retried and out-of-order saves per sid without writing a revision', async () => {
    await save([el('cart')], 2, 0)
    const text = readFileSync(abs, 'utf8')
    for (const seq of [2, 1]) expect((await save([el('cart', { x: 99 })], seq, 0)).rev).toBe(1)
    expect(readFileSync(abs, 'utf8')).toBe(text)
    expect(log()).toHaveLength(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect((await service.save(ID, { baseRev: 1, upserts: [el('cart', { x: 40 })], deletes: [] }, 'other-tab', 1)).rev).toBe(2)
  })

  it('ingests a stale agent file three-way: applies edits/deletes, keeps person additions and reports lost edits', async () => {
    await save([el('cart'), el('agent-edit', { index: 'a1' }), el('agent-delete', { index: 'a2' })], 1)
    const stale = disk()
    await save([el('cart', { x: 80, version: 2 }), el('person-added', { index: 'a3' })], 2)
    stale.elements.set('cart', { ...stale.elements.get('cart')!, x: 200 })
    stale.elements.set('agent-edit', { ...stale.elements.get('agent-edit')!, y: 40 })
    stale.elements.delete('agent-delete')
    writeAgent(stale)
    await service.onDisk(abs)
    const state = await service.get(ID)
    expect(state.rev).toBe(3)
    expect(new Map(state.elements.map((e) => [e.id, e])).get('cart')?.x).toBe(80)
    expect(disk().elements.get('agent-edit')?.y).toBe(40)
    expect([...disk().elements.keys()].sort()).toEqual(['agent-edit', 'cart', 'person-added'])
    expect(log()[2]).toMatchObject({ via: 'file', by: 'agent', lost: [{ id: 'cart', by: 'owner', rev: 2 }] })
    const text = await service.describe(ID, 1)
    expect(text).toContain("1 change of yours lost to the person's edit")
    expect(text).toContain('cart (rev 2)')
    expect(text).toContain('Changes since rev 1:')
    expect(text).toContain('deleted agent-delete')
    expect(text).toContain(`npx marver shot ${ID}`)
    expect(await service.describe(ID)).not.toContain('lost to')
  })

  it('does not ingest its own write again, even when the watcher reports a changed mtime', async () => {
    await save([el('cart')], 1)
    const text = readFileSync(abs, 'utf8')
    const at = new Date(1_700_000_000_000)
    utimesSync(abs, at, at)
    await service.onDisk(abs)
    expect((await service.get(ID)).rev).toBe(1)
    expect(readFileSync(abs, 'utf8')).toBe(text)
    expect(log()).toHaveLength(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('absorbs an agent file before an owner save so unrelated edits survive the write', async () => {
    await save([el('cart'), el('agent-edit', { index: 'a1' })], 1)
    const edited = disk()
    edited.elements.set('agent-edit', { ...edited.elements.get('agent-edit')!, x: 25 })
    writeAgent(edited)
    const result = await save([el('cart', { y: 50, version: 2 })], 2)
    expect(result.rev).toBe(3)
    expect(disk().elements.get('cart')?.y).toBe(50)
    expect(disk().elements.get('agent-edit')?.x).toBe(25)
    expect(log().map((l) => l.via)).toEqual(['frame', 'file', 'frame'])
  })

  it('rebuilds a file behind its log on reopen, including deletes and header changes', async () => {
    const before = readFileSync(abs, 'utf8')
    await save([el('cart'), el('gone', { index: 'a1' })], 1)
    await service.save(ID, { baseRev: 1, upserts: [el('cart', { x: 70, version: 2 })], deletes: [{ id: 'gone', version: 2 }], header: { title: 'Recovered' } }, 'tab', 2)
    const expected = disk()
    service.stop()
    writeFileSync(abs, before) // crash after log append, before file rename
    service = makeService()
    expect((await service.get(ID)).rev).toBe(2)
    expect(disk()).toEqual(expected)
    expect(log()).toHaveLength(2)
    expect((await service.since(ID, 1)).patches[0].deletes).toEqual([{ id: 'gone', version: 2 }])
  })

  it('adds, sets, moves and removes by opId without applying a retry twice', async () => {
    const add = { kind: 'add' as const, elements: [{ id: 'cart', type: 'rectangle', x: 20, y: 30 }], at: { x: 100, y: 200 } }
    expect(await service.op(ID, add, 'add-1')).toEqual({ rev: 1, ids: ['cart'] })
    expect(await service.op(ID, add, 'add-1')).toEqual({ rev: 1, ids: [] })
    const set = { kind: 'set' as const, id: 'cart', fields: { strokeColor: '#f00', id: 'wrong', version: 100 } }
    expect(await service.op(ID, set, 'set-1')).toEqual({ rev: 2, ids: ['cart'] })
    expect(await service.op(ID, set, 'set-1')).toEqual({ rev: 2, ids: [] })
    const move = { kind: 'move' as const, ids: ['cart'], dx: -10, dy: 50 }
    expect(await service.op(ID, move, 'move-1')).toEqual({ rev: 3, ids: ['cart'] })
    expect(await service.op(ID, move, 'move-1')).toEqual({ rev: 3, ids: [] })
    expect(disk().elements.get('cart')).toMatchObject({ id: 'cart', x: 90, y: 250, strokeColor: '#f00', version: 3 })
    const rm = { kind: 'rm' as const, ids: ['cart'] }
    expect(await service.op(ID, rm, 'rm-1')).toEqual({ rev: 4, ids: ['cart'] })
    expect(await service.op(ID, rm, 'rm-1')).toEqual({ rev: 4, ids: [] })
    expect(disk().elements.size).toBe(0)
    expect(log().map((l) => [l.rev, l.via])).toEqual([[1, 'cli'], [2, 'cli'], [3, 'cli'], [4, 'cli']])
    expect(broadcast).toHaveBeenCalledTimes(4)
  })

  it('removes bound labels with the container and repairs arrows left behind', async () => {
    await service.op(ID, { kind: 'add', elements: [{ id: 'cart' }, { id: 'label', type: 'text', text: 'Cart', containerId: 'cart' }, { id: 'arrow', type: 'arrow', startBinding: { elementId: 'cart', focus: 0, gap: 4 } }] }, 'add')
    await service.op(ID, { kind: 'set', id: 'label', fields: { text: 'Checkout' } }, 'label')
    expect(disk().elements.get('label')?.originalText).toBe('Checkout')
    await service.op(ID, { kind: 'rm', ids: ['cart'] }, 'rm')
    expect([...disk().elements.keys()]).toEqual(['arrow'])
    expect(disk().elements.get('arrow')?.startBinding).toBeNull()
  })

  it('returns ordered patches since a revision and none when already current', async () => {
    await save([el('cart')], 1)
    await service.op(ID, { kind: 'move', ids: ['cart'], dx: 10, dy: 20 }, 'move')
    await service.op(ID, { kind: 'rm', ids: ['cart'] }, 'rm')
    const answer = await service.since(ID, 1)
    expect(answer.rev).toBe(3)
    expect(answer.patches.map((p) => p.rev)).toEqual([2, 3])
    expect(answer.patches[0].upserts[0]).toMatchObject({ id: 'cart', x: 10, y: 20 })
    expect(answer.patches[1].deletes).toEqual([{ id: 'cart', version: 3 }])
    expect(await service.since(ID, 3)).toEqual({ rev: 3, patches: [] })
  })

  it('returns one full patch when the local log is too short', async () => {
    const doc = emptyDoc({ rev: 10, epoch: 'imported-history', title: 'Imported' })
    doc.elements.set('cart', el('cart'))
    writeFileSync(abs, serializeDrawFile(doc))
    await service.op(ID, { kind: 'add', elements: [{ id: 'other' }] }, 'add')
    const result = await service.since(ID, 1)
    expect(result.rev).toBe(11)
    expect(result.patches).toHaveLength(1)
    expect(result.patches[0]).toMatchObject({ frame: ID, rev: 11, by: 'server', header: { title: 'Imported' }, deletes: [], files: {} })
    expect(result.patches[0].upserts.map((e) => e.id)).toEqual(['cart', 'other'])
  })

  it('resolves files through the manifest and rejects unknown drawings', async () => {
    await expect(service.get('unknown/frame')).rejects.toThrow('no drawing "unknown/frame"')
  })

  // BUG src/server/draw/service.ts:329: no accepted ops means absorb returns without restoring the rejected file.
  // rev 1 x=0 -> owner rev 2 x=80 -> agent writes rev 1 x=200: memory keeps 80, disk incorrectly keeps 200.
  it('restores the person version on disk when every agent edit loses', async () => {
    await save([el('cart')], 1)
    const stale = disk()
    await save([el('cart', { x: 80, version: 2 })], 2)
    stale.elements.set('cart', { ...stale.elements.get('cart')!, x: 200 })
    writeAgent(stale)
    await service.onDisk(abs)
    expect((await service.get(ID)).elements[0].x).toBe(80)
    expect(disk().elements.get('cart')?.x).toBe(80)
  })
})

describe('DrawService - review r1 regressions', () => {
  it('merges an edit made to the file while the server was down, instead of overwriting it (r1 #4)', async () => {
    await save([el('a', { x: 0 })], 1)
    // an agent's no-rewrite edit: the file holds its text, the log is ahead of the header
    const doc = disk(); doc.elements.set('b', el('b', { index: 'a1' })); writeAgent(doc)
    await service.onDisk(abs)
    const revBefore = log().at(-1)!.rev
    service.stop()
    // offline: the agent edits again
    const offline = disk(); offline.elements.set('c', el('c', { index: 'a2', x: 300 })); writeAgent(offline)
    service = makeService()
    const got = await service.get(ID)
    expect(got.elements.map((e) => e.id).sort()).toEqual(['a', 'b', 'c'])
    expect(got.rev).toBeGreaterThan(revBefore)
    expect(disk().elements.has('c')).toBe(true)
  })

  it('refuses a stale agent file bringing back what another write deleted after its base (r1 #9)', async () => {
    await save([el('a'), el('b', { index: 'a1' })], 1)
    const stale = disk()                                   // the agent reads at rev 1
    await service.op(ID, { kind: 'rm', ids: ['b'] }, 'op-1')  // rev 2: a CLI delete
    stale.elements.set('b', el('b', { index: 'a1', x: 500 }))  // the stale file changes b
    stale.elements.set('a', el('a', { x: 77 }))
    writeAgent(stale)
    await service.onDisk(abs)
    const got = await service.get(ID)
    expect(got.elements.some((e) => e.id === 'b')).toBe(false)
    expect(got.elements.find((e) => e.id === 'a')!.x).toBe(77)
  })

  it('re-adding a box and its label gives both new ids and the label follows its box (r1 #13)', async () => {
    const box = { id: 'box', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, boundElements: [{ id: 'lbl', type: 'text' }] }
    const lbl = { id: 'lbl', type: 'text', x: 10, y: 10, text: 'Hi', containerId: 'box' }
    await service.op(ID, { kind: 'add', elements: [box, lbl] }, 'add-1')
    const r = await service.op(ID, { kind: 'add', elements: [box, lbl] }, 'add-2')
    const got = await service.get(ID)
    const [nb, nl] = r.ids.map((id) => got.elements.find((e) => e.id === id)!)
    expect(nb.id).not.toBe('box')
    expect(nl.containerId).toBe(nb.id)
    expect((nb.boundElements as { id: string }[]).map((b) => b.id)).toContain(nl.id)
  })

  it('old bytes of ours written back are a change, reconciled to the truth (r1 #10)', async () => {
    await save([el('a')], 1)
    const rev1 = readFileSync(abs, 'utf8')
    await save([el('a'), el('stroke', { index: 'a1' })], 2)
    writeFileSync(abs, rev1)                               // the exact rev-1 bytes come back
    const at = new Date(1_700_000_000_000 + ++clock * 1000); utimesSync(abs, at, at)
    await service.onDisk(abs)
    expect(disk().elements.has('stroke')).toBe(true)
  })

  it('never writes over a file that changed under it: the change is merged first (r1 #5)', async () => {
    await save([el('a')], 1)
    // an agent's write lands without the watcher having told us yet
    const doc = disk(); doc.elements.set('agent', el('agent', { index: 'a1' }))
    writeFileSync(abs, serializeDrawFile(doc))
    await save([el('a', { x: 5 }), el('mine', { index: 'a2' })], 2)
    const got = await service.get(ID)
    expect(got.elements.map((e) => e.id).sort()).toEqual(['a', 'agent', 'mine'])
    expect([...disk().elements.keys()].sort()).toEqual(['a', 'agent', 'mine'])
  })
})
