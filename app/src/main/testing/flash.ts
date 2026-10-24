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
 * - `procs:roles`: the budgets' roles in a dev build - canvas renderers from the canvas tabs' own views, app pages from
 *   the strip, Home, Settings and the tab pages, the cover's renderer (S15's variant 3: a view of the window loading
 *   `marver-app://cover/`) as `cover` and among the pages; any other webContents' process `unknown` (counted against
 *   the app).
 * - `clock:marker { on, color? }`: the capture harness's clock control (A3.8 #36) - a red page view on top of the
 *   window's bottom-left corner shown or hidden, journaled (`clock` topic) right after main made the change; `color`
 *   (hex) paints it another colour first, a known source the matrix calibrates the ground and its dots from (#34).
 */
import { writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { app, WebContentsView, webContents, type WebContents } from 'electron'
import type { AppBody, Sample } from '../../../../src/shared/app-perf.ts'
import { values, type Home } from '../config.ts'
import { flashPorts, perfDirOf } from '../flash-ports.ts'
import { markFlash, quitFlashes } from '../flashes.ts'
import { readAgx } from '../machine.ts'
import { lastPressure } from '../pressure.ts'
import { recorder, sampler } from '../recorder.ts'
import { allTabs } from '../tabs.ts'
import { APP_ORIGIN, captureApp, contentView, mainWindow, pageView, stripContents } from '../window.ts'
import { note, provide } from './index.ts'

const records: AppBody<'flash'>[] = []
/** the clock control's marker view (test mode only), and where it sits: 24 x 24 pt, 24 pt from the bottom-left corner */
let marker: WebContentsView | null = null
const MARKER_AT = (h: number) => ({ x: 24, y: h - 48, width: 24, height: 24 })

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
  // app pages', from main's own views (never from a URL: a view not yet loaded, DevTools or about:blank is no canvas);
  // anything else is `unknown`, which the budgets count against the app (it can fail a run, never pass one)
  provide('procs:roles', () => {
    const pidsOf = (wc: WebContents | undefined): number[] => {
      if (!wc || wc.isDestroyed()) return []
      const ps = new Set<number>([wc.getOSProcessId()])
      try { for (const f of wc.mainFrame.framesInSubtree) ps.add(f.osProcessId) } catch { /* going */ }
      return [...ps].filter((p) => p > 0)
    }
    const canvasWc = new Set<number>()
    const pageWc = new Set<number>()
    const canvas = new Set<number>()
    const pages = new Set<number>()
    for (const t of allTabs()) {
      const v = contentView(t.id)?.webContents
      if (v && !v.isDestroyed()) { (t.kind === 'local' ? canvasWc : pageWc).add(v.id); for (const p of pidsOf(v)) (t.kind === 'local' ? canvas : pages).add(p) }
      const pv = pageView(t.id)?.webContents
      if (pv && !pv.isDestroyed()) { pageWc.add(pv.id); for (const p of pidsOf(pv)) pages.add(p) }
    }
    const strip = stripContents()
    if (strip) { pageWc.add(strip.id); for (const p of pidsOf(strip)) pages.add(p) }
    if (marker && !marker.webContents.isDestroyed()) { pageWc.add(marker.webContents.id); for (const p of pidsOf(marker.webContents)) pages.add(p) }
    // the cover's renderer (S15's variant 3, A3.8 #48: it counts in the no-canvas gate): a view of the window on the
    // cover's own page - an app page of our scheme, never a canvas
    const cover = new Set<number>()
    for (const v of mainWindow()?.contentView.children ?? []) {
      if (!(v instanceof WebContentsView) || v.webContents.isDestroyed() || !v.webContents.getURL().startsWith(`${APP_ORIGIN}cover/`)) continue
      pageWc.add(v.webContents.id)
      for (const p of pidsOf(v.webContents)) { pages.add(p); cover.add(p) }
    }
    const unknown = new Set<number>()
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed() || canvasWc.has(wc.id) || pageWc.has(wc.id)) continue
      for (const p of pidsOf(wc)) if (!canvas.has(p) && !pages.has(p)) unknown.add(p)
    }
    // a process shared by a canvas and an app page (never expected) is the app's: counted, not taken out
    return { canvas: [...canvas].filter((p) => !pages.has(p) && !unknown.has(p)), pages: [...pages], cover: [...cover], unknown: [...unknown] }
  })
  // the capture harness's clock control (A3.8 #36): a red page view on top, in the window's bottom-left corner, shown
  // or hidden and journaled right after - its first frame on the screen must follow within 3 refreshes. A
  // WebContentsView paints nothing until its renderer has presented (S15, 24 Oct), so the page is loaded first
  provide('clock:marker', async (a) => {
    const o = (a ?? {}) as { on?: boolean; remove?: boolean; color?: string }
    const win = mainWindow()
    if (!win) return false
    if (o.remove) { if (marker) { try { win.contentView.removeChildView(marker); marker.webContents.close() } catch { /* gone */ } marker = null } return true }
    if (!marker || marker.webContents.isDestroyed()) {
      marker = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
      marker.setBackgroundColor('#ff0000')
      marker.setVisible(false)
      win.contentView.addChildView(marker)
      await marker.webContents.loadURL('data:text/html,<style>html,body{margin:0;height:100%;background:%23ff0000}</style>')
    }
    if (typeof o.color === 'string' && /^#?[0-9a-f]{6}$/i.test(o.color)) {
      const hex = `#${o.color.replace('#', '')}`
      marker.setBackgroundColor(hex)
      await marker.webContents.executeJavaScript(`document.documentElement.style.background = document.body.style.background = ${JSON.stringify(hex)}; new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))`)
    }
    const { height } = win.getContentBounds()
    marker.setBounds(MARKER_AT(height))
    // on top of everything added since - re-added only when something went above it: re-adding a WebContentsView
    // detaches it, and its next frame then waits on its renderer
    const kids = win.contentView.children
    if (kids[kids.length - 1] !== marker) win.contentView.addChildView(marker)
    marker.setVisible(!!o.on)
    note('clock', { marker: !!o.on })
    return { rect: MARKER_AT(height) }
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
