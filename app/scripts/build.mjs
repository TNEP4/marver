#!/usr/bin/env node
/**
 * Builds the Marver Mac app (spec 28 A2.8, A2.14 #29; spike S9's recipe, run 22 Oct).
 *
 *   node scripts/build.mjs --js       the dev flavour into dist/ (tests, `electron .`): bundles, pages, manifest
 *   node scripts/build.mjs            the release flavour, Developer ID signed, then the packaged smoke
 *   node scripts/build.mjs --adhoc    the same, ad-hoc signed (agents, CI, a locked keychain)
 *   --no-smoke                        skip the smoke (it runs on every build otherwise)
 *
 * The release pipeline, each step failing the build, nothing retried:
 *   checks -> tsdown (release flavour) -> pages + manifest -> stage { package.json, dist/ } -> @electron/packager
 *   (unsigned, asar, arm64) -> @electron/fuses (all nine, strict) -> @electron/osx-sign (hardened runtime,
 *   per-helper entitlements) -> test/smoke/smoke.mjs
 * Fuses come before signing: flipping them changes the binary. Output: out/Marver-darwin-arm64/Marver.app, and an
 * ad-hoc build in out/adhoc/Marver-darwin-arm64/Marver.app, so it never replaces Nic's signed one.
 *
 * The signing identity is Nic's Developer ID (MARVER_SIGN_IDENTITY overrides). The first signing on a Mac asks
 * the keychain for the private key ("Always Allow" once); Apple's timestamp server needs the network - an offline
 * build uses --adhoc.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { arch, platform, release } from 'node:os'
import { join, resolve } from 'node:path'
import { tokensFrom } from './tokens.mjs'

export const APP = resolve(import.meta.dirname, '..')
export const ROOT = resolve(APP, '..')
export const ELECTRON = '45.0.0'
export const BUNDLE_ID = 'design.marver.app'
export const PRODUCT = 'Marver'
export const IDENTITY = process.env.MARVER_SIGN_IDENTITY || 'Developer ID Application: Nicolas Touron (PXV6WER853)'
export const MIC = 'Marver uses the microphone only during a Jam session you start.'
export const MIN_MACOS = '13.0'
/** Strings only the dev flavour's test hooks hold (testing/index.ts): the release bundle must have none. */
export const TEST_SENTINELS = ['mv-test-hook', 'MARVER_APP_CONTROL', '__mvTest', 'MARVER_APP_SPY']

const require = createRequire(join(APP, 'package.json'))
const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'))
const ENT_APP = join(APP, 'build', 'entitlements', 'app.plist')
const ENT_JIT = join(APP, 'build', 'entitlements', 'jit.plist')
const ICNS = join(APP, 'build', 'Marver.icns')
const ICON_COMPOSER = join(APP, 'build', 'Marver.icon')

const t0 = Date.now()
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`)
const fail = (s) => { console.error(`build: ${s}`); process.exit(1) }

/** True once Nic has made Marver.icon in Icon Composer (a folder with icon.json); until then only the .icns. */
export const iconComposerReady = () => existsSync(join(ICON_COMPOSER, 'icon.json'))

function walk(dir, base = dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, base))
    else out.push(p.slice(base.length + 1))
  }
  return out
}

/** The bundles (tsdown.config.ts) of one flavour into `out`. */
function bundles(flavour, out) {
  const bin = join(resolve(require.resolve('tsdown/package.json'), '..'), 'dist', 'run.mjs')
  const r = spawnSync(process.execPath, [bin, '--config', 'tsdown.config.ts'], {
    cwd: APP, stdio: 'inherit', env: { ...process.env, MV_FLAVOUR: flavour, MV_OUT: out },
  })
  if (r.status !== 0) fail(`tsdown failed (${flavour})`)
}

/**
 * The pages: each `pages/<page>/` folder's HTML and CSS beside its built main.js, the shell's tokens and
 * `pages/shared/` in dist/pages/shared/, and dist/pages/manifest.json - generated from what was copied, never
 * kept by hand. The manifest maps each page (the host of marver-app://<page>/) to the URL paths it may serve:
 *   { "strip": { "/": "strip/index.html", "/index.html": "strip/index.html", "/main.js": "strip/main.js",
 *                "/style.css": "strip/style.css", "/tokens.css": "shared/tokens.css", ... }, ... }
 * Anything else answers 404 (sessions.ts serves it, A2.5). Source maps are never listed.
 */
function pages(out) {
  const src = join(APP, 'pages')
  const dst = join(out, 'pages')
  const shared = join(dst, 'shared')
  mkdirSync(shared, { recursive: true })
  writeFileSync(join(shared, 'tokens.css'), tokensFrom(join(ROOT, 'src', 'client', 'shell', 'styles.css')))
  if (existsSync(join(src, 'shared'))) cpSync(join(src, 'shared'), shared, { recursive: true })
  const sharedFiles = walk(shared)
  const manifest = {}
  for (const p of readdirSync(src, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'shared').map((d) => d.name)) {
    if (!existsSync(join(src, p, 'index.html'))) fail(`pages/${p} has no index.html`)
    mkdirSync(join(dst, p), { recursive: true })
    for (const f of readdirSync(join(src, p))) if (/\.(html|css)$/.test(f)) cpSync(join(src, p, f), join(dst, p, f))
    const files = {}
    for (const f of sharedFiles) if (!f.endsWith('.map')) files[`/${f}`] = `shared/${f}`
    for (const f of walk(join(dst, p))) if (!f.endsWith('.map')) files[`/${f}`] = `${p}/${f}`
    files['/'] = `${p}/index.html`
    manifest[p] = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
  }
  writeFileSync(join(dst, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

/** The release flavour must hold no test hook (A2.14 #27); checked here and again by the smoke, in the asar. */
function checkNoTestHooks(dist) {
  for (const f of walk(dist).filter((f) => /\.(c?js)$/.test(f))) {
    const text = readFileSync(join(dist, f), 'utf8')
    const hit = TEST_SENTINELS.find((s) => text.includes(s))
    if (hit) fail(`the release bundle ${f} holds the test hook string "${hit}"`)
  }
}

function checks({ release: rel }) {
  const ev = JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8')).version
  if (ev !== ELECTRON) fail(`electron ${ev} installed, the app pins ${ELECTRON}`)
  if (!rel) return
  if (platform() !== 'darwin' || arch() !== 'arm64') fail('the app is built on an Apple silicon Mac')
  if (!existsSync(ICNS)) fail('build/Marver.icns is missing - run `node scripts/icon.mjs`')
  if (iconComposerReady()) {
    if (Number(release().split('.')[0]) < 25) fail('Marver.icon needs macOS 26 on the build Mac (actool 26)')
    const v = execFileSync('xcrun', ['actool', '--version'], { encoding: 'utf8' })
    const m = /<key>short-bundle-version<\/key>\s*<string>(\d+)/.exec(v)
    if (!m || Number(m[1]) < 26) fail('Marver.icon needs Xcode 26 or later (actool 26)')
  } else {
    console.log('build: build/Marver.icon is not made yet (Icon Composer, by hand - see app/build/README.md): the bundle wears Marver.icns alone')
  }
}

/** The dev flavour into dist/, for tests and `electron .`; also fetches Electron's binary when it is missing. */
export function buildJs() {
  checks({ release: false })
  require('electron')   // the path lookup downloads the binary when missing (electron 45 has no install script)
  const dist = join(APP, 'dist')
  rmSync(dist, { recursive: true, force: true })
  bundles('dev', 'dist')
  const manifest = pages(dist)
  step(`dist/ (dev flavour): main, 2 preloads, ${Object.keys(manifest).length} pages`)
}

async function buildRelease({ adhoc, smoke }) {
  checks({ release: true })
  const out = adhoc ? join(APP, 'out', 'adhoc') : join(APP, 'out')
  const stage = join(out, 'stage')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })

  step('bundles (release flavour)')
  bundles('release', join(stage, 'dist'))
  pages(join(stage, 'dist'))
  checkNoTestHooks(join(stage, 'dist'))
  writeFileSync(join(stage, 'package.json'), JSON.stringify({
    name: pkg.name, productName: PRODUCT, version: pkg.version, private: true, main: 'dist/main.cjs',
  }, null, 2) + '\n')

  step('package (unsigned)')
  const { packager } = await import('@electron/packager')
  const icon = iconComposerReady() ? [ICON_COMPOSER, ICNS] : [ICNS]
  const [dir] = await packager({
    dir: stage, out, overwrite: true, quiet: true,
    name: PRODUCT, platform: 'darwin', arch: 'arm64', electronVersion: ELECTRON,
    asar: true, prune: false, junk: true,
    appBundleId: BUNDLE_ID, appCategoryType: 'public.app-category.developer-tools',
    appVersion: pkg.version, buildVersion: pkg.version,
    icon,
    usageDescription: { Microphone: MIC },
    extendInfo: { LSMinimumSystemVersion: MIN_MACOS, CFBundleDisplayName: PRODUCT, LSArchitecturePriority: ['arm64'] },
  })
  const app = join(dir, `${PRODUCT}.app`)

  step('fuses (all nine, strict)')
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses')
  await flipFuses(app, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    resetAdHocDarwinSignature: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true,
  })

  // An ad-hoc signature has no Team ID, and the hardened runtime's library validation then refuses to map Electron
  // Framework into the process ("different Team IDs"): ad-hoc builds are signed without it. They serve agents and
  // CI - the fuses, the guard, the archive - never Nic's builds, which are Developer ID signed with it.
  step(adhoc ? 'sign (ad-hoc, no hardened runtime)' : `sign (${IDENTITY}, hardened runtime; the keychain may ask once)`)
  const { sign } = await import('@electron/osx-sign')
  const mainApp = resolve(app)
  await sign({
    app, platform: 'darwin', type: 'distribution',
    identity: adhoc ? '-' : IDENTITY,
    identityValidation: !adhoc,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: true,
    optionsForFile: (file) => ({
      hardenedRuntime: !adhoc,
      entitlements: resolve(file) === mainApp || file.endsWith(`/${PRODUCT} Helper.app`) ? ENT_APP : ENT_JIT,
      ...(adhoc ? { timestamp: 'none' } : {}),
    }),
  })
  const report = { app, adhoc, version: pkg.version, electron: ELECTRON, icon: icon.map((p) => p.slice(APP.length + 1)), seconds: (Date.now() - t0) / 1000 }
  writeFileSync(join(out, 'build.json'), JSON.stringify(report, null, 2) + '\n')
  step(`built ${app}`)

  if (smoke) {
    step('smoke')
    const r = spawnSync(process.execPath, [join(APP, 'test', 'smoke', 'smoke.mjs'), app, ...(adhoc ? ['--adhoc'] : [])], { stdio: 'inherit' })
    if (r.status !== 0) fail(`the packaged smoke failed (${r.status} failing checks)`)
  }
  console.log(`APP=${app}`)
}

// run as a script (tests import the constants above without building)
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2)
  if (args.includes('--js')) buildJs()
  else await buildRelease({ adhoc: args.includes('--adhoc'), smoke: !args.includes('--no-smoke') })
}
