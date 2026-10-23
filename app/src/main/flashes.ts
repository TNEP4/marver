/**
 * Mark a Flash (spec 28 A3.3, A3.8 #13, #14): ⌃⌥F on any view, or Help > Mark a Flash. Owner: the flash stream; the
 * recorder stream supplies its ports. A transaction, in this order:
 * 1. the 2 s debounce is reserved at once, counted from the last mark: a press inside it does nothing (no new pill
 *    `rev`);
 * 2. in the same turn: the mark's id, the active tab's identity, the ring (only with the recorder on), the state now
 *    (one `getAppMetrics()`), the GPU events of the second before, thermal state, pressure and feature status; the
 *    AGX read starts now, beside the picture;
 * 3. the picture - a reconstructed app-content picture, 480 px wide (`captureApp`), 2 s at most - then written
 *    (mode 600) to `perf/flashes/<id>.png` (at most 50 kept);
 * 4. only then the pill "Flash marked", its Show bound to that picture (`showItemInFolder`); no picture, no button;
 * 5. the record, once the picture settled, the AGX read ended and the GPU-event window closed at mark + 1 s. At a
 *    quit an unfinished mark is written at once with what it has (`pictureWhy: 'quit'`, AGX 'unknown').
 * With the recorder off the mark carries no history, and the pill adds "no samples before it: the recorder is off".
 *
 * FROZEN (A3.8 #53): `FlashPorts`, `markFlash`, `quitFlashes`. Until the flash stream fills them a mark does nothing.
 */
import type { AgxReading, AppBody, Flavour, PictureWhy, PressureReading, RingEvent, Sample, TabIdent, ThermalState } from '../../../src/shared/app-perf.ts'
import type { AppPicture } from './window.ts'

/** The picture's width, px, and how many pictures are kept (both flavours). */
export const FLASH_WIDTH = 480
export const FLASH_PICTURES_KEPT = 50

/** What a mark needs of the recorder and the window (the recorder stream builds these). */
export interface FlashPorts {
  now(): number
  flavour: Flavour
  recorderOn(): boolean
  /** the active local tab's identity, in this turn; null on Home, Settings or with no canvas */
  identity(): TabIdent | null
  /** the ring (A3.8 #7): the last 12 samples and 60 s of events; null with the recorder off */
  ring(): { samples: Sample[]; events: RingEvent[] } | null
  /** one getAppMetrics() now, on the sampler's baselines (the GPU process's gpuProcessRssMB in it) */
  stateNow(): Sample
  /** GPU process events of the ring between two times (gone, child-gone, gpu-restart, gpu), also those still to come */
  gpuEvents(from: number, to: number): RingEvent[]
  thermal(): ThermalState
  pressure(): PressureReading | null
  featureStatus(): Record<string, string>
  readAgx(timeoutMs: number): Promise<AgxReading>
  /** window.ts captureApp */
  capture(o: { width: number }): Promise<AppPicture>
  /** written whole, mode 600, under perf/flashes: the path relative to perf/, or why not */
  writePicture(name: string, png: Buffer): Promise<{ path: string } | { why: PictureWhy }>
  /** the strip's pill (pill.ts confirm 'flash'), with Show only for a picture */
  confirm(c: { at: number; recorder: boolean; picture: string | null }): void
  /** perflog.ts append */
  append(body: AppBody<'flash'>): void
}

/** runCommand('mark-flash'), through the recorder's port. */
export async function markFlash(via: 'key' | 'menu', p: FlashPorts): Promise<void> {
  void via; void p   // A3 flash stream: the transaction above
}

/** `will-quit`, before the writer's flush: every unfinished mark written now with what it has. */
export function quitFlashes(): void {}   // A3 flash stream
