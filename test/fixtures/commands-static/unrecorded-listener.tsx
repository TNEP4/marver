// Negative fixture (R16): a keydown listener that records nothing fails.
declare function hide(): void
export function start() { window.addEventListener('keydown', () => hide()) }
