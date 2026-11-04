// The walk's allowlist control (R16): an exact entry covers this site, and the same entry without it is stale.
declare function open(): void
export function Menu() { return <button aria-label="Open the menu" onClick={() => open()}>menu</button> }
