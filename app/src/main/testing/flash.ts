/**
 * Mark a Flash's and the white-out detector's test hooks (spec 28 A3.7; dev builds with MARVER_APP_TEST=1 only).
 * Owner: the flash stream.
 *
 * - `flash:mark { via?, wait? }`: the transaction through the app's own ports (flash-ports.ts: captureApp, the
 *   pictures' folder, the strip's pill), the recorder's half stood in by what this hook can read without it (the
 *   sampler's last sample, else one `getAppMetrics()`); the record kept here and in the journal's `flash` topic.
 *   `recorder.markFlash` (⌃⌥F, the menu, the `command` hook) is the recorder stream's composition of the same ports.
 * - `flash:records`: the records so far; `flash:quit`: `quitFlashes()` now, as will-quit does.
 * - `picture:app { width?, path }`: captureApp's picture written to an absolute path the case names.
 */
import { writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { app, webContents } from 'electron'
import type { AppBody, Sample } from '../../../../src/shared/app-perf.ts'
import { values, type Home } from '../config.ts'
import { flashPorts, perfDirOf } from '../flash-ports.ts'
import { markFlash, quitFlashes } from '../flashes.ts'
import { readAgx } from '../machine.ts'
import { lastPressure } from '../pressure.ts'
import { recorder, sampler } from '../recorder.ts'
import { captureApp, contentView, mainWindow } from '../window.ts'
import { provide } from './index.ts'

const records: AppBody<'flash'>[] = []

/** One getAppMetrics() as a Sample, for when the sampler has none yet (the recorder stream's is the real one). */
function metricsNow(): Sample {
  const now = Date.now()
  const m = app.getAppMetrics()
  const gpu = m.find((x) => x.type === 'GPU')
  return {
    ts: now, mono: performance.now(), dt: null,
    procs: m.map((x) => ({ pid: x.pid, born: x.creationTime, type: x.type === 'Browser' ? 'browser' : x.type === 'GPU' ? 'gpu' : x.type === 'Utility' ? 'utility' : x.type === 'Tab' ? 'renderer' : 'other', role: 'unknown', tabs: [], cpu: null, rssMB: x.memory.workingSetSize / 1024, footprintMB: null })),
    gpu: gpu ? { pid: gpu.pid, born: gpu.creationTime, cpu: null, gpuProcessRssMB: gpu.memory.workingSetSize / 1024 } : null,
    pressure: null, thermal: 'unknown', sys: null, visible: null,
  }
}

export function provideFlashHooks(home: Home): void {
  if (!__MV_TEST__) return
  const ports = () => flashPorts({
    flavour: __MARVER_RELEASE__ ? 'release' : 'dev', perfDir: perfDirOf(home.dir),
    recorderOn: () => values().config.recorder,
    ring: () => { const s = sampler.last(); return { samples: s ? [s] : [], events: [] } },
    stateNow: () => sampler.last() ?? metricsNow(),
    gpuEvents: (from, to) => recorder.gpuEvents(from, to),
    pressure: () => lastPressure(),
    readAgx: (ms) => readAgx(ms),
    append: (b) => { records.push(b) },
  })
  provide('flash:mark', async (a) => {
    const o = (a ?? {}) as { via?: 'key' | 'menu'; wait?: boolean }
    const done = markFlash(o.via ?? 'menu', ports())
    if (o.wait !== false) await done
    return true
  })
  provide('flash:records', () => records)
  provide('flash:quit', () => { quitFlashes(); return records.length })
  // the budgets' roles in a dev build (A3.8 #48, #49): each canvas tab's main-frame and subframe processes, and the
  // app pages'. The signed build has no hook: there the roles come from the recorder's own sample lines
  provide('procs:roles', () => {
    const canvas = new Set<number>()
    const pages = new Set<number>()
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue
      const url = wc.getURL()
      const pids = new Set<number>([wc.getOSProcessId()])
      try { for (const f of wc.mainFrame.framesInSubtree) pids.add(f.osProcessId) } catch { /* going */ }
      for (const p of pids) if (p > 0) (url.startsWith('marver-app://') ? pages : canvas).add(p)
    }
    return { canvas: [...canvas], pages: [...pages].filter((p) => !canvas.has(p)) }
  })
  // the recorder's pan in the real window (A3.8 #51, the detector's cost on a real board): wheel events into a
  // tab's view on an absolute schedule, never awaiting an ack (A3.8 #20)
  provide('wheel', async (a) => {
    const o = a as { tab: string; x: number; y: number; dx?: number; dy?: number; n: number; everyMs?: number; ctrl?: boolean }
    const wc = contentView(o.tab)?.webContents
    if (!wc || wc.isDestroyed()) return false
    const t0 = performance.now()
    for (let i = 0; i < o.n; i++) {
      const at = t0 + i * (o.everyMs ?? 16)
      const wait = at - performance.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      wc.sendInputEvent({ type: 'mouseWheel', x: o.x, y: o.y, deltaX: o.dx ?? 0, deltaY: o.dy ?? 0, modifiers: o.ctrl ? ['control'] : [] } as Electron.MouseWheelInputEvent)
    }
    return true
  })
  // the capture harness's window (A3.8 #35, #37): its CGWindowID, from getMediaSourceId() ("window:<id>:0")
  provide('window:id', () => { const m = /^window:(\d+):/.exec(mainWindow()?.getMediaSourceId() ?? ''); return m ? Number(m[1]) : null })
  provide('picture:app', async (a) => {
    const o = a as { width?: number; path: string }
    if (!o?.path || !isAbsolute(o.path)) throw new Error('picture:app needs an absolute path')
    try {
      const p = await captureApp({ width: o.width })
      writeFileSync(o.path, p.png)
      return { width: p.width, height: p.height, layers: p.layers }
    } catch (e) { return { why: (e as { why?: string }).why ?? String(e) } }
  })
}
