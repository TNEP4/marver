/**
 * Build-time constants, set by `tsdown.config.ts` (scripts/build.mjs picks the flavour). Never read
 * `app.isPackaged` in their place: a copy of the binary named `electron` reads false (spec 28 A2.14 #30).
 *
 * - `__MARVER_RELEASE__`: the packaged release flavour. The debugging guard is on, the app is "Marver".
 * - `__MV_TEST__`: the dev flavour. Test hooks are compiled in and switched on only by `MARVER_APP_TEST=1`;
 *   every call site is written `if (__MV_TEST__) ...`, so the release build drops them (A2.14 #27).
 * - `__MARVER_FEED__` (A5.1 #4): the update feed, `''` in the dev flavour, ad-hoc builds and ordinary signed builds;
 *   production's feed only in a bundle `scripts/release.mjs` builds, the test repo's only with `--test`. updater.ts
 *   reads this alone, never `app.isPackaged` or `__MARVER_RELEASE__`.
 */
declare const __MARVER_RELEASE__: boolean
declare const __MV_TEST__: boolean
declare const __MARVER_FEED__: string
