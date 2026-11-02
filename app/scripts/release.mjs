#!/usr/bin/env node
/**
 * Releases the Marver Mac app (spec 28 A5.1 #1-#12): one notarised arm64 DMG, one signed and stapled update ZIP and one
 * static feed, on an immutable GitHub release - draft first, resumable, verified. Three phases, each resumable:
 *
 *   node scripts/release.mjs <X.Y.Z> [--test]                      prepare: steps 0-11, stopping at awaiting-acceptance
 *   node scripts/release.mjs <X.Y.Z> --resume [--test]             go on from where the state stands, never past a gate
 *   node scripts/release.mjs <X.Y.Z> --accept=<evidence> [--test]  record the acceptance of the draft's exact bytes
 *   node scripts/release.mjs <X.Y.Z> --publish [--test]            steps 12-14, for accepted bytes only
 *
 * and the operator's commands, for the rare states the script will not guess about (#11; the release playbook says
 * when each is run, after looking at GitHub): --settle-published, --republish, --settle-unpublished, --abandon,
 * --withdraw, --clear-owner. Nothing else is accepted (#3). `--test` releases into TNEP4/marver-app-test with the test
 * feed, as a 0.9x candidate, and needs no acceptance (#4, #11, #31, #43).
 *
 * The steps (#11), each recorded in `.release/X.Y.Z/state.json` (gitignored) before the next starts:
 *   0 preflight     refusals only: a clean tree, pushed (marver's main for production); the versions (#5) above the
 *                   floor; a dated, committed CHANGELOG section naming its companion marver version, published on
 *                   npm; no release or tag vX.Y.Z but this state's draft; gh able to write; immutability on; notarytool
 *   1 freeze        the source SHA, the notes and their sha256, the feed, the designated requirement (DR)
 *   2 build         scripts/build.mjs's buildRelease with the feed baked in, the smoke whole, into .release/X.Y.Z/
 *   3 notarize-app  the built app's tree hash first (app-hashed), then its ZIP submitted without --wait (#7)
 *   4 staple-app    a ditto copy, stapled, validated, spctl'd and checked against the DR; the copy's tree hash
 *   5 zip           the update ZIP of the stapled app
 *   6 dmg           dmg-built, dmg-signed (a clone, signed), its submission, dmg-accepted, dmg-stapled (a clone)
 *   7 verify        the ZIP extracted and the DMG mounted: signatures, DR, staple, spctl, Info.plist, lipo, tree hash
 *   8 feed          releases.json from the state
 *   9-11 draft, upload, check-draft: the private draft, its three assets reconciled by digest, downloaded back and
 *                   checked; then the run stops at awaiting-acceptance and prints the three sha256
 *   12 publish      the gates again (acceptance, hashes, immutability, floor), then one request, written ahead
 *   13 check-public anonymously: this release's artifacts, then who owns `latest` (18 reads in a row agree)
 *   14 record       app/releases/X.Y.Z.json: published, superseded, check-failed or withdrawn
 *
 * Every side effect is written ahead (`pending`) and reconciled with the world before anything else on the next run
 * (#10): a notary submission through `notarytool history` and its unique file name; a signature or a staple by
 * deleting its unrecorded output and making it again from its unchanged input; GitHub by reading the release first.
 * No recorded file is ever changed. One run per repository at a time, under `~/.marver/release/<owner>-<repo>.lock`,
 * and `<owner>-<repo>.json` beside it names the release that owns the repository, any publish in flight and the
 * releases settled unpublished that are watched (#10).
 *
 * Every external tool goes through a port (`realPorts`): the clock, the lock, git, notarytool, codesign, stapler,
 * spctl, hdiutil, ditto, cp -c, lipo, plutil, GitHub, npm and the build. test/fake/release-flow.test.ts drives every
 * phase, resume point and operator command against fakes (spec 28 A5.1 #33). Nothing here is ever run by a test for
 * real: a real run notarises with Apple and publishes on GitHub.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync, constants, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, readlinkSync, readSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { FEEDS } from '../tsdown.config.ts'
import { APP, BuildFailure, BUNDLE_ID, IDENTITY, MIN_MACOS, PRODUCT, feedKind } from './build.mjs'

// ---- the frozen names (A5.1 #41) ------------------------------------------------------------------------------------

/** The two releases repositories (#31): production, and the candidates' (0.9x) */
export const REPOS = { production: 'TNEP4/marver-app', test: 'TNEP4/marver-app-test' }
/** The notarytool keychain profile Nic stored (#7, "As done": from the team's App Store Connect API key) */
export const NOTARY_PROFILE = 'marver-notary'
/**
 * The one smoke check a --test candidate may pass failing, at a measured number (Nic, 2 Nov: the no-canvas memory
 * budget, 226.9 MB against 200 on 0.99.1; candidates test the update and install mechanics, not memory). A production
 * release never names a known failure (#3): the check stays binding for 1.0.0. The number goes into the record.
 */
export const CANDIDATE_WAIVERS = ['memory-no-canvas']
/** the companion's npm name (#2): the repo's own package, read from its package.json - never a bare `marver`, which is someone else's */
export const NPM_NAME = JSON.parse(readFileSync(join(APP, '..', 'package.json'), 'utf8')).name
/** The commands besides preparing (#3, #11) */
export const COMMANDS = ['resume', 'accept', 'publish', 'abandon', 'withdraw', 'settle-published', 'republish', 'settle-unpublished', 'clear-owner']
/** The operator's commands (#11): each has its own prerequisites and skips the resume checks */
export const OPERATOR = ['abandon', 'withdraw', 'settle-published', 'republish', 'settle-unpublished', 'clear-owner']
/** A version is three numbers (#5): Squirrel compares them with NSNumericSearch, so `1.0.0-rc.1` would compare wrongly */
export const VERSION = /^\d+\.\d+\.\d+$/
/** The three assets (#6), and nothing else; the DMG's name is the same in every release */
export const assetNames = (v) => ({ zip: `Marver-darwin-arm64-${v}.zip`, dmg: 'Marver-arm64.dmg', feed: 'releases.json' })
export const assetList = (v) => Object.values(assetNames(v))
/** The notary submissions' names (#7): a name no other submission has, from its own bytes */
export const notaryAppName = (v, sha) => `Marver-${v}-app-${sha.slice(0, 12)}.zip`
export const notaryDmgName = (v, sha) => `Marver-${v}-dmg-${sha.slice(0, 12)}.dmg`
/** The files steps 2, 4 and 6 make, under `.release/X.Y.Z/` (#11) */
export const FILES = { app: 'Marver.app', stapled: 'stapled/Marver.app', dmgBuilt: 'Marver-built.dmg', dmgSigned: 'Marver-signed.dmg' }
/** #11's frozen acceptance list, for every production release whatever its notes say; 1.0.0 adds #37's matrix */
export const ACCEPTANCE_IDS = ['install-open', 'notarised', 'not-translocated', 'notice-ask', 'notice-banner', 'dock-badge',
  'notice-denied', 'settings-link', 'signin', 'shared-card', 'live-picture']
export const requiredChecks = (v) => (v === '1.0.0' ? [...ACCEPTANCE_IDS, 'install-matrix'] : [...ACCEPTANCE_IDS])
/** The record's four statuses (#11, step 14); `abandoned` is only ever a final in the shared record */
export const RECORD_STATUSES = ['published', 'superseded', 'check-failed', 'withdrawn']

/** The waits (#10, #11; S3's measurements) */
export const T = {
  /** --republish no sooner than this after the publish request: a retry delay, it proves nothing (r6 #2) */
  publishWaitMs: 10 * 60_000,
  /** --settle-unpublished only this long after the request, the draft unchanged (r6 #2) */
  settleUnpublishedMs: 24 * 3600_000,
  /** step 13: `latest` read every 10 s for up to 15 min; an owner counts after 18 reads in a row agree (S3: the
   *  redirects first give a new release 59-74 s after a publish, and flap for a minute or two after a change) */
  latestEveryMs: 10_000,
  latestForMs: 15 * 60_000,
  latestAgree: 18,
  /** the versioned URLs answer 2-3 s after the publish (S3): read up to a minute */
  versionedTries: 12,
  versionedEveryMs: 5_000,
  /** --withdraw reads the release again until GitHub shows the prerelease flag */
  prereleaseTries: 20,
  prereleaseEveryMs: 3_000,
  /** history's `createdDate` is Apple's clock: a submission counts from this long before `pending`'s time. Its name
   *  holds its bytes' hash, so an older one of that name is the same bytes, and its ticket staples them as well */
  notarySkewMs: 10 * 60_000,
}

// ---- errors -----------------------------------------------------------------------------------------------------

/** The run stops, on purpose, with a plain message: exit 1 (2 for the command line). Anything else is a crash. */
export class Stop extends Error {
  constructor(message, code = 1) { super(message); this.name = 'Stop'; this.code = code }
}
/** GitHub, npm or notarytool could not be read: never taken for an answer */
export class Unreadable extends Stop {
  constructor(message) { super(message); this.name = 'Unreadable' }
}
const stop = (m) => { throw new Stop(m) }

// ---- pure rules (unit-tested: test/unit/release-args.test.ts, release-plan.test.ts) ---------------------------------

export const USAGE = 'usage: node scripts/release.mjs <X.Y.Z> [--resume | --accept=<evidence> | --publish | --abandon | --withdraw | --settle-published | --republish | --settle-unpublished | --clear-owner] [--test]'

/** The command line (#3): one version, at most one command, `--test`; anything else refused by name. */
export function parseArgs(argv) {
  let version = null, command = null, evidence = null, test = false
  for (const a of argv) {
    if (!a.startsWith('-')) {
      if (version !== null) return { error: `one version at a time: ${version} and ${a}` }
      version = a
      continue
    }
    if (a === '--test') {
      if (test) return { error: '--test given twice' }
      test = true
      continue
    }
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(a)
    let c = null
    if (m?.[1] === 'accept') {
      if (!m[2]) return { error: '--accept needs the evidence file: --accept=<evidence.json>' }
      c = 'accept'
      evidence = m[2]
    } else if (m && COMMANDS.includes(m[1]) && m[2] === undefined) c = m[1]
    else if (m?.[1] === 'release' || m?.[1] === 'js' || m?.[1] === 'adhoc') return { error: `${a}: not an option of release.mjs, which always builds signed, smoked and with its feed (scripts/build.mjs builds the rest)` }
    else return { error: `${a}: not an option of release.mjs` }
    if (command !== null) return { error: `one command at a time: --${command} and ${a}` }
    command = c
  }
  if (version === null) return { error: 'the version is missing' }
  if (!VERSION.test(version)) return { error: `${version} is not a version X.Y.Z of three numbers (A5.1 #5: no -rc or other suffix)` }
  return { version, command: command ?? 'prepare', evidence, test }
}

/** [major, minor, patch] of `X.Y.Z` or `vX.Y.Z`, or null */
export const parseVersion = (v) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v))?.slice(1).map(Number) ?? null
/** Numeric order of two versions, as Squirrel's NSNumericSearch compares them */
export function cmpVersion(a, b) {
  const x = parseVersion(a), y = parseVersion(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}
/** A test candidate's version (#5, #31, #43): 0.90.0-0.99.x */
export const isCandidate = (v) => { const p = parseVersion(v); return p[0] === 0 && p[1] >= 90 && p[1] <= 99 }

/**
 * The version floor (#5, r2 #7): the highest version the repository has ever made public - every `vX.Y.Z` tag and
 * every published release, prereleases (withdrawn ones) included, drafts never. `latest` is never the floor.
 * @param {{ tags: ({ name: string } | string)[]; releases: { tag_name: string; draft: boolean }[] }} o
 */
export function versionFloor({ tags, releases }) {
  const names = [...tags.map((t) => (typeof t === 'string' ? t : t.name)), ...releases.filter((r) => !r.draft).map((r) => r.tag_name)]
  return names.filter((n) => /^v\d+\.\d+\.\d+$/.test(n)).map((n) => n.slice(1)).sort(cmpVersion).at(-1) ?? null
}

/**
 * The CHANGELOG section for `version` (#5, #11 step 0): exactly one `## X.Y.Z - YYYY-MM-DD` heading, a real date, a
 * body. Returns `{ heading, date, text }` (the body trimmed) or `{ error }`.
 */
export function changelogSection(changelog, version) {
  const lines = String(changelog ?? '').split('\n')
  const heads = lines.flatMap((l, i) => (l.startsWith('## ') ? [i] : []))
  const mine = heads.filter((i) => lines[i] === `## ${version}` || lines[i].startsWith(`## ${version} `))
  if (!mine.length) return { error: `app/CHANGELOG.md has no section for ${version}` }
  if (mine.length > 1) return { error: `app/CHANGELOG.md has ${mine.length} sections for ${version}` }
  const at = mine[0]
  const heading = lines[at]
  const m = /^## (\d+\.\d+\.\d+) - (\d{4})-(\d{2})-(\d{2})$/.exec(heading)
  const date = m && new Date(Date.UTC(+m[2], +m[3] - 1, +m[4]))
  if (!m || date.getUTCFullYear() !== +m[2] || date.getUTCMonth() !== +m[3] - 1 || date.getUTCDate() !== +m[4]) {
    return { error: `the section's heading is "${heading}": a release's is "## ${version} - YYYY-MM-DD", dated` }
  }
  const end = heads.find((i) => i > at) ?? lines.length
  const text = lines.slice(at + 1, end).join('\n').trim()
  if (!text) return { error: `the ${version} section is empty` }
  return { heading, date: `${m[2]}-${m[3]}-${m[4]}`, text }
}

/**
 * The companion marver versions a section names (#2, #30): every lowercase `marver X.Y.Z` - the npm package, as the
 * CHANGELOG's voice writes it ("a canvas on marver 0.29.0"), never "Marver", the app - in order. The highest is the
 * companion the record names; each must be published on npm (preflight).
 */
export function companionVersions(text) {
  return [...new Set([...String(text).matchAll(/(?<![\w.-])marver (\d+\.\d+\.\d+)(?![\w-]|\.\d)/g)].map((m) => m[1]))].sort(cmpVersion)
}

/** The asset URL of a version's release (the feed's `url`, check-public's reads) */
export const assetUrl = (repo, v, name) => `https://github.com/${repo}/releases/download/v${v}/${name}`

/**
 * releases.json (#9): one entry, from the release state, keys in this order, ending in a newline. Squirrel finds
 * `currentRelease` equal to the running version: current; the running one higher: skipped; else this entry.
 */
export function feedText({ version, pubDate, notes, repo }) {
  const feed = { currentRelease: version, releases: [{ version, updateTo: { version, pub_date: pubDate, notes, name: version, url: assetUrl(repo, version, assetNames(version).zip) } }] }
  return JSON.stringify(feed, null, 2) + '\n'
}

/** The release's body on GitHub: the CHANGELOG section, then a footer naming the app's source commit (#10) */
export function releaseBody({ notes, sha }) {
  return `${notes}\n\n---\nBuilt from [TNEP4/marver@${sha.slice(0, 12)}](https://github.com/TNEP4/marver/tree/${sha}/app).\n`
}

/** Every place #5 names agrees on the version; returns what does not */
export function versionAgreement(version, { plist, feed, release, zipName, heading, repo } = {}) {
  const bad = []
  const eq = (what, got) => { if (got !== version) bad.push(`${what} is ${JSON.stringify(got)}`) }
  if (plist) { eq('CFBundleShortVersionString', plist.CFBundleShortVersionString); eq('CFBundleVersion', plist.CFBundleVersion) }
  if (feed) {
    eq('the feed\'s currentRelease', feed.currentRelease)
    if (feed.releases?.length !== 1) bad.push(`the feed holds ${feed.releases?.length ?? 'no'} entries, not one`)
    const e = feed.releases?.[0]
    eq('the feed\'s version', e?.version); eq('updateTo.version', e?.updateTo?.version); eq('updateTo.name', e?.updateTo?.name)
    if (repo && e?.updateTo?.url !== assetUrl(repo, version, assetNames(version).zip)) bad.push(`updateTo.url is ${JSON.stringify(e?.updateTo?.url)}`)
  }
  if (release) {
    if (release.tag_name !== `v${version}`) bad.push(`the tag is ${release.tag_name}`)
    if (release.name !== `Marver ${version}`) bad.push(`the release's title is ${JSON.stringify(release.name)}`)
  }
  if (zipName !== undefined && zipName !== assetNames(version).zip) bad.push(`the ZIP is named ${zipName}`)
  if (heading !== undefined && !heading.startsWith(`## ${version} - `)) bad.push(`the CHANGELOG heading is ${JSON.stringify(heading)}`)
  return bad
}

/** The one publish request (#10, r6 #1): `-F` sends `draft` as the boolean false, `-f` sends `make_latest` as a string */
export const publishArgs = (repo, id) => ['api', '-X', 'PATCH', `repos/${repo}/releases/${id}`, '-F', 'draft=false', '-f', 'make_latest=legacy']

/**
 * The JSON body `gh api` sends for its field flags (`gh help api`): `-f`/`--raw-field` adds a string; `-F`/`--field`
 * a typed value - `true`, `false`, `null` and integers become JSON literals, anything else a string (its `@file` and
 * `{placeholder}` forms aside, which the release never uses). The unit test reads publishArgs through it.
 */
export function ghFieldsPayload(args) {
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (!['-f', '-F', '--raw-field', '--field'].includes(flag)) continue
    const kv = args[++i]
    const eq = kv.indexOf('=')
    const k = kv.slice(0, eq), v = kv.slice(eq + 1)
    out[k] = flag === '-f' || flag === '--raw-field' ? v : v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : /^-?\d+$/.test(v) ? Number(v) : v
  }
  return JSON.stringify(out)
}

/**
 * The draft's assets against the state's (#10): kept when GitHub's `digest` (sha256) and size equal the record;
 * deleted and uploaded again when they differ; uploaded when missing; any other asset deleted.
 * @param {Record<string, { sha256: string; bytes: number }>} expected
 * @param {{ id: number; name: string; size: number; digest?: string | null }[]} actual
 */
export function reconcileAssets(expected, actual) {
  const plan = { keep: [], upload: [], replace: [], remove: [] }
  for (const [name, want] of Object.entries(expected)) {
    const have = actual.filter((a) => a.name === name)
    if (!have.length) plan.upload.push(name)
    else if (have.length === 1 && have[0].digest === `sha256:${want.sha256}` && have[0].size === want.bytes) plan.keep.push(name)
    else plan.replace.push({ name, ids: have.map((a) => a.id) })
  }
  for (const a of actual) if (!Object.hasOwn(expected, a.name)) plan.remove.push({ name: a.name, id: a.id })
  return plan
}
export const exactlyKept = (plan) => !plan.upload.length && !plan.replace.length && !plan.remove.length

/** The submissions named `name` since `since` in `notarytool history`'s list, oldest first (#7) */
export function submissionsOf(history, name, since) {
  return history.filter((h) => h.name === name && Date.parse(h.createdDate) >= since - T.notarySkewMs)
    .sort((a, b) => Date.parse(a.createdDate) - Date.parse(b.createdDate))
}

/**
 * What the waits on a submission's ids decide (#7), in their order: the first Accepted serves (a ticket belongs to the
 * code's hash, not to a submission); all Invalid or Rejected fail; anything else (In Progress, a timeout, no answer)
 * is waited on again by the next run, nothing submitted again.
 * @param {{ id: string; status: string | null }[]} seen
 */
export function notaryOutcome(seen) {
  const ok = seen.find((x) => x.status === 'Accepted')
  if (ok) return { accepted: ok.id }
  if (seen.length && seen.every((x) => x.status === 'Invalid' || x.status === 'Rejected')) return { failed: true }
  return { waiting: true }
}

/**
 * The acceptance evidence (#11, r2 #5): `{ version, dmg, zip, mac, macos, checks: { <id>: 'pass' | 'fail' }, google:
 * 'accepted' | 'refused', notes }`. Refused unless both hashes equal the state's and the draft's digests and every
 * required id is present and `pass`: matching hashes alone admit nothing. Whether Continue with Google was accepted
 * is recorded, never passed or failed.
 */
export function judgeEvidence(ev, { version, zip, dmg, digests, required = requiredChecks(version) }) {
  const why = []
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return { ok: false, why: ['the evidence is not a JSON object'] }
  if (ev.version !== version) why.push(`its version is ${JSON.stringify(ev.version)}, not ${version}`)
  const names = assetNames(version)
  for (const [k, want, asset] of [['dmg', dmg, names.dmg], ['zip', zip, names.zip]]) {
    if (typeof ev[k] !== 'string' || !/^[0-9a-f]{64}$/.test(ev[k])) { why.push(`${k}: not a sha256 (64 lowercase hex)`); continue }
    if (ev[k] !== want) why.push(`${k}: ${ev[k]} is not the state's ${want}`)
    if (digests[asset] !== `sha256:${ev[k]}`) why.push(`${k}: the draft's digest of ${asset} is ${digests[asset] ?? 'missing'}`)
  }
  for (const k of ['mac', 'macos']) if (typeof ev[k] !== 'string' || !ev[k].trim()) why.push(`${k} is missing`)
  if (ev.google !== 'accepted' && ev.google !== 'refused') why.push(`google is ${JSON.stringify(ev.google)}: 'accepted' or 'refused'`)
  if (ev.notes !== undefined && typeof ev.notes !== 'string') why.push('notes is not text')
  const checks = ev.checks
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) why.push('checks is missing')
  else {
    for (const [id, v] of Object.entries(checks)) if (v !== 'pass' && v !== 'fail') why.push(`check ${id} is ${JSON.stringify(v)}: 'pass' or 'fail'`)
    for (const id of required) {
      if (!Object.hasOwn(checks, id)) why.push(`the required check ${id} is missing`)
      else if (checks[id] !== 'pass') why.push(`the required check ${id} is ${checks[id]}`)
    }
  }
  return { ok: !why.length, why }
}

/** sha256 of a file, read in 1 MB chunks */
export function sha256File(path) {
  const h = createHash('sha256')
  const fd = openSync(path, 'r')
  const buf = Buffer.allocUnsafe(1 << 20)
  try { let n; while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)) } finally { closeSync(fd) }
  return h.digest('hex')
}
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/**
 * A folder's tree hash (#11 step 7): every file's path, mode and sha256, each symlink as its target, each folder by
 * its path, in sorted order. `bytes` is the files' total size.
 */
export function treeHash(root) {
  const lines = []
  let bytes = 0
  const walk = (rel) => {
    for (const name of readdirSync(rel ? join(root, rel) : root).sort()) {
      const r = rel ? `${rel}/${name}` : name
      const p = join(root, r)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) lines.push(`L ${r} -> ${readlinkSync(p)}`)
      else if (st.isDirectory()) { lines.push(`D ${r}`); walk(r) }
      else if (st.isFile()) { lines.push(`F ${r} ${(st.mode & 0o7777).toString(8)} ${sha256File(p)}`); bytes += st.size }
      else lines.push(`? ${r}`)
    }
  }
  walk('')
  return { sha256: sha256(lines.join('\n') + '\n'), bytes }
}
/** A recorded file's `{ sha256, bytes }`: a folder (an app) by its tree hash */
export const hashOf = (path) => (lstatSync(path).isDirectory() ? treeHash(path) : { sha256: sha256File(path), bytes: statSync(path).size })

/** JSON written whole (#10): a temporary file, fsync, rename, the folder fsync'd */
export function writeJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  const fd = openSync(tmp, 'w', 0o644)
  try { writeSync(fd, JSON.stringify(obj, null, 2) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
  try { const d = openSync(dirname(file), 'r'); try { fsyncSync(d) } finally { closeSync(d) } } catch { /* a folder fsync is best-effort */ }
}

// ---- the lock (#10, r4 #1) ------------------------------------------------------------------------------------------

/** <fcntl.h>'s O_EXLOCK: Node does not name it, and libuv passes open(2)'s flags through as they are */
const O_EXLOCK = 0x20
/**
 * The repository's lock, `O_EXLOCK | O_NONBLOCK`: held, the run stops at once. Held for the whole run, it goes with
 * the process, crash or not.
 */
export function takeLock(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let fd
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_RDWR | O_EXLOCK | constants.O_NONBLOCK, 0o600)
  } catch (err) {
    if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') stop(`another release run holds ${path}: one run per repository at a time (A5.1 #10)`)
    throw err
  }
  return { release: () => { try { closeSync(fd) } catch { /* closed */ } } }
}

// ---- the real ports ------------------------------------------------------------------------------------------------

const tail = (s, n = 400) => String(s ?? '').trim().split('\n').slice(-4).join(' | ').slice(-n)

/**
 * The tools as they really run (S1's and S3's command lines, `~/marver-a5-spikes`). Each call's output goes to
 * `toolLog` (the state's logs/tools.log). Checks answer `{ ok, out }`; actions throw a Stop with the tool's words.
 */
export function realPorts({ toolLog = () => {} } = {}) {
  const x = (cmd, args, { timeout = 600_000, input, secret = false } = {}) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, input, maxBuffer: 256 << 20 })
    // a secret's output (gh's token) never reaches the log
    toolLog(cmd, args, secret ? { ...r, stdout: '[secret]' } : r)
    if (r.error) throw new Unreadable(`${cmd} ${args.join(' ')}: ${r.error.message}`)
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  }
  const must = (r, what) => { if (r.status !== 0) stop(`${what} failed (exit ${r.status}): ${tail(r.out)}`); return r }
  const check = (r) => ({ ok: r.status === 0, out: tail(r.out) })
  const nt = (args, o) => x('xcrun', ['notarytool', ...args, '--keychain-profile', NOTARY_PROFILE], o)
  const git = (cwd, args, o) => x('git', ['-C', cwd, ...args], o)
  return {
    clock: { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    lock: { take: takeLock },
    git: {
      root: (cwd) => must(git(cwd, ['rev-parse', '--show-toplevel']), 'git rev-parse').stdout.trim(),
      head: (cwd) => must(git(cwd, ['rev-parse', 'HEAD']), 'git rev-parse HEAD').stdout.trim(),
      branch: (cwd) => git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim() || null,
      /** `git status --porcelain`, untracked files included: anything at all is an unclean tree */
      dirty: (cwd) => must(git(cwd, ['status', '--porcelain', '--untracked-files=all']), 'git status').stdout.split('\n').filter(Boolean),
      /** HEAD is on origin's `branch`: read with ls-remote (nothing fetched), then an ancestry check */
      pushed: (cwd, branch) => {
        const r = git(cwd, ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`], { timeout: 120_000 })
        const remote = /^([0-9a-f]{40})\s/.exec(r.stdout)?.[1]
        if (!remote) return { ok: false, why: `origin has no ${branch} (${tail(r.stderr) || `exit ${r.status}`})` }
        if (git(cwd, ['cat-file', '-e', `${remote}^{commit}`]).status !== 0) return { ok: false, why: `origin/${branch} is at ${remote.slice(0, 12)}, which this checkout does not have: pull first` }
        return git(cwd, ['merge-base', '--is-ancestor', 'HEAD', remote]).status === 0 ? { ok: true } : { ok: false, why: `HEAD is not in origin/${branch} (${remote.slice(0, 12)})` }
      },
      show: (cwd, rev, path) => { const r = git(cwd, ['show', `${rev}:${path}`]); return r.status === 0 ? r.stdout : null },
      user: (cwd) => git(cwd, ['config', 'user.name']).stdout.trim() || null,
    },
    notary: {
      /** without --wait (#7): JSON output holds everything back until the command ends, so a crash leaves no id */
      submit: async (file) => ({ id: JSON.parse(must(nt(['submit', file, '--output-format', 'json'], { timeout: 3 * 3600_000 }), 'notarytool submit').stdout).id }),
      history: async () => {
        const r = nt(['history', '--output-format', 'json'], { timeout: 300_000 })
        if (r.status !== 0) throw new Unreadable(`notarytool history failed (exit ${r.status}): ${tail(r.out)}`)
        return JSON.parse(r.stdout).history ?? []
      },
      wait: async (id) => {
        const r = nt(['wait', id, '--timeout', '2h', '--output-format', 'json'], { timeout: 2 * 3600_000 + 600_000 })
        let j = null
        try { j = JSON.parse(r.stdout) } catch { /* no answer */ }
        return { status: j?.status ?? null, message: j?.message ?? tail(r.out) }
      },
      log: async (id, dest) => { must(nt(['log', id, dest], { timeout: 300_000 }), 'notarytool log') },
    },
    codesign: {
      verify: (p) => check(x('codesign', ['--verify', '--deep', '--strict', p])),
      /** `-R` then `=<DR>` as two arguments: S1 found `-R='=...'` refused ("unexpected token: =") */
      verifyDR: (p, dr) => check(x('codesign', ['--verify', '--deep', '--strict', '-R', `=${dr}`, p])),
      dr: (p) => /^designated => (.*)$/m.exec(x('codesign', ['-d', '-r-', p]).out)?.[1]?.trim() ?? null,
      signDmg: (p) => { must(x('codesign', ['--timestamp', '--sign', IDENTITY, p], { timeout: 300_000 }), 'codesign --sign (the DMG)') },
      verifyFile: (p) => check(x('codesign', ['--verify', '-vv', p])),
    },
    stapler: {
      staple: (p) => { must(x('xcrun', ['stapler', 'staple', p], { timeout: 300_000 }), `stapler staple ${p}`) },
      validate: (p) => check(x('xcrun', ['stapler', 'validate', p], { timeout: 300_000 })),
    },
    spctl: {
      app: (p) => { const r = x('spctl', ['-a', '-vv', p]); return { ok: r.status === 0 && /source=Notarized Developer ID/.test(r.out), out: tail(r.out) } },
      dmg: (p) => { const r = x('spctl', ['-a', '-vv', '-t', 'open', '--context', 'context:primary-signature', p]); return { ok: r.status === 0 && /source=Notarized Developer ID/.test(r.out), out: tail(r.out) } },
    },
    hdiutil: {
      create: ({ volname, src, out }) => { must(x('hdiutil', ['create', '-volname', volname, '-srcfolder', src, '-format', 'UDZO', '-ov', out], { timeout: 900_000 }), 'hdiutil create') },
      attach: (dmg, mnt) => { must(x('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mnt, dmg], { timeout: 300_000 }), 'hdiutil attach') },
      detach: (mnt) => { if (x('hdiutil', ['detach', mnt]).status !== 0) x('hdiutil', ['detach', '-force', mnt]) },
    },
    ditto: {
      /** `preserve`: #11 step 4's `--rsrc --extattr --qtn --acl` */
      copy: (src, dst, { preserve = false } = {}) => { must(x('ditto', [...(preserve ? ['--rsrc', '--extattr', '--qtn', '--acl'] : []), src, dst], { timeout: 900_000 }), 'ditto') },
      /** `sequester`: the update ZIP's `--sequesterRsrc` (#6); the notary ZIP is plain `-c -k --keepParent` (#7) */
      zip: (src, out, { sequester = false } = {}) => { must(x('ditto', ['-c', '-k', ...(sequester ? ['--sequesterRsrc'] : []), '--keepParent', src, out], { timeout: 900_000 }), 'ditto -c -k') },
      unzip: (zip, dir) => { must(x('ditto', ['-x', '-k', zip, dir], { timeout: 900_000 }), 'ditto -x -k') },
    },
    /** an APFS clone (#10: a signature or a staple works on a new file) */
    clone: (src, dst) => { must(x('cp', ['-c', src, dst], { timeout: 300_000 }), 'cp -c') },
    lipo: { archs: (bin) => x('lipo', ['-archs', bin]).stdout.trim() },
    plist: { read: (file) => JSON.parse(must(x('plutil', ['-convert', 'json', '-o', '-', file]), `plutil ${file}`).stdout) },
    npm: {
      published: async (v) => {
        const r = x('npm', ['view', `${NPM_NAME}@${v}`, 'version', '--json'], { timeout: 120_000 })
        if (r.status !== 0) throw new Unreadable(`npm view ${NPM_NAME}@${v} failed (exit ${r.status}): ${tail(r.out)}`)
        try { return JSON.parse(r.stdout) === v } catch { return false }   // an unknown version answers nothing
      },
    },
    github: githubPort(x),
    build: async (o) => (await import('./build.mjs')).buildRelease(o),
  }
}

/**
 * GitHub (#10): JSON through `gh api` - the publish is S3's exact command, `publishArgs` - and the assets' bytes
 * through fetch with `gh auth token`'s token, as S3 and the spike app's publish.mjs uploaded and downloaded them (a
 * draft's asset by `Accept: application/octet-stream`, the redirect to storage dropping the credentials). Anonymous
 * reads carry no credentials and no cache, as Squirrel's. A non-2xx answer gives its status; no answer is Unreadable.
 */
function githubPort(x) {
  let token = null
  const auth = () => {
    if (token) return token
    const r = x('gh', ['auth', 'token'], { secret: true })
    if (r.status !== 0) throw new Unreadable(`gh auth token failed: ${tail(r.stderr)}`)
    return (token = r.stdout.trim())
  }
  const api = (args, input) => {
    const r = x('gh', ['api', ...args], { timeout: 180_000, ...(input !== undefined ? { input } : {}) })
    if (r.status === 0) return { status: 200, json: r.stdout.trim() ? JSON.parse(r.stdout) : null }
    const code = Number(/\(HTTP (\d{3})\)/.exec(r.stderr)?.[1] ?? 0)
    if (!code) throw new Unreadable(`gh api ${args.join(' ')}: ${tail(r.out)}`)
    return { status: code, json: null, message: tail(r.stderr) }
  }
  const ok = (r, what) => { if (r.status >= 300) throw new Unreadable(`${what}: HTTP ${r.status} ${r.message ?? ''}`); return r.json }
  const pages = (path, what) => ok(api(['--paginate', '--slurp', path]), what).flat()
  /** a body read cut short (a timeout, a reset) is Unreadable, as a request that never answered */
  const body = async (res, what) => { try { return Buffer.from(await res.arrayBuffer()) } catch (err) { throw new Unreadable(`${what}: ${err.message}`) } }
  const net = async (url, init, what) => {
    try { return await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 120_000) }) } catch (err) { throw new Unreadable(`${what}: ${err.message}`) }
  }
  return {
    releases: async (repo) => pages(`repos/${repo}/releases?per_page=100`, `the releases of ${repo}`),
    release: async (repo, id) => { const r = api([`repos/${repo}/releases/${id}`]); return r.status === 404 ? null : ok(r, `release ${id}`) },
    tags: async (repo) => pages(`repos/${repo}/tags?per_page=100`, `the tags of ${repo}`).map((t) => ({ name: t.name, sha: t.commit?.sha })),
    /** the commit a tag names (`GET /repos/{owner}/{repo}/commits/tags/{tag}`); no such tag answers 404 or 422 */
    tagCommit: async (repo, tag) => { const r = api([`repos/${repo}/commits/tags/${tag}`]); return r.status === 404 || r.status === 422 ? null : ok(r, `the tag ${tag}`).sha },
    branchHead: async (repo, branch) => ok(api([`repos/${repo}/branches/${branch}`]), `${repo}'s ${branch}`).commit.sha,
    /** the repository's release immutability (#10): 200 with enabled, or 404 for off (it needs admin read) */
    immutable: async (repo) => { const r = api([`repos/${repo}/immutable-releases`]); return r.status === 404 ? false : ok(r, 'the immutable-releases setting')?.enabled === true },
    canWrite: async (repo) => { const j = ok(api([`repos/${repo}`]), repo); return j.permissions?.push === true || j.permissions?.admin === true },
    createDraft: async (repo, body) => ok(api(['-X', 'POST', `repos/${repo}/releases`, '-H', 'Content-Type: application/json', '--input', '-'], JSON.stringify(body)), 'the draft'),
    publish: async (repo, id) => ok(api(publishArgs(repo, id).slice(1)), 'the publish'),
    markPrerelease: async (repo, id) => ok(api(['-X', 'PATCH', `repos/${repo}/releases/${id}`, '-F', 'prerelease=true']), 'the prerelease flag'),
    deleteAsset: async (repo, assetId) => { const r = api(['-X', 'DELETE', `repos/${repo}/releases/assets/${assetId}`]); if (r.status !== 404) ok(r, `deleting asset ${assetId}`) },
    uploadAsset: async (repo, id, name, file) => {
      const res = await net(`https://uploads.github.com/repos/${repo}/releases/${id}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST', body: readFileSync(file), timeoutMs: 30 * 60_000,
        headers: { Authorization: `Bearer ${auth()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/octet-stream' },
      }, `uploading ${name}`)
      const text = await res.text()
      if (res.status !== 201) stop(`uploading ${name}: HTTP ${res.status} ${text.slice(0, 200)}`)
      return JSON.parse(text)
    },
    downloadAsset: async (repo, assetId, dest) => {
      const res = await net(`https://api.github.com/repos/${repo}/releases/assets/${assetId}`, {
        timeoutMs: 30 * 60_000, headers: { Authorization: `Bearer ${auth()}`, Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' },
      }, `downloading asset ${assetId}`)
      if (res.status !== 200) stop(`downloading asset ${assetId}: HTTP ${res.status}`)
      writeFileSync(dest, await body(res, `downloading asset ${assetId}`))
    },
    anonGet: async (url) => {
      const res = await net(url, { redirect: 'follow', headers: { 'Cache-Control': 'no-cache' }, timeoutMs: 30 * 60_000 }, url)
      return { status: res.status, bytes: res.status === 200 ? await body(res, url) : null }
    },
    anonLocation: async (url) => {
      const res = await net(url, { redirect: 'manual', headers: { 'Cache-Control': 'no-cache' } }, url)
      return { status: res.status, location: res.headers.get('location') }
    },
  }
}

// ---- the run ---------------------------------------------------------------------------------------------------------

/**
 * One run of the command line (`argv` without node and the script). Returns `{ code }`: 0 when the command did its
 * part, 1 when it stopped on purpose (the message said why and what to run), 2 for the command line. Anything else
 * thrown is a crash, which the state survives by construction. `opts` (tests): `ports`, `app` (the checkout's app/
 * folder), `home` (the shared `release/` folder), `log`.
 */
export async function run(argv, opts = {}) {
  const log = opts.log ?? ((s) => console.log(s))
  const args = parseArgs(argv)
  if (args.error) { log(`release: ${args.error}\n${USAGE}`); return { code: 2 } }
  const cx = context(args, opts, log)
  let lock = null
  try {
    lock = cx.p.lock.take(join(cx.home, `${cx.repo.replace('/', '-')}.lock`))
    await main(cx)
    return { code: 0 }
  } catch (err) {
    if (!(err instanceof Stop)) throw err
    log(`release ${cx.label}: STOPPED - ${err.message}`)
    return { code: err.code, stop: err.message }
  } finally {
    for (const m of cx.mounts.splice(0)) { try { cx.p.hdiutil.detach(m) } catch { /* left mounted: hdiutil detach by hand */ } }
    lock?.release()
  }
}

function context(args, opts, log) {
  const app = resolve(opts.app ?? APP)
  // one lock and one owner record per repository on this Mac (#10; code review r2 #5): the account's own ~/.marver,
  // from its passwd entry - never MARVER_HOME or HOME, which two checkouts could set apart. Tests inject theirs.
  const home = resolve(opts.home ?? join(userInfo().homedir, '.marver', 'release'))
  const repo = args.test ? REPOS.test : REPOS.production
  const cx = {
    ...args, app, home, repo, tag: `v${args.version}`, dir: join(app, '.release', args.version),
    feed: FEEDS[args.test ? 'test' : 'production'], names: assetNames(args.version),
    label: `${args.version}${args.test ? ' (--test)' : ''}`, mounts: [], state: null, shared: null,
  }
  cx.say = (s) => log(`release ${cx.label}: ${s}`)
  cx.p = opts.ports ?? realPorts({ toolLog: (cmd, a, r) => toolLog(cx, cmd, a, r) })
  return cx
}

function toolLog(cx, cmd, args, r) {
  if (!existsSync(join(cx.dir, 'state.json'))) return
  const cut = (s) => (String(s ?? '').length > 20_000 ? `${String(s).slice(0, 20_000)}\n[... cut]` : String(s ?? ''))
  const line = `--- ${new Date().toISOString()} ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')} -> exit ${r.status}${r.signal ? ` ${r.signal}` : ''}\n${cut(r.stdout)}${cut(r.stderr)}\n`
  try { mkdirSync(join(cx.dir, 'logs'), { recursive: true }); writeFileSync(join(cx.dir, 'logs', 'tools.log'), line, { flag: 'a' }) } catch { /* the log is best-effort */ }
}

const sharedPath = (cx) => join(cx.home, `${cx.repo.replace('/', '-')}.json`)
const statePath = (cx) => join(cx.dir, 'state.json')
const at = (cx, name) => join(cx.dir, name)
const now = (cx) => cx.p.clock.now()
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString())
const flag = (cx) => (cx.test ? ' --test' : '')
const cmd = (cx, c = '', v = cx.version) => `node scripts/release.mjs ${v}${c ? ` ${c}` : ''}${flag(cx)}`

/** `~/.marver/release/<owner>-<repo>.json` (#10): `{ v: 1, owner, pending, watch }`, written whole */
function readShared(cx) {
  const file = sharedPath(cx)
  let j
  try { j = JSON.parse(readFileSync(file, 'utf8')) } catch (err) {
    if (err.code === 'ENOENT') return { v: 1, owner: null, pending: null, watch: [] }
    stop(`${file} cannot be read (${err.message}): it names who owns ${cx.repo} - mend it by hand, never delete it`)
  }
  if (j?.v !== 1 || !Array.isArray(j.watch ?? [])) stop(`${file} is not a v1 record: mend it by hand`)
  return { v: 1, owner: j.owner ?? null, pending: j.pending ?? null, watch: j.watch ?? [] }
}
const saveShared = (cx) => writeJson(sharedPath(cx), cx.shared)

function readState(cx) {
  if (!existsSync(statePath(cx))) return null
  let s
  try { s = JSON.parse(readFileSync(statePath(cx), 'utf8')) } catch (err) { stop(`${statePath(cx)} cannot be read (${err.message})`) }
  if (s?.v !== 1 || s.version !== cx.version) stop(`${statePath(cx)} is not a v1 state of ${cx.version}`)
  return s
}
const saveState = (cx) => writeJson(statePath(cx), cx.state)
const did = (cx, step) => !!cx.state?.steps[step]
/** A step recorded, with whatever else the same write carries (`fn` changes the state first) */
function mark(cx, step, data = {}, fn) {
  fn?.(cx.state)
  cx.state.steps[step] = { at: now(cx), ...data }
  saveState(cx)
  cx.say(`${step}: done`)
}
/** Write-ahead (#10): `pending` names the side effect, its input and output, before it happens */
function ahead(cx, pending) {
  cx.state.pending = { ...pending, at: now(cx) }
  saveState(cx)
}
function settle(cx, fn) {
  fn?.(cx.state)
  delete cx.state.pending
  saveState(cx)
}

/** The releases GitHub has for a tag, drafts included (#10: every GitHub step reads it first) */
async function releasesFor(cx, version = cx.version) {
  try { return (await cx.p.github.releases(cx.repo)).filter((r) => r.tag_name === `v${version}`) } catch (err) {
    if (err instanceof Unreadable) stop(`GitHub cannot be read (${err.message}): nothing is decided without it - run again`)
    throw err
  }
}
async function readRelease(cx, id) {
  try { return await cx.p.github.release(cx.repo, id) } catch (err) {
    if (err instanceof Unreadable) stop(`GitHub cannot be read (${err.message}): run again`)
    throw err
  }
}

async function main(cx) {
  cx.root = cx.p.git.root(cx.app)
  cx.appRel = relative(cx.root, cx.app)
  cx.shared = readShared(cx)
  cx.state = readState(cx)
  if (cx.state && cx.state.test !== cx.test) stop(`${relative(cx.app, cx.dir)} is a ${cx.state.test ? '--test' : 'production'} release: run it ${cx.state.test ? 'with' : 'without'} --test`)
  await startup(cx)
  switch (cx.command) {
    case 'abandon': return abandon(cx)
    case 'withdraw': return withdrawCommand(cx)
    case 'settle-published': return settlePublished(cx)
    case 'republish': return republish(cx)
    case 'settle-unpublished': return settleUnpublished(cx)
    case 'clear-owner': return clearOwner(cx)
  }
  if (!cx.state) {
    if (cx.command !== 'prepare') stop(`there is no release state for ${cx.version} in ${relative(cx.root, cx.dir)}: a release starts with ${cmd(cx)}`)
    mkdirSync(join(cx.dir, 'logs'), { recursive: true })
    cx.state = { v: 1, version: cx.version, test: cx.test, source: null, steps: {}, notary: { app: [], dmg: [] }, files: {} }
    saveState(cx)
    cx.created = true
  }
  if (cx.state.steps.abandoning) stop(`${cx.version} is being abandoned: ${cmd(cx, '--abandon')} finishes it`)
  if (cx.state.steps.final) return finished(cx)
  const o = cx.shared.owner
  if (!o && did(cx, 'preflight')) {
    stop(`this state is not ${cx.repo}'s owner any more (the shared record names none) and never ended: nothing touches its draft - ${cmd(cx, '--abandon')} ends it`)
  }
  await reconcilePending(cx)
  if (await githubFirst(cx)) return afterPublish(cx)
  checkBeforePublish(cx)
  if (cx.command === 'accept') return accept(cx)
  if (cx.command === 'publish') { await publish(cx); return afterPublish(cx) }
  return prepare(cx)
}

// ---- startup: the shared record (#10 "At startup", r6 #2, #3; r7) ---------------------------------------------------

async function startup(cx) {
  const sh = cx.shared
  // an owner with a final status is cleared
  if (sh.owner?.final) {
    cx.say(`the last owner, ${sh.owner.version}, ended ${sh.owner.final}: the repository is free`)
    sh.owner = null
    saveShared(cx)
  }
  // a publish in flight is observed, never replayed
  if (sh.pending) await observeSharedPending(cx)
  // the watched releases (settled unpublished)
  // a republication is reconciled as its own run's publish only while that run's release owns the repository, its
  // folder there (code review r2 #2): otherwise nothing tells it from the original request landing late
  const active = (v) => sh.owner?.version === v && existsSync(join(sh.owner.state, 'state.json'))
  for (const w of [...sh.watch]) {
    const rel = await readRelease(cx, w.releaseId)
    if (!rel) {
      sh.watch = sh.watch.filter((x) => x !== w)
      saveShared(cx)
      cx.say(`watch: ${w.version}'s release ${w.releaseId} is gone from GitHub: dropped`)
      continue
    }
    if (rel.draft) continue
    if (w.republishing && active(w.version)) {
      // its own run's republication, reconciled before any alarm (r7)
      sh.watch = sh.watch.filter((x) => x !== w)
      saveShared(cx)
      cx.say(`watch: ${w.version} was republished and GitHub shows it published: its entry is retired`)
      continue
    }
    // --withdraw goes past every alarm, its own and the others' (each entry kept for its own --withdraw): two late
    // publications would otherwise stop each other's way out (code review r2 #3)
    if (cx.command === 'withdraw') continue
    stop(`${w.version} was settled unpublished (--settle-unpublished) and GitHub now shows it published (${rel.html_url}): a publish request landed late. ${cmd(cx, '--withdraw', w.version)} ends it`)
  }
  // the owner
  const o = sh.owner
  if (!o) return
  if (!existsSync(join(o.state, 'state.json'))) {
    // a lost owner folder (r6 #3): read by GitHub's identity alone, and name the one way out
    if (o.version === cx.version && ['withdraw', 'clear-owner', 'settle-unpublished', 'settle-published'].includes(cx.command)) return
    let rels
    try { rels = (await cx.p.github.releases(cx.repo)).filter((r) => r.tag_name === `v${o.version}`) } catch (err) {
      if (!(err instanceof Unreadable)) throw err
      stop(`${cx.repo} is owned by ${o.version}, whose folder ${o.state} is missing, and GitHub cannot be read: the repository stays reserved - run again once GitHub answers`)
    }
    const lead = `${cx.repo} is owned by ${o.version}, whose folder ${o.state} is missing (no final status)`
    if (rels.some((r) => !r.draft)) stop(`${lead}, and GitHub shows v${o.version} published: ${cmd(cx, '--withdraw', o.version)} ends it from GitHub's identity alone`)
    stop(`${lead}, and v${o.version} is ${rels.length ? 'a draft' : 'not on GitHub'} with no publish sent: ${cmd(cx, '--clear-owner', o.version)} frees the repository`)
  }
  if (o.version === cx.version && resolve(o.state) === resolve(cx.dir)) return
  // withdrawing another, published release never touches the owner's draft; the lock serialises the two
  if (cx.command === 'withdraw' && o.version !== cx.version) return
  stop(`${cx.repo} is owned by ${o.version}'s release in ${o.state}: one release at a time - resume or end it there (nothing here touched)`)
}

/** The shared `pending` (r4 #2; r5 #1): published, recorded; a draft or unreadable, the run stops and names the choices */
async function observeSharedPending(cx) {
  const p = cx.shared.pending
  let rel, unreadable = false
  try { rel = await cx.p.github.release(cx.repo, p.releaseId) } catch (err) { if (!(err instanceof Unreadable)) throw err; unreadable = true }
  if (!unreadable && rel && !rel.draft) {
    cx.shared.pending = null
    const o = cx.shared.owner
    if (o?.version === p.version && existsSync(join(o.state, 'state.json'))) cx.shared.watch = cx.shared.watch.filter((w) => !(w.version === p.version && w.republishing))
    saveShared(cx)
    cx.say(`the publish request of ${p.version} landed: GitHub shows it published`)
    // into this state only when it is the owner's: another checkout's state of the same version is never touched
    if (cx.state && p.version === cx.version && !cx.state.steps.publish && resolve(cx.shared.owner?.state ?? '') === resolve(cx.dir)) recordPublished(cx, rel)
    return
  }
  if (!unreadable && !rel) {
    // GitHub answers 404 for the release: deleted by hand, no request can ever publish it
    cx.shared.pending = null
    saveShared(cx)
    cx.say(`the publish request of ${p.version} named release ${p.releaseId}, which GitHub no longer has: retired`)
    return
  }
  if (p.version === cx.version && ['settle-published', 'republish', 'settle-unpublished'].includes(cx.command)) return
  stop(choices(cx, p, unreadable ? 'GitHub cannot be read' : 'GitHub still shows a draft'))
}

/** The operator's choices for a publish that is not settled (#11, r5 #1, r6 #2) */
function choices(cx, p, seen) {
  const lost = !existsSync(join(cx.shared.owner?.state ?? cx.dir, 'state.json'))
  return [
    `the publish request of ${p.version} (release ${p.releaseId}, sent ${iso(p.at)}) is not settled: ${seen}. Nothing is replayed.`,
    `Look at https://github.com/${cx.repo}/releases, then run one of:`,
    `  ${cmd(cx, '--settle-published', p.version)}     once GitHub shows it published`,
    ...(lost ? [] : [`  ${cmd(cx, '--republish', p.version)}            from ${iso(p.at + T.publishWaitMs)}: every gate again, then the one request`]),
    `  ${cmd(cx, '--settle-unpublished', p.version)}   from ${iso(p.at + T.settleUnpublishedMs)}, the draft unchanged: the request declared failed${lost ? ', then --clear-owner' : ', then --republish or --abandon'}`,
  ].join('\n')
}

// ---- reconciling this state's own pending (#10) ----------------------------------------------------------------------

async function reconcilePending(cx) {
  const p = cx.state.pending
  if (!p) return
  switch (p.what) {
    case 'notary-submit': {
      // JSON output holds the id back until notarytool ends: the submission is found by its unique name (#7)
      let history
      try { history = await cx.p.notary.history() } catch (err) { if (err instanceof Unreadable) stop(`a ${p.kind} submission is pending and notarytool history cannot be read (${err.message}): run again`); throw err }
      const found = submissionsOf(history, p.input, p.at)
      settle(cx, (s) => { for (const f of found) if (!s.notary[p.kind].includes(f.id)) s.notary[p.kind].push(f.id) })
      cx.say(found.length ? `notary: ${p.input} found in history${found.length > 1 ? ` ${found.length} times (duplicate: the same bytes; the first Accepted serves)` : ''}: ${found.map((f) => f.id).join(', ')}`
        : `notary: ${p.input} is not in history: Apple has nothing, it is submitted again`)
      return
    }
    case 'sign': case 'staple': {
      // its output, unrecorded, is deleted and made again from its input, unchanged by construction (r2 #3)
      rmSync(at(cx, p.output), { recursive: true, force: true })
      if (p.output === FILES.stapled) rmSync(at(cx, 'stapled'), { recursive: true, force: true })
      settle(cx)
      cx.say(`${p.step}: the unrecorded ${p.output} is deleted and made again from ${p.input}`)
      return
    }
    case 'draft': {
      const rels = await releasesFor(cx)
      const drafts = rels.filter((r) => r.draft)
      if (drafts.length > 1) stop(`v${cx.version} has ${drafts.length} drafts on GitHub (${drafts.map((d) => d.id).join(', ')}): a release adopts one, never a second - delete the extra by hand, then run again`)
      if (drafts.length === 1) {
        settle(cx, (s) => { s.release = { id: drafts[0].id, url: drafts[0].html_url, tagTarget: drafts[0].target_commitish ?? p.tagTarget } })
        cx.say(`draft: release ${drafts[0].id} found on GitHub, adopted`)
      } else settle(cx)
      return
    }
    case 'upload': case 'delete': settle(cx); return   // the upload step reconciles every asset by its digest
    // a withdrawal under way is finished by --withdraw alone (it reads the flag again): never checked public meanwhile
    case 'withdraw': stop(`a withdrawal of v${cx.version} is under way: ${cmd(cx, '--withdraw')} finishes it`)
    case 'publish': return reconcilePublish(cx)
    default: stop(`an unknown pending ${JSON.stringify(p)} in ${statePath(cx)}`)
  }
}

/** This state's own publish request (#10): only observed */
async function reconcilePublish(cx) {
  const p = cx.state.pending
  let rel, unreadable = false
  try { rel = await cx.p.github.release(cx.repo, p.releaseId) } catch (err) { if (!(err instanceof Unreadable)) throw err; unreadable = true }
  if (rel && !rel.draft) { recordPublished(cx, rel); return }
  if (cx.shared.pending?.version === cx.version) stop(choices(cx, cx.shared.pending, unreadable ? 'GitHub cannot be read' : 'GitHub still shows a draft'))
  if (cx.shared.watch.some((w) => w.version === cx.version && w.releaseId === p.releaseId)) {
    settle(cx, (s) => { s.steps['settled-unpublished'] ??= { at: now(cx), releaseId: p.releaseId } })
    cx.say('publish: settled unpublished (the release is watched): --republish or --abandon')
    return
  }
  if (unreadable) stop('a publish is pending and GitHub cannot be read: run again')
  // the shared record is written before the request goes out: with none, this run died in between, and nothing was sent
  settle(cx)
  cx.say('publish: the request was never sent (the shared record holds no pending for it): cleared')
}

/** GitHub read first (#10): published, the publish is recorded and the run goes to check-public, whatever the state said */
async function githubFirst(cx) {
  if (!did(cx, 'preflight')) return false
  const rels = await releasesFor(cx)
  const pub = rels.filter((r) => !r.draft)
  if (!pub.length) {
    if (did(cx, 'publish')) stop(`the state says v${cx.version} was published, and GitHub shows no published release for it: look at https://github.com/${cx.repo}/releases`)
    return false
  }
  if (pub.length > 1 || !cx.state.release || pub[0].id !== cx.state.release.id) {
    stop(`v${cx.version} is published on GitHub as ${pub.map((r) => r.id).join(', ')}, not this state's draft ${cx.state.release?.id ?? '(none made)'}: someone else published it - nothing here touches it`)
  }
  if (!did(cx, 'publish')) recordPublished(cx, pub[0])
  return true
}

/** GitHub shows this release published: the publish recorded, both pendings cleared, a republication's watch retired */
function recordPublished(cx, rel) {
  if (cx.state.pending?.what === 'publish') delete cx.state.pending
  cx.state.steps.publish ??= { at: now(cx), id: rel.id, publishedAt: rel.published_at ?? null, immutable: rel.immutable ?? null }
  saveState(cx)
  const before = JSON.stringify(cx.shared)
  if (cx.shared.pending?.version === cx.version) cx.shared.pending = null
  cx.shared.watch = cx.shared.watch.filter((w) => !(w.version === cx.version && w.republishing))
  if (JSON.stringify(cx.shared) !== before) saveShared(cx)
  cx.say(`publish: GitHub shows ${cx.tag} published (${rel.html_url})`)
}

/** Until the publish (#10, r3 #3): HEAD the frozen SHA, a clean tree, every recorded file hashed again */
function checkBeforePublish(cx) {
  if (!cx.state.source) return
  const head = cx.p.git.head(cx.root)
  if (head !== cx.state.source.sha) stop(`HEAD is ${head.slice(0, 12)}, and this release froze ${cx.state.source.sha.slice(0, 12)}: a release is never rebuilt under its state - check out ${cx.state.source.sha} or ${cmd(cx, '--abandon')}`)
  const dirty = cx.p.git.dirty(cx.root)
  if (dirty.length) stop(`the tree is not clean (${dirty.slice(0, 4).join(', ')}${dirty.length > 4 ? ', ...' : ''}): until the publish, a release reads only its frozen commit`)
  checkFiles(cx, Object.keys(cx.state.files))
}
function checkFiles(cx, names) {
  const bad = []
  for (const name of names) {
    const want = cx.state.files[name]
    if (!existsSync(at(cx, name))) { bad.push(`${name} is missing`); continue }
    const got = hashOf(at(cx, name))
    if (got.sha256 !== want.sha256 || got.bytes !== want.bytes) bad.push(`${name} changed (sha256 ${got.sha256.slice(0, 12)}, recorded ${want.sha256.slice(0, 12)})`)
  }
  if (bad.length) stop(`a recorded file is not as recorded - no recorded file is ever changed (#10): ${bad.join('; ')}. ${cmd(cx, '--abandon')} ends this release`)
}

function finished(cx) {
  const f = cx.state.steps.final
  // a crash between the state's final and the shared one left the owner unfinished: finished here (code review r2 #1)
  finishOwner(cx, f.status)
  cx.say(`ended ${f.status} at ${iso(f.at)}${existsSync(join(cx.app, 'releases', `${cx.version}.json`)) ? `; its record is app/releases/${cx.version}.json` : ''}: nothing to do`)
}

// ---- prepare: steps 0-11 ---------------------------------------------------------------------------------------------

async function prepare(cx) {
  if (!did(cx, 'preflight')) await preflight(cx)
  if (!did(cx, 'freeze')) freeze(cx)
  if (!did(cx, 'build')) await build(cx)
  if (!did(cx, 'notarize-app')) await notarizeApp(cx)
  if (!did(cx, 'staple-app')) stapleApp(cx)
  if (!did(cx, 'zip')) zip(cx)
  if (!did(cx, 'dmg')) await dmg(cx)
  if (!did(cx, 'verify')) verify(cx)
  if (!did(cx, 'feed')) feed(cx)
  if (!did(cx, 'draft')) await draft(cx)
  if (did(cx, 'check-draft')) {
    // a draft found changed since (an asset replaced or added by hand) is repaired: the same bytes again
    const rel = await ownDraft(cx)
    if (!exactlyKept(reconcileAssets(expectedAssets(cx), rel.assets))) {
      cx.say('the draft no longer holds exactly the three recorded assets: repairing it')
      delete cx.state.steps.upload
      delete cx.state.steps['check-draft']
      saveState(cx)
    }
  }
  if (!did(cx, 'upload')) await upload(cx)
  if (!did(cx, 'check-draft')) await checkDraft(cx)
  awaiting(cx)
}

/** 0: refusals only; nothing is written outside the state folder, then the repository is claimed (#10, #11) */
async function preflight(cx) {
  const { git, github, notary, npm } = cx.p
  const bad = []
  const dirty = git.dirty(cx.root)
  if (dirty.length) bad.push(`the tree is not clean: ${dirty.slice(0, 4).join(', ')}${dirty.length > 4 ? ', ...' : ''}`)
  const branch = git.branch(cx.root)
  if (!branch) bad.push('HEAD is detached: a release is made from a branch')
  else if (!cx.test && branch !== 'main') bad.push(`on ${branch}: a production release is made from marver's main (any branch with --test)`)
  else { const p = git.pushed(cx.root, branch); if (!p.ok) bad.push(`the commit is not pushed: ${p.why}`) }
  const head = git.head(cx.root)
  // the versions (#5), from the commit
  let pkgVersion = null
  try { pkgVersion = JSON.parse(git.show(cx.root, 'HEAD', `${cx.appRel}/package.json`) ?? 'null')?.version ?? null } catch { /* reported below */ }
  if (pkgVersion !== cx.version) bad.push(`app/package.json's version is ${pkgVersion}, not ${cx.version} (one version everywhere, #5)`)
  if (cx.test && !isCandidate(cx.version)) bad.push(`a --test release is a 0.9x candidate (0.90.0-0.99.x), not ${cx.version}`)
  if (!cx.test && isCandidate(cx.version)) bad.push(`${cx.version} is a candidate's number: the production repository sees only real versions (--test for a candidate)`)
  const section = changelogSection(git.show(cx.root, 'HEAD', `${cx.appRel}/CHANGELOG.md`), cx.version)
  let companions = []
  if (section.error) bad.push(`${section.error}, dated and committed before this run (## ${cx.version} - YYYY-MM-DD)`)
  else {
    companions = companionVersions(section.text)
    if (!companions.length) bad.push(`the ${cx.version} section names no companion marver version (written "marver X.Y.Z", A5.1 #2)`)
  }
  const dr = (git.show(cx.root, 'HEAD', `${cx.appRel}/build/designated-requirement.txt`) ?? '').trim()
  if (!dr.includes(`identifier "${BUNDLE_ID}"`) || !dr.includes('anchor apple generic')) bad.push('app/build/designated-requirement.txt is missing or not the Developer ID form (#8)')
  // GitHub
  let floor = null
  try {
    const [all, tags] = [await github.releases(cx.repo), await github.tags(cx.repo)]
    const mine = all.filter((r) => r.tag_name === cx.tag && !(r.draft && r.id === cx.state.release?.id))
    if (mine.length) bad.push(`${cx.repo} already has ${mine.map((r) => (r.draft ? `a draft ${r.id}` : `a published release ${r.id}`)).join(' and ')} for ${cx.tag}`)
    if (tags.some((t) => t.name === cx.tag)) bad.push(`${cx.repo} already has the tag ${cx.tag}`)
    floor = versionFloor({ tags, releases: all })
    if (floor && cmpVersion(cx.version, floor) <= 0) bad.push(`${cx.version} is not above the version floor ${floor}, the highest version ${cx.repo} has ever made public (tags and published releases, withdrawn ones included; #5)`)
    if (!(await github.canWrite(cx.repo))) bad.push(`gh cannot write ${cx.repo}`)
    if (!(await github.immutable(cx.repo))) bad.push(`release immutability is off on ${cx.repo} (#10): turn it on in the repository's settings`)
  } catch (err) { if (!(err instanceof Unreadable)) throw err; bad.push(`GitHub: ${err.message}`) }
  try { await notary.history() } catch (err) { if (!(err instanceof Unreadable)) throw err; bad.push(`notarytool history --keychain-profile ${NOTARY_PROFILE} does not answer: ${err.message}`) }
  for (const c of companions) {
    try { if (!(await npm.published(c))) bad.push(`the companion marver ${c} is not published on npm`) } catch (err) { if (!(err instanceof Unreadable)) throw err; bad.push(`npm: ${err.message}`) }
  }
  if (bad.length) {
    if (cx.created) rmSync(cx.dir, { recursive: true, force: true })
    stop(`preflight refuses ${cx.version}:\n  - ${bad.join('\n  - ')}`)
  }
  // the repository is this release's from here (#10)
  if (!cx.shared.owner) { cx.shared.owner = { version: cx.version, state: cx.dir, at: now(cx) }; saveShared(cx) }
  mark(cx, 'preflight', { head, branch, floor, companions })
}

/** 1: what the release is made of, read from the commit */
function freeze(cx) {
  const head = cx.p.git.head(cx.root)
  const pre = cx.state.steps.preflight
  if (head !== pre.head || cx.p.git.dirty(cx.root).length) stop(`the checkout moved after preflight (HEAD ${head.slice(0, 12)}, preflight read ${pre.head.slice(0, 12)}): check out ${pre.head} on a clean tree, or ${cmd(cx, '--abandon')}`)
  const section = changelogSection(cx.p.git.show(cx.root, 'HEAD', `${cx.appRel}/CHANGELOG.md`), cx.version)
  const dr = cx.p.git.show(cx.root, 'HEAD', `${cx.appRel}/build/designated-requirement.txt`).trim()
  const companions = companionVersions(section.text)
  mark(cx, 'freeze', {
    version: cx.version, repo: cx.repo, feed: cx.feed, dr, companion: companions.at(-1),
    notes: { heading: section.heading, date: section.date, text: section.text, sha256: sha256(section.text) },
  }, (s) => { s.source = { sha: head, branch: pre.branch } })
}

/** 2: #3's build, redone from scratch until recorded (nothing outside has seen its bytes) */
async function build(cx) {
  rmSync(at(cx, FILES.app), { recursive: true, force: true })
  rmSync(at(cx, 'build.json'), { force: true })
  for (const f of readdirSync(cx.dir)) if (/^smoke-\d+\.json$/.test(f)) rmSync(at(cx, f))
  const waive = cx.test ? CANDIDATE_WAIVERS : []
  const o = { adhoc: false, smoke: true, tamper: false, knownFail: [...waive], feed: cx.feed, into: cx.dir }
  cx.say(`build: Developer ID signed, the ${feedKind(cx.feed)} feed baked in, the smoke whole (no --adhoc, no --no-smoke, ${waive.length ? `a candidate: only ${waive.join(', ')} may fail, at a measured number` : 'no known failure'})`)
  try { await cx.p.build(o) } catch (err) {
    if (err instanceof BuildFailure) stop(`the build failed: ${err.message} - a smoke check that fails stops the release, and its numbers go to Nic`)
    throw err
  }
  let b = null
  try { b = JSON.parse(readFileSync(at(cx, 'build.json'), 'utf8')) } catch { /* below */ }
  const bad = []
  if (!b) bad.push('no build.json')
  else {
    if (b.version !== cx.version) bad.push(`version ${b.version}`)
    if (b.feed !== feedKind(cx.feed)) bad.push(`feed ${b.feed}`)
    if (b.adhoc !== false) bad.push('ad-hoc')
    if (b.smoke !== 'default') bad.push(`smoke ${b.smoke}`)
    const known = (b.knownFailures ?? []).map((k) => k.name)
    const beyond = known.filter((n) => !waive.includes(n))
    if (beyond.length) bad.push(`known failures ${beyond.join(', ')}`)
  }
  if (!existsSync(join(at(cx, FILES.app), 'Contents', 'Info.plist'))) bad.push(`no ${FILES.app}`)
  if (bad.length) stop(`the build is not a release's: ${bad.join('; ')}`)
  mark(cx, 'build', { smokeReport: b.smokeReport ?? null, electron: b.electron ?? null, team: b.team ?? null, knownFailures: b.knownFailures ?? [] })
}

/** 3: the built app hashed, then zipped under a name no other submission has and submitted (#7) */
async function notarizeApp(cx) {
  if (!did(cx, 'app-hashed')) {
    const h = hashOf(at(cx, FILES.app))
    mark(cx, 'app-hashed', { sha256: h.sha256 }, (s) => { s.files[FILES.app] = h })
  }
  if (!did(cx, 'app-zipped')) {
    const tmp = at(cx, 'notary-app.zip.tmp')
    rmSync(tmp, { force: true })
    cx.p.ditto.zip(at(cx, FILES.app), tmp)
    const h = hashOf(tmp)
    const name = notaryAppName(cx.version, h.sha256)
    renameSync(tmp, at(cx, name))
    mark(cx, 'app-zipped', { name }, (s) => { s.files[name] = h })
  }
  const id = await notarize(cx, 'app', cx.state.steps['app-zipped'].name)
  mark(cx, 'notarize-app', { id })
}

/**
 * A notarisation (#7): submitted once, written ahead; then each recorded id waited on in turn, going on at the first
 * Accepted (a ticket belongs to the code's hash, not to a submission). All Invalid or Rejected: the release stops with
 * the issues. A timeout keeps the ids: the next run waits on them.
 */
async function notarize(cx, kind, name) {
  if (!cx.state.notary[kind].length) {
    ahead(cx, { step: `notarize-${kind}`, what: 'notary-submit', kind, input: name })
    const { id } = await cx.p.notary.submit(at(cx, name))
    settle(cx, (s) => { s.notary[kind].push(id) })
    cx.say(`notary: ${name} submitted, ${id}`)
  }
  const seen = []
  for (const id of cx.state.notary[kind]) {
    const r = await cx.p.notary.wait(id)
    seen.push({ id, status: r.status, message: r.message })
    if (['Accepted', 'Invalid', 'Rejected'].includes(r.status)) {
      const log = at(cx, `logs/notary-${id}.json`)
      if (!existsSync(log)) { try { await cx.p.notary.log(id, log) } catch (err) { if (!(err instanceof Stop)) throw err; cx.say(`notary: no log for ${id}: ${err.message}`) } }
    }
    if (notaryOutcome(seen).accepted) { cx.say(`notary: ${id} Accepted`); return id }
  }
  if (notaryOutcome(seen).failed) {
    const issues = seen.map((x) => { try { return `${x.id}: ${JSON.stringify(JSON.parse(readFileSync(at(cx, `logs/notary-${x.id}.json`), 'utf8')).issues ?? []).slice(0, 2000)}` } catch { return `${x.id}: ${x.status} (no log)` } })
    stop(`Apple did not accept ${name} (${seen.map((x) => `${x.id} ${x.status}`).join(', ')}): the issues, from notarytool log:\n${issues.join('\n')}\nA new build happens only after ${cmd(cx, '--abandon')}`)
  }
  stop(`notary: ${name} is not finished (${seen.map((x) => `${x.id} ${x.status ?? x.message}`).join(', ')}): run again to keep waiting - the ids are kept and nothing is submitted again`)
}

/** Every check #8 and #11 make of an app: signatures, the DR, the staple, spctl; `full` adds Info.plist and lipo */
function checkApp(cx, app, label, { full = false } = {}) {
  const dr = cx.state.steps.freeze.dr
  const bad = []
  const v = cx.p.codesign.verify(app)
  if (!v.ok) bad.push(`codesign --verify --deep --strict: ${v.out}`)
  const r = cx.p.codesign.verifyDR(app, dr)
  if (!r.ok) bad.push(`it does not satisfy the designated requirement (codesign -R "=<DR>"): ${r.out}`)
  const own = cx.p.codesign.dr(app)
  if (own !== dr) bad.push(`its own DR is ${JSON.stringify(own)}, not app/build/designated-requirement.txt's`)
  const s = cx.p.stapler.validate(app)
  if (!s.ok) bad.push(`stapler validate: ${s.out}`)
  const g = cx.p.spctl.app(app)
  if (!g.ok) bad.push(`spctl -a -vv does not say Notarized Developer ID: ${g.out}`)
  if (full) {
    const p = cx.p.plist.read(join(app, 'Contents', 'Info.plist'))
    bad.push(...versionAgreement(cx.version, { plist: p }))
    if (p.CFBundleIdentifier !== BUNDLE_ID) bad.push(`CFBundleIdentifier is ${p.CFBundleIdentifier}`)
    if (p.LSMinimumSystemVersion !== MIN_MACOS) bad.push(`LSMinimumSystemVersion is ${p.LSMinimumSystemVersion}, not ${MIN_MACOS}`)
    if (p.ElectronSquirrelPreventDowngrades !== true) bad.push(`ElectronSquirrelPreventDowngrades is ${p.ElectronSquirrelPreventDowngrades}, not true`)
    const archs = cx.p.lipo.archs(join(app, 'Contents', 'MacOS', PRODUCT))
    if (archs !== 'arm64') bad.push(`lipo -archs says ${JSON.stringify(archs)}, not arm64 alone`)
  }
  if (bad.length) stop(`${label} fails its checks: ${bad.join('; ')}`)
}

/** 4: a copy of the built app, stapled and checked; the built app itself is never changed (r2 #3) */
function stapleApp(cx) {
  ahead(cx, { step: 'staple-app', what: 'staple', input: FILES.app, output: FILES.stapled })
  rmSync(at(cx, 'stapled'), { recursive: true, force: true })
  mkdirSync(at(cx, 'stapled'))
  cx.p.ditto.copy(at(cx, FILES.app), at(cx, FILES.stapled), { preserve: true })
  cx.p.stapler.staple(at(cx, FILES.stapled))
  checkApp(cx, at(cx, FILES.stapled), 'the stapled app')
  const h = hashOf(at(cx, FILES.stapled))
  settle(cx, (s) => { s.files[FILES.stapled] = h; s.steps['staple-app'] = { at: now(cx), sha256: h.sha256 } })
  cx.say('staple-app: done')
}

/** 5: the update ZIP (#6): one top-level Marver.app, permissions and symlinks kept */
function zip(cx) {
  const name = cx.names.zip
  const tmp = at(cx, `${name}.tmp`)
  rmSync(tmp, { force: true })
  rmSync(at(cx, name), { force: true })
  cx.p.ditto.zip(at(cx, FILES.stapled), tmp, { sequester: true })
  renameSync(tmp, at(cx, name))
  const h = hashOf(at(cx, name))
  mark(cx, 'zip', { sha256: h.sha256 }, (s) => { s.files[name] = h })
}

/** 6: the DMG, in recorded substeps, each a new file from the one before; a file Apple has seen is never remade */
async function dmg(cx) {
  const v = cx.version
  if (!did(cx, 'dmg-built')) {
    const root = at(cx, 'dmg-root')
    rmSync(root, { recursive: true, force: true })
    rmSync(at(cx, FILES.dmgBuilt), { force: true })
    mkdirSync(root)
    cx.p.ditto.copy(at(cx, FILES.stapled), join(root, `${PRODUCT}.app`))
    symlinkSync('/Applications', join(root, 'Applications'))
    cx.p.hdiutil.create({ volname: `Marver ${v}`, src: root, out: at(cx, FILES.dmgBuilt) })
    rmSync(root, { recursive: true, force: true })
    const h = hashOf(at(cx, FILES.dmgBuilt))
    mark(cx, 'dmg-built', { sha256: h.sha256 }, (s) => { s.files[FILES.dmgBuilt] = h })
  }
  if (!did(cx, 'dmg-signed')) {
    ahead(cx, { step: 'dmg-signed', what: 'sign', input: FILES.dmgBuilt, output: FILES.dmgSigned })
    rmSync(at(cx, FILES.dmgSigned), { force: true })
    cx.p.clone(at(cx, FILES.dmgBuilt), at(cx, FILES.dmgSigned))
    cx.p.codesign.signDmg(at(cx, FILES.dmgSigned))
    const c = cx.p.codesign.verifyFile(at(cx, FILES.dmgSigned))
    if (!c.ok) stop(`the signed DMG does not verify: ${c.out}`)
    const h = hashOf(at(cx, FILES.dmgSigned))
    settle(cx, (s) => { s.files[FILES.dmgSigned] = h; s.steps['dmg-signed'] = { at: now(cx), sha256: h.sha256 } })
    cx.say('dmg-signed: done')
  }
  if (!did(cx, 'dmg-accepted')) {
    // submitted through a hard link of its own name: the same bytes, never changed (#7)
    const name = notaryDmgName(v, cx.state.files[FILES.dmgSigned].sha256)
    if (!existsSync(at(cx, name))) linkSync(at(cx, FILES.dmgSigned), at(cx, name))
    if (!cx.state.files[name]) { cx.state.files[name] = { ...cx.state.files[FILES.dmgSigned] }; saveState(cx) }
    const id = await notarize(cx, 'dmg', name)
    mark(cx, 'dmg-accepted', { id, name })
  }
  if (!did(cx, 'dmg-stapled')) {
    const out = cx.names.dmg
    ahead(cx, { step: 'dmg-stapled', what: 'staple', input: FILES.dmgSigned, output: out })
    rmSync(at(cx, out), { force: true })
    cx.p.clone(at(cx, FILES.dmgSigned), at(cx, out))
    cx.p.stapler.staple(at(cx, out))
    const s = cx.p.stapler.validate(at(cx, out))
    if (!s.ok) stop(`the stapled DMG does not validate: ${s.out}`)
    const g = cx.p.spctl.dmg(at(cx, out))
    if (!g.ok) stop(`spctl -t open does not accept the stapled DMG as Notarized Developer ID: ${g.out}`)
    const h = hashOf(at(cx, out))
    settle(cx, (st) => { st.files[out] = h; st.steps['dmg-stapled'] = { at: now(cx), sha256: h.sha256 } })
    cx.say('dmg-stapled: done')
  }
  mark(cx, 'dmg')
}

/** The DMG mounted read-only and out of Finder's sight for `fn`, then detached */
function mounted(cx, file, mnt, fn) {
  mkdirSync(mnt, { recursive: true })
  cx.p.hdiutil.attach(file, mnt)
  cx.mounts.push(mnt)
  try { return fn(mnt) } finally {
    cx.p.hdiutil.detach(mnt)
    cx.mounts.splice(cx.mounts.indexOf(mnt), 1)
  }
}

/** Step 7's checks on a ZIP and a DMG (the state's own, or check-draft's downloaded copies) */
function checkArtifacts(cx, zipFile, dmgFile, work, what) {
  const stapled = cx.state.files[FILES.stapled].sha256
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const x = join(work, 'zip')
  cx.p.ditto.unzip(zipFile, x)
  // (ditto's own __MACOSX, from --sequesterRsrc, is no entry of the app's)
  const top = readdirSync(x).filter((n) => !n.startsWith('.') && n !== '__MACOSX')
  if (top.length !== 1 || top[0] !== `${PRODUCT}.app`) stop(`${what}: the ZIP holds ${top.join(', ') || 'nothing'}, not one top-level ${PRODUCT}.app (#6)`)
  checkApp(cx, join(x, `${PRODUCT}.app`), `${what}: the app from the ZIP`, { full: true })
  if (treeHash(join(x, `${PRODUCT}.app`)).sha256 !== stapled) stop(`${what}: the app from the ZIP is not the stapled app (tree hash)`)
  mounted(cx, dmgFile, join(work, 'mnt'), (mnt) => {
    const shown = readdirSync(mnt).filter((n) => !n.startsWith('.')).sort()
    const link = shown.includes('Applications') && lstatSync(join(mnt, 'Applications')).isSymbolicLink() ? readlinkSync(join(mnt, 'Applications')) : null
    if (shown.join(',') !== `Applications,${PRODUCT}.app` || link !== '/Applications') stop(`${what}: the DMG shows ${shown.join(', ')}${link ? ` (Applications -> ${link})` : ''}, not ${PRODUCT}.app and the Applications link alone`)
    checkApp(cx, join(mnt, `${PRODUCT}.app`), `${what}: the app on the DMG`, { full: true })
    if (treeHash(join(mnt, `${PRODUCT}.app`)).sha256 !== stapled) stop(`${what}: the app on the DMG is not the stapled app (tree hash)`)
  })
  rmSync(work, { recursive: true, force: true })
}

/** 7: the ZIP extracted and the DMG mounted, each app checked as a client gets it */
function verify(cx) {
  checkArtifacts(cx, at(cx, cx.names.zip), at(cx, cx.names.dmg), at(cx, 'verify'), 'verify')
  mark(cx, 'verify')
}

/** 8: releases.json from the state, its version the bundle's (#8, #9); `pub_date` the freeze's time */
function feed(cx) {
  const p = cx.p.plist.read(join(at(cx, FILES.stapled), 'Contents', 'Info.plist'))
  const version = p.CFBundleShortVersionString
  if (version !== cx.version) stop(`the bundle says ${version}, not ${cx.version}`)
  const fr = cx.state.steps.freeze
  const text = feedText({ version, pubDate: iso(fr.at), notes: fr.notes.text, repo: cx.repo })
  const bad = versionAgreement(cx.version, { feed: JSON.parse(text), zipName: cx.names.zip, heading: fr.notes.heading, repo: cx.repo })
  if (bad.length) stop(`the versions do not agree (#5): ${bad.join('; ')}`)
  const tmp = at(cx, `${cx.names.feed}.tmp`)
  writeFileSync(tmp, text)
  renameSync(tmp, at(cx, cx.names.feed))
  const h = hashOf(at(cx, cx.names.feed))
  mark(cx, 'feed', { sha256: h.sha256 }, (s) => { s.files[cx.names.feed] = h })
}

/** The draft is this release's (#5, #10): its tag, title, target, body, a draft and no prerelease (code review r2 #7) */
function draftIdentity(cx, rel) {
  const bad = versionAgreement(cx.version, { release: rel })
  if (rel.target_commitish !== cx.state.release.tagTarget) bad.push(`its target is ${rel.target_commitish}, not ${cx.state.release.tagTarget}`)
  if (rel.body !== releaseBody({ notes: cx.state.steps.freeze.notes.text, sha: cx.state.source.sha })) bad.push('its body is not the CHANGELOG section and its footer')
  if (rel.prerelease !== false) bad.push('it is marked a prerelease')
  if (rel.draft !== true) bad.push('it is no longer a draft')
  return bad
}

const expectedAssets = (cx) => Object.fromEntries(assetList(cx.version).map((n) => [n, cx.state.files[n]]))

/** This state's draft, read again; gone or published, the run stops (githubFirst handles a publish) */
async function ownDraft(cx) {
  const rel = await readRelease(cx, cx.state.release.id)
  if (!rel) stop(`this state's draft ${cx.state.release.id} is gone from GitHub (deleted by hand?): ${cmd(cx, '--abandon')}, then a new version`)
  if (!rel.draft) stop(`release ${rel.id} is no longer a draft: run again (GitHub is read first)`)
  return rel
}

/** 9: one draft, adopted or made (#10), its tag to be made on the releases repo's main head at the publish */
async function draft(cx) {
  const drafts = (await releasesFor(cx)).filter((r) => r.draft)
  if (drafts.length > 1) stop(`v${cx.version} has ${drafts.length} drafts on GitHub (${drafts.map((d) => d.id).join(', ')}): a release adopts one, never a second - delete the extra by hand, then run again`)
  if (drafts.length === 1) {
    if (drafts[0].id !== cx.state.release?.id) stop(`a draft for v${cx.version} (${drafts[0].id}) is on GitHub that this state did not make: nothing here touches it`)
  } else {
    let target
    try { target = await cx.p.github.branchHead(cx.repo, 'main') } catch (err) { if (err instanceof Unreadable) stop(`GitHub cannot be read (${err.message}): run again`); throw err }
    ahead(cx, { step: 'draft', what: 'draft', tagTarget: target })
    const fr = cx.state.steps.freeze
    const d = await cx.p.github.createDraft(cx.repo, {
      tag_name: cx.tag, target_commitish: target, name: `Marver ${cx.version}`,
      body: releaseBody({ notes: fr.notes.text, sha: cx.state.source.sha }), draft: true, prerelease: false,
    })
    settle(cx, (s) => { s.release = { id: d.id, url: d.html_url, tagTarget: target } })
    cx.say(`draft: release ${d.id} made (${d.html_url})`)
  }
  mark(cx, 'draft', { id: cx.state.release.id })
}

/** 10: the assets reconciled, never blindly replaced (#10) */
async function upload(cx) {
  const rel = await ownDraft(cx)
  const want = expectedAssets(cx)
  const plan = reconcileAssets(want, rel.assets)
  const gone = [...plan.remove, ...plan.replace.flatMap((r) => r.ids.map((id) => ({ name: r.name, id })))]
  for (const a of gone) {
    ahead(cx, { step: 'upload', what: 'delete', name: a.name, assetId: a.id })
    await cx.p.github.deleteAsset(cx.repo, a.id)
    settle(cx)
    cx.say(`upload: deleted the draft's ${a.name} (${a.id})`)
  }
  for (const name of [...plan.upload, ...plan.replace.map((r) => r.name)]) {
    ahead(cx, { step: 'upload', what: 'upload', name })
    const a = await cx.p.github.uploadAsset(cx.repo, rel.id, name, at(cx, name))
    if (a.digest !== `sha256:${want[name].sha256}` || a.size !== want[name].bytes) stop(`GitHub's digest of the uploaded ${name} is ${a.digest} (${a.size} bytes), not ours: run again`)
    settle(cx)
    cx.say(`upload: ${name}, digest ours`)
  }
  mark(cx, 'upload', { kept: plan.keep, uploaded: [...plan.upload, ...plan.replace.map((r) => r.name)], deleted: gone.map((a) => a.name) })
}

/** 11: the draft downloaded back with authentication, checked as step 7, and private (#10) */
async function checkDraft(cx) {
  const rel = await ownDraft(cx)
  const bad = draftIdentity(cx, rel)
  const want = expectedAssets(cx)
  if (!exactlyKept(reconcileAssets(want, rel.assets))) bad.push(`its assets are ${rel.assets.map((a) => `${a.name} ${a.digest}`).join(', ')}`)
  if (bad.length) stop(`the draft ${rel.html_url} is not this release's: ${bad.join('; ')}`)
  const dir = at(cx, 'check-draft')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'assets'), { recursive: true })
  for (const a of rel.assets) {
    const f = join(dir, 'assets', a.name)
    await cx.p.github.downloadAsset(cx.repo, a.id, f)
    if (sha256File(f) !== want[a.name].sha256) stop(`${a.name} downloaded from the draft is not the recorded bytes`)
  }
  checkArtifacts(cx, join(dir, 'assets', cx.names.zip), join(dir, 'assets', cx.names.dmg), join(dir, 'x'), 'check-draft')
  // a draft is private: no anonymous request gets its files
  for (const a of rel.assets) {
    for (const url of [a.browser_download_url, assetUrl(cx.repo, cx.version, a.name)]) {
      const r = await cx.p.github.anonGet(url)
      if (r.status === 200) stop(`the draft's ${a.name} is served anonymously at ${url}`)
    }
  }
  rmSync(dir, { recursive: true, force: true })
  mark(cx, 'check-draft', { digests: Object.fromEntries(rel.assets.map((a) => [a.name, a.digest])) })
}

function awaiting(cx) {
  const f = cx.state.files
  const lines = [`awaiting-acceptance: the private draft ${cx.state.release.url} holds`, ...assetList(cx.version).map((n) => `  ${n.padEnd(34)} ${f[n].sha256}`)]
  if (cx.shared.watch.some((w) => w.version === cx.version)) lines.push(`settled unpublished and watched: next, ${cmd(cx, '--republish')} (every gate again, then the one request) or ${cmd(cx, '--abandon')}`)
  else if (cx.state.accepted) lines.push(`accepted by ${cx.state.accepted.by} at ${iso(cx.state.accepted.at)}: next, ${cmd(cx, '--publish')}`)
  else if (cx.test) lines.push(`a --test release needs no acceptance: next, ${cmd(cx, '--publish')}`)
  else lines.push('next: on the clean Mac, download the DMG from the draft, compare its sha256, run the acceptance list, then',
    `  ${cmd(cx, '--accept=<evidence.json>')}`, `  ${cmd(cx, '--publish')}`)
  cx.say(lines.join('\n'))
}

// ---- acceptance and the publish (#11, step 12) ---------------------------------------------------------------------

async function accept(cx) {
  if (!did(cx, 'check-draft')) stop(`nothing to accept yet: the draft is checked at awaiting-acceptance (${cmd(cx)} first)`)
  const file = resolve(cx.evidence)
  let ev
  try { ev = JSON.parse(readFileSync(file, 'utf8')) } catch (err) { stop(`the evidence ${file} cannot be read: ${err.message}`) }
  const rel = await ownDraft(cx)
  const digests = Object.fromEntries(rel.assets.map((a) => [a.name, a.digest]))
  const f = cx.state.files
  const v = judgeEvidence(ev, { version: cx.version, zip: f[cx.names.zip].sha256, dmg: f[cx.names.dmg].sha256, digests })
  if (!v.ok) stop(`the acceptance is refused:\n  - ${v.why.join('\n  - ')}`)
  copyFileSync(file, at(cx, 'acceptance.json'))
  cx.state.accepted = { by: cx.p.git.user(cx.root) ?? userInfo().username, at: now(cx), zip: ev.zip, dmg: ev.dmg, evidence: ev }
  saveState(cx)
  cx.say(`accepted (${requiredChecks(cx.version).length} checks pass on ${ev.mac}, macOS ${ev.macos}; Google ${ev.google}): next, ${cmd(cx, '--publish')}`)
}

/** Step 12's gates, fresh (#11; r1 #10; r2 #7): the acceptance, the hashes, immutability, the floor */
async function publishGates(cx, rel) {
  // the draft's identity again, just before the request: an edit by hand would publish these bytes under another
  // version, the feed naming URLs that never exist (code review r2 #7)
  const who = draftIdentity(cx, rel)
  if (who.length) stop(`the draft ${rel.html_url} is not this release's any more: ${who.join('; ')}. Nothing is published - mend it on GitHub, or ${cmd(cx, '--abandon')}`)
  const bad = []
  const want = expectedAssets(cx)
  if (!exactlyKept(reconcileAssets(want, rel.assets))) bad.push(`the draft does not hold exactly the three recorded assets (${cmd(cx, '--resume')} repairs it)`)
  const a = cx.state.accepted
  if (!a && !cx.test) bad.push(`no acceptance: a production release publishes only accepted bytes (${cmd(cx, '--accept=<evidence.json>')})`)
  if (a && (a.zip !== want[cx.names.zip].sha256 || a.dmg !== want[cx.names.dmg].sha256)) bad.push('the acceptance names other bytes than the state\'s')
  try {
    if (!(await cx.p.github.immutable(cx.repo))) bad.push(`release immutability is off on ${cx.repo}: the publish is never attempted (#10)`)
    const floor = versionFloor({ tags: await cx.p.github.tags(cx.repo), releases: await cx.p.github.releases(cx.repo) })
    if (floor && cmpVersion(cx.version, floor) <= 0) bad.push(`${cx.version} is not above the version floor ${floor} (#5): this draft can never ship - ${cmd(cx, '--abandon')}`)
  } catch (err) { if (!(err instanceof Unreadable)) throw err; bad.push(`GitHub: ${err.message}`) }
  if (bad.length) stop(`the publish is refused:\n  - ${bad.join('\n  - ')}`)
}

/** The one request (#10): `pending` written here and in the shared record, with the draft's updated_at, then sent */
async function sendPublish(cx, rel) {
  const t = now(cx)
  cx.state.pending = { step: 'publish', what: 'publish', releaseId: rel.id, updatedAt: rel.updated_at, at: t }
  saveState(cx)
  cx.shared.pending = { version: cx.version, releaseId: rel.id, at: t, updatedAt: rel.updated_at }
  saveShared(cx)
  cx.say(`publish: gh ${publishArgs(cx.repo, rel.id).slice(1).join(' ')}`)
  let out
  try { out = await cx.p.github.publish(cx.repo, rel.id) } catch (err) {
    if (err instanceof Stop) stop(`the publish request failed (${err.message}). It may still land: ${choices(cx, cx.shared.pending, 'no answer')}`)
    throw err
  }
  if (out?.draft !== false) stop(choices(cx, cx.shared.pending, 'GitHub answered with a draft'))
  recordPublished(cx, out)
}

async function publish(cx) {
  if (!did(cx, 'check-draft')) stop(`the draft is not checked yet: ${cmd(cx)} prepares it`)
  // settled unpublished, it is watched: only --republish marks the watch before its request, so the publish is told
  // from a late one (code review r2 #4)
  if (cx.shared.watch.some((w) => w.version === cx.version)) stop(`v${cx.version} was settled unpublished and is watched: ${cmd(cx, '--republish')} publishes it (or ${cmd(cx, '--abandon')})`)
  const rel = await ownDraft(cx)
  await publishGates(cx, rel)
  await sendPublish(cx, rel)
}

// ---- after the publish: check-public and the record (#11, steps 13 and 14) ------------------------------------------

async function afterPublish(cx) {
  if (cx.command === 'accept') stop(`v${cx.version} is published: an acceptance is recorded only before the publish`)
  if (cx.state.steps.withdrawn && !cx.state.steps.final) stop(`a withdrawal of v${cx.version} is under way: ${cmd(cx, '--withdraw')} finishes it`)
  // only the state and its recorded files: whatever HEAD is, the tree clean or not (r3 #3)
  checkFiles(cx, assetList(cx.version))
  if (cx.state.steps.final) return finished(cx)
  await checkPublic(cx)
}

/** Who owns `latest` at one read: the version the feed's redirect names, and whether its bytes are this release's */
async function latestRead(cx) {
  const r = await cx.p.github.anonLocation(`https://github.com/${cx.repo}/releases/latest/download/${cx.names.feed}`)
  const v = /\/releases\/download\/v(\d+\.\d+\.\d+)\//.exec(r.location ?? '')?.[1] ?? null
  if (v !== cx.version) return v
  const f = await cx.p.github.anonGet(r.location)
  return f.status === 200 && sha256(f.bytes) === cx.state.files[cx.names.feed].sha256 ? v : `${v} (other bytes)`
}

async function checkPublic(cx) {
  const { github, clock } = cx.p
  const files = cx.state.files
  const result = { at: now(cx), problems: [], latest: null }
  // a read that throws (a timeout, a reset) is a failed read, never the end of the step: every outcome is recorded
  // (code review r2 #6). Anything but the port's own Stop/Unreadable is a crash, as everywhere.
  const tryRead = async (what, fn) => {
    try { return { value: await fn() } } catch (err) { if (!(err instanceof Stop)) throw err; return { error: `${what} could not be read: ${err.message}` } }
  }
  // the release first: one that reads mutable is withdrawn whatever its downloads do (r1 #10, r2 #6)
  const read = await tryRead(`release ${cx.state.release.id}`, () => github.release(cx.repo, cx.state.release.id))
  const rel = read.value ?? null
  if (read.error) result.problems.push(read.error)
  else if (!rel) result.problems.push(`GitHub no longer has release ${cx.state.release.id}`)
  result.immutable = rel?.immutable ?? null
  if (rel && rel.immutable !== true) {
    // published mutable (r1 #10, r2 #6): withdrawn at once, its record written, the step failing
    const reason = 'it reads immutable: false after its publish, so nothing protects its assets from replacement (#10)'
    keepCheck(cx, { ...result, status: 'withdrawn', reason })
    await withdrawRelease(cx, rel, reason)
    stop(`v${cx.version} was published mutable: it is withdrawn (a prerelease; latest falls back) and its version is spent - the replacement is the next version, published once immutability is on`)
  }
  const tag = await tryRead(`the tag ${cx.tag}`, () => github.tagCommit(cx.repo, cx.tag))
  if (tag.error) result.problems.push(tag.error)
  else if (tag.value !== cx.state.release.tagTarget) result.problems.push(`the tag ${cx.tag} is on ${tag.value ?? 'nothing'}, not ${cx.state.release.tagTarget}`)
  // this release's artifacts, anonymously, by their versioned URLs; a refused or a failed read is read again
  for (const name of assetList(cx.version)) {
    let r = { status: 0 }
    let error = null
    for (let i = 0; i < T.versionedTries; i++) {
      const got = await tryRead(name, () => github.anonGet(assetUrl(cx.repo, cx.version, name)))
      r = got.value ?? { status: 0 }
      error = got.error ?? null
      if (r.status === 200) break
      await clock.sleep(T.versionedEveryMs)
    }
    const got = r.status === 200 ? sha256(r.bytes) : null
    if (got !== files[name].sha256) result.problems.push(error ?? `${name}: ${got ? `sha256 ${got}` : `HTTP ${r.status}`} anonymously, recorded ${files[name].sha256}`)
  }
  if (result.problems.length) {
    keepCheck(cx, { ...result, status: 'check-failed' })
    writeRecord(cx, 'check-failed')
    stop(`check-public: this release's artifacts do not check (${result.problems.join('; ')}): its record says check-failed; ${cmd(cx, '--resume')} checks again, and ${cmd(cx, '--withdraw')} ends a release that never will`)
  }
  // who owns `latest`: an owner counts only after 18 reads in a row agree (S3)
  const end = now(cx) + T.latestForMs
  let owner, run = 0, reads = 0, status = null
  for (;;) {
    const v = (await tryRead('latest', () => latestRead(cx))).value ?? 'unreadable'
    reads++
    if (v === owner) run++
    else { owner = v; run = 1 }
    if (run >= T.latestAgree && owner) {
      if (owner === cx.version) {
        const ours = await tryRead('the latest DMG', async () => {
          const d = await github.anonLocation(`https://github.com/${cx.repo}/releases/latest/download/${cx.names.dmg}`)
          const dv = /\/releases\/download\/v(\d+\.\d+\.\d+)\//.exec(d.location ?? '')?.[1]
          return dv === cx.version ? github.anonGet(d.location) : null
        })
        const bytes = ours.value
        if (bytes?.status === 200 && sha256(bytes.bytes) === files[cx.names.dmg].sha256) { status = 'published'; break }
        run = 0
      } else if (parseVersion(owner) && cmpVersion(owner, cx.version) > 0) { status = 'superseded'; break }
    }
    if (now(cx) >= end) break
    await clock.sleep(T.latestEveryMs)
  }
  result.latest = { owner: owner ?? null, agreeing: run, reads }
  status ??= 'check-failed'
  keepCheck(cx, { ...result, status })
  writeRecord(cx, status)
  if (status === 'check-failed') stop(`check-public: latest is ${owner ?? 'nothing'} after ${T.latestForMs / 60_000} min (${reads} reads): the record says check-failed; ${cmd(cx, '--resume')} checks again`)
  finalize(cx, status)
  cx.say(status === 'published' ? `published: latest serves ${cx.version}'s feed and DMG. Commit app/releases/${cx.version}.json ("release: app ${cx.version}")`
    : `superseded: a newer release, ${owner}, owns latest; this release's own artifacts check. Commit app/releases/${cx.version}.json`)
}

/** check-public's result: the last in the state, every one in logs/ (the evidence a withdrawal keeps) */
function keepCheck(cx, result) {
  cx.state.steps['check-public'] = result
  saveState(cx)
  mkdirSync(at(cx, 'logs'), { recursive: true })
  const n = readdirSync(at(cx, 'logs')).filter((f) => f.startsWith('check-public-')).length + 1
  writeJson(at(cx, `logs/check-public-${n}.json`), result)
}

/** A final status (#10): the state's, then the shared owner's, then the owner cleared */
function finalize(cx, status) {
  if (cx.state) { cx.state.steps.final = { at: now(cx), status }; saveState(cx) }
  finishOwner(cx, status)
}
/** The shared half of a final status, idempotent: `final` written into this version's owner, then the owner cleared */
function finishOwner(cx, status) {
  const o = cx.shared.owner
  if (o?.version !== cx.version) return
  if (o.final !== status) { o.final = status; saveShared(cx) }
  cx.shared.owner = null
  saveShared(cx)
}
/** This version's watch entries lose `republishing` when its release ends unpublished (code review r2 #2) */
function unmarkRepublishing(cx) {
  let changed = false
  for (const w of cx.shared.watch) if (w.version === cx.version && w.republishing) { delete w.republishing; changed = true }
  return changed
}

/** What a record cannot say when the state is lost (r6 #3): named, never made up */
const LOST = ['the acceptance', 'the recorded hashes', 'the notary ids', 'the source commit', 'the companion version', 'the designated requirement', 'the smoke report', 'the steps\' times']

/** 14: app/releases/X.Y.Z.json, written into this checkout by every run that reaches the publish (r2 #6) */
function writeRecord(cx, status, { reason = null, rel = null, tagTarget = null } = {}) {
  const s = cx.state
  const steps = s ? Object.fromEntries(Object.entries(s.steps).filter(([k]) => k !== 'check-public').map(([k, v]) => [k, iso(v.at)])) : null
  const record = {
    v: 1, version: cx.version, status,
    // a candidate accepts the mechanism on the test repo, never a release (#11, #43)
    kind: cx.test ? 'candidate' : 'production',
    repo: cx.repo, tag: cx.tag,
    ...(reason ? { reason } : {}),
    source: s?.source ?? null,
    companion: s?.steps.freeze?.companion ?? null,
    tagTarget: s?.release?.tagTarget ?? tagTarget,
    release: s?.release ? { id: s.release.id, url: s.release.url } : rel ? { id: rel.id, url: rel.html_url } : null,
    assets: s ? assetList(cx.version).map((name) => ({ name, bytes: s.files[name]?.bytes ?? null, sha256: s.files[name]?.sha256 ?? null }))
      : (rel?.assets ?? []).map((a) => ({ name: a.name, bytes: a.size, githubDigest: a.digest ?? null })),
    acceptance: s?.accepted ? { by: s.accepted.by, at: iso(s.accepted.at), evidence: s.accepted.evidence } : null,
    notary: s ? s.notary : null,
    dr: s?.steps.freeze?.dr ?? null,
    immutable: s?.steps['check-public']?.immutable ?? rel?.immutable ?? null,
    smokeReport: s?.steps.build?.smokeReport ?? null,
    knownFailures: s?.steps.build?.knownFailures ?? [],
    steps,
    check: s?.steps['check-public'] ?? null,
    ...(s ? {} : { unavailable: LOST }),
  }
  writeJson(join(cx.app, 'releases', `${cx.version}.json`), record)
  cx.say(`record: app/releases/${cx.version}.json, ${status}`)
}

// ---- the operator's commands (#11, r5-r7) ----------------------------------------------------------------------------

/** --withdraw: any published release that cannot pass verification ends as a prerelease (#11, #12; r5 #4; r6 #3) */
async function withdrawCommand(cx) {
  const rels = await releasesFor(cx)
  const pub = rels.filter((r) => !r.draft)
  if (!pub.length) stop(`v${cx.version} is not published on GitHub: --withdraw ends a published release${rels.length ? ` (a draft ends with ${cmd(cx, '--abandon')})` : ''}`)
  if (pub.length > 1) stop(`v${cx.version} has ${pub.length} published releases on GitHub: look at it by hand`)
  const rel = pub[0]
  if (cx.state?.release && cx.state.release.id !== rel.id) stop(`GitHub's v${cx.version} is release ${rel.id}, not this state's ${cx.state.release.id}: nothing here touches it`)
  if (cx.state && !cx.state.steps.publish) recordPublished(cx, rel)
  const w = cx.shared.watch.find((x) => x.version === cx.version)
  const last = cx.state?.steps['check-public']
  const reason = w ? 'it was published after it was settled unpublished: a late publish request (A5.1 #10, r6 #2)'
    : !cx.state ? 'its state folder is lost (A5.1 #10, r6 #3)'
      : last?.reason ? last.reason
        : last && last.status !== 'published' && last.status !== 'superseded' ? `its check-public does not pass: ${[...(last.problems ?? []), last.latest ? `latest is ${last.latest.owner}` : ''].filter(Boolean).join('; ')}`
        : 'withdrawn by the operator: a bad release (A5.1 #12)'
  await withdrawRelease(cx, rel, reason)
  cx.say(`withdrawn: ${cx.tag} is a prerelease, latest falls back to the release before; the version stays in the floor - the fix is a newer version (#12)`)
}

/** --withdraw's steps, in order, each picked up again by running it again (#11) */
async function withdrawRelease(cx, rel, reason) {
  if (!rel.prerelease) {
    if (cx.state) ahead(cx, { step: 'withdraw', what: 'withdraw', releaseId: rel.id })
    await cx.p.github.markPrerelease(cx.repo, rel.id)
  }
  let r = rel
  for (let i = 0; !r?.prerelease; i++) {
    if (i >= T.prereleaseTries) stop(`GitHub does not show ${cx.tag} as a prerelease yet: ${cmd(cx, '--withdraw')} again`)
    await cx.p.clock.sleep(T.prereleaseEveryMs)
    r = await readRelease(cx, rel.id)
  }
  if (cx.state) settle(cx, (s) => { s.steps.withdrawn ??= { at: now(cx), reason } })
  let tagTarget = null
  if (!cx.state) { try { tagTarget = await cx.p.github.tagCommit(cx.repo, cx.tag) } catch (err) { if (!(err instanceof Unreadable)) throw err } }
  writeRecord(cx, 'withdrawn', { reason: cx.state?.steps.withdrawn?.reason ?? reason, rel: r, tagTarget })
  finalize(cx, 'withdrawn')
  if (cx.shared.watch.some((w) => w.version === cx.version)) {
    cx.shared.watch = cx.shared.watch.filter((w) => w.version !== cx.version)
    saveShared(cx)
  }
}

/** --abandon, for a release never published (r5 #2, #3; r6 #2): its own prerequisites only; deletes nothing on GitHub */
async function abandon(cx) {
  const o = cx.shared.owner
  if (!cx.state) {
    if (o?.version === cx.version) stop(`the owning folder ${o.state} is missing: ${cmd(cx, '--clear-owner')}`)
    cx.say(`there is no release state for ${cx.version}: nothing to abandon`)
    return
  }
  if (cx.state.steps.final) stop(`v${cx.version} ended ${cx.state.steps.final.status}: there is nothing to abandon`)
  const rels = await releasesFor(cx)
  if (rels.some((r) => !r.draft)) stop(`v${cx.version} is published on GitHub: --abandon is refused (a published release ends with ${cmd(cx, '--withdraw')})`)
  if (cx.shared.pending?.version === cx.version) stop(choices(cx, cx.shared.pending, 'a publish request is not settled'))
  const mine = o?.version === cx.version
  // journal, final, owner cleared, the folder last; a republication cut before its request ends with the release, so
  // a late original publish still raises the alarm (code review r2 #2)
  const unmarked = unmarkRepublishing(cx)
  if (mine && !o.abandoning) o.abandoning = now(cx)
  if (unmarked || (mine && o.abandoning)) saveShared(cx)
  cx.state.steps.abandoning ??= { at: now(cx) }
  saveState(cx)
  if (mine) {
    o.final = 'abandoned'
    saveShared(cx)
    cx.shared.owner = null
    saveShared(cx)
  }
  rmSync(cx.dir, { recursive: true, force: true })
  const d = rels.find((r) => r.draft)
  cx.say(`abandoned: nothing deleted on GitHub${d ? ` - the draft ${d.html_url} stays, private; the release playbook says you may delete it by hand once it is settled` : ''}`)
}

/** --clear-owner (r6 #3): the owning folder missing with no final, and the release definitely unpublished */
async function clearOwner(cx) {
  const o = cx.shared.owner
  if (!o) { cx.say(`${cx.repo} has no owner: nothing to clear`); return }
  if (o.version !== cx.version) stop(`${cx.repo}'s owner is ${o.version}, not ${cx.version}: nothing to clear`)
  if (existsSync(join(o.state, 'state.json'))) stop(`the owning folder ${o.state} is there: resume it, or ${cmd(cx, '--abandon')} there`)
  let rels
  try { rels = await cx.p.github.releases(cx.repo) } catch (err) {
    if (!(err instanceof Unreadable)) throw err
    stop(`GitHub cannot be read (${err.message}): unknown, so the repository stays reserved`)
  }
  rels = rels.filter((r) => r.tag_name === cx.tag)
  if (rels.some((r) => !r.draft)) stop(`GitHub shows v${cx.version} published: ${cmd(cx, '--withdraw')} ends it`)
  // a matching pending is settled only by --settle-unpublished; one whose release is gone (startup) is already retired
  if (cx.shared.pending?.version === cx.version) stop(`a publish request of v${cx.version} is not settled: ${cmd(cx, '--settle-unpublished')} first, from ${iso(cx.shared.pending.at + T.settleUnpublishedMs)}`)
  unmarkRepublishing(cx)
  o.final = 'abandoned'
  saveShared(cx)
  cx.shared.owner = null
  saveShared(cx)
  cx.say(`the owner is cleared (final: abandoned)${rels.length ? `; the draft ${rels[0].html_url} stays, private` : ''}: ${cx.repo} is free`)
}

/** --settle-unpublished (r6 #2): the operator declares an uncertain publish failed, 24 h on, the draft unchanged */
async function settleUnpublished(cx) {
  const p = cx.shared.pending
  if (!p || p.version !== cx.version) stop(`no publish request of v${cx.version} is outstanding: nothing to settle`)
  if (now(cx) - p.at < T.settleUnpublishedMs) stop(`--settle-unpublished is allowed from ${iso(p.at + T.settleUnpublishedMs)}, 24 h after the request`)
  const rel = await readRelease(cx, p.releaseId)
  if (!rel) stop(`release ${p.releaseId} is gone from GitHub: run any command and the request is retired`)
  if (!rel.draft) stop(`GitHub shows v${cx.version} published: ${cmd(cx, '--settle-published')}`)
  if (rel.updated_at !== p.updatedAt) stop(`the draft changed since the request (updated_at ${rel.updated_at}, then ${p.updatedAt}): refused`)
  cx.shared.pending = null
  cx.shared.watch.push({ version: cx.version, releaseId: p.releaseId })
  saveShared(cx)
  if (cx.state?.pending?.what === 'publish') settle(cx, (s) => { s.steps['settled-unpublished'] = { at: now(cx), releaseId: p.releaseId } })
  cx.say(`settled unpublished: the request is retired and v${cx.version} is watched - a late publish stops every run until --withdraw. Next: ${cx.state ? `${cmd(cx, '--republish')} or ${cmd(cx, '--abandon')}` : cmd(cx, '--clear-owner')}`)
}

/** --settle-published (r5 #1): the operator has seen it published; read again, recorded, or refused */
async function settlePublished(cx) {
  // startup's observation may have recorded it already: then it is settled, and the run goes on to check-public
  if (cx.state?.steps.publish) return afterPublish(cx)
  const p = cx.shared.pending?.version === cx.version ? cx.shared.pending : cx.state?.pending?.what === 'publish' ? cx.state.pending : null
  if (!p) stop(`no publish request of v${cx.version} is outstanding: nothing to settle`)
  const rel = await readRelease(cx, p.releaseId)
  if (!rel || rel.draft) stop(`GitHub ${rel ? 'still shows a draft' : 'no longer has the release'}: refused - only what GitHub shows published is recorded`)
  if (!cx.state) {
    cx.shared.pending = null
    saveShared(cx)
    cx.say(`the request is settled published; the owning folder is lost: ${cmd(cx, '--withdraw')} ends it`)
    return
  }
  recordPublished(cx, rel)
  await afterPublish(cx)
}

/** --republish (r5 #1; r7): every gate fresh, no sooner than publishWaitMs after the request, then the one request */
async function republish(cx) {
  if (!cx.state) stop(`there is no release state for ${cx.version}: nothing to republish`)
  if (cx.state.steps.final) return finished(cx)
  const p = cx.shared.pending?.version === cx.version ? cx.shared.pending : null
  const w = cx.shared.watch.find((x) => x.version === cx.version)
  if (!p && !w) stop(`v${cx.version} has no unsettled publish request and is not watched: ${cmd(cx, '--publish')}`)
  if (p && now(cx) - p.at < T.publishWaitMs) stop(`--republish is allowed from ${iso(p.at + T.publishWaitMs)}, ${T.publishWaitMs / 60_000} min after the request (a retry delay)`)
  const rel = await readRelease(cx, cx.state.release.id)
  if (rel && !rel.draft) { recordPublished(cx, rel); return afterPublish(cx) }
  if (!rel) stop(`this state's draft ${cx.state.release.id} is gone from GitHub`)
  checkBeforePublish(cx)
  await publishGates(cx, rel)
  if (w && !w.republishing) { w.republishing = true; saveShared(cx) }
  await sendPublish(cx, rel)
  await afterPublish(cx)
}

// run as a script (tests import it without running)
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const r = await run(process.argv.slice(2))
  process.exitCode = r.code
}
