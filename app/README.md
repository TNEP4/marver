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
view), the registry, the bridge (`mv:doc` answering each document's inset from layout.ts), the recorder (A3: its
writer, the machine profile, the one sampler), then `views.ts` - the window and its pages (the transparent strip, painting controls over the cover; Home,
Settings and the tab pages at the full height; S15's cover, a web view on `marver-app://cover/` drawing the still dots
over its native ground; a canvas whose shell offers `inset` at the full height once that cover has made a frame,
below the strip until then and after a loss of its renderer or the GPU process until it makes one), the tabs restored
from `tabs.json` (only the active one loads; each canvas view on its workspace's partition, its proof dispatcher
attached before its first load), the menu, the quit through `guardAll` - then Home's and Settings' channels, the
unloading policy (`memory.ts`) and the white-out detector (`whiteout.ts`), and last
the error policy (`errors.ts`): from there an uncaught exception or rejection in main is a line in
`~/.marver/perf/app.jsonl` (Marver Dev: `app-dev.jsonl`), through the recorder's writer, and the app goes on, never
Electron's modal box over pages that may hold unsaved work
(before it, a startup that fails keeps Electron's box: no page holds anything yet). Each module after the guard is its stream's; its header says what is still to build.

A3's contracts (spec 28 A3.8 #53) are frozen on `a3-base` before its five streams split: `src/shared/app-api.ts`
(`mv:doc`'s inset, `mv:present` / `mv:presented`, `mv:perf` / `mv:perf-ask`), `src/shared/app-perf.ts` (app.jsonl's
envelope and kinds, the one sampler's `Sample`, `ProcSample`, `Sampler`), `tabs.ts` (`Tab.geo`, the `unload` guard
action, `GuardOperation.done`, `unloadRefusal`), `channels.ts` (`unloaded`, the tab page's `reopening`), the
recorder's ports (`recorder.ts`), the journal topics (`testing/index.ts` `JournalTopics`) and `timings.ts`. The new
modules - `procs`, `recorder`, `pressure`, `machine`, `perflog`, `flashes`, `whiteout`, `memory`, `layout`,
`present`, `cover` - start as their exported signatures with inert bodies: nothing is sampled, written, unloaded or
uncovered until a stream fills its own, so app 0.2's base behaves as app 0.1.

The recorder (A3.1, A3.2, A3.6; `procs`, `recorder`, `pressure`, `machine`, `perflog`): one `getAppMetrics()` tick
every 5 s while the recorder is on or memory.ts wants it - otherwise the tick calls neither `getAppMetrics()` nor
`sysctl`, and the app calls `getAppMetrics()` only to read an identity in an event's turn (a renderer the samples have
not met when the tabs change, the GPU process at `gpu-info-update` and at a presentation's answer) or for a flash's
state at its mark, every call through `recorder.ts` `appMetrics(why)`, counted; its samples in a 60 s ring and one
`sample` line a minute; the events; the machine profile under `perf/machine/`; one writer per file (`app.jsonl`,
Marver Dev `app-dev.jsonl`; main's errors written in their own turn) with retention a few seconds after launch and
daily, its whole rewrites written off the main thread. Its test hooks are `testing/recorder.ts`'s
(`recorder:samples`, `:events`, `:tick`, `:flush`, `:need`, `:inject`, `:machine`, `:prune`, `:metrics`,
`pressure:inject`): `:tick` returns its sample with what that tick's `getAppMetrics()` said, and `:flush` is the
writer's 2 s flush run now, which never ends the hold at launch; `test/prod/recorder.test.ts` runs it on the real
binary.

## Tests (A2.10, A2.14 #27)

- **unit**, **fake**: no Electron; the bundles, the token copy, the fake canvas.
- **pw** (`test/harness/app.ts` `launchPW`): Playwright's own Electron launch. Its loader turns on Chromium's test
  switches (the hang monitor off, paint holding off, no backgrounding, no back-forward cache, a mock keychain).
- **prod** (`launchProd`): the real binary with the app folder and nothing else, driven over the control socket
  (`MARVER_APP_CONTROL`, mode 600). The hang, one copy of each guard case, hidden tabs, and a
  quit whose helpers end with it (`test/prod/quit.test.ts`: `test/harness/catch-uncaught.cjs`, loaded with
  `NODE_OPTIONS=--require`, records an uncaught exception in main instead of Electron's modal error box), and the
  error policy (`test/prod/errors.test.ts`: the `throw` hook raises one in a later turn; the catcher is its safety net).
- Hooks: `provide(name, fn)` in `src/main/testing/index.ts`, reached as `run.call(name, args)`, each name provided
  once (a second never replaces the first: calling that name fails, naming both places); `note(topic, data)`
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
  `focusApp`, `onTop`, `drag` (down, held moves, up), `page`, `tabpage:action`, `pill:raise`, `pill:action`, `menu:items`, `menu:hold`,
  `menu:click`, `openInTab`, `openSameCanvas`, `outside`, `effects`, `resume` (powerMonitor's wake), `silent` (a main
  frame that does not answer for a while), `cdpClick` (a click hit-tested by the browser, so it reaches a
  cross-process iframe), `frames`, `hang:report` (the hang monitor's report made by hand). A test build never shows
  a native sheet: `sheet` sets how the seam answers (`confirm` by default, `cancel`, `throw` - an exception in the
  guard's wait - or `hold` until `sheet:answer`,
  a held hang sheet closing itself when its signal aborts, as `showMessageBox` does), `sheets` lists what was asked;
  nor a native popup: `tabMenu` and `tabsMore` record the strip's menus in the journal (`popup`), `popup:click`
  chooses an item. With `MARVER_APP_FAKE_TRUST=1` the window stream's cases run before the trust stream's modules
  (`testing/fake-trust.ts`: `fake:entry`, `fake:gone`, `fake:mode`, `fake:report`, `fake:logo`, `fake:session` (each partition's preparation held until released);
  `MARVER_APP_FAKE_ENTRIES` for the canvases running at launch). The fake trust registers nothing with the real
  bridge: once the trust stream's modules are built in, its policy lets a subframe navigate only for a canvas the
  bridge knows, so a case with iframes runs on the real trust (`test/prod/hang.test.ts`), as does
  `test/prod/guard-bridge.test.ts` (skipped, saying so, without them). Helpers in `test/harness/window.ts`; real key
  events in `test/native/keypost.swift` (Accessibility for the terminal, else those cases say they are
  inconclusive); the focus cases read focus only while the window is key, else they are skipped as inconclusive.
- **the one ground's hooks** (`src/main/window.ts` `groundHooks`; A3.8 #24-#33): `ground:state` (the gate, the live
  resize, the cover, each tab's geometry, epoch and gen), `ground:emit` (`will-resize`, `resized`, `resize` as macOS
  sends them for a person's drag), `ground:gpu-lost` and `ground:gpu` (the GPU process gone, or its identity read
  changed, with nothing killed), `ground:gpu-kill` (the GPU process killed with SIGKILL: Electron's own events reach
  views.ts, journaled as `gpu`), `ground:heartbeat` (the capture matrix's 1 px compositor animation in the strip) and
  `ground:beat-pixel` (its corner as the strip's compositor drew it, through `capturePage`), `ground:strip-regions`
  (the strip's empty part and the heartbeat's corner, measured in the strip: A3.8 #34's regions), `ground:inset-off`
  (A3.8 #51's switch: every next document told 0 - which also moves it below the strip, so its run paints a viewport
  44 px shorter; the band's cost read from it is an upper bound). The matrix's case 15 load (`loadWindow`, a heavy
  board panning in a second window) is the native acceptance stream's.
  `trust:hold-proved` holds a proved document response before Chromium may commit it (proof.ts `holdProved`: "a new
  instance taking the port after the proof's headers"), and `exec`'s `frame` runs in the main frame without waiting
  for a load in flight. The cover (cover.ts, S15's variant 3) opens layout.ts's gate by itself; its readiness is the
  journal's `cover` topic (`{ ready, why }`), `ground:state`'s `cover.ready`, and `ground:cover-crash` crashes its
  renderer (every canvas below until its reload makes a frame). `MARVER_APP_COVER=plain` stands app 0.1's plain view
  in (a cover that could not be made: the gate shut, the strip drawing the dots); `MARVER_APP_GROUND=1` then opens the
  gate over it, main's half alone - its decisions, from the journal's `compose`, `layout`, `present` and `resize`
  topics, never its pixels.
  `test/harness/ground-shell.ts` is a fake 0.27.2 shell for a fake canvas's `script` (the inset, hello, the answers,
  and their failure modes).
- **by hand on the first 0.2 build** (`clickpost.swift` needs Accessibility for the runner): over Home, over
  Settings and over a canvas - each at the full height under the transparent strip - a drag in the strip's empty part
  moves the window, and a click there reaches no page; a click on a tab activates it. And a switch Home ↔ canvas,
  watched for a frame of plain ground or doubled dots under the tabs.
- **unloading** (A3.8 #39-#45; `test/unit/unload.test.ts`, `memory.test.ts`, `unload-act.test.ts` - the act on a fake
  webContents: refusal, `unsure`, a renderer gone mid-close, the retries that hold the tab until `destroyed` -
  `test/prod/unload.test.ts`, `unload-shell.test.ts`): memory.ts's
  hooks - `memory:tick` (one tick now, on a sample the case describes: a pressure `level`, `canvasMB` as one canvas
  process, or `procs`; `real: true` takes the sampler's own `requestSample()`), `memory:state` (each canvas tab's
  refusal, the cooldown, the last tick), `memory:totalmem { mb }` (null: `os.totalmem()` again) - and the window's
  `page:event` (Chromium's `audio-state-changed` and DevTools events emitted on a view's own webContents, so no case
  plays a sound or opens a window). Every record the stream writes is a journal `record` line too. The fake trust
  keeps `mv:doc`'s reopen flag as the bridge does: `fake-trust { doc, reopen }` is what each document on the tab's
  origin took. `unload.test.ts`'s "Chromium's own end" case measures how long Chromium lets a page sit in its
  beforeunload before it closes it anyway (1.0 s on Electron 45); `unload-shell.test.ts` keeps its window above
  the others (`onTop`): an occluded window's page gets no animation frames.
- **the packaged smoke** (`test/smoke/smoke.mjs`): S9's checks and X7's cases on the signed build; every launch on
  its own profile with `--use-mock-keychain`. Its clean launch loads a fake canvas as the active tab: the first frame
  callback, a canvas cookie read back encrypted (`v10`) after a SIGTERM to main alone (a group SIGTERM ends the network
  service, which holds the cookie store, before it writes it), and the canvas's own partition in the temporary
  profile. A second launch with a canvas loaded quits on a SIGTERM to its whole process group (`quit-group-exit-code`):
  exit 0, and no `main-error` in its `perf/app.jsonl` - the release build loads no catcher, so the error policy's
  record is the witness. The one WARN left is `build/Marver.icon` (Icon Composer, by hand).
- **A2's budgets, in the smoke, from outside the signed build** (A2.14 #28; the spec's Budgets): `launch-warm` launches
  the clean launch's profile a second time and gates spawn to the canvas page's first animation-frame callback under
  1 s (the first launch is reported, not gated). The app's own memory is macOS's footprint - Activity Monitor's Memory,
  read with `/usr/bin/footprint`, never by the app about itself - under 200 MB as the mean of three reads 10 s apart:
  `memory-no-canvas` (three fake canvases registered, Home active, none shown) counts the browser, the GPU process,
  every utility process, the strip and Home, and crashpad's handler; `memory-canvas-open` (the second launch's canvas
  loaded) counts the same without the GPU process, which is reported beside it, and without the canvas's renderer -
  the one renderer that burned the 2.5 s of CPU its page spends when the smoke asks. RSS is reported, never gated; a
  footprint that cannot be read is a FAIL (inconclusive). A gate that fails says its numbers; its limit is not
  loosened - the numbers go to Nic. Each memory line's numbers are in the JSON report too.

## A3: flashes, white-outs, the capture harness, the budgets (app 0.2)

- **Mark a Flash** (`⌃⌥F` on every view, Help > Mark a Flash; `src/main/flashes.ts`, spec 28 A3.8 #13, #14): one
  transaction in a fixed order - the 2 s debounce from the last mark, the moment's state in the mark's turn, the
  picture, the pill, the record. The picture is a **reconstructed app-content picture**: window.ts's `captureApp`
  stacks each visible view as main does, scaled to 480 px - it is not the screen, holds no traffic lights, and may
  miss a flash that happens in the compositor. It is written under `~/.marver/perf/flashes/` (the newest 50 kept)
  before the strip's pill says "Flash marked", whose Show selects it in Finder. `flash-ports.ts` joins the flash's
  ports to the recorder's.
- **The white-out detector** (`src/main/whiteout.ts`, the shell's `whiteout-probes.ts`; A3.8 #15, #16): during a
  gesture and 500 ms after, with the recorder on, a capture every 250 ms of the visible view and geometric probes
  of empty background bracketing it; two white samples at consecutive ticks are a `whiteout-candidate` - a candidate,
  never proof, until a real flash is filmed (spike B-S3.1).
- **The native helpers** (`test/native/`, compiled once into a temp folder keyed by their source,
  `test/harness/capture.ts` `nativeTool`): `capture.swift` (ScreenCaptureKit, a window or a display stream, regions
  sampled per frame, a sentinel block found - with `detect-pid` only inside that process's window, 44 pt below its
  top - a 2 px heartbeat and a clock-control marker for display streams, a frame with no display time written
  `untimed` and never evidence, the display held awake while it streams; its times on
  `mach_continuous_time`, as `process.hrtime.bigint()` is - SCK's own are `mach_absolute_time`, which stops while the
  Mac sleeps), `procusage.swift` (each process's own CPU and its reaped children's, from outside), `clickpost.swift`
  and `keypost.swift` (CGEvents to the app's pid alone). **The permissions are the runner's**: Screen Recording for
  the capture (without it the helper exits 77 and the case is *blind*, not run), Accessibility for posted keys and
  clicks (without it those cases say INCONCLUSIVE and skip). The app itself never asks for either. A locked screen or
  a sleeping display is blind too (exit 77): WindowServer then composites nothing and a stream sends only `idle`
  frames - an unattended Mac with its lid shut cannot run the capture cases.
- **Spike S15** (`test/bench/s15/`): the four covers over a full-height web view, on the screen. On Nic's Mac only
  a `WebContentsView` whose ground is its native background covers (variant 3): a plain `View` and an `ImageView`
  are drawn beneath the web views, and the strip's own background stops covering when the strip's renderer stalls.
  **Variant 3's covering waits on its own renderer** (24 Oct, two runs): with that renderer crashed, or before its
  page has painted, it never covers (p95 n 25-26, about 220 ms - the whole hold), since a `WebContentsView`'s native
  background is the base of its renderer's frame. So `cover.ts` keeps every canvas below the strip until the cover
  has made a frame, and again from its renderer's or the GPU process's loss until it makes one (layout.ts
  `setCoverReady`); A3.8 #3's "covering never waits on a renderer" does not hold for variant 3.
- **The capture matrix** (`node app/test/capture/matrix.ts`): the transitions judged at every refresh against main's
  journal (`test/harness/capture.ts` `judgeTransition`, `judgeCase`; `test/capture/matrix-judge.ts`). **It proves
  nothing in the opaque layout** (`MARVER_APP_COVER=plain`): there every canvas view sits below the strip, so the strip's
  empty part can only show the strip or the cover and every case would pass by construction - it then reports each
  case not applicable and exits 3, never 0. In the one ground: A2.2's threshold, each transition from main's decision
  to 100 ms and 4 refreshes after the journal says the state settled, the size tag allowed only where a view of the
  uncovered width draws it, the colours calibrated from a known source (a test-mode marker view) and from see-through
  frames, and three inconclusive runs failing a case. An idle frame is the held frame judged at its own time, and
  more than four in a row are not evidence. A window stream skips the refreshes in which nothing changed, so the
  runner keeps a heartbeat and checks its own second first (no complete frame: blind; under 90 % of the refresh rate,
  or a gap: inconclusive): in the one ground the one-ground stream's compositor animation (`ground:heartbeat`), which
  a stalled strip does not stop; a script in the strip only in the opaque layout, where nothing is judged. The strip
  is stalled per transition, its span checked against the window; every fixture load has a tag of its own, and a
  transition whose documents before and after show one tag is inconclusive; the screen is checked before each case.
  Main's clock is checked against the helper's display times with a marker it shows and hides, removed before the
  cases (`--control` runs only that). `--n 40` is the acceptance count; exit 0 pass, 1 fail, 3 inconclusive, broke or
  not applicable, 77 blind.
- **A3's budgets** (`test/budgets/`, every launch on a temporary world with the production switches and Chromium's
  mock keychain; `--app <Marver.app>` for the signed build): `memory.mjs` (two footprint gates, A3.8 #48),
  `hidden-cpu.mjs` (the window hidden, the app's own CPU counted from outside with canvases taken out, A3.8 #49; the
  canvases named only by the recorder's own log, in either flavour, whole and its figure agreeing with the outside
  one, else inconclusive - `evidence.ts`; `--ballast` makes one hidden canvas burn a third of a core, which must be
  taken out), `launch-painted.mjs` (spawn to the first painted sentinel frame, A3.8 #50: the sentinel counted only inside
  the spawned app's window, 44 pt below its top; a clock control on display times first; no gap before the detection
  unless `--gap-refreshes 3`, a narrowing the report states; any launch with a frame past 1.5 s and no sentinel fails
  the gate, conclusive or not; the mock keychain skips the real Safe Storage read, a narrowing the report states -
  `--real-keychain` only on a Mac with no Marver of the person's own), `scroll-edge.mjs` (the
  band's cost, A3.8 #51: a real board panned in the real window with `TOP` 44 and with 0 - the one-ground stream's
  `ground:inset-off` hook; until the one ground is merged the 0 run needs no switch and the 44 run is not run). The
  handler of Crashpad counted is the one with this run's `--database`, never one found by the bundle's path.

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
