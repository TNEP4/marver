/**
 * A world for scripts/release.mjs (spec 28 A5.1 #33): a real checkout (a temporary git repository with a bare origin),
 * a temporary shared `release/` folder, the real lock, git, ditto, hdiutil, cp -c and plutil on a small fake bundle -
 * and fakes for everything that reaches Apple or GitHub: the clock, notarytool, codesign, stapler, spctl, lipo, GitHub
 * (drafts, publishing, the repository's immutability, prereleases, tags, asset digests, anonymous and authenticated
 * reads, `latest` and its lag) and npm, and the build (a bundle made by hand, never scripts/build.mjs).
 *
 * Crashes are injected as `Crash`, thrown by a fake right after its side effect and before the release can record it;
 * the run lets it through (only its own Stop is caught), its lock going with it as a process's would.
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { feedKind } from '../../scripts/build.mjs'
import { REPOS, Stop, Unreadable, assetNames, realPorts, run } from '../../scripts/release.mjs'

export class Crash extends Error {
  constructor(where: string) { super(`crash: ${where}`); this.name = 'Crash' }
}

/** The DR committed in app/build/designated-requirement.txt (e60ccf86) */
export const DR = 'identifier "design.marver.app" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = PXV6WER853'
const MAIN_HEAD = 'a'.repeat(40)
const MAIN_DATE = '2026-11-02T09:06:33Z'
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const iso = (t: number) => new Date(t).toISOString()
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
/** a fake answers in a later turn of the event loop, as a process or a request would: a run made only of fakes
 *  resolving at once would hold the worker's loop for its whole length (vitest's RPC times out) */
const turn = () => new Promise<void>((r) => setImmediate(r))

export class FakeClock {
  t = Date.parse('2026-11-10T09:00:00Z')
  now = () => this.t
  sleep = async (ms: number) => { this.t += ms; await turn() }
  advance(ms: number) { this.t += ms }
}

// ---- GitHub ------------------------------------------------------------------------------------------------------

interface Asset { id: number; name: string; size: number; digest: string; bytes: Buffer; browser_download_url: string }
interface Release {
  id: number; tag_name: string; target_commitish: string; name: string; body: string; draft: boolean; prerelease: boolean
  immutable: boolean; created_at: string; updated_at: string; published_at: string | null; html_url: string; assets: Asset[]
}
interface Repo { immutable: boolean; canWrite: boolean; releases: Release[]; tags: Map<string, string>; latestLog: { t: number; latest: string | null }[] }
type Hook = (name: string, args: unknown[]) => void | Promise<void>

export class FakeGitHub {
  repos = new Map<string, Repo>()
  nextId = 5000
  unreadable = false
  calls: string[] = []
  /** a crash right after the named call's effect (`publish`, `uploadAsset`, `createDraft`, `markPrerelease`, `deleteAsset`) */
  crashAfter = new Set<string>()
  /** the next publish request is sent and held back: the caller dies, the request lands when `landHeld()` says */
  holdNextPublish = false
  held: (() => void)[] = []
  /** after-call hooks, by method name: another actor acting between the release's read and its next step */
  after: Record<string, Hook> = {}
  /** anonymous `latest` lags the API by this much (S3: 59-74 s) */
  latestLagMs = 70_000
  /** the next this-many anonymous downloads throw (a timeout, a reset), as the real port's Unreadable */
  anonGetThrows = 0
  constructor(public clock: FakeClock) {
    for (const r of Object.values(REPOS)) this.repos.set(r, { immutable: true, canWrite: true, releases: [], tags: new Map(), latestLog: [{ t: 0, latest: null }] })
  }

  repo(name: string) { return this.repos.get(name)! }
  private rel(repo: string, id: number) { return this.repo(repo).releases.find((r) => r.id === id) ?? null }
  private out(r: Release | null) { return r ? clone({ ...r, assets: r.assets.map(({ bytes, ...a }) => a) }) : null }
  private async done(name: string, args: unknown[]) { await turn(); await this.after[name]?.(name, args) }
  private read(name: string) { this.calls.push(name); if (this.unreadable) throw new Unreadable(`fake GitHub unreadable (${name})`) }

  /** GitHub's `legacy` choice (S3; r6 #4): the published non-prereleases, latest by created_at, a tie to the higher version */
  apiLatest(repo: string) {
    const cands = this.repo(repo).releases.filter((r) => !r.draft && !r.prerelease)
    const v = (r: Release) => r.tag_name.slice(1).split('.').map(Number)
    cands.sort((a, b) => a.created_at.localeCompare(b.created_at) || v(a)[0]! - v(b)[0]! || v(a)[1]! - v(b)[1]! || v(a)[2]! - v(b)[2]!)
    return cands.at(-1)?.tag_name.slice(1) ?? null
  }
  private moved(repo: string) {
    const r = this.repo(repo)
    const latest = this.apiLatest(repo)
    if (r.latestLog.at(-1)!.latest !== latest) r.latestLog.push({ t: this.clock.now(), latest })
  }
  /** what an anonymous reader of `latest/download/` sees now: the API's latest of `latestLagMs` ago */
  anonLatest(repo: string) {
    const t = this.clock.now() - this.latestLagMs
    return [...this.repo(repo).latestLog].reverse().find((e) => e.t <= t)?.latest ?? null
  }

  /** A release published before the test, `latest` long settled (S3's and S2's releases on the test repo, say) */
  seed(repo: string, version: string, { prerelease = false, draft = false } = {}) {
    const r = this.repo(repo)
    const id = this.nextId++
    const names = assetNames(version)
    const assets = Object.values(names).map((name) => this.asset(repo, version, name, Buffer.concat([Buffer.from(`seed ${version} ${name}\n`), randomBytes(512)])))
    r.releases.push({ id, tag_name: `v${version}`, target_commitish: MAIN_HEAD, name: `Marver ${version}`, body: 'seed', draft, prerelease,
      immutable: !draft, created_at: draft ? iso(this.clock.now()) : MAIN_DATE, updated_at: iso(this.clock.now()), published_at: draft ? null : iso(this.clock.now()),
      html_url: `https://github.com/${repo}/releases/${draft ? `untagged-${id}` : `tag/v${version}`}`, assets })
    if (!draft) r.tags.set(`v${version}`, MAIN_HEAD)
    this.moved(repo)
    r.latestLog = r.latestLog.map((e) => ({ ...e, t: Math.min(e.t, this.clock.now() - 3600_000) }))
    return id
  }
  /** Another release published now, by the one request (another release run, say): `latest` moves after its lag */
  publishNew(repo: string, version: string) {
    const id = this.nextId++
    const assets = Object.values(assetNames(version)).map((name) => this.asset(repo, version, name, Buffer.from(`other ${version} ${name}\n`)))
    this.repo(repo).releases.push({ id, tag_name: `v${version}`, target_commitish: MAIN_HEAD, name: `Marver ${version}`, body: 'other', draft: true, prerelease: false,
      immutable: false, created_at: iso(this.clock.now()), updated_at: iso(this.clock.now()), published_at: null, html_url: `https://github.com/${repo}/releases/untagged-${id}`, assets })
    this.applyPublish(repo, id)
    return id
  }
  dump() {
    return JSON.stringify({ nextId: this.nextId, repos: [...this.repos].map(([k, r]) => [k, { ...r, tags: [...r.tags],
      releases: r.releases.map((x) => ({ ...x, assets: x.assets.map((a) => ({ ...a, bytes: a.bytes.toString('base64') })) })) }]) })
  }
  load(text: string) {
    const j = JSON.parse(text)
    this.nextId = j.nextId
    this.repos = new Map(j.repos.map(([k, r]: [string, any]) => [k, { ...r, tags: new Map(r.tags),
      releases: r.releases.map((x: any) => ({ ...x, assets: x.assets.map((a: any) => ({ ...a, bytes: Buffer.from(a.bytes, 'base64') })) })) }]))
    this.unreadable = false
    this.calls = []
    this.crashAfter.clear()
    this.holdNextPublish = false
    this.held = []
    this.after = {}
    this.latestLagMs = 70_000
    this.anonGetThrows = 0
  }
  private asset(repo: string, version: string, name: string, bytes: Buffer): Asset {
    return { id: this.nextId++, name, size: bytes.length, digest: `sha256:${sha(bytes)}`, bytes, browser_download_url: `https://github.com/${repo}/releases/download/v${version}/${name}` }
  }

  // the port
  releases = async (repo: string) => { this.read('releases'); const o = this.repo(repo).releases.map((r) => this.out(r)!); await this.done('releases', [repo]); return o }
  release = async (repo: string, id: number) => { this.read('release'); const o = this.out(this.rel(repo, id)); await this.done('release', [repo, id]); return o }
  tags = async (repo: string) => { this.read('tags'); const o = [...this.repo(repo).tags].map(([name, s]) => ({ name, sha: s })); await this.done('tags', [repo]); return o }
  tagCommit = async (repo: string, tag: string) => { this.read('tagCommit'); const o = this.repo(repo).tags.get(tag) ?? null; await this.done('tagCommit', [repo, tag]); return o }
  branchHead = async (_repo: string, _branch: string) => { this.read('branchHead'); return MAIN_HEAD }
  immutable = async (repo: string) => { this.read('immutable'); const o = this.repo(repo).immutable; await this.done('immutable', [repo]); return o }
  canWrite = async (repo: string) => { this.read('canWrite'); return this.repo(repo).canWrite }
  createDraft = async (repo: string, body: { tag_name: string; target_commitish: string; name: string; body: string }) => {
    this.calls.push('createDraft')
    const id = this.nextId++
    const r: Release = { id, tag_name: body.tag_name, target_commitish: body.target_commitish, name: body.name, body: body.body, draft: true, prerelease: false,
      immutable: false, created_at: iso(this.clock.now()), updated_at: iso(this.clock.now()), published_at: null, html_url: `https://github.com/${repo}/releases/untagged-${id}`, assets: [] }
    this.repo(repo).releases.push(r)
    if (this.crashAfter.delete('createDraft')) throw new Crash('after the draft is made')
    return this.out(r)!
  }
  uploadAsset = async (repo: string, id: number, name: string, file: string) => {
    this.calls.push(`uploadAsset ${name}`)
    const r = this.rel(repo, id)
    if (!r) throw new Stop(`uploading ${name}: HTTP 404`)
    if (!r.draft && r.immutable) throw new Stop(`uploading ${name}: HTTP 422 Cannot upload assets to an immutable release.`)
    if (r.assets.some((a) => a.name === name)) throw new Stop(`uploading ${name}: HTTP 422 already_exists`)
    const a = this.asset(repo, r.tag_name.slice(1), name, readFileSync(file))
    a.browser_download_url = r.draft ? `https://github.com/${repo}/releases/download/untagged-${id}/${name}` : a.browser_download_url
    r.assets.push(a)
    r.updated_at = iso(this.clock.now())
    if (this.crashAfter.delete('uploadAsset')) throw new Crash(`after uploading ${name}`)
    const { bytes, ...o } = a
    return o
  }
  deleteAsset = async (repo: string, assetId: number) => {
    this.calls.push(`deleteAsset ${assetId}`)
    for (const r of this.repo(repo).releases) {
      const i = r.assets.findIndex((a) => a.id === assetId)
      if (i < 0) continue
      if (!r.draft && r.immutable) throw new Stop('deleting: HTTP 422')
      r.assets.splice(i, 1)
      r.updated_at = iso(this.clock.now())
    }
    if (this.crashAfter.delete('deleteAsset')) throw new Crash('after deleting an asset')
  }
  downloadAsset = async (repo: string, assetId: number, dest: string) => {
    this.read('downloadAsset')
    const a = this.repo(repo).releases.flatMap((r) => r.assets).find((x) => x.id === assetId)
    if (!a) throw new Stop(`downloading asset ${assetId}: HTTP 404`)
    writeFileSync(dest, a.bytes)
  }
  /** the PATCH with draft=false and make_latest=legacy, as GitHub applies it (S3) */
  applyPublish(repo: string, id: number) {
    const r = this.rel(repo, id)
    if (!r) return null
    if (r.draft) {
      r.draft = false
      r.published_at = iso(this.clock.now())
      r.immutable = this.repo(repo).immutable
      if (!this.repo(repo).tags.has(r.tag_name)) this.repo(repo).tags.set(r.tag_name, r.target_commitish)
      // a release's created_at is its tag's target commit's date: every tag here is on the releases repo's main
      r.created_at = MAIN_DATE
      for (const a of r.assets) a.browser_download_url = `https://github.com/${repo}/releases/download/${r.tag_name}/${a.name}`
    }
    r.updated_at = iso(this.clock.now())
    this.moved(repo)
    return this.out(r)
  }
  publish = async (repo: string, id: number) => {
    this.calls.push(`publish ${id}`)
    if (this.holdNextPublish) {
      this.holdNextPublish = false
      this.held.push(() => { this.applyPublish(repo, id) })
      throw new Crash('the publish request is sent; the run dies before any answer')
    }
    const o = this.applyPublish(repo, id)
    if (!o) throw new Stop('the publish: HTTP 404')
    if (this.crashAfter.delete('publish')) throw new Crash('after the publish')
    return o
  }
  landHeld() { for (const f of this.held.splice(0)) f() }
  markPrerelease = async (repo: string, id: number) => {
    this.calls.push(`markPrerelease ${id}`)
    const r = this.rel(repo, id)!
    r.prerelease = true
    r.updated_at = iso(this.clock.now())
    this.moved(repo)
    if (this.crashAfter.delete('markPrerelease')) throw new Crash('after the prerelease flag')
    return this.out(r)
  }
  /** anonymous: a published release's versioned URLs serve its bytes; a draft's nothing */
  anonGet = async (url: string) => {
    this.calls.push(`anonGet ${url}`)
    if (this.anonGetThrows > 0) { this.anonGetThrows--; throw new Unreadable(`${url}: The operation was aborted due to timeout`) }
    const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(url)
    const r = m ? this.repo(m[1]!)?.releases.find((x) => !x.draft && x.tag_name === m[2]) : null
    const a = r?.assets.find((x) => x.name === m![3])
    return a ? { status: 200, bytes: Buffer.from(a.bytes) } : { status: 404, bytes: null }
  }
  anonLocation = async (url: string) => {
    this.calls.push(`anonLocation ${url}`)
    const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/latest\/download\/(.+)$/.exec(url)
    const v = m ? this.anonLatest(m[1]!) : null
    return v ? { status: 302, location: `https://github.com/${m![1]}/releases/download/v${v}/${m![2]}` } : { status: 404, location: null }
  }

  // a test's view
  find(repo: string, version: string) { return this.repo(repo).releases.filter((r) => r.tag_name === `v${version}`) }
  publishCalls() { return this.calls.filter((c) => c.startsWith('publish ')) }
}

// ---- notarytool --------------------------------------------------------------------------------------------------

export class FakeNotary {
  subs: { id: string; name: string; createdDate: string; status: string }[] = []
  /** the statuses of the next submissions, by kind; Accepted by default */
  plan: Record<'app' | 'dmg', string[]> = { app: [], dmg: [] }
  calls: string[] = []
  crashAfterSubmit = 0
  waitTimeouts = 0
  constructor(public clock: FakeClock) {}
  submit = async (file: string) => {
    const name = basename(file)
    const kind = /-app-[0-9a-f]{12}\.zip$/.test(name) ? 'app' : 'dmg'
    const id = randomUUID()
    this.subs.push({ id, name, createdDate: iso(this.clock.now()), status: this.plan[kind].shift() ?? 'Accepted' })
    this.calls.push(`submit ${name}`)
    if (this.crashAfterSubmit > 0) { this.crashAfterSubmit--; throw new Crash(`after submitting ${name}`) }
    return { id }
  }
  history = async () => { this.calls.push('history'); await turn(); return clone(this.subs) }
  wait = async (id: string) => {
    this.calls.push(`wait ${id}`)
    if (this.waitTimeouts > 0) { this.waitTimeouts--; return { status: 'In Progress', message: 'timed out' } }
    return { status: this.subs.find((s) => s.id === id)?.status ?? null, message: '' }
  }
  log = async (id: string, dest: string) => {
    const s = this.subs.find((x) => x.id === id)
    writeFileSync(dest, JSON.stringify({ jobId: id, status: s?.status, issues: s?.status === 'Accepted' ? null : [{ severity: 'error', message: 'The signature of the binary is invalid.' }] }))
  }
  submits() { return this.calls.filter((c) => c.startsWith('submit ')) }
}

// ---- codesign, stapler, spctl, lipo, the build ----------------------------------------------------------------

const SIGNED = 'FAKE-DEVELOPER-ID-SIGNATURE'
const TICKET = 'FAKE-NOTARY-TICKET'
const isApp = (p: string) => p.endsWith('.app')
const appSigned = (p: string) => existsSync(join(p, 'Contents', '_CodeSignature', 'CodeResources'))
const appTicket = (p: string) => existsSync(join(p, 'Contents', 'CodeResources'))
const fileHas = (p: string, s: string) => existsSync(p) && readFileSync(p).includes(s)
/** As codesign and stapler do to a DMG: their blob goes before UDIF's 512-byte `koly` trailer, so it still mounts */
function intoDmg(p: string, marker: string) {
  const b = readFileSync(p)
  const n = b.length
  if (b.subarray(n - 512, n - 508).toString() !== 'koly') throw new Error(`${p} is not a UDIF image`)
  writeFileSync(p, Buffer.concat([b.subarray(0, n - 512), Buffer.from(`\n${marker}\n`), b.subarray(n - 512)]))
}

export class FakeTools {
  calls: string[] = []
  /** a crash right after the named effect: `staple-app`, `staple-dmg`, `sign-dmg` */
  crashAfter = new Set<string>()
  dr = DR
  codesign = {
    verify: (p: string) => ({ ok: appSigned(p), out: '' }),
    verifyDR: (p: string, dr: string) => ({ ok: appSigned(p) && dr === this.dr, out: dr === this.dr ? '' : 'code failed to satisfy specified code requirement(s)' }),
    dr: (p: string) => (appSigned(p) ? this.dr : null),
    signDmg: (p: string) => {
      this.calls.push(`sign ${basename(p)}`)
      intoDmg(p, SIGNED)
      if (this.crashAfter.delete('sign-dmg')) throw new Crash('after the DMG\'s signature')
    },
    verifyFile: (p: string) => ({ ok: fileHas(p, SIGNED), out: '' }),
  }
  stapler = {
    staple: (p: string) => {
      this.calls.push(`staple ${basename(p)}`)
      if (isApp(p)) writeFileSync(join(p, 'Contents', 'CodeResources'), `${TICKET}\n`)
      else intoDmg(p, TICKET)
      const k = isApp(p) ? 'staple-app' : 'staple-dmg'
      if (this.crashAfter.delete(k)) throw new Crash(`after ${k}`)
    },
    validate: (p: string) => ({ ok: isApp(p) ? appTicket(p) : fileHas(p, TICKET), out: '' }),
  }
  spctl = {
    app: (p: string) => ({ ok: appSigned(p) && appTicket(p), out: 'accepted\nsource=Notarized Developer ID' }),
    dmg: (p: string) => ({ ok: fileHas(p, SIGNED) && fileHas(p, TICKET), out: 'accepted\nsource=Notarized Developer ID' }),
  }
  lipo = { archs: (_bin: string) => 'arm64' }
}

/** A small bundle as the signed build leaves it: Info.plist, the binary, a framework's symlinks, an asar, a signature */
export function makeBundle(app: string, version: string, { downgrades = true } = {}) {
  const c = join(app, 'Contents')
  const fw = join(c, 'Frameworks', 'Electron Framework.framework')
  for (const d of [join(c, 'MacOS'), join(c, 'Resources'), join(c, '_CodeSignature'), join(fw, 'Versions', 'A')]) mkdirSync(d, { recursive: true })
  const keys: [string, string][] = [['CFBundleIdentifier', '<string>design.marver.app</string>'], ['CFBundleExecutable', '<string>Marver</string>'],
    ['CFBundleShortVersionString', `<string>${version}</string>`], ['CFBundleVersion', `<string>${version}</string>`],
    ['LSMinimumSystemVersion', '<string>13.0</string>'], ['ElectronSquirrelPreventDowngrades', downgrades ? '<true/>' : '<false/>']]
  writeFileSync(join(c, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${keys.map(([k, v]) => `  <key>${k}</key>\n  ${v}`).join('\n')}\n</dict>\n</plist>\n`)
  writeFileSync(join(c, 'MacOS', 'Marver'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(c, 'MacOS', 'Marver'), 0o755)
  writeFileSync(join(fw, 'Versions', 'A', 'Electron Framework'), randomBytes(4096))
  chmodSync(join(fw, 'Versions', 'A', 'Electron Framework'), 0o755)
  symlinkSync('A', join(fw, 'Versions', 'Current'))
  symlinkSync('Versions/Current/Electron Framework', join(fw, 'Electron Framework'))
  writeFileSync(join(c, 'Resources', 'app.asar'), randomBytes(16384))
  writeFileSync(join(c, '_CodeSignature', 'CodeResources'), `${SIGNED}\n`)
}

// ---- the world ---------------------------------------------------------------------------------------------------

const git = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export const changelog = (version: string, { date = '2026-11-09', companion = '0.29.0' } = {}) =>
  `# Changelog - the Marver Mac app\n\n## ${version} - ${date}\n\n- **Updates arrive by themselves.** Needs a canvas on marver ${companion}.\n\n## 0.3.0 - unreleased (spec 28 A4)\n\n- Earlier.\n`

export interface World {
  base: string; repo: string; app: string; home: string; clock: FakeClock; gh: FakeGitHub; notary: FakeNotary; tools: FakeTools
  builds: Record<string, unknown>[]; lines: string[]; npm: Set<string>
  ports: Record<string, unknown>
  run(argv: string[], o?: { app?: string }): Promise<{ code: number; stop?: string }>
  state(version: string, app?: string): any
  shared(test?: boolean): any
  record(version: string, app?: string): any
  /** a new version committed and pushed: package.json and its CHANGELOG section */
  bump(version: string, o?: { companion?: string; push?: boolean }): void
  worktree(name: string): string
  evidence(version: string, o?: Record<string, unknown>): string
  /** the whole world - checkout, origin, shared folder and every fake - kept, to be restored at the same path */
  snap(): Snap
  restore(snap: Snap): void
  cleanupMounts(): void
  cleanup(): void
}
export interface Snap { dir: string; gh: string; subs: string; t: number }

export function makeWorld(version: string, { test = false } = {}): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mv-release-')))
  const remote = join(base, 'origin.git')
  const repo = join(base, 'repo')
  const app = join(repo, 'app')
  const home = join(base, 'home', 'release')
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote])
  mkdirSync(join(app, 'build'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, ['config', 'user.name', 'Release Test'])
  git(repo, ['config', 'user.email', 'release-test@example.invalid'])
  writeFileSync(join(repo, '.gitignore'), 'app/.release/\napp/.stage/\n')
  writeFileSync(join(app, 'build', 'designated-requirement.txt'), `${DR}\n`)
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'marver-app', version }, null, 2) + '\n')
  writeFileSync(join(app, 'CHANGELOG.md'), changelog(version))
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', `app ${version}`])
  git(repo, ['remote', 'add', 'origin', remote])
  git(repo, ['push', '-q', '-u', 'origin', 'main'])
  if (test) { git(repo, ['checkout', '-q', '-b', 'candidate']); git(repo, ['push', '-q', '-u', 'origin', 'candidate']) }

  const clock = new FakeClock()
  const gh = new FakeGitHub(clock)
  const notary = new FakeNotary(clock)
  const tools = new FakeTools()
  const builds: Record<string, unknown>[] = []
  const lines: string[] = []
  const npm = new Set(['0.28.0', '0.29.0'])
  const snaps: string[] = []
  const real = realPorts()
  const ports = {
    ...real,
    clock, notary, github: gh,
    codesign: tools.codesign, stapler: tools.stapler, spctl: tools.spctl, lipo: tools.lipo,
    npm: { published: async (v: string) => npm.has(v) },
    build: async (o: { feed: string; into: string; adhoc: boolean; smoke: boolean; tamper: boolean; knownFail: string[] }) => {
      builds.push(o)
      const v = JSON.parse(readFileSync(join(o.into, '..', '..', 'package.json'), 'utf8')).version
      makeBundle(join(o.into, 'Marver.app'), v)
      writeFileSync(join(o.into, 'smoke-1.json'), '{"completed":true,"failures":0}\n')
      writeFileSync(join(o.into, 'build.json'), JSON.stringify({ app: join(o.into, 'Marver.app'), adhoc: false, version: v, electron: '45.0.0', team: 'PXV6WER853',
        feed: feedKind(o.feed), release: true, smoke: 'default', smokeReport: 'smoke-1.json', knownFailures: [] }, null, 2))
    },
  }
  const w: World = {
    base, repo, app, home, clock, gh, notary, tools, builds, lines, npm, ports,
    run: (argv, o = {}) => run(argv, { ports, app: o.app ?? app, home, log: (s: string) => { lines.push(s) } }),
    state: (v, a = app) => { const f = join(a, '.release', v, 'state.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null },
    shared: (t = test) => { const f = join(home, `${(t ? REPOS.test : REPOS.production).replace('/', '-')}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null },
    record: (v, a = app) => { const f = join(a, 'releases', `${v}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null },
    bump: (v, { companion = '0.29.0', push = true } = {}) => {
      writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'marver-app', version: v }, null, 2) + '\n')
      writeFileSync(join(app, 'CHANGELOG.md'), changelog(v, { companion }))
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', `app ${v}`])
      if (push) git(repo, ['push', '-q'])
    },
    worktree: (name) => {
      const dir = join(base, name)
      git(repo, ['worktree', 'add', '-q', '--detach', dir, 'HEAD'])
      git(dir, ['checkout', '-q', '-B', `wt-${name}`, 'HEAD'])
      return join(dir, 'app')
    },
    evidence: (v, o = {}) => {
      const s = w.state(v)
      const names = assetNames(v)
      const ev = { version: v, dmg: s.files[names.dmg].sha256, zip: s.files[names.zip].sha256, mac: 'Mac mini M2 (clean)', macos: '26.1',
        checks: Object.fromEntries(['install-open', 'notarised', 'not-translocated', 'notice-ask', 'notice-banner', 'dock-badge', 'notice-denied', 'settings-link', 'signin', 'shared-card', 'live-picture', ...(v === '1.0.0' ? ['install-matrix'] : [])].map((id) => [id, 'pass'])),
        google: 'accepted', notes: '', ...o }
      const f = join(base, `evidence-${v}-${randomUUID().slice(0, 8)}.json`)
      writeFileSync(f, JSON.stringify(ev, null, 2))
      return f
    },
    snap: () => {
      const dir = `${base}.snap-${randomUUID().slice(0, 8)}`
      execFileSync('cp', ['-cR', base, dir])
      snaps.push(dir)
      return { dir, gh: gh.dump(), subs: JSON.stringify(notary.subs), t: clock.t }
    },
    restore: (snap) => {
      w.cleanupMounts()
      rmSync(base, { recursive: true, force: true })
      execFileSync('cp', ['-cR', snap.dir, base])
      gh.load(snap.gh)
      Object.assign(notary, { subs: JSON.parse(snap.subs), plan: { app: [], dmg: [] }, calls: [], crashAfterSubmit: 0, waitTimeouts: 0 })
      Object.assign(tools, { calls: [], dr: DR })
      tools.crashAfter.clear()
      clock.t = snap.t
      builds.length = 0
      lines.length = 0
      npm.clear(); npm.add('0.28.0'); npm.add('0.29.0')
    },
    cleanupMounts: () => {
      // a DMG left mounted by a failed case: detach anything under this world
      try {
        const info = execFileSync('hdiutil', ['info'], { encoding: 'utf8' })
        for (const m of info.split('\n').map((l) => l.split('\t').at(-1)?.trim() ?? '').filter((p) => p.startsWith(base))) execFileSync('hdiutil', ['detach', '-force', m], { stdio: 'ignore' })
      } catch { /* nothing mounted */ }
    },
    cleanup: () => {
      w.cleanupMounts()
      for (const d of snaps) rmSync(d, { recursive: true, force: true })
      rmSync(base, { recursive: true, force: true })
    },
  }
  return w
}

/** The run's words, joined, for an assertion on what it named */
export const said = (w: World) => w.lines.join('\n')
export const gitIn = git
