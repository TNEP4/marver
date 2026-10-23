/**
 * Presentation epochs (spec 28 A2.2, A3.8 #27, #28, #30): when the cover may lift over a full-height canvas view.
 * Owner: the one-ground stream. Pure core, one send port.
 *
 * - Epochs are one counter across all tabs and documents. An epoch belongs to a key - `doc`, `w x h`, HTML
 *   fullscreen and the view's `gen` - and compose derives the key from the model every time, so a second compose
 *   in the same state makes no new epoch.
 * - `gen` advances, in the event's turn, at four events only: the view shown after being hidden, its document's
 *   accepted hello, a live resize's end, and - for every view at once - the GPU process lost (gone, or its identity
 *   changed: Electron 45 sends no event for a clean exit, A3.8 r3 #1).
 * - Main sends `mv:present { doc, epoch, w, h, frames }` after the turn's view changes, never during a live resize;
 *   it accepts only the current epoch of the active view, from its admitted, trusted document, at that size within
 *   1 px, with the GPU identity read in the turn of acceptance. Anything else is journaled and changes nothing.
 *
 * FROZEN (A3.8 #53): `PresentKey`, `observe`, `flush`, `answer`, `forget`, `bumpGen`, `noteGpu`, `gpuGone`. Until
 * the one-ground stream fills them nothing is ever presented and the cover never lifts (app 0.1's look).
 */
import type { Present, Presented } from '../../../src/shared/app-api.ts'
import type { GpuIdentity } from '../../../src/shared/app-perf.ts'

/** What an epoch is about; `gen` is the view's generation (the four events above). */
export interface PresentKey { doc: string; w: number; h: number; fs: boolean; gen: number }

/** What `answer` made of a reply: `ok` lifts the cover at the next compose (plus `uncoverDelayMs`). */
export type PresentVerdict = 'ok' | 'stale' | 'mismatch' | 'refused' | 'lost'

/** compose, before plan(): the active, eligible view's key now; true when its current epoch is accepted. */
export function observe(tab: string, k: PresentKey, now: number): boolean {
  void tab; void k; void now
  return false
}

/** compose, after the views were applied and with no live resize: send the current epoch once; a failed send is retried by the next compose. */
export function flush(tab: string, send: (doc: string, r: Present) => boolean, frames: number): void {
  void tab; void send; void frames
}

/** The bridge accepted an `mv:presented` from the tab's admitted document; `gpu` is the GPU identity read now. */
export function answer(tab: string, doc: string, r: Presented, now: number, gpu: GpuIdentity | null): PresentVerdict {
  void tab; void doc; void r; void now; void gpu
  return 'refused'
}

/** The view closed, unloaded or its renderer went: its epochs and gen forgotten. */
export function forget(tab: string): void { void tab }

/** One of the four events for one view: what was presented no longer counts. */
export function bumpGen(tab: string): void { void tab }

/** The GPU identity read now (a sample, a gpu-info-update): true when it changed or went - every view's gen advanced; the caller composes. */
export function noteGpu(id: GpuIdentity | null): boolean {
  void id
  return false
}

/** `child-process-gone` with type GPU: every view covered until it presents again, at an epoch made after the loss. */
export function gpuGone(): void {}
