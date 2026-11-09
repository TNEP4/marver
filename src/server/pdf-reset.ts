/**
 * The dev server's restart and close reach deck PDF jobs through this hook (spec 31): plugin.ts calls `resetPdf(root)`
 * without loading pdf.ts (and pdf-lib) on a canvas that never exported; pdf.ts registers itself when it first loads.
 */
let reset: ((root: string) => void) | null = null
export function onPdfReset(fn: (root: string) => void): void { reset = fn }
/** Cancel this canvas's running PDF job (its browser closes) and forget its jobs. A no-op until pdf.ts has loaded. */
export function resetPdf(root: string): void { try { reset?.(root) } catch { /* best-effort */ } }
