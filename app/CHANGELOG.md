# Changelog - the Marver Mac app

## 0.2.0 - unreleased (spec 28 A3)

- Hidden tabs are unloaded when macOS runs short of memory (Settings: Unload hidden tabs when memory runs short, on by
  default): at warn the least recently shown one, then 30 s before the next; at critical every hidden tab but the one
  in front; also when the canvases together pass half of the Mac's memory. Never the tab in front, and never one that
  is busy - unsaved work, a Jam session, the microphone, an agent at work - nor one that has not said it is idle (a
  Marver 0.27.0 canvas), one playing sound, one with DevTools open, one hidden less than 10 s or one whose page
  declined. Nothing asks and nothing comes forward. An unloaded tab keeps its place, name and logo, dimmed, and
  reopens on its board and camera when shown, saying "Reopening" until it is back; a link opened into it opens on what
  the link names instead. What an unload does not keep is the page's undo, Back and Forward, and a selection the link
  does not name.

## 0.1.0 - unreleased (spec 28 A2, for Nic)

- The build: one bundle for main and one per preload, the release flavour packaged for Apple silicon, all nine
  fuses, signed with a Developer ID and the hardened runtime, the microphone line, macOS 13 and later.
- The debugging guard: a release build started with a remote-debugging switch ends at once (exit code 3).
- The icon for macOS 13-15 (`Marver.icns`); macOS 26's `Marver.icon` is still to make in Icon Composer.
- The packaged smoke and the test harnesses. The smoke gates A2's budgets from outside the signed build: a second
  launch reaches the canvas's first frame callback within 1 s, and the app's own memory - macOS's footprint, with no
  canvas open (the GPU process counted) and with one open (the GPU process reported beside it) - stays under 200 MB.
- Trust: the app reads `~/.marver/running/` itself and proves each canvas document before it commits (a fresh nonce,
  A1's proof, the registry read again once when a restarted canvas's own reload beats its slot file); trust belongs
  to the committed document. No service worker on a local canvas, swept before its partition's first load. The
  microphone only for a trusted canvas's main frame; app pages pinned; every view sandboxed with dialogs off; a link
  or a window leaves for the browser only from a trusted canvas, and a save sheet only for a trusted canvas in use.
  The canvas bridge admits a trusted document and replays what the page said before, hello first.
- The window: one window named `main` (its place kept), the strip over a plain cover in the active tab's ground, and
  every view - a canvas, Home, Settings, a tab page - below the strip (the opaque strip; the one ground is app 0.2's).
  Closing the window hides it; the Dock shows it again. HTML fullscreen stays in its view.
- Tabs: Home, canvases by slot then by port, Settings; `⌘1`-`⌘8` and `⌘9` the last canvas; a tab loads when first
  shown and stays loaded; the session restored from `tabs.json`; a tab closed for its canvas's run stays closed.
- One guard for every document the app replaces - closing a tab, quitting, `⌘R`, `⇧⌘R`, Try Again, a link: a page
  that said it holds unsaved work is refused at once and comes forward with "Unsaved work here"; one main cannot hear
  asks first (Cancel the default); the page's own `beforeunload` an extra veto. The quit is one guarded operation
  per canvas tab, cancelled by any refusal - and a refused quit shows the window, even one you had closed. A tab the
  quit already closed and you open again while it runs stops it, once its page is back. Only a link that names a
  hash on the page's own document opens with no question; one without a hash is a new document.
- Each canvas tab wears its canvas's logo (`design/logo.svg` and the rest of A1's ladder, proved like the page) once
  the canvas is ready, shown or not; a canvas with none wears its initials.
- Home lists the canvases running on this Mac, four across in a window of the default size, and Recently here; a
  canvas whose slot file offers no bridge (Marver 0.27.0) says to update for the full unsaved-work guard. Settings is
  a view of `~/.marver/config.json` and `theme.json`.
- A canvas that starts after launch opens its tab on the board it was left on; a second `marver dev` of the same repo
  gets a tab of its own.
- The tab's own page in place of an error page - starting, stopped, not a Marver canvas, can't be reached, crashed -
  and crashes with one owner: the first reloads at once, a second within a minute latches until you press Reload.
- A quit whose helpers end at the same moment (a SIGTERM to the app's process group) exits cleanly: a page whose
  renderer went is never read in a way that throws, so main no longer stops on Electron's error box.
- Once the window is up, an error nothing in main caught is recorded in `~/.marver/perf/app.jsonl` and the app goes
  on - never Electron's modal error box over pages that may hold unsaved work. A quit whose guard fails is refused,
  never left waiting: the next `⌘Q` quits.
- A canvas back after a stop or a restart picks up what waited for it: a tab whose reload met nothing listening, or
  whose page reloaded itself while the canvas was still starting, loads once it is ready; a crash's reload waits for
  it; a page kept under a failure is looked at again. A crash page offers Reload only when there is something to
  reload into, and a crash's reload that fails shows the failure.
- Home and Settings come back from a renderer that went, and an app page that tried to leave its own address keeps
  getting the app's news. A tab closed while its first view was being made stays closed and loads nothing.
- Mark All as Seen in a canvas tab's right-click menu clears every frame's "new" (Marver 0.27.1; disabled on a
  canvas without the bridge). A link from `⌘L` into a canvas that is restarting under a page it keeps is refused,
  saying the page stays as it was. With Reopen tabs at launch off, the boards saved for canvases not running stay in
  `tabs.json`.
- Not responding: the pill's Reload asks first, then ends the page's renderer once and reloads every tab it held.
- The menu bar: the app's keys fire once whatever the page does with keys; the canvas's own items with their keys in
  their names; a stale click does nothing. F6 between the strip and the page; focus never left beneath a tab page.
