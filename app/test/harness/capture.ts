/**
 * The capture harness (spec 28 A3.8 #34-#38, #50): what WindowServer composited for the app's window at each
 * refresh, read by `test/native/capture.swift` (ScreenCaptureKit, a window or a display stream) and judged here
 * against main's journal (testing/index.ts `JournalTopics`: both clocks are mach_absolute_time; a control case
 * checks that they line up). Owner: the flash and native acceptance stream; the one-ground stream reads its matrix.
 *
 * **Screen Recording is the runner's** (A3.8 #37): the helper checks `CGPreflightScreenCaptureAccess()` and exits 77
 * when it is not granted - reported as **blind**, not run, never passed, naming the app that needs the permission
 * (the terminal or agent running the suite). The app itself never asks for Screen Recording (A2.12).
 *
 * The helper's stdout, one JSON line each (FROZEN, A3.8 #53): first `{ ready: { hostNs, refreshHz, scale } }`, then
 * per frame `{ hostNs, status: 'complete' | 'idle' | 'blank' | 'suspended' | 'started' | 'stopped', gap?, detect? }`.
 * A run is conclusive only if every sample is `complete` or `idle` and display times stay within 1.5 refreshes; an
 * inconclusive transition is run again, and three fail the case.
 */

/** capture.swift's exit code when Screen Recording is not granted to the process running it. */
export const CAPTURE_BLIND = 77

export interface CaptureReady { hostNs: string; refreshHz: number; scale: number }
export interface CaptureFrame {
  hostNs: string
  status: 'complete' | 'idle' | 'blank' | 'suspended' | 'started' | 'stopped'
  /** frames the stream missed before this one: the transition is inconclusive */
  gap?: number
  /** `--detect <hex>:<minPx>`: a solid block of that colour found, and where */
  detect?: { found: boolean; rect?: { x: number; y: number; w: number; h: number } }
}
export type CaptureLine = { ready: CaptureReady } | CaptureFrame

/** A transition's verdict (A3.8 #36): `n` bad refreshes, `ms` from the first bad frame to the first verified good one. */
export type TransitionVerdict = { kind: 'pass' | 'fail'; n: number; ms: number } | { kind: 'inconclusive'; why: string } | { kind: 'blind'; needs: string }

/** One capture session of the app's window (or the display, for the painted launch). */
export async function startCapture(o: { mode: 'window' | 'display'; windowId?: number; detect?: { hex: string; minPx: number; belowY: number } }): Promise<{ lines: AsyncIterable<CaptureLine>; stop(): Promise<void> }> {
  void o
  throw new Error('capture.ts: not built yet (spec 28 A3.8 #35)')
}
