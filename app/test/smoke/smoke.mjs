#!/usr/bin/env node
/**
 * The packaged smoke (spec 28 A2.8, A2.10, A2.14 #29, #30, v1.12 r1 #9): no Playwright, on the signed, fused
 * build - spike S9's twelve checks and X7's cases, against the real app.
 *
 *   node test/smoke/smoke.mjs [<Marver.app>] [--adhoc] [--keep] [--tamper] [--report=<dir>]
 *
 * The default app is out/Marver-darwin-arm64/Marver.app. `--adhoc` expects an ad-hoc signature (no Developer ID,
 * no timestamp). `--keep` leaves the run's temporary folder. Every line is PASS, FAIL, WARN or SKIP; the exit code
 * is the number of FAILs; a JSON report goes beside the app's out/ folder (smoke-<time>.json), or into --report's.
 *
 * Nothing on Nic's screen by default (spec 28 A2.8). The cases that crash the app on purpose - a byte changed in
 * app.asar (twice), and on a signed build the renamed copy the kernel kills - each make macOS show its "quit
 * unexpectedly" dialog, so they run only with `--tamper` and are SKIP lines otherwise; the run then checks that no
 * crash report of Marver's appeared while it ran. And no launch at all of a bundle whose Mach-O parts carry more
 * than one Team ID (scripts/team-id.mjs): a bundle caught while it is being signed crashes at once, with the dialog.
 *
 * Every launch runs on its own temporary profile - MARVER_APP_USER_DATA, MARVER_HOME and MARVER_SLOT_BASE - so a
 * Marver Nic has open holds another lock and nothing of his is read or written: the smoke checks that
 * ~/Library/Application Support/Marver (and Marver Dev) - their listing and modification times - did not change.
 * Only the guard's exit code 3 passes a debugging-switch case, so a launch that met any lock can never pass as a
 * refusal. The smoke ends only processes it started (each launch is its own process group).
 *
 * A2's budgets (A2.14 #28, v1.12 r1 #8, #9; the Budgets section), measured from outside the signed build:
 * - launch-warm: the clean launch's profile launched a second time, spawn to the request the fake canvas's page
 *   sends from its first animation-frame callback, under 1 s; the first launch's time is reported, not gated.
 * - memory-no-canvas: three fake canvases registered, Home active, none ever shown; the app's own memory as macOS
 *   counts it - each process's physical footprint (Activity Monitor's Memory), read with /usr/bin/footprint, never by
 *   the app about itself (Nic, 23 Oct; A3.8 #2, #48) - the browser, the GPU process, every utility process, the strip
 *   and Home (and crashpad's handler), under 200 MB as the mean of three reads 10 s apart.
 * - memory-canvas-open: the second launch's canvas loaded and shown; the same without the GPU process, whose
 *   footprint is reported beside it, never counted (no Electron API splits GPU memory by canvas), nor the canvas's
 *   renderer - told apart from the app pages' from outside: it is the one renderer that spent the 2.5 s of CPU its
 *   page burns when the smoke asks it to.
 * A footprint that cannot be read makes a memory gate inconclusive, a FAIL, never a pass on RSS. A gate that fails
 * says its numbers; the limits are not loosened here - the numbers go to Nic.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { BUNDLE_ID, IDENTITY, MIC, MIN_MACOS, PRODUCT, TEAM, TEST_SENTINELS } from '../../scripts/build.mjs'
import { bundleOf, checkTeams, machOParts } from '../../scripts/team-id.mjs'

const APP_DIR = resolve(import.meta.dirname, '..', '..')
const require = createRequire(join(APP_DIR, 'package.json'))
const args = process.argv.slice(2)
const appPath = resolve(args.find((a) => !a.startsWith('--')) ?? join(APP_DIR, 'out', `${PRODUCT}-darwin-arm64`, `${PRODUCT}.app`))
const adhoc = args.includes('--adhoc')
const keep = args.includes('--keep')
const tamper = args.includes('--tamper')
const reportArg = args.find((a) => a.startsWith('--report='))?.slice('--report='.length)
const BIN = join(appPath, 'Contents', 'MacOS', PRODUCT)
const VERSION = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')).version
if (!existsSync(BIN)) { console.error(`smoke: no app at ${appPath}`); process.exit(1) }

// short paths: a Unix socket or a Chromium profile path must stay well under macOS's limits
const RUN = realpathSync(mkdtempSync(join(tmpdir(), 'mv-smoke-')))
const results = []
const t0 = Date.now()
const log = (verdict, name, detail = '') => {
  results.push({ verdict, name, detail })
  console.log(`${verdict} ${name}${detail ? ' ' + detail : ''}`)
}
const pass = (n, d) => log('PASS', n, d)
const fail = (n, d) => log('FAIL', n, d)
const warn = (n, d) => log('WARN', n, d)
const skip = (n, d) => log('SKIP', n, d)
const TAMPER_SKIP = 'run with --tamper: it crashes the app on purpose, and macOS shows a dialog for it'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sh = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: 'utf8', ...opts })

// ---- Nic's own profiles, before anything runs -----------------------------------------------------
const NIC = [join(homedir(), 'Library', 'Application Support', 'Marver'), join(homedir(), 'Library', 'Application Support', 'Marver Dev')]
function snapshot(dir) {
  if (!existsSync(dir)) return 'absent'
  const st = statSync(dir)
  return JSON.stringify({ mtime: st.mtimeMs, entries: readdirSync(dir).sort().map((n) => { const s = lstatSync(join(dir, n)); return [n, s.mtimeMs, s.size] }) })
}
const nicBefore = NIC.map(snapshot)
// macOS's crash reports: one of Marver's written during the run is a "quit unexpectedly" dialog on Nic's screen
const REPORTS = join(homedir(), 'Library', 'Logs', 'DiagnosticReports')
function crashReports() {
  try {
    return readdirSync(REPORTS).filter((n) => n.startsWith(PRODUCT) && statSync(join(REPORTS, n)).mtimeMs >= t0).sort()
  } catch { return null }
}
// and the login keychain: every launch below passes Chromium's --use-mock-keychain, so the cookie key never
// reaches "Marver Safe Storage" (an item an ad-hoc build made would make Nic's signed app ask for it later)
const KEYCHAIN_ITEM = `${PRODUCT} Safe Storage`
const keychainHas = () => sh('security', ['find-generic-password', '-s', KEYCHAIN_ITEM]).status === 0   // attributes only, never the secret
const keychainBefore = keychainHas()
const MOCK_KEYCHAIN = '--use-mock-keychain'

// ---- static checks ---------------------------------------------------------------------------------
function plist(file) { return JSON.parse(sh('plutil', ['-convert', 'json', '-o', '-', file]).stdout) }

{ // 1. Info.plist
  const p = plist(join(appPath, 'Contents', 'Info.plist'))
  const res = join(appPath, 'Contents', 'Resources')
  const want = {
    CFBundleIdentifier: BUNDLE_ID, CFBundleName: PRODUCT, CFBundleDisplayName: PRODUCT, CFBundleExecutable: PRODUCT,
    CFBundleShortVersionString: VERSION, LSMinimumSystemVersion: MIN_MACOS, NSMicrophoneUsageDescription: MIC,
  }
  const bad = Object.entries(want).filter(([k, v]) => p[k] !== v).map(([k, v]) => `${k}=${JSON.stringify(p[k])} (want ${JSON.stringify(v)})`)
  const iconFile = String(p.CFBundleIconFile ?? '')
  if (!iconFile || !(existsSync(join(res, iconFile)) || existsSync(join(res, `${iconFile}.icns`)))) bad.push(`CFBundleIconFile ${iconFile} names no file`)
  if (!p.ElectronAsarIntegrity?.['Resources/app.asar']?.hash) bad.push('no ElectronAsarIntegrity for Resources/app.asar')
  bad.length ? fail('info-plist', bad.join('; ')) : pass('info-plist', `${BUNDLE_ID} ${VERSION}, macOS ${MIN_MACOS}+, microphone line, icon ${iconFile}`)
  const iconComposer = existsSync(join(APP_DIR, 'build', 'Marver.icon', 'icon.json'))
  if (!iconComposer) warn('icon-composer', 'build/Marver.icon not made yet (Icon Composer, by hand): macOS 26 shows Marver.icns')
  else if (p.CFBundleIconName === 'Icon' && existsSync(join(res, 'Assets.car'))) pass('icon-composer', 'Assets.car and CFBundleIconName')
  else fail('icon-composer', `CFBundleIconName=${p.CFBundleIconName}, Assets.car ${existsSync(join(res, 'Assets.car'))}`)
}

{ // 2. arm64 only
  const archs = sh('lipo', ['-archs', BIN]).stdout.trim()
  archs === 'arm64' ? pass('arm64-only', archs) : fail('arm64-only', archs)
}

{ // 3. the signature verifies (S9 #1)
  const r = sh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  r.status === 0 ? pass('codesign-verify', '--deep --strict') : fail('codesign-verify', r.stderr.trim().split('\n').slice(-2).join(' | '))
}

{ // 4. who signed it, hardened runtime, timestamp
  const d = sh('codesign', ['-dvv', appPath]).stderr
  const runtime = /flags=0x[0-9a-f]*\(.*runtime.*\)/.test(d)
  if (adhoc) {
    // no hardened runtime on an ad-hoc build: library validation would refuse Electron Framework (build.mjs)
    ;/Signature=adhoc/.test(d) ? pass('signature', `ad-hoc${runtime ? ', hardened runtime' : ', no hardened runtime (by design)'}`) : fail('signature', d.split('\n').filter((l) => /Signature|flags/.test(l)).join(' | '))
  } else {
    const ok = d.includes(`Authority=${IDENTITY}`) && (!TEAM || d.includes(`TeamIdentifier=${TEAM}`)) && runtime && /Timestamp=/.test(d)
    ok ? pass('signature', `${IDENTITY}, hardened runtime, timestamped`) : fail('signature', d.split('\n').filter((l) => /Authority=|TeamIdentifier|flags|Timestamp/.test(l)).join(' | '))
  }
}

{ // 5. each bundle's entitlements, exactly
  const JIT = 'com.apple.security.cs.allow-jit'
  const MICK = 'com.apple.security.device.audio-input'
  const fw = join(appPath, 'Contents', 'Frameworks')
  const cases = [[appPath, [JIT, MICK]], [join(fw, `${PRODUCT} Helper.app`), [JIT, MICK]],
    [join(fw, `${PRODUCT} Helper (Renderer).app`), [JIT]], [join(fw, `${PRODUCT} Helper (GPU).app`), [JIT]], [join(fw, `${PRODUCT} Helper (Plugin).app`), [JIT]]]
  const bad = []
  for (const [bundle, want] of cases) {
    const xml = join(RUN, `ent-${basename(bundle).replace(/\W+/g, '-')}.plist`)
    writeFileSync(xml, sh('codesign', ['-d', '--entitlements', '-', '--xml', bundle]).stdout)
    let got = []
    try { got = Object.entries(plist(xml)).filter(([, v]) => v === true).map(([k]) => k).sort() } catch { got = ['(unreadable)'] }
    if (JSON.stringify(got) !== JSON.stringify([...want].sort())) bad.push(`${basename(bundle)}: ${got.join(', ') || 'none'}`)
  }
  bad.length ? fail('entitlements', bad.join('; ')) : pass('entitlements', 'app + Helper: allow-jit, audio-input; Renderer, GPU, Plugin: allow-jit')
}

{ // 6. the fuses read back (S9 #2), all nine
  const { getCurrentFuseWire, FuseV1Options, FuseState } = await import(require.resolve('@electron/fuses'))
  const wire = await getCurrentFuseWire(appPath)
  const want = { RunAsNode: false, EnableCookieEncryption: true, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: true, OnlyLoadAppFromAsar: true, LoadBrowserProcessSpecificV8Snapshot: false,
    GrantFileProtocolExtraPrivileges: false, WasmTrapHandlers: true }
  const keys = Object.keys(wire).filter((k) => /^\d+$/.test(k))
  const bad = Object.entries(want).filter(([n, on]) => wire[FuseV1Options[n]] !== (on ? FuseState.ENABLE : FuseState.DISABLE)).map(([n]) => n)
  if (keys.length !== 9) bad.push(`a wire of ${keys.length} fuses`)
  bad.length ? fail('fuses-read', bad.join(', ')) : pass('fuses-read', '9/9 as A2.8')
}

{ // 7. the archive: package.json and dist/ alone, the release flavour, no test hook
  const asar = await import(require.resolve('@electron/asar'))
  const archive = join(appPath, 'Contents', 'Resources', 'app.asar')
  const files = asar.listPackage(archive, { isPack: false })
  const bad = files.filter((f) => !/^\/(package\.json|dist(\/.*)?)$/.test(f))
  for (const f of files.filter((f) => /\.(c?js|map)$/.test(f))) {
    if (f.endsWith('.map')) { bad.push(`${f} (a source map)`); continue }
    const text = asar.extractFile(archive, f.slice(1)).toString('utf8')
    const hit = TEST_SENTINELS.find((s) => text.includes(s))
    if (hit) bad.push(`${f} holds "${hit}"`)
  }
  const main = asar.extractFile(archive, 'dist/main.cjs').toString('utf8')
  if (/\bvite\b/.test(main)) bad.push('dist/main.cjs mentions vite')
  if (!files.includes('/dist/pages/manifest.json')) bad.push('no dist/pages/manifest.json')
  bad.length ? fail('asar-contents', bad.join('; ')) : pass('asar-contents', `${files.length} entries: package.json and dist/, no test hook, no source map`)
}

// ---- one Team ID, or no launch at all ------------------------------------------------------------------
const started = []   // every process group this smoke started
let block = null
const teamChecks = new Map()
/** The bundle holding `bin` carries one Team ID (scripts/team-id.mjs); checked once per bundle. */
function teamCheck(bin) {
  const app = bundleOf(bin) ?? appPath
  if (!teamChecks.has(app)) teamChecks.set(app, checkTeams(app))
  return teamChecks.get(app)
}
{
  const v = teamCheck(BIN)
  const want = adhoc ? null : TEAM
  if (!v.ok) { fail('team-id', v.message); await finish('no launch: the bundle carries more than one Team ID') }
  else if (adhoc ? v.team !== null : v.team === null || (want && v.team !== want)) {
    fail('team-id', `refusing to launch ${appPath}: every part carries Team ID ${v.team ?? 'none'}, ${adhoc ? 'an ad-hoc build carries none' : `the signed build wants ${want ?? 'one'}`}`)
    await finish('no launch: the bundle carries another Team ID')
  } else pass('team-id', v.message)
}

// ---- launches ---------------------------------------------------------------------------------------
const { takeBlock } = await import(resolve(APP_DIR, '..', 'test', 'slot-block.ts'))
block = await takeBlock()
const SLOT_BASE = block.base

function freePort() {
  // the X7 probes poll a port nothing should ever open: one in the smoke's own block, past the twenty slots
  freePort.n = (freePort.n ?? 100) + 1
  return SLOT_BASE + freePort.n
}

/**
 * One launch on its own profile. Returns { pid, dir, ud, home, out, err, exit (promise), t0 }. A bundle whose
 * Mach-O parts carry more than one Team ID is never launched: the case gets a launch that never ran (`refused`).
 */
function launch(name, { argv = [], env = {}, bin = BIN, stdio } = {}) {
  const dir = join(RUN, name)
  const ud = join(dir, 'ud')
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const t = Date.now()
  const teams = teamCheck(bin)
  if (!teams.ok) {
    fail(`team-id-${name}`, teams.message)
    return { name, child: null, pid: 0, dir, ud, home, out: '', err: teams.message, t0: t, exitAt: 0, code: null, signal: 'REFUSED', refused: true, exit: Promise.resolve({ code: null, signal: 'REFUSED' }) }
  }
  const child = spawn(bin, [...argv, MOCK_KEYCHAIN], {
    env: { ...process.env, MARVER_APP_USER_DATA: ud, MARVER_HOME: home, MARVER_SLOT_BASE: String(SLOT_BASE), ...env },
    stdio: stdio ?? ['ignore', 'pipe', 'pipe'], detached: true,
  })
  started.push(child.pid)
  const L = { name, child, pid: child.pid, dir, ud, home, out: '', err: '', t0: t, exitAt: null, code: null, signal: null }
  child.stdout?.on('data', (c) => { L.out += c })
  child.stderr?.on('data', (c) => { L.err += c })
  L.exit = new Promise((r) => child.on('exit', (code, signal) => { L.code = code; L.signal = signal; L.exitAt = Date.now() - t; r({ code, signal }) }))
  return L
}
const alive = (L) => L.code === null && L.signal === null
/** what main's error policy recorded on this launch (errors.ts): an uncaught exception or rejection, never a box */
const mainErrors = (L) => { try { return readFileSync(join(L.home, 'perf', 'app.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"main-error"')).map((l) => l.slice(0, 300)) } catch { return [] } }
const lexists = (p) => { try { lstatSync(p); return true } catch { return false } }
/** main.ts ran on this launch's profile: the lock taken there, and the crash reporter's database made in its home */
const mainRan = (L) => lexists(join(L.ud, 'SingletonLock')) && existsSync(join(L.home, 'perf', 'crashpad', 'settings.dat'))
/** ready: persist:app made (sessions.ts at ready) */
const reachedReady = (L) => existsSync(join(L.ud, 'Partitions'))
async function waitFor(fn, ms, every = 50) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(every) } return fn() }
/** `signal` to the launch's process group (main and every helper at once), or with `{ group: false }` to main alone, as
 *  `kill <pid>` would; then up to `ms`, then SIGKILL to the group. */
async function stop(L, signal = 'SIGTERM', ms = 10_000, { group = true } = {}) {
  if (L.refused) return true
  if (alive(L)) { try { process.kill(group ? -L.pid : L.pid, signal) } catch { /* gone */ } }
  const done = await Promise.race([L.exit.then(() => true), sleep(ms).then(() => false)])
  if (!done) { try { process.kill(-L.pid, 'SIGKILL') } catch { /* gone */ } await L.exit }
  return done
}
function poll(port, everyMs = 10) {
  const st = { answers: 0, connects: 0 }
  let on = true
  const tick = () => {
    if (!on) return
    const req = request({ host: '127.0.0.1', port, path: '/json/version', timeout: 300, agent: false }, (res) => { res.resume(); res.on('end', () => { st.answers++ }) })
    req.on('socket', (s) => s.on('connect', () => { st.connects++ }))
    req.on('timeout', () => req.destroy()); req.on('error', () => {})
    req.end()
  }
  const iv = setInterval(tick, everyMs); tick()
  return { st, stop: () => { on = false; clearInterval(iv) } }
}

// ---- the budgets, read from outside the app (A2.14 #28; Budgets; A3.8 #2, #48) ------------------------------------
const BUDGET_LAUNCH_MS = 1000
const BUDGET_MEMORY_MB = 200
const MB = (bytes) => bytes / 1048576
const mb = (bytes) => MB(bytes).toFixed(1)
/** the GPU process's footprint with a canvas open (memory-canvas-open), for the no-canvas run's line */
let gpuWithCanvas = null

/** Every process of a launch, from outside: main (its group's leader), the helpers in its group, and anything whose
 *  command names the launch's folder (crashpad's handler: its database is in the launch's MARVER_HOME). */
function processesOf(L) {
  const ids = new Set([String(L.pid)])
  for (const args of [['-g', String(L.pid)], ['-f', L.dir]]) for (const p of sh('pgrep', args).stdout.split('\n')) if (p.trim()) ids.add(p.trim())
  return sh('ps', ['-o', 'pid=,rss=,time=,command=', '-p', [...ids].join(',')]).stdout.split('\n').flatMap((row) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(row)
    if (!m) return []
    const [, pid, rss, time, cmd] = m
    const role = Number(pid) === L.pid ? 'browser' : /--type=gpu-process/.test(cmd) ? 'gpu' : /--type=utility/.test(cmd) ? 'utility'
      : /--type=renderer/.test(cmd) ? 'renderer' : /crashpad/.test(cmd) ? 'crashpad' : 'other'
    const sub = /--utility-sub-type=(\S+)/.exec(cmd)?.[1]
    return [{ pid: Number(pid), rssKB: Number(rss), cpu: time.split(':').reduce((a, x) => a * 60 + Number(x), 0), role, sub }]
  })
}
/** pid -> CPU seconds */
const cpuOf = (procs) => new Map(procs.map((p) => [p.pid, p.cpu]))
/** pid -> physical footprint in bytes (Activity Monitor's Memory column), by /usr/bin/footprint; missing when unread */
function footprints(pids) {
  const file = join(RUN, `footprint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
  sh('/usr/bin/footprint', ['--noCategories', '-f', 'bytes', '-j', file, ...pids.flatMap((p) => ['-p', String(p)])])
  const out = new Map()
  try {
    for (const p of JSON.parse(readFileSync(file, 'utf8')).processes ?? []) {
      const b = p?.auxiliary?.phys_footprint ?? p?.footprint
      if (Number.isFinite(b)) out.set(p.pid, b)
    }
  } catch { /* nothing read */ }
  return out
}
/** One read of a launch's memory: every process with its footprint; null when any footprint could not be read (twice). */
function readMemory(L) {
  for (let i = 0; i < 2; i++) {
    const procs = processesOf(L)
    const fp = footprints(procs.map((p) => p.pid))
    if (procs.length && procs.every((p) => fp.has(p.pid))) return procs.map((p) => ({ ...p, fp: fp.get(p.pid) }))
  }
  return null
}
/**
 * A memory gate (A3.8 #48, at A2's scale): after 10 s, three reads 10 s apart; the mean of the counted footprints
 * under BUDGET_MEMORY_MB. Counted: the browser, every utility process, the app pages' renderers (every renderer but the
 * canvas's), crashpad's handler and anything else of the launch's - and the GPU process only with `countGpu` (a run
 * with no canvas open). Reported beside: the GPU process when not counted, the canvas's renderer, the RSS sums.
 * Inconclusive - a FAIL - when a footprint cannot be read, the renderers change between reads, or `check` says so.
 * Returns the GPU process's mean footprint in bytes, or null.
 */
async function memoryGate(name, L, { canvas, countGpu, check }) {
  await sleep(10_000)
  const samples = []
  for (let i = 0; i < 3; i++) { if (i) await sleep(10_000); samples.push(alive(L) ? readMemory(L) : null) }
  const why = !alive(L) ? `the app went (code=${L.code} signal=${L.signal})`
    : samples.some((x) => !x) ? 'a footprint could not be read (/usr/bin/footprint)'
      : new Set(samples.map((x) => x.filter((p) => p.role === 'renderer').map((p) => p.pid).sort().join(','))).size > 1 ? 'the renderers changed between reads'
        : check?.() ?? null
  if (why) { fail(name, `inconclusive: ${why}`); return null }
  const mean = (f) => samples.reduce((a, x) => a + x.filter(f).reduce((b, p) => b + p.fp, 0), 0) / samples.length
  const meanRss = (f) => samples.reduce((a, x) => a + x.filter(f).reduce((b, p) => b + p.rssKB * 1024, 0), 0) / samples.length
  const isCanvas = (p) => canvas.has(p.pid)
  const counted = (p) => !isCanvas(p) && (countGpu || p.role !== 'gpu')
  const last = samples.at(-1)
  const n = (f) => last.filter(f).length
  const total = mean(counted)
  const gpu = mean((p) => p.role === 'gpu')
  const parts = [
    `browser ${mb(mean((p) => p.role === 'browser'))}`,
    `utility ${mb(mean((p) => p.role === 'utility'))} (${last.filter((p) => p.role === 'utility').map((p) => p.sub?.replace(/\.mojom\./, ' ').split(' ').pop() ?? '?').join(', ')})`,
    `app pages ${mb(mean((p) => p.role === 'renderer' && !isCanvas(p)))} (${n((p) => p.role === 'renderer' && !isCanvas(p))} renderers)`,
    `crashpad ${mb(mean((p) => p.role === 'crashpad'))}`,
    ...(n((p) => p.role === 'other') ? [`other ${mb(mean((p) => p.role === 'other'))} (${n((p) => p.role === 'other')})`] : []),
    countGpu ? `GPU ${mb(gpu)} counted${gpuWithCanvas !== null ? ` (${mb(gpuWithCanvas)} with a canvas open: ${gpuWithCanvas >= gpu ? '+' : ''}${mb(gpuWithCanvas - gpu)})` : ''}` : `GPU ${mb(gpu)} reported, not counted`,
  ]
  if (canvas.size) parts.push(`the canvas's renderer ${mb(mean(isCanvas))} not counted`)
  const detail = `${mb(total)} MB footprint, mean of 3 reads 10 s apart: ${parts.join(', ')}; RSS beside it ${mb(meanRss(counted))} MB counted, ${mb(meanRss(() => true))} MB all ${last.length} processes`
  MB(total) < BUDGET_MEMORY_MB ? pass(name, `${detail}; under ${BUDGET_MEMORY_MB} MB`)
    : fail(name, `${detail}; over the ${BUDGET_MEMORY_MB} MB budget - the limit stays (Nic, 23 Oct): the numbers go to Nic`)
  results.at(-1).memory = { totalMB: +MB(total).toFixed(1), budgetMB: BUDGET_MEMORY_MB, gpuMB: +MB(gpu).toFixed(1), countGpu, samples: samples.map((x) => x.map(({ pid, role, sub, fp, rssKB }) => ({ pid, role, sub, fpMB: +MB(fp).toFixed(1), rssMB: +(rssKB / 1024).toFixed(1), canvas: isCanvas({ pid }) }))) }
  return gpu
}

// 8-11. a clean launch, with a fake canvas registered and named the active tab (the launch budget's setup, A2.14 #28)
{
  const { startFakeCanvas } = await import(join(APP_DIR, 'test', 'harness', 'fake-canvas.ts'))
  // the fake canvas registers in this launch's home, and the home names it the active tab, before the app starts
  const home = join(RUN, 'clean', 'home')
  mkdirSync(join(home, 'state'), { recursive: true, mode: 0o700 })
  // the page says what a 0.27.1 shell says at boot - its hello, then a clean busy (A2.9) - so its record is fresh and
  // the SIGTERM's quit goes through the guard without asking: a page that never reported asks first with a native
  // sheet (A2.2, v1.13 r2 #1), which on the release build is real and on the screen, and would hold the quit until
  // the smoke's SIGKILL (and a killed Chromium never writes its Local State)
  // and, once its first frame is reported, it asks whether to burn 2.5 s of CPU: only the second launch says yes, and
  // only once the smoke has read every renderer's CPU time - the memory gate's way to tell the canvas's renderer
  // from the app pages' from outside (spin below)
  const spin = { wanted: false, res: null, asked: null }
  spin.askedP = new Promise((r) => { spin.asked = r })
  const fake = await startFakeCanvas({ home, slotBase: SLOT_BASE, slot: 1, cookie: true, name: 'Smoke canvas', root: join(RUN, 'clean', 'repo'),
    script: "if (window.marverApp) { marverApp.hello({ version: '0.27.1', board: null, page: 'smoke-page-01' }); marverApp.busy({ busy: false, unsaved: false, why: [] }) }\n"
      + "requestAnimationFrame(function () { setTimeout(function () { fetch('/__mv/test/spin-please', { method: 'POST' }).then(function (r) { if (r.status !== 200) return; var end = performance.now() + 2500; while (performance.now() < end) {} fetch('/__mv/test/spun', { method: 'POST', keepalive: true }) }).catch(function () {}) }, 100) })",
    onRequest: (req, res) => {
      if ((req.url ?? '').split('?')[0] !== '/__mv/test/spin-please') return false
      if (!spin.wanted || spin.res) { res.writeHead(204); res.end(); return true }
      spin.res = res
      spin.asked()
      return true
    } })
  await fake.ready
  writeFileSync(join(home, 'state', 'launched'), '')
  writeFileSync(join(home, 'state', 'tabs.json'), JSON.stringify({ v: 1, active: { kind: 'canvas', ws: fake.ws, origin: fake.origin },
    canvases: [{ ws: fake.ws, origin: fake.origin, path: '/', shownAt: Date.now() }], settings: false, closed: [] }))
  const C = launch('clean')
  const ran = await waitFor(() => mainRan(C) && reachedReady(C), 20_000)
  const readyIn = Date.now() - C.t0
  await sleep(3000)
  if (ran && alive(C)) pass('launch-ready', `main ran on the temporary profile and reached ready within ${readyIn} ms of spawn; alive 3 s later`)
  else fail('launch-ready', `mainRan=${mainRan(C)} ready=${reachedReady(C)} alive=${alive(C)} code=${C.code}; stderr: ${C.err.trim().split('\n').slice(-3).join(' | ')}`)
  const raf = fake.requests.find((r) => r.path === '/__mv/test/raf')
  const doc = fake.requests.find((r) => r.path === '/' && r.headers['x-mv-nonce'])
  // the first launch on a fresh profile is reported, not gated (A2.14 #28: S9's one-off keychain stall); launch-warm gates the second
  if (raf) pass('launch-frame-callback', `${raf.t - C.t0} ms from spawn to the canvas page's first animation-frame callback (first launch, reported; launch-warm gates the second)`)
  else fail('launch-frame-callback', doc ? 'the canvas document was requested, no frame callback seen' : 'the canvas named the active tab was never loaded')

  // SIGTERM to main alone: its quit runs through guardAll while the helpers live, and the network service, which holds
  // the cookie store, writes it as it shuts down - a group SIGTERM ends that process at once, so the cookie check
  // below would read a store never written (the group's SIGTERM quit is test/prod/quit.test.ts's)
  const termAt = Date.now()
  const quit = await stop(C, 'SIGTERM', 10_000, { group: false })
  const errsC = mainErrors(C)
  quit && C.code === 0 && !errsC.length ? pass('quit-exit-code', `SIGTERM to main: exit 0 ${C.t0 + C.exitAt - termAt} ms later; nothing uncaught in main`)
    : fail('quit-exit-code', `code=${C.code} signal=${C.signal} graceful=${quit}; main errors: ${errsC.join(' | ') || 'none'}`)

  // the temporary profile is the one Chromium wrote: its Local State (written at a graceful quit), persist:app and
  // the canvas's own partition (persist:local:<ws>, one per canvas workspace, A2.5) - Nic's profiles are checked
  // unchanged at the end (nic-profile-untouched)
  const parts = existsSync(join(C.ud, 'Partitions')) ? readdirSync(join(C.ud, 'Partitions')).map((n) => { try { return decodeURIComponent(n) } catch { return n } }) : []
  const want = ['app', `local:${fake.ws}`]
  const missing = [...(existsSync(join(C.ud, 'Local State')) ? [] : ['Local State']), ...want.filter((p) => !parts.includes(p)).map((p) => `Partitions/${p}`)]
  const crashpad = existsSync(join(C.home, 'perf', 'crashpad', 'settings.dat'))
  const homeMode = existsSync(join(C.home, 'perf', 'crashpad')) ? (statSync(join(C.home, 'perf', 'crashpad')).mode & 0o777).toString(8) : 'missing'
  !missing.length && crashpad && homeMode === '700'
    ? pass('profile-written', `temporary profile: Local State, Partitions/{${parts.sort().join(', ')}}; MARVER_HOME/perf/crashpad (700) initialised`)
    : fail('profile-written', `missing ${missing.join(', ') || 'nothing'} (partitions: ${parts.join(', ') || 'none'}); crashpad ${crashpad} mode ${homeMode}`)

  // 11. cookie encryption, read from a real cookie when the app loaded the canvas (S9: value empty, encrypted_value 'v10...')
  const dbs = []
  const find = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) find(p); else if (e.name === 'Cookies') dbs.push(p) } }
  find(C.ud)
  const rows = dbs.flatMap((db) => sh('sqlite3', [db, "select name||'|'||length(value)||'|'||substr(hex(encrypted_value),1,6) from cookies where name='mvfake'"]).stdout.trim().split('\n').filter(Boolean))
  if (!rows.length && !doc) warn('cookie-encrypted', `pending: no canvas cookie written yet (${dbs.length} cookie store(s), no canvas loaded); EnableCookieEncryption read on above`)
  else if (!rows.length) fail('cookie-encrypted', `the canvas page set mvfake and no cookie store holds it (${dbs.length} store(s)) after a graceful quit`)
  else rows.every((r) => r === 'mvfake|0|763130') ? pass('cookie-encrypted', `${rows.length} cookie(s): value empty, encrypted_value 'v10...'`) : fail('cookie-encrypted', rows.join(' '))

  // 11c. the launch budget (A2.14 #28): the same profile, `state/launched` present and tabs.json naming the running
  // fake canvas (the first launch wrote it back at its quit), launched again - warm - and timed from spawn to the
  // request the page sends from its first animation-frame callback once its view shows
  spin.wanted = true
  const W = launch('clean')
  await waitFor(() => fake.requests.some((r) => r.path === '/__mv/test/raf' && r.t >= W.t0) || !alive(W), 20_000)
  const rafW = fake.requests.find((r) => r.path === '/__mv/test/raf' && r.t >= W.t0)
  const firstMs = raf ? `${raf.t - C.t0} ms` : 'no frame callback'
  if (!rafW) fail('launch-warm', `no frame callback within 20 s of the second launch (alive=${alive(W)} code=${W.code}; first launch: ${firstMs}); stderr: ${W.err.trim().split('\n').slice(-2).join(' | ')}`)
  else {
    const ms = rafW.t - W.t0
    ms < BUDGET_LAUNCH_MS ? pass('launch-warm', `second launch: ${ms} ms from spawn to the canvas page's first animation-frame callback, under ${BUDGET_LAUNCH_MS} ms (first launch: ${firstMs}, not gated)`)
      : fail('launch-warm', `second launch: ${ms} ms from spawn to the canvas page's first animation-frame callback, over the ${BUDGET_LAUNCH_MS} ms budget (first launch: ${firstMs}) - the limit stays (A2.14 #28): the numbers go to Nic`)
  }

  // 11d. the app's own memory with a canvas open: the canvas's renderer found by its spin, then three reads
  let canvasPids = null
  if (rafW && alive(W) && await Promise.race([spin.askedP.then(() => true), sleep(10_000).then(() => false)])) {
    const before = cpuOf(processesOf(W).filter((p) => p.role === 'renderer'))
    spin.res.writeHead(200); spin.res.end()
    const spun = await waitFor(() => fake.requests.some((r) => r.path === '/__mv/test/spun' && r.t >= W.t0), 15_000)
    const after = cpuOf(processesOf(W).filter((p) => p.role === 'renderer'))
    const burned = [...after].filter(([pid, s]) => before.has(pid) && s - before.get(pid) >= 1.5).map(([pid]) => pid)
    if (spun && burned.length === 1) canvasPids = new Set(burned)
    else fail('memory-canvas-open', `inconclusive: the canvas's renderer not told apart (spun=${spun}; ${burned.length} renderer(s) burned 1.5 s or more; CPU s before ${JSON.stringify([...before])} after ${JSON.stringify([...after])})`)
  } else fail('memory-canvas-open', `inconclusive: the canvas page never asked to spin (frame callback ${!!rafW}, alive=${alive(W)})`)
  if (canvasPids) gpuWithCanvas = await memoryGate('memory-canvas-open', W, { canvas: canvasPids, countGpu: false })

  const termW = Date.now()
  const quitW = await stop(W, 'SIGTERM', 10_000, { group: false })
  const errsW = mainErrors(W)
  quitW && W.code === 0 && !errsW.length ? pass('quit-warm-exit-code', `SIGTERM to main: exit 0 ${W.t0 + W.exitAt - termW} ms later; nothing uncaught in main`)
    : fail('quit-warm-exit-code', `code=${W.code} signal=${W.signal} graceful=${quitW}; main errors: ${errsW.join(' | ') || 'none'}`)
  await fake.close()
}

// 11e. the app's own memory with no canvas open (A3.8 #48's first gate, the GPU process counted): three fake canvases
// registered, no tabs.json - Home active - and none ever shown, so no canvas has a view or a renderer
{
  const { startFakeCanvas } = await import(join(APP_DIR, 'test', 'harness', 'fake-canvas.ts'))
  const home = join(RUN, 'idle', 'home')
  mkdirSync(join(home, 'state'), { recursive: true, mode: 0o700 })
  const fakes = await Promise.all([3, 4, 5].map((slot) => startFakeCanvas({ home, slotBase: SLOT_BASE, slot, name: `Smoke idle ${slot}`, root: join(RUN, 'idle', `repo-${slot}`) })))
  await Promise.all(fakes.map((f) => f.ready))
  writeFileSync(join(home, 'state', 'launched'), '')
  const I = launch('idle')
  const up = await waitFor(() => (mainRan(I) && reachedReady(I)) || !alive(I), 20_000)
  // a document request (a view's navigation) or a frame: a canvas was shown
  const shown = () => fakes.filter((f) => f.requests.some((r) => r.headers['sec-fetch-dest'] === 'document' || r.path === '/__mv/test/raf')).length
  if (!up || !alive(I)) fail('memory-no-canvas', `the app never reached ready (alive=${alive(I)} code=${I.code}); stderr: ${I.err.trim().split('\n').slice(-2).join(' | ')}`)
  else await memoryGate('memory-no-canvas', I, { canvas: new Set(), countGpu: true, check: () => shown() ? `${shown()} canvas(es) shown` : null })
  const termI = Date.now()
  const quitI = await stop(I, 'SIGTERM', 10_000, { group: false })
  quitI && I.code === 0 ? pass('quit-idle-exit-code', `SIGTERM to main: exit 0 ${I.t0 + I.exitAt - termI} ms later`) : fail('quit-idle-exit-code', `code=${I.code} signal=${I.signal} graceful=${quitI}`)
  await Promise.all(fakes.map((f) => f.close()))
}

// 11b. the process group's SIGTERM with a canvas loaded (A2.14 #33): main and every helper at once - the strip's,
// Home's and the canvas's renderers, the GPU and the network service go while main's quit runs through guardAll, as a
// terminal's signal or a logout ends them. Exit 0, and nothing uncaught in main: the release build loads no catcher
// (the NodeOptions fuse), so the error policy's own record (MARVER_HOME/perf/app.jsonl, errors.ts) is the witness
{
  const { startFakeCanvas } = await import(join(APP_DIR, 'test', 'harness', 'fake-canvas.ts'))
  const home = join(RUN, 'group', 'home')
  mkdirSync(join(home, 'state'), { recursive: true, mode: 0o700 })
  const fake = await startFakeCanvas({ home, slotBase: SLOT_BASE, slot: 2, name: 'Smoke group canvas', root: join(RUN, 'group', 'repo'),
    script: "if (window.marverApp) { marverApp.hello({ version: '0.27.1', board: null, page: 'smoke-page-02' }); marverApp.busy({ busy: false, unsaved: false, why: [] }) }" })
  await fake.ready
  writeFileSync(join(home, 'state', 'launched'), '')
  writeFileSync(join(home, 'state', 'tabs.json'), JSON.stringify({ v: 1, active: { kind: 'canvas', ws: fake.ws, origin: fake.origin },
    canvases: [{ ws: fake.ws, origin: fake.origin, path: '/', shownAt: Date.now() }], settings: false, closed: [] }))
  const G = launch('group')
  await waitFor(() => (mainRan(G) && reachedReady(G) && fake.requests.some((r) => r.path === '/__mv/test/raf')) || !alive(G), 20_000)
  const loaded = fake.requests.some((r) => r.path === '/__mv/test/raf')
  await sleep(500)
  const termAt = Date.now()
  const quit = await stop(G, 'SIGTERM', 10_000)
  const errs = mainErrors(G)
  if (!loaded) fail('quit-group-exit-code', `the canvas never drew (alive=${alive(G)} code=${G.code}); stderr: ${G.err.trim().split('\n').slice(-2).join(' | ')}`)
  else quit && G.code === 0 && !errs.length ? pass('quit-group-exit-code', `SIGTERM to the process group, the canvas loaded: exit 0 ${G.t0 + G.exitAt - termAt} ms later; nothing uncaught in main`)
    : fail('quit-group-exit-code', `code=${G.code} signal=${G.signal} graceful=${quit}; main errors: ${errs.join(' | ') || 'none'}`)
  await fake.close()
}

// 12. RunAsNode off: started as the app, not as Node (S9 #4)
{
  const marker = join(RUN, 'runasnode-ran')
  const L = launch('runasnode', { env: { ELECTRON_RUN_AS_NODE: '1' }, argv: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1'); console.log(1)`] })
  await waitFor(() => mainRan(L) || !alive(L), 20_000)
  await sleep(500)
  const asApp = mainRan(L)
  await stop(L)
  existsSync(marker) || /^1$/m.test(L.out) ? fail('run-as-node', 'the -e script ran') : asApp ? pass('run-as-node', 'the -e script never ran; it started as the app') : fail('run-as-node', `neither ran: code ${L.code}; ${L.err.trim().slice(-200)}`)
}

// 13. NODE_OPTIONS ignored (S9 #5)
{
  const marker = join(RUN, 'nodeoptions-ran')
  const req = join(RUN, 'evil-require.cjs')
  writeFileSync(req, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`)
  const L = launch('nodeoptions', { env: { NODE_OPTIONS: `--require ${req}` } })
  await waitFor(() => mainRan(L) || !alive(L), 20_000)
  await sleep(500)
  const asApp = mainRan(L)
  await stop(L)
  existsSync(marker) ? fail('node-options', 'the --require ran') : asApp ? pass('node-options', 'the --require never ran; the app started') : fail('node-options', `the app did not start: code ${L.code}`)
}

// 14. --inspect and --inspect-brk closed by the fuse (S9 #6)
for (const flag of ['--inspect', '--inspect-brk']) {
  const port = freePort()
  const P = poll(port, 50)
  const L = launch(`inspect${flag === '--inspect-brk' ? '-brk' : ''}`, { argv: [`${flag}=127.0.0.1:${port}`] })
  const ran = await waitFor(() => mainRan(L) || !alive(L), 20_000)
  const started = mainRan(L)
  await sleep(1500)
  P.stop()
  const graceful = await stop(L)
  const name = flag === '--inspect' ? 'inspect' : 'inspect-brk'
  if (P.st.connects || /Debugger listening/.test(L.err)) fail(name, `the inspector listened on ${port}`)
  else if (ran && started && L.code !== null) pass(name, `${port} never listened; main ran (not held at a breakpoint)`)
  else if (!started) fail(name, `the app did not start: code ${L.code} signal ${L.signal}; ${L.err.trim().slice(-200)}`)
  else fail(name, `main ran but did not quit on SIGTERM: code ${L.code} signal ${L.signal} graceful ${graceful}; ${L.err.trim().slice(-200)}`)
}

// 15. a byte changed in app.asar refuses to start (S9 #7): in the archive's header, and in dist/main.cjs's bytes
async function tampered(name, mutate) {
  const copy = join(RUN, name, `${PRODUCT}.app`)
  mkdirSync(dirname(copy), { recursive: true })
  execFileSync('ditto', [appPath, copy])
  const archive = join(copy, 'Contents', 'Resources', 'app.asar')
  const buf = readFileSync(archive)
  mutate(buf)
  writeFileSync(archive, buf)
  const L = launch(`${name}-run`, { bin: join(copy, 'Contents', 'MacOS', PRODUCT) })
  const exited = await Promise.race([L.exit.then(() => true), sleep(10_000).then(() => false)])
  const ran = mainRan(L)
  await stop(L, 'SIGKILL', 1000)
  const why = /ASAR Integrity Violation[^\n]*|Integrity check failed[^\n]*/.exec(L.err)?.[0]?.slice(0, 90) ?? L.err.trim().slice(-120)
  return { exited, ran, code: L.code, signal: L.signal, why }
}
if (!tamper) {
  skip('asar-tamper-header', TAMPER_SKIP)
  skip('asar-tamper-content', TAMPER_SKIP)
} else {
  const headerSize = (buf) => buf.readUInt32LE(12)   // the pickle's JSON length, after 16 bytes of sizes
  const r1 = await tampered('tamper-header', (buf) => {
    const i = buf.indexOf('"package.json"', 16)
    if (i < 0 || i > 16 + headerSize(buf)) throw new Error('no package.json entry in the header')
    buf[i + 1] = 'q'.charCodeAt(0)   // "qackage.json": still JSON, a different header
  })
  const r2 = await tampered('tamper-content', (buf) => {
    const at = buf.indexOf('marver-app', 16 + headerSize(buf))
    if (at < 0) throw new Error('no "marver-app" in the archive body')
    buf[at] = 'M'.charCodeAt(0)
  })
  for (const [n, r] of [['asar-tamper-header', r1], ['asar-tamper-content', r2]]) {
    r.exited && !r.ran && (r.code !== 0 || r.signal) ? pass(n, `refused, exit ${r.code ?? r.signal}: ${r.why}`) : fail(n, `exited=${r.exited} mainRan=${r.ran} code=${r.code}`)
  }
}

// 16. OnlyLoadAppFromAsar: a Resources/app folder beside app.asar is never loaded (S9 #8)
{
  const copy = join(RUN, 'onlyasar', `${PRODUCT}.app`)
  mkdirSync(dirname(copy), { recursive: true })
  execFileSync('ditto', [appPath, copy])
  const marker = join(RUN, 'onlyasar-ran')
  const folder = join(copy, 'Contents', 'Resources', 'app')
  mkdirSync(folder)
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'impostor', main: 'main.js' }))
  writeFileSync(join(folder, 'main.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(7)\n`)
  const L = launch('onlyasar-run', { bin: join(copy, 'Contents', 'MacOS', PRODUCT) })
  await waitFor(() => mainRan(L) || !alive(L), 20_000)
  const ran = mainRan(L)
  await stop(L)
  existsSync(marker) ? fail('only-asar', 'the Resources/app folder ran') : ran ? pass('only-asar', 'app.asar loaded, the folder ignored') : fail('only-asar', `no start: code ${L.code}`)
}

// ---- X7: the debugging guard (A2.1, A2.14 #30) --------------------------------------------------------
/**
 * A guarded launch: the DevTools endpoint never answers, exit code 3, and the guard ran before the lock.
 * `refusedByMacOS`: the case expects the kernel to refuse the binary instead (SIGKILL before any code runs).
 */
async function guarded(name, { argv, bin, stdio, pipe, refusedByMacOS = false }) {
  const port = argv.port
  const P = port ? poll(port, 10) : null
  await sleep(50)
  const L = launch(name, { argv: argv.list, bin, stdio })
  let pipeReply = null
  if (pipe) {
    const w = L.child.stdio[3], r = L.child.stdio[4]
    w.on('error', () => {}); r.on('error', () => {})
    r.on('data', (c) => { pipeReply = (pipeReply ?? '') + c })
    w.write(JSON.stringify({ id: 1, method: 'Browser.getVersion' }) + '\0')
  }
  const exited = await Promise.race([L.exit.then(() => true), sleep(5000).then(() => false)])
  await sleep(300)
  P?.stop()
  await stop(L, 'SIGKILL', 1000)
  const lock = lexists(join(L.ud, 'SingletonLock'))
  const active = lexists(join(L.ud, 'DevToolsActivePort'))
  const bad = []
  if (!exited) bad.push('still running after 5 s')
  if (refusedByMacOS ? L.signal !== 'SIGKILL' : L.code !== 3) bad.push(`exit ${L.code ?? L.signal} (want ${refusedByMacOS ? 'SIGKILL from the kernel' : 3})`)
  if (P && (P.st.connects || P.st.answers)) bad.push(`DevTools answered on ${port} (${P.st.connects} connects)`)
  if (pipe && pipeReply) bad.push(`a reply on fd 4: ${pipeReply.slice(0, 60)}`)
  if (lock) bad.push('the lock was taken (the guard ran late)')
  if (active) bad.push('DevToolsActivePort written')
  const how = refusedByMacOS ? `refused by macOS (SIGKILL: its signature no longer matches the bundle) in ${L.exitAt} ms` : `exit 3 in ${L.exitAt} ms`
  bad.length ? fail(name, bad.join('; ')) : pass(name, `${how}; ${pipe ? 'nothing on fd 4' : `nothing answered on ${port}`}; no lock, no DevToolsActivePort`)
}
{
  let p = freePort()
  await guarded('rdp-port', { argv: { port: p, list: [`--remote-debugging-port=${p}`] } })
  p = freePort()
  await guarded('rdp-port-space', { argv: { port: p, list: ['--remote-debugging-port', String(p)] } })
  p = freePort()
  await guarded('rdp-port-dash1', { argv: { port: p, list: [`-remote-debugging-port=${p}`] } })
  await guarded('rdp-pipe', { argv: { list: ['--remote-debugging-pipe'] }, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], pipe: true })
  // a copy of the bundle whose binary is named `electron`: app.isPackaged reads false there, the build constant does not.
  // A Developer ID copy is refused by macOS outright (its signature no longer matches the bundle's main executable);
  // whoever made the copy can sign it again ad-hoc, and then it runs - and must meet the guard.
  const copy = join(RUN, 'electron-name', `${PRODUCT}.app`)
  mkdirSync(dirname(copy), { recursive: true })
  execFileSync('ditto', [appPath, copy])
  cpSync(join(copy, 'Contents', 'MacOS', PRODUCT), join(copy, 'Contents', 'MacOS', 'electron'))
  const renamed = join(copy, 'Contents', 'MacOS', 'electron')
  if (!adhoc) {
    if (tamper) {
      p = freePort()
      await guarded('rdp-electron-name-signed', { argv: { port: p, list: [`--remote-debugging-port=${p}`] }, bin: renamed, refusedByMacOS: true })
    } else skip('rdp-electron-name-signed', TAMPER_SKIP)
    // signed again ad-hoc, all of it: `--deep` leaves the Mach-O files outside what codesign counts as nested code
    // (the framework's Libraries/ dylibs, Squirrel's ShipIt) with the Developer ID, and a bundle of two Team IDs is
    // never launched (team-id.mjs). So each part first, then the bundle resealed - one Team ID, none.
    for (const f of machOParts(copy)) execFileSync('codesign', ['--force', '--sign', '-', f], { stdio: 'ignore' })
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', copy], { stdio: 'ignore' })
  }
  p = freePort()
  await guarded('rdp-electron-name', { argv: { port: p, list: [`--remote-debugging-port=${p}`] }, bin: renamed })
}

{ // through LaunchServices: open -n -W -a <app> --args --remote-debugging-port=<p>
  const port = freePort()
  const dir = join(RUN, 'rdp-open')
  const ud = join(dir, 'ud'), home = join(dir, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const tag = `--mv-smoke-run=${basename(RUN)}-open`
  const P = poll(port, 10)
  await sleep(50)
  const t = Date.now()
  const open = spawn('open', ['-n', '-W', '-a', appPath, '--env', `MARVER_APP_USER_DATA=${ud}`, '--env', `MARVER_HOME=${home}`,
    '--env', `MARVER_SLOT_BASE=${SLOT_BASE}`, '--args', `--remote-debugging-port=${port}`, tag, MOCK_KEYCHAIN], { stdio: 'ignore' })
  const done = await Promise.race([new Promise((r) => open.on('exit', () => r(true))), sleep(10_000).then(() => false)])
  await sleep(300)
  P.stop()
  let leftover = ''
  if (!done) {
    // the app outlived the guard: end exactly the process this case started (its argv carries the tag)
    leftover = sh('pgrep', ['-f', tag]).stdout.trim()
    for (const pid of leftover.split('\n').filter(Boolean)) { try { process.kill(Number(pid), 'SIGKILL') } catch { /* gone */ } }
    try { open.kill('SIGKILL') } catch { /* gone */ }
  }
  const bad = []
  if (!done) bad.push(`still running after 10 s (pid ${leftover})`)
  if (P.st.connects || P.st.answers) bad.push(`DevTools answered on ${port}`)
  if (lexists(join(ud, 'SingletonLock'))) bad.push('the lock was taken')
  if (lexists(join(ud, 'DevToolsActivePort'))) bad.push('DevToolsActivePort written')
  bad.length ? fail('rdp-open-args', bad.join('; ')) : pass('rdp-open-args', `open -a ... --args: gone in ${Date.now() - t} ms, nothing answered on ${port}, no lock, no DevToolsActivePort`)
}

await finish()

// ---- after everything --------------------------------------------------------------------------------
/** The closing checks, the report and the exit (also when the smoke refused to launch anything). */
async function finish(stopped) {
  if (stopped) console.log(`smoke: ${stopped}`)
  await sleep(500)
  {
    const left = started.flatMap((pid) => sh('pgrep', ['-g', String(pid)]).stdout.trim().split('\n').filter(Boolean))
    const byPath = sh('pgrep', ['-f', RUN]).stdout.trim().split('\n').filter(Boolean)
    const all = [...new Set([...left, ...byPath])]
    all.length ? fail('no-leftovers', sh('ps', ['-o', 'pid=,command=', '-p', all.join(',')]).stdout.trim().slice(0, 300)) : pass('no-leftovers', `${started.length} launches, every process gone`)
  }
  {
    const nicAfter = NIC.map(snapshot)
    const changed = NIC.filter((_, i) => nicBefore[i] !== nicAfter[i])
    changed.length ? fail('nic-profile-untouched', `changed: ${changed.join(', ')}`) : pass('nic-profile-untouched', NIC.map((d, i) => `${basename(d)}: ${nicAfter[i] === 'absent' ? 'absent' : 'unchanged'}`).join(', '))
    const kc = keychainHas()
    kc === keychainBefore ? pass('keychain-untouched', `"${KEYCHAIN_ITEM}" ${kc ? 'present before and after' : 'absent before and after'}`) : fail('keychain-untouched', `"${KEYCHAIN_ITEM}" ${kc ? 'appeared' : 'went away'} during the smoke`)
  }
  { // no "quit unexpectedly" dialog: no crash report of Marver's written during the run (expected with --tamper only)
    const reports = crashReports()
    if (reports === null) warn('no-crash-dialogs', `${REPORTS} unreadable`)
    else if (tamper) pass('no-crash-dialogs', `--tamper: ${reports.length} crash report(s) from the cases that crash on purpose${reports.length ? ` (${reports.slice(0, 4).join(', ')})` : ''}`)
    else reports.length ? fail('no-crash-dialogs', `${reports.length} crash report(s) during the run, each a macOS dialog: ${reports.slice(0, 4).join(', ')}`) : pass('no-crash-dialogs', 'no crash report of Marver\'s during the run: no macOS dialog')
  }

  block?.release()
  const count = (v) => results.filter((r) => r.verdict === v).length
  const failures = count('FAIL')
  const report = { app: appPath, adhoc, tamper, version: VERSION, at: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, failures, results }
  const reportDir = reportArg ? resolve(reportArg) : appPath.includes(`${join(APP_DIR, 'out')}/`) ? join(APP_DIR, 'out') : RUN
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(join(reportDir, `smoke-${Date.now()}.json`), JSON.stringify(report, null, 2) + '\n')
  if (!keep) rmSync(RUN, { recursive: true, force: true, maxRetries: 3 })
  console.log(`FAILURES=${failures} (${count('PASS')} pass, ${count('WARN')} warn, ${count('SKIP')} skip) in ${report.seconds.toFixed(1)} s${keep ? `; run folder ${RUN}` : ''}`)
  process.exit(failures)
}
