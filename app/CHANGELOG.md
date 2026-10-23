# Changelog - the Marver Mac app

## 0.1.0 - unreleased (spec 28 A2, for Nic)

- The build: one bundle for main and one per preload, the release flavour packaged for Apple silicon, all nine
  fuses, signed with a Developer ID and the hardened runtime, the microphone line, macOS 13 and later.
- The debugging guard: a release build started with a remote-debugging switch ends at once (exit code 3).
- The icon for macOS 13-15 (`Marver.icns`); macOS 26's `Marver.icon` is still to make in Icon Composer.
- The packaged smoke and the test harnesses.
