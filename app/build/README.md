# app/build - the bundle's inputs

| File | What | Made by |
|---|---|---|
| `a-mark.svg`, `a-mark-l1.svg`, `a-mark-l2.svg` | Icon option A (Nic, 22 Oct), as balanced on 26 Oct (way 3, straighter: the slant eased, 15% room at each side): `a-mark-straighter*.svg`, copied from `marver-platform/canvas/design/scenes/mac-app/_icons/` | by hand |
| `Marver.icns` | the icon for macOS 13-15, from `a-mark.svg` | `node scripts/icon.mjs`, committed |
| `Marver.icon` | **not made yet** - the icon macOS 26 draws in its own glass | Icon Composer, by hand (below) |
| `entitlements/app.plist` | `Marver.app` and `Marver Helper.app`: allow-jit, audio-input | by hand |
| `entitlements/jit.plist` | the Renderer, GPU and Plugin helpers: allow-jit | by hand |

## Marver.icon (the manual step)

`Marver.icon` goes here, as `app/build/Marver.icon` - a folder Icon Composer saves (`icon.json` and `Assets/`).
Nothing may stand at that path until then: @electron/packager looks for `Marver.icon` beside `Marver.icns` and
compiles whatever it finds there with `actool`. While it is absent the build says so, the bundle wears
`Marver.icns` alone, and the smoke prints `WARN icon-composer`.

To make it (macOS 26 and Xcode 26 on the build Mac - `actool` 26; the app itself still runs on macOS 13):
1. Open Icon Composer (Xcode > Open Developer Tool > Icon Composer), new icon.
2. Background: the tile's blue gradient, `#54b2ff` at the top to `#005bd9` at the bottom.
3. Layer 1: `a-mark-l1.svg` (the rear glass); layer 2: `a-mark-l2.svg` (the front parallelogram); glass on.
4. Check the default, dark, clear and tinted looks against frame `mac-app-icon/04-straighter`. The layers still carry
   painted edge light that macOS 26 adds again: flat layers may read better - Nic's eye decides (spec 28 A2.14,
   "Not resolved here").
5. Save as `app/build/Marver.icon`, rebuild: packager compiles it into `Assets.car` and sets
   `CFBundleIconName`, and the smoke's `icon-composer` line turns PASS.
