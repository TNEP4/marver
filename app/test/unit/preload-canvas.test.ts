/**
 * The canvas preload's half of the one ground (src/preload/canvas.ts; spec 28 A3.8 #26, #27), in node with Electron
 * mocked: `topInset` is 44 only for an `mv:doc` answer of 44; `onPresent` hears main's requests for this document
 * alone, each field checked; `presented` posts at once, stamped with the current `doc`, and nothing before an admit -
 * an answer, never held or replayed. The real preload under a real renderer is test/pw/ground.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { CANVAS_CHANNELS } from '../../../src/shared/app-api.ts'

const wire = vi.hoisted(() => ({
  answer: null as unknown,
  sent: [] as { ch: string; msg: unknown }[],
  invoked: [] as { ch: string; msg: unknown }[],
  reply: (): Promise<unknown> => Promise.resolve(null),
  on: new Map<string, (e: unknown, m: unknown) => void>(),
  exposed: null as Record<string, unknown> | null,
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_k: string, api: Record<string, unknown>) => { wire.exposed = api } },
  ipcRenderer: {
    sendSync: () => wire.answer,
    send: (ch: string, msg: unknown) => { wire.sent.push({ ch, msg }) },
    invoke: (ch: string, msg: unknown) => { wire.invoked.push({ ch, msg }); return wire.reply() },
    on: (ch: string, fn: (e: unknown, m: unknown) => void) => { wire.on.set(ch, fn) },
  },
}))

interface Api { topInset: number; onPresent(fn: (r: unknown) => void): () => void; presented(p: unknown): void; hello(p: unknown): void }
async function load(answer: unknown): Promise<Api> {
  vi.resetModules()
  wire.answer = answer
  wire.sent.length = 0
  wire.invoked.length = 0
  wire.on.clear()
  wire.exposed = null
  ;(globalThis as unknown as { location: unknown }).location = { origin: 'http://[::1]:5301' }
  await import('../../src/preload/canvas.ts')
  return wire.exposed as unknown as Api
}
const main = (ch: string, m: unknown) => wire.on.get(ch)!({}, m)
const DOC = 'A'.repeat(22)

describe('the canvas preload: the inset and the presentation (A3.8 #26, #27)', () => {
  it('topInset is 44 only for an answer of 44; 0 for 0, none, a string, any other number, or no answer (app 0.1)', async () => {
    expect((await load({ reopen: false, inset: 44 })).topInset).toBe(44)
    for (const a of [{ reopen: false, inset: 0 }, { reopen: false }, { reopen: false, inset: '44' }, { reopen: false, inset: 12 }, null]) {
      expect((await load(a)).topInset).toBe(0)
    }
  })

  it('onPresent hears requests for this document only, every field checked; presented posts with the current doc, nothing before an admit', async () => {
    const api = await load({ reopen: false, inset: 44 })
    const heard: unknown[] = []
    api.onPresent((r) => heard.push(r))
    api.presented({ epoch: 1, w: 1280, h: 820 })                                       // no admit yet: nothing goes
    expect(wire.sent.filter((s) => s.ch === CANVAS_CHANNELS.presented)).toEqual([])
    main(CANVAS_CHANNELS.present, { doc: DOC, epoch: 1, w: 1280, h: 820, frames: 2 })   // before the admit: not this document's yet
    expect(heard).toEqual([])
    main(CANVAS_CHANNELS.admit, { doc: DOC })
    main(CANVAS_CHANNELS.present, { doc: DOC, epoch: 2, w: 1280, h: 820, frames: 2 })
    main(CANVAS_CHANNELS.present, { doc: 'B'.repeat(22), epoch: 3, w: 1280, h: 820, frames: 2 })   // another document's
    main(CANVAS_CHANNELS.present, { doc: DOC, epoch: 4, w: 1280, h: 820, frames: 0 })                // frames 1-8
    main(CANVAS_CHANNELS.present, { doc: DOC, epoch: 5, w: 1280, h: 820, frames: 9 })
    main(CANVAS_CHANNELS.present, { doc: DOC, epoch: -1, w: 1280, h: 820, frames: 2 })
    main(CANVAS_CHANNELS.present, { doc: DOC, epoch: 6, w: 20_001, h: 820, frames: 2 })
    main(CANVAS_CHANNELS.present, { doc: DOC, epoch: 7, w: '1280', h: 820, frames: 2 })
    expect(heard).toEqual([{ epoch: 2, w: 1280, h: 820, frames: 2 }])
    api.presented({ epoch: 2, w: 1280, h: 820 })
    expect(wire.sent.filter((s) => s.ch === CANVAS_CHANNELS.presented)).toEqual([{ ch: CANVAS_CHANNELS.presented, msg: { doc: DOC, p: { epoch: 2, w: 1280, h: 820 } } }])
    // a new document's admit: the answer goes with the new doc, and nothing earlier is replayed
    const n = wire.sent.length
    main(CANVAS_CHANNELS.admit, { doc: 'C'.repeat(22) })
    expect(wire.sent.slice(n).filter((s) => s.ch === CANVAS_CHANNELS.presented)).toEqual([])
    api.presented({ epoch: 9, w: 1, h: 1 })
    expect((wire.sent.at(-1)!.msg as { doc: string }).doc).toBe('C'.repeat(22))
  })
})

describe('the canvas preload: a notice\'s click (A4.6 #29)', () => {
  const ITEM = { id: `review:${'a'.repeat(20)}`, kind: 'review', board: 'main', cards: ['c1', 'c2'], batch: 'b1', occ: 2 }
  interface OpenApi { onOpen(fn: (p: unknown) => unknown): () => void }
  const opened = () => wire.sent.filter((s) => s.ch === CANVAS_CHANNELS.opened).map((s) => s.msg)
  const flushed = () => new Promise((r) => setTimeout(r, 0))

  it('mv:open reaches onOpen only for this document\'s admitted doc, its item checked, the known fields alone; the answer goes back stamped', async () => {
    const api = await load({ reopen: false, inset: 44 }) as unknown as OpenApi
    const heard: unknown[] = []
    api.onOpen((p) => { heard.push(p); return 'handled' })
    main(CANVAS_CHANNELS.open, { doc: DOC, item: ITEM })   // before the admit: not this document's
    main(CANVAS_CHANNELS.admit, { doc: DOC })
    main(CANVAS_CHANNELS.open, { doc: 'B'.repeat(22), item: ITEM })
    for (const bad of [
      { ...ITEM, kind: 'stopped', id: `stopped:${'a'.repeat(20)}` }, { ...ITEM, id: 'review:xyz' }, { ...ITEM, board: 'b'.repeat(129) },
      { ...ITEM, thread: 'a\nb' }, { ...ITEM, batch: 'x'.repeat(129) }, { ...ITEM, cards: Array.from({ length: 9 }, (_, i) => `c${i}`) },
      { ...ITEM, gen: 1.5 }, { ...ITEM, occ: -1 }, { ...ITEM, msg: 3 },
    ]) main(CANVAS_CHANNELS.open, { doc: DOC, item: bad })
    expect(heard).toEqual([])
    main(CANVAS_CHANNELS.open, { doc: DOC, item: { ...ITEM, title: 'words main never sends', note: 'x' } })
    expect(heard).toEqual([ITEM])
    await flushed()
    expect(opened()).toEqual([{ doc: DOC, p: { id: ITEM.id, result: 'handled' } }])
  })

  it('an async answer goes to the document that was asked; a result that is not one of the five, or a throw, sends nothing', async () => {
    const api = await load({ reopen: false }) as unknown as OpenApi
    let answer: unknown = 'stale'
    let release!: () => void
    const off = api.onOpen(() => new Promise((r) => { release = () => r(answer) }))
    main(CANVAS_CHANNELS.admit, { doc: DOC })
    main(CANVAS_CHANNELS.open, { doc: DOC, item: ITEM })
    release(); await flushed()
    expect(opened()).toEqual([{ doc: DOC, p: { id: ITEM.id, result: 'stale' } }])
    answer = 'opened-ish'
    main(CANVAS_CHANNELS.open, { doc: DOC, item: ITEM })
    release(); await flushed()
    expect(opened()).toHaveLength(1)
    answer = 'busy'
    main(CANVAS_CHANNELS.open, { doc: DOC, item: ITEM })
    main(CANVAS_CHANNELS.admit, { doc: 'C'.repeat(22) })   // another doc meanwhile: the answer was for the one asked
    release(); await flushed()
    expect(opened()).toHaveLength(1)
    off()
    api.onOpen(() => { throw new Error('the page\'s own') })
    main(CANVAS_CHANNELS.open, { doc: 'C'.repeat(22), item: ITEM })
    await flushed()
    expect(opened()).toHaveLength(1)
  })

  it('with no listener (a 0.28 shell) a click answers nothing', async () => {
    await load({ reopen: false })
    main(CANVAS_CHANNELS.admit, { doc: DOC })
    main(CANVAS_CHANNELS.open, { doc: DOC, item: ITEM })
    await flushed()
    expect(opened()).toEqual([])
  })
})

describe('the canvas preload: capture (A4.6 #35)', () => {
  type CaptureApi = { capture(a: unknown): Promise<unknown> }
  const RECT = { x: 10, y: 20, width: 300, height: 200 }
  it('before an admit it answers untrusted and sends nothing; after, mv:capture with the admitted doc and the ask as JSON', async () => {
    const api = await load({ reopen: false }) as unknown as CaptureApi
    expect(await api.capture({ rect: RECT })).toEqual({ ok: false, why: 'untrusted' })
    expect(wire.invoked).toEqual([])
    main(CANVAS_CHANNELS.admit, { doc: DOC })
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
    wire.reply = () => Promise.resolve({ ok: true, png, width: 300, height: 200, extra: 1 })
    expect(await api.capture({ rect: RECT, more: () => 1 })).toEqual({ ok: true, png, width: 300, height: 200 })
    expect(wire.invoked).toEqual([{ ch: CANVAS_CHANNELS.capture, msg: { doc: DOC, p: { rect: RECT } } }])
    expect(wire.sent.filter((x) => x.ch === CANVAS_CHANNELS.capture)).toEqual([])
  })

  it('main\'s answer reaches the page only as the contract types it: its refusals, else untrusted', async () => {
    const api = await load({ reopen: false }) as unknown as CaptureApi
    main(CANVAS_CHANNELS.admit, { doc: DOC })
    for (const why of ['hidden', 'busy', 'bounds', 'empty', 'timeout', 'stale', 'untrusted']) {
      wire.reply = () => Promise.resolve({ ok: false, why })
      expect(await api.capture({ rect: RECT })).toEqual({ ok: false, why })
    }
    const png = Uint8Array.from([1, 2, 3])
    const bad: unknown[] = [
      { ok: false, why: 'nope' }, { ok: true, png: [1, 2, 3], width: 1, height: 1 }, { ok: true, png, width: 4097, height: 1 },
      { ok: true, png, width: 0, height: 1 }, { ok: true, png: new Uint8Array(0), width: 1, height: 1 }, { ok: true, png, width: 1.5, height: 1 }, null, 'ok',
    ]
    for (const b of bad) {
      wire.reply = () => Promise.resolve(b)
      expect(await api.capture({ rect: RECT }), JSON.stringify(b)).toEqual({ ok: false, why: 'untrusted' })
    }
    // an invoke main refused (no handler, the frame gone)
    wire.reply = () => Promise.reject(new Error('refused'))
    expect(await api.capture({ rect: RECT })).toEqual({ ok: false, why: 'untrusted' })
  })
})
