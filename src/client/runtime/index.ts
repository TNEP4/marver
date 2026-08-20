/**
 * Optional sugar. `data-goto="scene/frame"` on any element is the primitive and needs no import;
 * go() posts the same message programmatically. Safe no-op outside an iframe, so promoted code cannot crash.
 */
export function go(target: string): void {
  if (typeof window === 'undefined' || !window.parent || window.parent === window) return
  window.parent.postMessage({ type: 'sh:go', target }, '*')
}
