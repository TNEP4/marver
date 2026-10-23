# The Marver Mac app

The Mac app of spec 28 (`marver-platform/canvas/specs/28-build.md`, milestones A2-A5). A private workspace member of
the marver repo: never in the npm package, built, signed and smoked by `scripts/build.mjs`.

```
pnpm install                                  # once; electron 45.0.0's binary downloads on first use
pnpm --filter marver-app build:js             # the dev flavour into app/dist/ (tests, `electron .`)
pnpm --filter marver-app dev                  # build:js, then run it as "Marver Dev"
pnpm --filter marver-app package              # the release flavour, Developer ID signed, then the smoke
pnpm --filter marver-app package:adhoc        # the same, ad-hoc signed (agents, CI, a locked keychain)
pnpm --filter marver-app smoke [-- <app>]     # the packaged smoke on its own
pnpm --filter marver-app test                 # unit, fake canvas, Playwright
pnpm --filter marver-app test:prod            # the production-switch harness
```

## Layout

```
app/
  package.json        private; exact pins: electron 45.0.0, @electron/packager 20.3.0, @electron/osx-sign 2.7.1,
                      @electron/fuses 2.1.3, @electron/asar 4.3.1, playwright-core 1.62.1
  tsdown.config.ts    main (CJS), each preload in its own build (no shared chunk), each page as one IIFE
  src/main/           main.ts (the pinned startup), guard.ts, timings.ts, testing/, and the streams' modules
  src/preload/        canvas.ts (window.marverApp), app.ts (the app pages' channel)
  src/shared/         channels.ts (the app pages' channels)
  pages/<page>/       index.html, main.ts, style.css - built into dist/pages/, listed in dist/pages/manifest.json
  build/              the icon's sources, Marver.icns, the entitlements (build/README.md)
  scripts/            build.mjs, tokens.mjs, icon.mjs (+ icon-render.cjs)
  test/               unit/, fake/, pw/, prod/, harness/, smoke/smoke.mjs
```

The canvas contract shared with the shell is the package's `src/shared/app-api.ts`.

## Two flavours, two constants

`__MARVER_RELEASE__` and `__MV_TEST__` are set at build time (`tsdown.config.ts`), never read from
`app.isPackaged` (a copy of the binary named `electron` reads false):

| | dev (`--js`, `dist/`) | release (packaged) |
|---|---|---|
| name, userData | Marver Dev, `<appData>/Marver Dev` | Marver, `<appData>/Marver` |
| state folder | `~/.marver/state-dev/` | `~/.marver/state/` |
| the debugging guard | off (Playwright needs its port) | on: `remote-debugging-port` / `-pipe` exit 3 |
| test hooks | compiled in, on only with `MARVER_APP_TEST=1` | absent (the smoke greps for them) |
| fuses, signature | Electron's own binary from node_modules | all nine fuses, Developer ID, hardened runtime |

`MARVER_APP_USER_DATA` (an absolute path) moves Chromium's profile and the single-instance lock in every build; it
turns nothing on. Tests and the smoke always set it, with `MARVER_HOME` and `MARVER_SLOT_BASE`, so no run touches
`~/.marver`, `~/Library/Application Support/Marver`, `Marver Dev` or a real canvas's port.

## main.ts's order (A2.14 #30)

The guard (first import) - test spies - Marver Dev's name and userData - `MARVER_APP_USER_DATA` - the lock -
`ensureHome()` - crash dumps under `~/.marver/perf/crashpad` and `crashReporter.start` - the `marver-app` scheme -
the files' first read - at ready: the theme, `persist:app`, the navigation hook, the bridge, the registry, the
window, the tabs, the menu. Each module after the guard is its stream's; its header says what is still to build.

## Tests (A2.10, A2.14 #27)

- **unit**, **fake**: no Electron; the bundles, the token copy, the fake canvas.
- **pw** (`test/harness/app.ts` `launchPW`): Playwright's own Electron launch. Its loader turns on Chromium's test
  switches (the hang monitor off, paint holding off, no backgrounding, no back-forward cache, a mock keychain).
- **prod** (`launchProd`): the real binary with the app folder and nothing else, driven over the control socket
  (`MARVER_APP_CONTROL`, mode 600). The hang, one copy of each guard case, hidden tabs and the memory budget.
- Hooks: `provide(name, fn)` in `src/main/testing/index.ts`, reached as `run.call(name, args)`; `note(topic, data)`
  writes the journal the `log` hook returns (the view journal goes there). Base hooks: `ping`, `log`, `hooks`,
  `quit`, `exit`, and `spies` with `MARVER_APP_SPY=1`. Every call site is `if (__MV_TEST__) ...`.
- **the fake canvas** (`test/harness/fake-canvas.ts`): its own slot file, a signed `GET /` (A1's `proofHeaders`),
  `proof: 'invalid' | 'none'`, IPv4 or IPv6, A1's guard answers, a request log, a page that reports its first frame
  callback and can set a cookie; `script` and `onRequest` for the rest. In-process or as a child (`kill -9`).
- **the packaged smoke** (`test/smoke/smoke.mjs`): S9's checks and X7's cases on the signed build; every launch on
  its own profile with `--use-mock-keychain`. WARN lines are what the skeleton cannot do yet (a canvas cookie, the
  launch's first frame callback); they turn PASS by themselves once a canvas tab loads.

## The icon

`build/Marver.icns` comes from `build/a-mark.svg` (`node scripts/icon.mjs`). `build/Marver.icon`, the icon macOS 26
draws in its own glass, is made by hand in Icon Composer and is **not made yet** - see `build/README.md`. Nothing
may stand at that path until then.

## Signing

Nic's Developer ID (`MARVER_SIGN_IDENTITY` overrides). The first signing on a Mac asks the keychain for the private
key ("Always Allow" once); Apple's timestamp server needs the network. Ad-hoc builds are signed without the hardened
runtime: its library validation refuses Electron Framework under a signature with no Team ID.
