/**
 * Move to Applications: Marver installs itself only where no Marver is (spec 28 A5.1 #23, #24, #40.1; v1.33, Nic's
 * choice of 2 Nov 2026: "move silently"). Electron 45's `app.moveToApplicationsFolder()` is not used: it removes an
 * existing copy as root before its conflict handler, strips quarantine at its relaunch and does nothing for a
 * translocated copy. This mover never asks for a privilege and **never renames, backs up, replaces or trashes an
 * existing installation**: no lock, no transaction, no backup to recover.
 *
 * - **When it looks** (`offerMove`): at launch, once ready and before the registry, the views or any tab (main.ts), so
 *   nothing editable exists and nothing needs a guard - when the build has a feed (`__MARVER_FEED__`), the app is not in
 *   an Applications folder, and `update.json` holds no declined `move`. Never mid-session.
 * - **What is at `/Applications/Marver.app` decides**, before anything is written (`look`, `answerFor`'s three
 *   answers): nothing, in an `/Applications` the person can write, is `install` - no question (`moveAsks` false), the
 *   moved copy's first launch says so once (updater.ts, from `move: { moved: true, at, from }`); a Marver of this
 *   version or newer is `open-existing` - "Marver 1.0.1 is already in Applications", Open It or Cancel; anything else -
 *   an older Marver, another app of that name, an empty or unknown folder, a file, a link, an `/Applications` the
 *   person cannot write - is the **Finder route**: an alert says why, and Show Both reveals this copy and the one in
 *   Applications; Finder asks for an administrator when one is needed. Cancel goes on launching where it is, and asks
 *   again next time.
 * - **The install**, only into an empty slot: (1) `mkdtemp('<apps>/.Marver-staging-')` (700, on the destination's
 *   volume), its path, device and inode in `update.json`'s `staging`, written synchronously **before anything is copied
 *   into it** - a write that fails stops the move there; (2) `ditto --rsrc --extattr --qtn --acl`, each preservation
 *   named so `DITTONORSRC` cannot drop one, then `codesign --verify --deep --strict` and the copy's designated
 *   requirement equal to the running app's; (3) **the claim**, `mkdir('<apps>/Marver.app')`, `EEXIST` when anything
 *   holds the name (an app put there since the look, a link, a file, `marver.app` on a case-insensitive volume): the
 *   staging folder removed, nothing else touched, and what is there now decides; the placeholder's identity added to
 *   `staging`; (4) **the publish**, `rename(2)` onto the placeholder, which on macOS replaces only an empty folder
 *   (`ENOTEMPTY` onto one holding anything, `ENOTDIR` onto a file or a link) - an existing installation is never
 *   replaced; a placeholder swapped for another empty folder is, and nothing is lost (r4 #4); (5) the staging folder
 *   removed, `staging` cleared and the moved note written, then the relaunch.
 * - **A leftover** (`cleanLeftover`), from a crash or a full disk: only a recorded identity is cleaned. The folder at
 *   the recorded path whose device and inode equal the record is removed with everything beneath it; a recorded
 *   placeholder still at the name with its identity is removed with `rmdir`, which fails, and so leaves it, when anything
 *   is inside; anything else is left alone and the record dropped. A crash before an identity is written leaves an
 *   empty staging folder no one deletes, or an empty `Marver.app` the next look sends to the Finder route.
 * - **The source** is never deleted or trashed: a DMG is read-only, a translocated path a read-only mount (#24).
 *   Quarantine is never removed: the copy carries what its source carried (`--qtn`).
 * - **The relaunch**: `/bin/sh -c 'while /bin/kill -0 <pid>; do /bin/sleep 0.1; done; /usr/bin/open <app>'`, detached,
 *   then the quit - Electron's own script without its `xattr` line. Open It relaunches the same way, so the copy it
 *   opens never meets this one's single-instance lock.
 *
 * No Electron import: main.ts gives it the alerts, Finder and the quit (`nodeMoverPorts`).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { UpdateBody } from '../../../src/shared/app-perf.ts'
import type { UpdateFile } from './config.ts'

/** #40.1: the one switch. False since 2 Nov 2026 (Nic): an empty slot is filled without a question. */
export const moveAsks = false

export const BUNDLE_ID = 'design.marver.app'
export const APP_NAME = 'Marver.app'
/** where the mover installs, and so where its moved copy runs from */
export const APPS = '/Applications'
/** The staging folder's name (frozen, #41): a private `mkdtemp` beside the destination. */
export const STAGING_PREFIX = '.Marver-staging-'
/** ditto's preservations, each named (#23): `DITTONORSRC` in the environment cannot drop one. */
export const DITTO_FLAGS = ['--rsrc', '--extattr', '--qtn', '--acl'] as const

/** What is at the destination (#23). */
export type Destination =
  | { kind: 'empty'; writable: boolean }
  /** `dev` and `ino`: the copy's identity when it was read, so an answer acts only on the copy it was given for */
  | { kind: 'marver'; version: string; newer: boolean; writable: boolean; dev: number; ino: number }
  | { kind: 'other-app' }
  | { kind: 'empty-folder' }
  | { kind: 'other' }

/** The three answers (frozen, #41). */
export type MoveAnswer = 'install' | 'open-existing' | 'finder'

/**
 * Nothing in a writable `/Applications`: install. A Marver of this version or newer: open it - whether this account
 * can write it or not, since opening changes nothing (the spec's "a copy the person cannot write" read as an older
 * one, which only Finder's Replace, with an administrator, can change). Anything else: the Finder route.
 */
export function answerFor(d: Destination): MoveAnswer {
  if (d.kind === 'empty' && d.writable) return 'install'
  if (d.kind === 'marver' && d.newer) return 'open-existing'
  return 'finder'
}

/** `X.Y.Z` against `X.Y.Z`, numerically (#5); anything else is lower. */
export function compareVersions(a: string, b: string): number {
  const p = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null)
  const x = p(a), y = p(b)
  if (!x) return y ? -1 : 0
  if (!y) return 1
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return 0
}

// ---- the words (frozen, #41: the docs copy them) ------------------------------------------------------------------

/** An alert: `buttons[0]` the default. `checkbox` only for `moveAsks`' question. */
export interface MoveAlert { message: string; detail: string; buttons: string[]; checkbox?: string }

export function openItAlert(version: string): MoveAlert {
  return { message: `Marver ${version} is already in Applications`, detail: 'Open it, and this copy quits. You can delete this copy afterwards.', buttons: ['Open It', 'Cancel'] }
}

/** The Finder route's alert: why, and what the person does in Finder. */
export function finderAlert(d: Destination): MoveAlert {
  const buttons = ['Show Both', 'Cancel']
  switch (d.kind) {
    case 'marver':
      return {
        message: `An older Marver (${d.version}) is in Applications`,
        detail: 'To replace it, drag this Marver into Applications and choose Replace.'
          + (d.writable ? '' : " Finder asks for an administrator's name and password."),
        buttons,
      }
    case 'other-app':
      return { message: 'Another app named Marver is in Applications', detail: "Marver doesn't replace it. Move it out of Applications, then drag this Marver in.", buttons }
    case 'empty-folder':
      return { message: 'An empty folder named Marver.app is in Applications', detail: 'Move that empty folder to the Trash, then open the download again.', buttons }
    case 'empty':
      return {
        message: "Marver can't add itself to Applications",
        detail: "This account can't add apps to Applications. Drag Marver into Applications in Finder: it asks for an administrator's name and password.",
        buttons,
      }
    case 'other':
      return { message: 'Something named Marver.app is in Applications', detail: "Marver doesn't replace what it doesn't know. Move it out of Applications, then drag this Marver in.", buttons }
  }
}

/** #40.1's question, asked only with `moveAsks` on. */
export const MOVE_QUESTION: MoveAlert = {
  message: 'Move Marver to Applications?', detail: 'Marver updates itself only from the Applications folder.', buttons: ['Move', 'Not Now'], checkbox: "Don't ask again",
}

/** The relaunch (#23): Electron's own script without its `xattr` line. */
export function relaunchScript(pid: number, app: string): string {
  return `while /bin/kill -0 ${pid}; do /bin/sleep 0.1; done; /usr/bin/open '${app.replace(/'/g, `'\\''`)}'`
}

/**
 * Where this copy came from, for the moved note (#23): `'dmg'` on a read-only volume (a mounted disk image), else the
 * folder's name. A translocated copy (#24) runs from `.../AppTranslocation/<id>/...`, a read-only nullfs mount of its
 * real folder: the mount table names that folder. Unknown: `''`, and the note has no second line.
 */
export function sourceOf(bundle: string, mounts: string, readOnly: (volume: string) => boolean): string {
  let dir = dirname(bundle)
  const t = /^(.*\/AppTranslocation\/[^/]+)(\/.*)?$/.exec(dir)
  if (t) {
    const point = t[1]!
    const line = mounts.split('\n').find((l) => l.includes(` on ${point} (`))
    if (!line) return ''
    dir = line.slice(0, line.indexOf(` on ${point} (`))
    if (!dir.startsWith('/')) return ''
  }
  const vol = /^\/Volumes\/[^/]+/.exec(dir)?.[0]
  if (vol && readOnly(vol)) return 'dmg'
  return basename(dir)
}

// ---- the ports --------------------------------------------------------------------------------------------------

export interface MoverPorts {
  /** the running bundle (`…/Marver.app`) and its version */
  bundle: string
  version: string
  /** `/Applications` (tests: a temporary folder) */
  apps: string
  pid: number
  now(): number
  read(): UpdateFile
  /** update.json whole and synchronously: false when it is not on disk */
  write(f: UpdateFile): boolean
  record(b: UpdateBody): void
  /** a tool, to its end: its exit code and what it printed */
  run(cmd: string, args: string[]): { code: number; out: string }
  /** an Info.plist read, or null */
  plist(path: string): Record<string, unknown> | null
  /** whether this account can write a path */
  writable(path: string): boolean
  /** where this copy came from: `'dmg'`, a folder's name, or `''` (`sourceOf`) */
  from(): string
  ask(a: MoveAlert): Promise<{ button: string; checked: boolean }>
  /** Show Both: each selected in Finder */
  reveal(paths: string[]): void
  /** the relaunch script, detached */
  relaunch(script: string): void
  quit(): void
  log?(topic: string, data: unknown): void
}

/** The mover's own ports on this Mac; main.ts adds the alerts, Finder and the quit, which need Electron. */
export function nodeMoverPorts(o: Pick<MoverPorts, 'bundle' | 'version' | 'read' | 'write' | 'record' | 'ask' | 'reveal' | 'quit' | 'log'> & { apps?: string }): MoverPorts {
  return {
    ...o,
    apps: o.apps ?? APPS,
    pid: process.pid,
    now: () => Date.now(),
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 300_000 })
      return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error.message) : ''}` }
    },
    plist: (path) => {
      try { return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })) as Record<string, unknown> } catch { return null }
    },
    writable: (path) => { try { accessSync(path, constants.W_OK); return true } catch { return false } },
    from: () => {
      let mounts = ''
      try { mounts = execFileSync('/sbin/mount', { encoding: 'utf8', timeout: 10_000 }) } catch { /* unknown: no second line */ }
      return sourceOf(o.bundle, mounts, (v) => { try { accessSync(v, constants.W_OK); return false } catch (e) { return (e as NodeJS.ErrnoException).code === 'EROFS' } })
    },
    relaunch: (script) => { spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref() },
  }
}

const destOf = (p: MoverPorts): string => join(p.apps, APP_NAME)
const codeOf = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? 'EIO'
const msg = (e: unknown): string => String((e as Error)?.message ?? e)

// ---- the look ---------------------------------------------------------------------------------------------------

/** What is at the destination now (#23), read before anything is written. `lstat`: a link is a link, wherever it points. */
export function look(p: MoverPorts): Destination {
  const dest = destOf(p)
  let st
  try { st = lstatSync(dest) } catch (e) {
    return codeOf(e) === 'ENOENT' ? { kind: 'empty', writable: p.writable(p.apps) } : { kind: 'other' }
  }
  if (!st.isDirectory()) return { kind: 'other' }
  const info = p.plist(join(dest, 'Contents', 'Info.plist'))
  if (!info) {
    let names: string[] = ['?']
    try { names = readdirSync(dest) } catch { /* unreadable: something */ }
    return names.length ? { kind: 'other' } : { kind: 'empty-folder' }
  }
  if (info.CFBundleIdentifier !== BUNDLE_ID) return { kind: 'other-app' }
  const version = typeof info.CFBundleShortVersionString === 'string' ? info.CFBundleShortVersionString : ''
  return { kind: 'marver', version, newer: compareVersions(version, p.version) >= 0, writable: p.writable(dest) && p.writable(p.apps), dev: st.dev, ino: st.ino }
}

// ---- the install's steps (exported: the unit cases stop between them, as a crash would) ---------------------------

/** (1) The staging folder, its identity recorded before anything is copied into it. Throws when it is not recorded. */
export function stage(p: MoverPorts): string {
  const path = mkdtempSync(join(p.apps, STAGING_PREFIX))
  const st = statSync(path)
  if (!p.write({ ...p.read(), staging: { path, dev: st.dev, ino: st.ino, placeholder: null, at: p.now() } })) {
    try { rmdirSync(path) } catch { /* left: empty, harmless */ }
    throw new Error('update.json not written: nothing copied')
  }
  return path
}

/** (2) The copy, each preservation named. */
export function copy(p: MoverPorts, staging: string): void {
  const r = p.run('/usr/bin/ditto', [...DITTO_FLAGS, p.bundle, join(staging, APP_NAME)])
  if (r.code !== 0) throw new Error(`ditto: ${r.out.trim().slice(0, 300)}`)
}

/** (2) The copy verified: a valid deep signature, and the running app's designated requirement. */
export function verify(p: MoverPorts, staging: string): void {
  const to = join(staging, APP_NAME)
  const v = p.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', to])
  if (v.code !== 0) throw new Error(`codesign --verify: ${v.out.trim().slice(0, 300)}`)
  const dr = (x: string) => /designated => (.+)/.exec(p.run('/usr/bin/codesign', ['-d', '-r-', x]).out)?.[1]?.trim() ?? null
  const want = dr(p.bundle)
  if (!want || dr(to) !== want) throw new Error('the copy\'s designated requirement is not the running app\'s')
}

/** (3) The claim: false when anything holds the name. The placeholder's identity is added to the record. */
export function claim(p: MoverPorts): boolean {
  const dest = destOf(p)
  try { mkdirSync(dest) } catch (e) {
    if (codeOf(e) === 'EEXIST') return false
    throw e
  }
  const st = lstatSync(dest)
  const f = p.read()
  // a write that fails here leaves an unrecorded placeholder only if the publish fails too: the next look's Finder route
  if (f.staging && !p.write({ ...f, staging: { ...f.staging, placeholder: { dev: st.dev, ino: st.ino } } })) p.log?.('move', { placeholder: 'not recorded' })
  return true
}

/** (4) The publish: rename(2) onto the empty placeholder. Throws ENOTEMPTY or ENOTDIR when it is not that any more. */
export function publish(p: MoverPorts, staging: string): void {
  renameSync(join(staging, APP_NAME), destOf(p))
}

/** (5) The staging folder removed, its record cleared, the moved note written - before the relaunch. */
export function finish(p: MoverPorts, staging: string, from: string): boolean {
  try { rmdirSync(staging) } catch { /* left: the record goes, so it is never cleaned - empty, harmless */ }
  return p.write({ ...p.read(), staging: null, move: { moved: true, at: p.now(), from } })
}

/**
 * What the record names, removed by its identity alone, and the record dropped: the staging folder with everything
 * beneath it; the placeholder with `rmdir`, which fails, and so leaves it, when anything is inside. Whether anything was
 * removed. A failed step's clean-up and a leftover's are this one rule.
 */
function clean(p: MoverPorts): boolean {
  const s = p.read().staging
  if (!s) return false
  let removed = false
  try {
    const st = lstatSync(s.path)
    if (st.isDirectory() && st.dev === s.dev && st.ino === s.ino) { rmSync(s.path, { recursive: true, force: true }); removed = true }
  } catch { /* nothing there, or not removable: left */ }
  if (s.placeholder) {
    const dest = join(dirname(s.path), APP_NAME)
    try {
      const st = lstatSync(dest)
      if (st.isDirectory() && st.dev === s.placeholder.dev && st.ino === s.placeholder.ino) { rmdirSync(dest); removed = true }
    } catch { /* not empty, or gone: left */ }
  }
  p.write({ ...p.read(), staging: null })
  return removed
}

/** The install (#23): `moved`, `taken` (the claim found the name held) or `failed` - each recorded. */
export function install(p: MoverPorts): 'moved' | 'taken' | 'failed' {
  let staging: string
  try { staging = stage(p) } catch (e) { p.record({ phase: 'move', why: 'failed', message: msg(e) }); return 'failed' }
  try {
    copy(p, staging)
    verify(p, staging)
  } catch (e) {
    clean(p)
    p.record({ phase: 'move', why: 'failed', message: msg(e) })
    return 'failed'
  }
  let claimed: boolean
  try { claimed = claim(p) } catch (e) {
    clean(p)
    p.record({ phase: 'move', why: 'failed', message: msg(e) })
    return 'failed'
  }
  if (!claimed) {
    // nothing at the name is touched: it was never ours
    clean(p)
    p.record({ phase: 'move', why: 'taken' })
    return 'taken'
  }
  try { publish(p, staging) } catch (e) {
    // what was put in or over the placeholder since the claim is left as it is: an empty placeholder still ours goes
    clean(p)
    p.record({ phase: 'move', why: 'failed', message: `the publish: ${codeOf(e)}` })
    return 'failed'
  }
  if (!finish(p, staging, p.from())) p.log?.('move', { note: 'not written' })
  p.record({ phase: 'move', why: 'moved', version: p.version })
  return 'moved'
}

/**
 * A leftover (r3 #2; r4 #5): only a recorded identity is cleaned, at the next look. Returns whether anything was
 * removed; the record is dropped either way.
 */
export function cleanLeftover(p: MoverPorts): boolean {
  if (!p.read().staging) return false
  const removed = clean(p)
  p.record({ phase: 'move', why: 'cleaned', ...(removed ? {} : { message: 'nothing at the recorded identity' }) })
  return removed
}

// ---- the offer --------------------------------------------------------------------------------------------------

/**
 * At launch, before the registry, the views or any tab (#23): `quit` when this copy is ending (moved, or another
 * opened), `go-on` to launch where it is.
 */
export async function offerMove(p: MoverPorts, o: { feed: string; inApplications: boolean }): Promise<'go-on' | 'quit'> {
  if (!o.feed) return 'go-on'
  if (p.read().staging) cleanLeftover(p)
  if (o.inApplications) return 'go-on'
  const m = p.read().move
  if (m && 'declined' in m) return 'go-on'
  return decide(p, true)
}

async function decide(p: MoverPorts, first: boolean): Promise<'go-on' | 'quit'> {
  const d = look(p)
  const a = answerFor(d)
  p.log?.('move', { look: d, answer: a })
  if (a === 'install') {
    if (moveAsks) {
      p.record({ phase: 'move', why: 'offered' })
      const r = await p.ask(MOVE_QUESTION)
      if (r.button !== 'Move') {
        if (r.checked) p.write({ ...p.read(), move: { declined: true, at: p.now() } })
        p.record({ phase: 'move', why: r.checked ? 'declined' : 'cancelled' })
        return 'go-on'
      }
    }
    const r = install(p)
    if (r === 'moved') { p.relaunch(relaunchScript(p.pid, destOf(p))); p.quit(); return 'quit' }
    // the name taken since the look, or the publish refused: what is there now decides, once
    return first && r !== 'failed' ? decide(p, false) : 'go-on'
  }
  if (a === 'open-existing' && d.kind === 'marver') {
    p.record({ phase: 'move', why: 'offered', version: d.version })
    const r = await p.ask(openItAlert(d.version))
    if (r.button === 'Open It') {
      // the answer was given for the copy read before the alert (code review r1 P2): read again, and only that same
      // copy - its identity and its version - is opened; anything else there now decides afresh, once
      const now = look(p)
      if (!(now.kind === 'marver' && now.version === d.version && now.dev === d.dev && now.ino === d.ino)) {
        p.log?.('move', { changed: now.kind })
        return first ? decide(p, false) : 'go-on'
      }
      p.record({ phase: 'move', why: 'opened-existing', version: d.version })
      p.relaunch(relaunchScript(p.pid, destOf(p)))
      p.quit()
      return 'quit'
    }
    p.record({ phase: 'move', why: 'cancelled' })
    return 'go-on'
  }
  p.record({ phase: 'move', why: 'finder', ...(d.kind === 'marver' ? { version: d.version } : {}) })
  const r = await p.ask(finderAlert(d))
  if (r.button === 'Show Both') p.reveal(d.kind === 'empty' ? [p.bundle, p.apps] : [p.bundle, destOf(p)])
  else p.record({ phase: 'move', why: 'cancelled' })
  return 'go-on'
}
