/** The play stage's size as it is drawn - a device, the window when it fills, a slide's own stage, the reading
 *  width of a document - in the frame's CSS pixels. Play publishes it after every layout (a resize, a device, the
 *  screen it shows); a capture reads it, and hears when it changes (what a frame on the stage is pictured at). */
export const stageSize: { at: string; w: number; h: number } = { at: '', w: 0, h: 0 }
const listeners = new Set<() => void>()
export function setStageSize(at: string, w: number, h: number) {
  if (stageSize.at === at && stageSize.w === w && stageSize.h === h) return
  stageSize.at = at; stageSize.w = w; stageSize.h = h
  for (const fn of listeners) { try { fn() } catch { /* a listener's own trouble */ } }
}
export function onStageSize(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn) }
