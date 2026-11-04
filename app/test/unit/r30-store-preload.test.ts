/**
 * Spec 30 #38: the 1.0.1 canvas preload's `perfInfo()` says `watch: true` - the only thing that lets a 0.30 shell send
 * `mv:perf watch` (app 1.0.0 would refuse it and spend the tab's bucket) - beside the `hz` it always answered.
 */
import { describe, expect, it, vi } from 'vitest'

const wire = vi.hoisted(() => ({ exposed: null as Record<string, unknown> | null }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_k: string, api: Record<string, unknown>) => { wire.exposed = api } },
  ipcRenderer: { sendSync: () => null, send() {}, invoke: () => Promise.resolve(null), on() {} },
}))

describe('the canvas preload: perfInfo (#38)', () => {
  it('answers watch: true, and hz null until main said it', async () => {
    ;(globalThis as unknown as { location: unknown }).location = { origin: 'http://[::1]:5301' }
    await import('../../src/preload/canvas.ts')
    const api = wire.exposed as unknown as { perfInfo(): { hz: number | null; watch?: boolean } }
    expect(api.perfInfo()).toEqual({ hz: null, watch: true })
  })
})
