// Types for trail.js (plain JS: it serves into frames like bridge.js).
export function createRecorder(opts: {
  post: (msg: Record<string, unknown>) => void
  getFrame: () => string
  mode: 'interact' | 'play'
  trusted: (e: MessageEvent) => boolean
}): { pick: (el: Element, e: MouseEvent) => boolean; screen: (to: string) => void; dispose: () => void }
