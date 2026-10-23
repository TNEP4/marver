/**
 * The app pages' preload (spec 28 "Channels and who may use them", A2.14 #19): the strip's, Home's,
 * Settings' and the tab page's channel. Owner: the trust stream (with the pages' streams).
 *
 * SKELETON (ship stream). Sandboxed: one bundle of its own, `require('electron')` only. To build: named
 * methods per channel in src/shared/channels.ts (never a generic send), `app:ready` once the page's script
 * runs, subscriptions that strip Electron's event objects, snapshots applied by `rev`.
 */
export {}
