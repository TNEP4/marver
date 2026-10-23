#!/usr/bin/env node
/**
 * The app icon for macOS 13-15 (spec 28 A2.8, A2.14 #29; option A, frame mac-app/12-icon-a):
 * build/a-mark.svg (the whole tile, its viewBox already the macOS 824/1024 body) -> build/Marver.icns.
 * Run by hand when the icon changes (`pnpm --filter marver-app icon`); the result is committed.
 *
 * Renders each size with Electron itself (scripts/icon-render.cjs: an offscreen page draws the SVG into a canvas
 * at exactly that many pixels, on a temporary profile), then `iconutil -c icns`.
 *
 * macOS 26 draws its own glass from build/Marver.icon, made once by hand in Icon Composer from a-mark-l1.svg and
 * a-mark-l2.svg (README.md says how); packager compiles it into Assets.car with actool.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const APP = resolve(import.meta.dirname, '..')
const require = createRequire(join(APP, 'package.json'))
const electron = require('electron')
const svg = join(APP, 'build', 'a-mark.svg')
const work = mkdtempSync(join(tmpdir(), 'mv-icon-'))
const iconset = join(work, 'Marver.iconset')
try {
  const r = spawnSync(electron, [join(APP, 'scripts', 'icon-render.cjs'), svg, iconset, join(work, 'profile')], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`icon-render exited ${r.status}`)
  const pngs = readdirSync(iconset).sort()
  if (pngs.length !== 10) throw new Error(`expected 10 PNGs in the iconset, got ${pngs.join(', ')}`)
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(APP, 'build', 'Marver.icns')], { stdio: 'inherit' })
  console.log(`build/Marver.icns from ${pngs.length} sizes`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
