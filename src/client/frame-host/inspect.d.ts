// Types for inspect.js (kept as plain JS so it serves into frames like bridge.js).
export function createInspect(opts: {
  post: (msg: Record<string, unknown>) => void
  getId: () => string
  onModeChange?: (laser: boolean, pick: boolean) => void
  onLaserPick?: (el: Element, e: MouseEvent) => boolean
}): { modeActive: () => boolean; isLaser: () => boolean; isPick: () => boolean; dispose: () => void }
export function safeBundle(el: Element, point?: { x: number; y: number }): Record<string, unknown>
export function fieldValue(f: Element): string
export function sensitiveField(f: Element): boolean
