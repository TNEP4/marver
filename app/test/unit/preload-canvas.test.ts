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
  on: new Map<string, (e: unknown, m: unknown) => void>(),
  exposed: null as Record<string, unknown> | null,
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_k: string, api: Record<string, unknown>) => { wire.exposed = api } },
  ipcRenderer: {
    sendSync: () => wire.answer,
    send: (ch: string, msg: unknown) => { wire.sent.push({ ch, msg }) },
    on: (ch: string, fn: (e: unknown, m: unknown) => void) => { wire.on.set(ch, fn) },
  },
}))

interface Api { topInset: number; onPresent(fn: (r: unknown) => void): () => void; presented(p: unknown): void; hello(p: unknown): void }
async function load(answer: unknown): Promise<Api> {
  vi.resetModules()
  wire.answer = answer
  wire.sent.length = 0
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
