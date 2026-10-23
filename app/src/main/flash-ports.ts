/**
 * Mark a Flash's ports in the app (spec 28 A3.8 #13, #14): the flash stream's half of `FlashPorts` - the active tab's
 * identity, the moment's thermal state and GPU feature status, the picture (window.ts `captureApp`), its file
 * (`pictureWriter`) and the pill (`flashMarked`) - joined to the recorder's half, which the recorder stream passes in
 * (its ring, its sampler's state now, its GPU events, pressure, the AGX read and the writer). So `recorder.markFlash`
 * is `void markFlash(via, flashPorts({ ...its parts }))`, and the test hook drives the same composition.
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
}

const j = (data: unknown) => { if (__MV_TEST__) note('flash', data) }

export function flashPorts(r: RecorderFlashParts): FlashPorts {
  const write = pictureWriter(r.perfDir)
  return {
    now: () => Date.now(),
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
