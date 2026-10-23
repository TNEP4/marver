#!/usr/bin/env node
/**
 * The packaged smoke (spec 28 A2.8, A2.10, A2.14 #29, #30, v1.12 r1 #9): no Playwright, on the signed, fused
 * build - spike S9's twelve checks and X7's cases, against the real app.
 *
 *   node test/smoke/smoke.mjs [<Marver.app>] [--adhoc] [--keep]
 *
 * The default app is out/Marver-darwin-arm64/Marver.app. `--adhoc` expects an ad-hoc signature (no Developer ID,
 * no timestamp). `--keep` leaves the run's temporary folder. Every line is PASS, FAIL or WARN; the exit code is
 * the number of FAILs; a JSON report goes beside the app's out/ folder (smoke-<time>.json).
 *
 * Every launch runs on its own temporary profile - MARVER_APP_USER_DATA, MARVER_HOME and MARVER_SLOT_BASE - so a
 * Marver Nic has open holds another lock and nothing of his is read or written: the smoke checks that
 * ~/Library/Application Support/Marver (and Marver Dev) - their listing and modification times - did not change.
 * Only the guard's exit code 3 passes a debugging-switch case, so a launch that met any lock can never pass as a
 * refusal. The smoke ends only processes it started (each launch is its own process group).
 *
 * WARN marks a check the app 0.1 skeleton cannot yet satisfy (no canvas loads before the trust and window
 * streams land): the cookie encryption read from a real cookie, and the launch budget's frame callback. They turn
 * into PASS or FAIL by themselves once a canvas tab loads.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { BUNDLE_ID, IDENTITY, MIC, MIN_MACOS, PRODUCT, TEST_SENTINELS } from '../../scripts/build.mjs'

const APP_DIR = resolve(import.meta.dirname, '..', '..')
const require = createRequire(join(APP_DIR, 'package.json'))
const args = process.argv.slice(2)
const appPath = resolve(args.find((a) => !a.startsWith('--')) ?? join(APP_DIR, 'out', `${PRODUCT}-darwin-arm64`, `${PRODUCT}.app`))
const adhoc = args.includes('--adhoc')
const keep = args.includes('--keep')
const BIN = join(appPath, 'Contents', 'MacOS', PRODUCT)
const VERSION = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')).version
const TEAM = /\(([A-Z0-9]{10})\)$/.exec(IDENTITY)?.[1]
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

// ---- launches ---------------------------------------------------------------------------------------
const { takeBlock } = await import(resolve(APP_DIR, '..', 'test', 'slot-block.ts'))
const block = await takeBlock()
const SLOT_BASE = block.base
const started = []   // every process group this smoke started

function freePort() {
  // the X7 probes poll a port nothing should ever open: one in the smoke's own block, past the twenty slots
  freePort.n = (freePort.n ?? 100) + 1
  return SLOT_BASE + freePort.n
}

/** One launch on its own profile. Returns { pid, dir, ud, home, out, err, exit (promise), t0 }. */
function launch(name, { argv = [], env = {}, bin = BIN, stdio } = {}) {
  const dir = join(RUN, name)
  const ud = join(dir, 'ud')
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const t = Date.now()
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
const lexists = (p) => { try { lstatSync(p); return true } catch { return false } }
/** main.ts ran on this launch's profile: the lock taken there, and the crash reporter's database made in its home */
const mainRan = (L) => lexists(join(L.ud, 'SingletonLock')) && existsSync(join(L.home, 'perf', 'crashpad', 'settings.dat'))
/** ready: persist:app made (sessions.ts at ready) */
const reachedReady = (L) => existsSync(join(L.ud, 'Partitions'))
async function waitFor(fn, ms, every = 50) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(every) } return fn() }
async function stop(L, signal = 'SIGTERM', ms = 10_000) {
  if (alive(L)) { try { process.kill(-L.pid, signal) } catch { /* gone */ } }
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

// 8-11. a clean launch, with a fake canvas registered and named the active tab (the launch budget's setup, A2.14 #28)
{
  const { startFakeCanvas } = await import(join(APP_DIR, 'test', 'harness', 'fake-canvas.ts'))
  // the fake canvas registers in this launch's home, and the home names it the active tab, before the app starts
  const home = join(RUN, 'clean', 'home')
  mkdirSync(join(home, 'state'), { recursive: true, mode: 0o700 })
  const fake = await startFakeCanvas({ home, slotBase: SLOT_BASE, slot: 1, cookie: true, name: 'Smoke canvas', root: join(RUN, 'clean', 'repo') })
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
  if (raf) pass('launch-frame-callback', `${raf.t - C.t0} ms from spawn to the canvas page's first animation-frame callback (first launch; the budget gates the second)`)
  else warn('launch-frame-callback', doc ? 'the canvas document was requested, no frame callback seen' : 'pending: the app loads no canvas yet (trust and window streams)')

  const termAt = Date.now()
  const quit = await stop(C, 'SIGTERM')
  quit && C.code === 0 ? pass('quit-exit-code', `SIGTERM: exit 0 ${C.t0 + C.exitAt - termAt} ms later`) : fail('quit-exit-code', `code=${C.code} signal=${C.signal} graceful=${quit}`)

  const wrote = ['Local State', 'Partitions'].filter((f) => existsSync(join(C.ud, f)))
  const crashpad = existsSync(join(C.home, 'perf', 'crashpad', 'settings.dat'))
  const homeMode = existsSync(join(C.home, 'perf', 'crashpad')) ? (statSync(join(C.home, 'perf', 'crashpad')).mode & 0o777).toString(8) : 'missing'
  wrote.length === 2 && crashpad && homeMode === '700'
    ? pass('profile-written', `temporary profile: ${wrote.join(', ')}; MARVER_HOME/perf/crashpad (700) initialised`)
    : fail('profile-written', `profile has ${wrote.join(', ') || 'nothing'}; crashpad ${crashpad} mode ${homeMode}`)

  // 11. cookie encryption, read from a real cookie when the app loaded the canvas (S9: value empty, encrypted_value 'v10...')
  const dbs = []
  const find = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) find(p); else if (e.name === 'Cookies') dbs.push(p) } }
  find(C.ud)
  const rows = dbs.flatMap((db) => sh('sqlite3', [db, "select name||'|'||length(value)||'|'||substr(hex(encrypted_value),1,6) from cookies where name='mvfake'"]).stdout.trim().split('\n').filter(Boolean))
  if (!rows.length) warn('cookie-encrypted', `pending: no canvas cookie written yet (${dbs.length} cookie store(s), no canvas loaded); EnableCookieEncryption read on above`)
  else rows.every((r) => r === 'mvfake|0|763130') ? pass('cookie-encrypted', `${rows.length} cookie(s): value empty, encrypted_value 'v10...'`) : fail('cookie-encrypted', rows.join(' '))
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
  await sleep(1500)
  P.stop()
  await stop(L)
  const name = flag === '--inspect' ? 'inspect' : 'inspect-brk'
  if (P.st.connects || /Debugger listening/.test(L.err)) fail(name, `the inspector listened on ${port}`)
  else ran && L.code !== null ? pass(name, `${port} never listened; main ran (not held at a breakpoint)`) : fail(name, `the app did not start: ${L.err.trim().slice(-200)}`)
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
{
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
    p = freePort()
    await guarded('rdp-electron-name-signed', { argv: { port: p, list: [`--remote-debugging-port=${p}`] }, bin: renamed, refusedByMacOS: true })
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

// ---- after everything --------------------------------------------------------------------------------
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

block.release()
const failures = results.filter((r) => r.verdict === 'FAIL').length
const report = { app: appPath, adhoc, version: VERSION, at: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, failures, results }
const reportDir = appPath.includes(`${join(APP_DIR, 'out')}/`) ? join(APP_DIR, 'out') : RUN
writeFileSync(join(reportDir, `smoke-${Date.now()}.json`), JSON.stringify(report, null, 2) + '\n')
if (!keep) rmSync(RUN, { recursive: true, force: true, maxRetries: 3 })
console.log(`FAILURES=${failures} (${results.filter((r) => r.verdict === 'PASS').length} pass, ${results.filter((r) => r.verdict === 'WARN').length} warn) in ${report.seconds.toFixed(1)} s${keep ? `; run folder ${RUN}` : ''}`)
process.exit(failures)
