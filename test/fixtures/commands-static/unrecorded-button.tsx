// Negative fixture (R16): a new button with neither a command nor a not-commands entry must fail the walk.
declare function doThing(): void
export function Button() { return <button onClick={() => doThing()}>Do the thing</button> }
