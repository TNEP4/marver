#!/usr/bin/env node
/**
 * Builds the Marver Mac app (spec 28 A2.8, A2.14 #29; spike S9's recipe, run 22 Oct).
 *
 *   node scripts/build.mjs --js       the dev flavour into dist/ (tests, `electron .`): bundles, pages, manifest
 *   node scripts/build.mjs            the release flavour, Developer ID signed, then the packaged smoke
 *   node scripts/build.mjs --adhoc    the same, ad-hoc signed (agents, CI, a locked keychain)
 *   --no-smoke                        skip the smoke (it runs on every build otherwise)
 *   --tamper                          the smoke's cases that crash the app on purpose too (each shows a macOS dialog)
 *   --known-fail=<check>[,<check>]    a smoke whose only failures are these named checks, each failing at a measured
 *                                     number, still moves into out/ - said loudly, with the number, and recorded in
 *                                     out/build.json (KNOWN_FAILABLE lists the only checks it can name)
 *
 * The release pipeline, each step failing the build, nothing retried:
 *   checks -> tsdown (release flavour) -> pages + manifest -> stage { package.json, dist/ } -> @electron/packager
 *   (unsigned, asar, arm64) -> @electron/fuses (all nine, strict) -> @electron/osx-sign (hardened runtime,
 *   per-helper entitlements) -> verify (codesign --deep --strict, one Team ID) -> test/smoke/smoke.mjs -> out/
 * Fuses come before signing: flipping them changes the binary. Output: out/Marver-darwin-arm64/Marver.app, and an
 * ad-hoc build in out/adhoc/Marver-darwin-arm64/Marver.app, so it never replaces Nic's signed one.
 *
 * Never a half-signed bundle in out/ (spec 28 A2.8): everything up to the smoke happens in app/.stage/<flavour>/
 * (a hidden folder, outside out/), and the finished bundle - signed, verified and smoked - moves into out/ only at
 * the end, by rename. A bundle launched while osx-sign works on it carries two Team IDs and crashes with macOS's
 * dialog; the one in out/ is always the last finished build. A build that fails leaves out/ as it was.
 *
 * The signing identity is Nic's Developer ID (MARVER_SIGN_IDENTITY overrides). The first signing on a Mac asks
 * the keychain for the private key ("Always Allow" once); Apple's timestamp server needs the network - an offline
 * build uses --adhoc.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { arch, platform, release } from 'node:os'
import { join, resolve } from 'node:path'
import { checkTeams } from './team-id.mjs'
import { tokensFrom } from './tokens.mjs'

export const APP = resolve(import.meta.dirname, '..')
export const ROOT = resolve(APP, '..')
export const ELECTRON = '45.0.0'
export const BUNDLE_ID = 'design.marver.app'
export const PRODUCT = 'Marver'
export const IDENTITY = process.env.MARVER_SIGN_IDENTITY || 'Developer ID Application: Nicolas Touron (PXV6WER853)'
/** The Team ID in the identity's name, which every Mach-O part of a signed build carries. */
export const TEAM = /\(([A-Z0-9]{10})\)$/.exec(IDENTITY)?.[1] ?? null
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

/**
 * The smoke checks a build may ship failing, by name, only with `--known-fail=<name>` (Nic, 24 Oct: app 0.2 goes to
 * him with the no-canvas memory gate failing at its measured value - 214 MB against 200 - the limit unchanged, the
 * cause investigated later). Each entry reads its measured number from the check's line in the smoke's report; a
 * failure with no number (an inconclusive gate) is never a known one. No other check can be named: a crash dialog, a
 * signature, a fuse or a budget not listed here always fails the build.
 */
export const KNOWN_FAILABLE = {
  'memory-no-canvas': {
    measured: (r) => r.memory?.totalMB,
    budget: (r) => r.memory?.budgetMB ?? 200,
    unit: 'MB',
    decision: 'Nic, 24 Oct: app 0.2 ships with it, the 200 MB limit unchanged; investigated later',
  },
}

/** `--known-fail=a,b` (repeatable) as names, or why the option is refused - an empty or unlisted name is never ignored. */
export function parseKnownFail(argv) {
  const names = []
  for (const a of argv) {
    if (a !== '--known-fail' && !a.startsWith('--known-fail=')) continue
    const list = a.startsWith('--known-fail=') ? a.slice('--known-fail='.length).split(',').map((x) => x.trim()) : []
    if (!list.length || list.some((x) => !x)) return { error: '--known-fail needs a check\'s name: --known-fail=memory-no-canvas' }
    for (const n of list) {
      if (!Object.hasOwn(KNOWN_FAILABLE, n)) return { error: `--known-fail=${n}: ${n} cannot be a known failure - only ${Object.keys(KNOWN_FAILABLE).join(', ')}` }
      if (!names.includes(n)) names.push(n)
    }
  }
  return { names }
}

/**
 * The smoke's verdict under the named known failures: ok only when every FAIL is a named, listed check failing at a
 * measured number, and the report adds up (its FAIL lines, its `failures` and the smoke's exit status agree). `known`
 * carries each one's number and its loud line; `other` the failures that are not known ones; `passed` the named
 * checks that passed this time.
 */
export function judgeSmoke(report, status, names) {
  const fails = report?.results?.filter((r) => r.verdict === 'FAIL')
  if (!fails) return { ok: false, known: [], other: [], passed: [], why: 'no smoke report to read' }
  if (fails.length !== report.failures || fails.length !== status) return { ok: false, known: [], other: [], passed: [], why: `the smoke's report does not add up: ${fails.length} FAIL lines, failures ${report.failures}, exit status ${status}` }
  const known = [], other = []
  for (const r of fails) {
    const k = names.includes(r.name) ? KNOWN_FAILABLE[r.name] : undefined
    const measured = k?.measured(r)
    if (!k || !Number.isFinite(measured)) { other.push(r.name); continue }
    const budget = k.budget(r)
    known.push({
      name: r.name, measured, unit: k.unit, budget, detail: r.detail, decision: k.decision,
      line: `KNOWN FAILURE ${r.name}: ${measured} ${k.unit} measured against the ${budget} ${k.unit} budget - let through by --known-fail=${r.name} (${k.decision})`,
    })
  }
  const passed = names.filter((n) => report.results.some((r) => r.name === n && r.verdict === 'PASS'))
  return { ok: !other.length, known, other, passed, ...(other.length ? { why: `${other.length} failing check(s) that are not named known failures: ${other.join(', ')}` } : {}) }
}

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

async function buildRelease({ adhoc, smoke, tamper, knownFail }) {
  checks({ release: true })
  if (knownFail.length && !smoke) fail('--known-fail names smoke checks: it cannot go with --no-smoke')
  const out = adhoc ? join(APP, 'out', 'adhoc') : join(APP, 'out')
  // the staging folder: never under out/, so nothing there is ever a bundle half-way through
  const work = join(APP, '.stage', adhoc ? 'adhoc' : 'signed')
  const stage = join(work, 'src')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  rmSync(join(out, 'stage'), { recursive: true, force: true })   // the old layout's stage, from before .stage/

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
    dir: stage, out: work, overwrite: true, quiet: true,
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
  step('verify (codesign --deep --strict, one Team ID)')
  const v = spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' })
  if (v.status !== 0) fail(`the signature does not verify: ${v.stderr.trim().split('\n').slice(-2).join(' | ')}`)
  const teams = checkTeams(app)
  if (!teams.ok) fail(teams.message)
  const want = adhoc ? null : TEAM   // a signed build with an identity whose name has no Team ID wants one, any
  if (adhoc ? teams.team !== null : teams.team === null || (want && teams.team !== want)) {
    fail(`every part carries Team ID ${teams.team ?? 'none'}, the build wants ${want ?? (adhoc ? 'none' : 'one')}`)
  }
  step(teams.message)

  let verdict = null
  let smokeReport = null
  if (smoke) {
    step(`smoke (in .stage/, before the move${tamper ? '; with --tamper' : ''}${knownFail.length ? `; known failures named: ${knownFail.join(', ')}` : ''})`)
    mkdirSync(out, { recursive: true })
    // its report into a folder of this build's own, so the one read is this smoke's; then beside out/ as before
    const reports = join(work, 'smoke')
    mkdirSync(reports, { recursive: true })
    const r = spawnSync(process.execPath, [join(APP, 'test', 'smoke', 'smoke.mjs'), app, `--report=${reports}`,
      ...(adhoc ? ['--adhoc'] : []), ...(tamper ? ['--tamper'] : [])], { stdio: 'inherit' })
    const file = readdirSync(reports).filter((f) => /^smoke-\d+\.json$/.test(f)).sort().at(-1)
    let report = null
    if (file) {
      cpSync(join(reports, file), join(out, file))
      smokeReport = file
      try { report = JSON.parse(readFileSync(join(reports, file), 'utf8')) } catch { report = null }
    }
    if (r.status !== 0 && !knownFail.length) fail(`the packaged smoke failed (${r.status} failing checks); out/ left as it was, the build in ${work}`)
    if (knownFail.length) {
      verdict = judgeSmoke(report, r.status, knownFail)
      if (!verdict.ok) fail(`the packaged smoke failed (${r.status} failing checks): ${verdict.why}; --known-fail lets through only ${knownFail.join(', ')} failing at a measured number; out/ left as it was, the build in ${work}`)
      const bar = '='.repeat(100)
      if (verdict.known.length) {
        console.error(`build: ${bar}`)
        for (const k of verdict.known) { console.error(`build: ${k.line}`); console.error(`build:   ${k.detail}`) }
        console.error(`build: ${bar}`)
      }
      for (const n of verdict.passed) console.log(`build: --known-fail=${n}: ${n} PASSED this time - the option is not needed for this build`)
    }
  }

  // the move: the finished bundle replaces out/'s by rename, the old one put aside first (never a mix of the two)
  step('into out/')
  mkdirSync(out, { recursive: true })
  const dest = join(out, `${PRODUCT}-darwin-arm64`)
  const old = join(work, 'previous')
  if (existsSync(dest)) renameSync(dest, old)
  renameSync(dir, dest)
  rmSync(work, { recursive: true, force: true })
  const final = join(dest, `${PRODUCT}.app`)
  const known = verdict?.known ?? []
  const report = { app: final, adhoc, version: pkg.version, electron: ELECTRON, team: teams.team, parts: teams.parts.length,
    icon: icon.map((p) => p.slice(APP.length + 1)), smoke: smoke ? (tamper ? 'with --tamper' : 'default') : 'skipped',
    ...(smokeReport ? { smokeReport } : {}),
    // never left out: a build moved into out/ with failing checks says which, at what number, and on whose decision
    knownFailures: known.map(({ name, measured, unit, budget, detail, decision }) => ({ name, measured, unit, budget, detail, decision })),
    ...(knownFail.length ? { knownFailNamed: knownFail } : {}),
    seconds: (Date.now() - t0) / 1000 }
  writeFileSync(join(out, 'build.json'), JSON.stringify(report, null, 2) + '\n')
  step(`built ${final}${known.length ? ` WITH ${known.length} KNOWN FAILURE${known.length > 1 ? 'S' : ''}: ${known.map((k) => `${k.name} ${k.measured} ${k.unit} (budget ${k.budget})`).join(', ')}` : ''}`)
  for (const k of known) console.error(`build: ${k.line}`)
  console.log(`APP=${final}`)
}

// run as a script (tests import the constants above without building)
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2)
  const known = parseKnownFail(args)
  if (known.error) fail(known.error)
  if (args.includes('--js')) buildJs()
  else await buildRelease({ adhoc: args.includes('--adhoc'), smoke: !args.includes('--no-smoke'), tamper: args.includes('--tamper'), knownFail: known.names })
}
