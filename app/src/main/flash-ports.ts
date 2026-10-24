/**
 * Mark a Flash's ports in the app (spec 28 A3.8 #13, #14): the flash stream's half of `FlashPorts` - the active tab's
 * identity, the moment's thermal state and GPU feature status, the picture (window.ts `captureApp`), its file
 * (`pictureWriter`, mode 600, the newest 50 kept) and the pill (`flashMarked`, Show bound to the picture) - joined to
 * the recorder's half, which the recorder stream passes in (its ring, its sampler's state now, its GPU events,
 * pressure, the AGX read, the writer, and the home's `writable` guard). **This is the composition `recorder.markFlash`
 * must use** (review of a3-native, major #4), never ports of its own - else the pill has no Show button (A3.8 #13.4)
 * and the journal no `flash` lines (flash-native.test.ts reads them):
 *
 *   markFlash(via) { if (!P) return; void markFlash(via, flashPorts({ flavour: flavour(), perfDir: join(P.home.dir,
 *     'perf'), writable: () => P.home.writable, recorderOn, ring: () => (recorderOn() ? { samples: ..., events: ... } :
 *     null), stateNow, gpuEvents, pressure: lastPressure, readAgx, append: (body) => record('flash', null, body,
 *     true) })).catch(...) }
 *
 * recorder.ts importing this file, and this file `identity` from recorder.ts, is a cycle esbuild bundles: each side
 * reads the other's exports only when a mark is made. The test hook drives the same composition.
 *
 * In test builds each step goes into the journal (`flash` topic: capture, written, pill, record), for "the pill after
 * the picture" read from the app itself.
 */
import { join } from 'node:path'
import { app, powerMonitor } from 'electron'
import type { Flavour, ThermalState } from '../../../src/shared/app-perf.ts'
import { pictureWriter, type FlashPorts } from './flashes.ts'
import { flashMarked } from './pill.ts'
import { identity } from './recorder.ts'
import { activeTab } from './tabs.ts'
import { note } from './testing/index.ts'
import { captureApp } from './window.ts'

/** What the recorder supplies. */
export type RecorderFlashParts = Pick<FlashPorts, 'recorderOn' | 'ring' | 'stateNow' | 'gpuEvents' | 'pressure' | 'readAgx' | 'append'> & {
  flavour: Flavour
  /** `<MARVER_HOME>/perf` */
  perfDir: string
  /** the home's guard (config.ts `Home.writable`): false, and no picture is written */
  writable?: () => boolean
}

const j = (data: unknown) => { if (__MV_TEST__) note('flash', data) }

export function flashPorts(r: RecorderFlashParts): FlashPorts {
  const write = pictureWriter(r.perfDir, r.writable)
  return {
    now: () => Date.now(),
    mono: () => performance.now(),
    flavour: r.flavour,
    recorderOn: r.recorderOn,
    identity: () => { const t = activeTab(); return t?.kind === 'local' ? identity(t) : null },
    ring: r.ring,
    stateNow: r.stateNow,
    gpuEvents: r.gpuEvents,
    thermal: () => powerMonitor.getCurrentThermalState() as ThermalState,
    pressure: r.pressure,
    featureStatus: () => app.getGPUFeatureStatus() as unknown as Record<string, string>,
    readAgx: r.readAgx,
    capture: async (o) => {
      j({ step: 'capture' })
      try { const p = await captureApp(o); j({ step: 'captured', width: p.width, height: p.height }); return p } catch (e) { j({ step: 'captured', why: (e as { why?: string }).why ?? String(e) }); throw e }
    },
    writePicture: async (name, png) => { const w = await write(name, png); j({ step: 'written', ...w }); return w },
    confirm: (c) => { j({ step: 'pill', picture: c.picture }); flashMarked(c) },
    append: (b) => { j({ step: 'record', id: b.id, picture: b.picture, ...(b.pictureWhy ? { pictureWhy: b.pictureWhy } : {}) }); r.append(b) },
  }
}

/** The pictures' folder under a home. */
export const perfDirOf = (homeDir: string): string => join(homeDir, 'perf')
