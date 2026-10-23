# The Marver Mac app

The Mac app of spec 28 (`marver-platform/canvas/specs/28-build.md`, milestones A2-A5). A private workspace member of
the marver repo: never in the npm package, built, signed and smoked by `scripts/build.mjs`.

```
pnpm install                                  # once; electron 45.0.0's binary downloads on first use
pnpm --filter marver-app build:js             # the dev flavour into app/dist/ (tests, `electron .`)
pnpm --filter marver-app dev                  # build:js, then run it as "Marver Dev"
pnpm --filter marver-app package              # the release flavour, Developer ID signed, then the smoke
pnpm --filter marver-app package:adhoc        # the same, ad-hoc signed, into out/adhoc/ (agents, CI, a locked keychain)
pnpm --filter marver-app smoke [-- <app>]     # the packaged smoke on its own (no dialog: add --tamper for the crashing cases)
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
  scripts/            build.mjs, team-id.mjs, tokens.mjs, icon.mjs (+ icon-render.cjs)
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
the files' first read - at ready: the theme and the files' watch, `persist:app`, the navigation hook (before any
view), the registry, the bridge, then `views.ts` - the window with the opaque strip and its pages, the tabs restored
from `tabs.json` (only the active one loads; each canvas view on its workspace's partition, its proof dispatcher
attached before its first load), the menu, the quit through `guardAll` - and last Home's and Settings' channels. Each module after the guard is its stream's; its header says what is still to build.

## Tests (A2.10, A2.14 #27)

- **unit**, **fake**: no Electron; the bundles, the token copy, the fake canvas.
- **pw** (`test/harness/app.ts` `launchPW`): Playwright's own Electron launch. Its loader turns on Chromium's test
  switches (the hang monitor off, paint holding off, no backgrounding, no back-forward cache, a mock keychain).
- **prod** (`launchProd`): the real binary with the app folder and nothing else, driven over the control socket
  (`MARVER_APP_CONTROL`, mode 600). The hang, one copy of each guard case, hidden tabs and the memory budget, and a
  quit whose helpers end with it (`test/prod/quit.test.ts`: `test/harness/catch-uncaught.cjs`, loaded with
  `NODE_OPTIONS=--require`, records an uncaught exception in main instead of Electron's modal error box).
- Hooks: `provide(name, fn)` in `src/main/testing/index.ts`, reached as `run.call(name, args)`; `note(topic, data)`
  writes the journal the `log` hook returns (the view journal goes there). Base hooks: `ping`, `log`, `hooks`,
  `quit`, `exit`, and `spies` with `MARVER_APP_SPY=1`. Every call site is `if (__MV_TEST__) ...`.
- **the fake canvas** (`test/harness/fake-canvas.ts`): its own slot file, a signed `GET /` (A1's `proofHeaders`),
  `proof: 'invalid' | 'none'`, IPv4 or IPv6, A1's guard answers, a request log, a page that reports its first frame
  callback and can set a cookie; `script` and `onRequest` for the rest. In-process or as a child (`kill -9`).
- **the trust hooks** (`src/main/testing/trust.ts`, `trust:*`): a test tab wired exactly as the frozen interfaces
  say - `localSession`, `canvasWebPreferences`, `attachNav`, the dispatcher's `attach`, `bridge.register` - so the
  proof, the bridge and the policy run for real before the tabs exist (`target: 'registry'` gives the dispatcher a
  target only while the registry holds the tab's instance, as the window stream's does); `trust:tab` reads its
  adapter events, trust and reports, `trust:ipc` and `trust:invoke` reach the bridge as a message or an invoke from a
  sender a case picks, `trust:admit-delay` holds each `mv:admit` so a page speaks well before it, `trust:opened`
  lists what `openOutside` let out (tests never open a browser), and the `download` journal what each download was
  decided (a test build never shows the save sheet). Helpers in `test/harness/trust.ts`.
- **the window hooks** (`src/main/views.ts` `testHooks`; the window stream): `state` (main's record of every tab,
  the pill, the focus owner), `views` (every view's bounds and visibility as Electron reports them), `window`,
  `activate`, `command`, `close`, `guard`, `guardAll`, `crash`, `reloadPage`, `exec`, `key`, `click`, `focused`,
  `focusApp`, `onTop`, `page`, `tabpage:action`, `pill:raise`, `pill:action`, `menu:items`, `menu:hold`,
  `menu:click`, `openInTab`, `openSameCanvas`, `outside`, `effects`, `resume` (powerMonitor's wake), `silent` (a main
  frame that does not answer for a while), `cdpClick` (a click hit-tested by the browser, so it reaches a
  cross-process iframe), `frames`, `hang:report` (the hang monitor's report made by hand). A test build never shows
  a native sheet: `sheet` sets how the seam answers (`confirm` by default, `cancel`, or `hold` until `sheet:answer`,
  a held hang sheet closing itself when its signal aborts, as `showMessageBox` does), `sheets` lists what was asked;
  nor a native popup: `tabMenu` and `tabsMore` record the strip's menus in the journal (`popup`), `popup:click`
  chooses an item. With `MARVER_APP_FAKE_TRUST=1` the window stream's cases run before the trust stream's modules
  (`testing/fake-trust.ts`: `fake:entry`, `fake:gone`, `fake:mode`, `fake:report`, `fake:logo`;
  `MARVER_APP_FAKE_ENTRIES` for the canvases running at launch). The fake trust registers nothing with the real
  bridge: once the trust stream's modules are built in, its policy lets a subframe navigate only for a canvas the
  bridge knows, so a case with iframes runs on the real trust (`test/prod/hang.test.ts`), as does
  `test/prod/guard-bridge.test.ts` (skipped, saying so, without them). Helpers in `test/harness/window.ts`; real key
  events in `test/native/keypost.swift` (Accessibility for the terminal, else those cases say they are
  inconclusive); the focus cases read focus only while the window is key, else they are skipped as inconclusive.
- **the packaged smoke** (`test/smoke/smoke.mjs`): S9's checks and X7's cases on the signed build; every launch on
  its own profile with `--use-mock-keychain`. Its clean launch loads a fake canvas as the active tab: the first frame
  callback, a canvas cookie read back encrypted (`v10`) after a SIGTERM to main alone (a group SIGTERM ends the network
  service, which holds the cookie store, before it writes it - that quit is `test/prod/quit.test.ts`'s), and the
  canvas's own partition in the temporary profile. The one WARN left is `build/Marver.icon` (Icon Composer, by hand).

## The icon

`build/Marver.icns` comes from `build/a-mark.svg` (`node scripts/icon.mjs`). `build/Marver.icon`, the icon macOS 26
draws in its own glass, is made by hand in Icon Composer and is **not made yet** - see `build/README.md`. Nothing
may stand at that path until then.

## Never a half-signed bundle in out/

A bundle launched while `@electron/osx-sign` works on it carries two Team IDs (the parts already signed with the
Developer ID, the rest still ad-hoc) and crashes at once, with macOS's "quit unexpectedly" dialog. So:

- `build.mjs` packages, fuses and signs in `app/.stage/<signed|adhoc>/` (hidden, gitignored), checks
  `codesign --verify --deep --strict` and one Team ID across every Mach-O part (`scripts/team-id.mjs`: the main
  binary, the frameworks and their libraries, the helpers), runs the smoke there, and only then moves the finished
  bundle into `out/` by rename. A build that fails leaves `out/` as it was.
- The smoke and both test launchers refuse to launch a bundle whose parts carry more than one Team ID, and name
  each Team ID with its parts. (`codesign --verify --deep` alone passes such a bundle.)
- The smoke's cases that crash the app on purpose - a byte changed in `app.asar`, twice, and on a signed build the
  renamed copy the kernel kills - each put a dialog on screen, so they run only with `--tamper` (`build.mjs
  --tamper` passes it on); otherwise they are SKIP lines, and the run checks that macOS wrote no crash report of
  Marver's while it ran.

## Signing

Nic's Developer ID (`MARVER_SIGN_IDENTITY` overrides). The first signing on a Mac asks the keychain for the private
key ("Always Allow" once); Apple's timestamp server needs the network. Ad-hoc builds are signed without the hardened
runtime: its library validation refuses Electron Framework under a signature with no Team ID.
