/**
 * The canvas preload (spec 28 A2.9, A2.14 #9, v1.12 r1 #1): `window.marverApp` for verified local canvases.
 * Owner: the trust stream.
 *
 * SKELETON (ship stream). It runs sandboxed: one bundle of its own, and it may `require` only `electron`
 * (test/unit/bundle.test.ts). To build, as `MarverAppV1` (src/shared/app-api.ts): one synchronous `mv:doc` at
 * document start (`{ reopen }`); nothing sent before an `mv:admit`; the latest hello, theme, busy and menu
 * held and replayed on every admit, hello first, stamped with that `doc`; one `ipcRenderer.on` per
 * main-to-page channel, fanning out to the page's listeners.
 */
export {}
