# Changelog - the Marver Mac app

## 0.1.0 - unreleased (spec 28 A2, for Nic)

- The build: one bundle for main and one per preload, the release flavour packaged for Apple silicon, all nine
  fuses, signed with a Developer ID and the hardened runtime, the microphone line, macOS 13 and later.
- The debugging guard: a release build started with a remote-debugging switch ends at once (exit code 3).
- The icon for macOS 13-15 (`Marver.icns`); macOS 26's `Marver.icon` is still to make in Icon Composer.
- The packaged smoke and the test harnesses.
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
  per canvas tab, cancelled by any refusal - and a refused quit shows the window, even one you had closed. Only a
  link that names a hash on the page's own document opens with no question; one without a hash is a new document.
- A canvas that starts after launch opens its tab on the board it was left on; a second `marver dev` of the same repo
  gets a tab of its own.
- The tab's own page in place of an error page - starting, stopped, not a Marver canvas, can't be reached, crashed -
  and crashes with one owner: the first reloads at once, a second within a minute latches until you press Reload.
- Not responding: the pill's Reload asks first, then ends the page's renderer once and reloads every tab it held.
- The menu bar: the app's keys fire once whatever the page does with keys; the canvas's own items with their keys in
  their names; a stale click does nothing. F6 between the strip and the page; focus never left beneath a tab page.
