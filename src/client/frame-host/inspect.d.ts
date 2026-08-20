// Types for inspect.js (kept as plain JS so it serves into frames like bridge.js).
export function createInspect(opts: {
  post: (msg: Record<string, unknown>) => void
  getId: () => string
  onModeChange?: (laser: boolean, pick: boolean) => void
}): { modeActive: () => boolean; isLaser: () => boolean; isPick: () => boolean; dispose: () => void }
