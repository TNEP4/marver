// Types for keys.js (plain JS: it serves into frames like bridge.js).
export function inField(t: EventTarget | null): boolean
export function composing(e: KeyboardEvent): boolean
export function keyAllowed(e: KeyboardEvent): boolean
export function keyDescriptor(e: KeyboardEvent): string
export function createKeys(opts: { post: (msg: Record<string, unknown>) => void; trusted: (e: MessageEvent) => boolean }): { owns: (e: KeyboardEvent) => boolean; dispose: () => void }
