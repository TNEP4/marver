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
