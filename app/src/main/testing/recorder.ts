/**
 * The recorder's test hooks (spec 28 A3.7; dev builds with MARVER_APP_TEST=1 only, like every hook): `recorder:samples`
 * (the ring), `recorder:flush` (the writer now), `recorder:inject` (a sample or an event, for the budgets' and
 * memory.ts's cases), `recorder:events`, `recorder:need`; `pressure:inject`, `memory:tick`, `memory:state`,
 * `memory:totalmem`. Owners: the recorder stream (its hooks) and the unloading stream (memory's and pressure's).
 *
 * FROZEN signature (A3.8 #53): main.ts calls it once in test mode, after the recorder started.
 */
export function provideRecorderHooks(): void {}   // A3 recorder and unloading streams
