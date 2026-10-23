/**
 * ~/.marver: the files (spec 28 A2.7, A2.12, A2.14 #23, #24, v1.12 r1 #7). Owner: the home-and-files stream.
 *
 * - `ensureHome()`, before the crash reporter (A2.1): the home (700, when missing; an existing one is never
 *   chmod-ed), `state/` (`state-dev/` in Marver Dev), `perf/` and `perf/crashpad` (700), `schemas/`; `README.md` and
 *   the schemas written whole when missing, of another version or not whole (a dev build only when missing or not
 *   whole); our leftover temp files swept. It never writes `config.json` or `theme.json`. A home that cannot be
 *   written leaves the app on defaults, with the files pill, keeping no state; the next launch tries again.
 * - `config.json` and `theme.json` are the person's (and their agents'): judged whole - a file that does not parse,
 *   has a wrong value or an unknown key does not apply at all, and the last good file stays in force (at launch,
 *   `state/status.json`'s record of it, else the defaults). `$schema` is allowed beside the keys.
 * - Watched as a folder (120 ms debounce, by content hash): our own writes echo as no-ops.
 * - `state/status.json` is written whole after every judgement and every failed or recovered write: what an agent
 *   reads after an edit (README rule 4).
 * - `settings:set` writes one key: read, set, write whole; onto a file that does not apply, the last good values
 *   plus the change, the broken bytes kept as `<name>.bad`.
 * - The strip's quiet files pill (A2.2's third tier): a file that did not apply, a write that failed, a home that
 *   cannot be written.
 *
 * main.ts calls `ensureHome()`, `readFiles()` and `applyTheme()` in its pinned order (A2.14 #30) and `startFiles()`
 * at ready. The bridge mounts `settingsGet`, `settingsSet` and `settingsReveal`; the window's pill feed subscribes
 * with `onPill`, Settings' `status` push with `onStatus`; tabs.ts reads `values()` and keeps `tabs.json` through
 * `readTabsFile()` and `tabsWriter()`.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { app, nativeTheme } from 'electron'
import type { FileProblem, FilesStatus, FileState, PillView, SettingsSetResult, SettingsView } from '../shared/channels.ts'
import { check, defaults, FILE_MAX, judgeObject, keySpec, shownIn, shownKeys, STAGE, type FileName } from '../shared/settings-keys.ts'
import { tilde } from '../shared/command.ts'
import type { TabsFile } from './tabs.ts'
import { effects, provideEffectHooks } from './effects.ts'
import { faults, readCapped, readCappedSync, readState, setAside, stateWriter, sweepTemps, writeWhole, writeWholeSync, type Capped, type StateWriter, type WriteHooks } from './fsx.ts'
import { renderOwned, wholeVersion } from './readme.ts'
import { T } from './timings.ts'
import { note, provide } from './testing/index.ts'

/** `MARVER_HOME` honoured, as the package does (slots.ts). */
export const marverHome = (): string => resolve(process.env.MARVER_HOME || join(homedir(), '.marver'))

/** config.json (A2.7 keys, v1). Every key is optional; absent means these (A2.14 #23). */
export interface Config {
  restoreTabs: boolean
  /** A3's: accepted from 0.1 and ignored */
  unloadUnderPressure: boolean
  /** A3's */
  recorder: boolean
  /** absent until the person chooses (A4.2) */
  notifications?: boolean
  /** A4's */
  dockBadge: boolean
  /** A3's, 1-90 */
  keepPerfDays: number
}
/** theme.json. */
export interface ThemeFile { mode: 'system' | 'light' | 'dark' }

export const CONFIG_DEFAULTS: Config = defaults('config') as unknown as Config
export const THEME_DEFAULTS: ThemeFile = defaults('theme') as unknown as ThemeFile

export interface Files { config: Config; theme: ThemeFile; applied: boolean }

export interface Home {
  dir: string
  /** false when the folder cannot be written: the app runs on defaults with the files pill (A2.12) */
  writable: boolean
  /** the errno code that made it so */
  reason?: string
  /** state/ or, in Marver Dev, state-dev/ (A2.14 #23) */
  state: string
  /** perf/crashpad, 700 - made before crashReporter.start (A2.14 #24) */
  crashpad: string
  /** how long ensureHome took (the budget: under 10 ms) */
  ms: number
}

const errCode = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? 'EIO'
const appVersion = (): string => { try { return app.getVersion() } catch { return '0.0.0' } }

let home: Home = { dir: marverHome(), writable: false, state: '', crashpad: '', ms: 0 }

/** The home as ensureHome last found it. */
export const currentHome = (): Home => home
/** The state folder: `state/` or, in Marver Dev, `state-dev/`. */
export const stateDir = (): string => home.state

function mkdir700(d: string): void {
  mkdirSync(d, { recursive: true, mode: 0o700 })
  if ((statSync(d).mode & 0o777) !== 0o700) chmodSync(d, 0o700)
}

/**
 * Made at every launch, before the window and before `crashReporter.start()` (A2.12). Synchronous; under 10 ms
 * when the files are current. Never writes config.json or theme.json, never touches running/, prefer/ or canvases/.
 */
export function ensureHome(o: { version?: string; dev?: boolean } = {}): Home {
  const t0 = performance.now()
  const dev = o.dev ?? !__MARVER_RELEASE__
  const version = o.version ?? appVersion()
  const dir = marverHome()
  const state = join(dir, dev ? 'state-dev' : 'state')
  const perf = join(dir, 'perf')
  const crashpad = join(perf, 'crashpad')
  const h: Home = { dir, writable: true, state, crashpad, ms: 0 }
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    else if (!statSync(dir).isDirectory()) throw Object.assign(new Error(`${dir} is not a folder`), { code: 'ENOTDIR' })
    for (const d of [state, perf, crashpad]) mkdir700(d)
    mkdirSync(join(dir, 'schemas'), { recursive: true })
    for (const d of [dir, state, join(dir, 'schemas')]) sweepTemps(d)
    for (const [name, want] of renderOwned(version)) {
      const p = join(dir, name)
      const raw = readCappedSync(p, 1024 * 1024)
      const have = Buffer.isBuffer(raw) ? raw.toString('utf8') : undefined
      const stale = dev ? have === undefined || wholeVersion(name, have) === null : have !== want
      if (stale) writeWholeSync(p, want, 0o644)
    }
  } catch (e) {
    h.writable = false
    h.reason = errCode(e)
  }
  h.ms = performance.now() - t0
  home = h
  return h
}

// ---- judging --------------------------------------------------------------------------------------------------

export type Judgement =
  | { ok: true; present: boolean; values: Record<string, unknown>; sha256: string }
  | { ok: false; present: true; problems: FileProblem[]; sha256: string; text?: string }

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

/** A settings file's bytes, judged whole (A2.7). Pure. */
export function judge(file: FileName, raw: Capped): Judgement {
  if (raw === undefined) return { ok: true, present: false, values: {}, sha256: '' }
  if (!Buffer.isBuffer(raw)) {
    if ('tooBig' in raw) return { ok: false, present: true, sha256: '', problems: [{ message: `the file is over ${FILE_MAX / 1024} KB` }] }
    return { ok: false, present: true, sha256: '', problems: [{ message: `the file could not be read (${raw.error})` }] }
  }
  const hash = sha256(raw)
  const text = raw.toString('utf8')
  let o: unknown
  try { o = JSON.parse(text.replace(/^﻿/, '')) } catch (e) {
    return { ok: false, present: true, sha256: hash, text, problems: [{ message: `not valid JSON: ${(e as Error).message}` }] }
  }
  const j = judgeObject(file, o)
  return j.ok ? { ok: true, present: true, values: j.values, sha256: hash } : { ok: false, present: true, sha256: hash, text, problems: j.problems }
}

// ---- the files in force -----------------------------------------------------------------------------------------

const NAMES = { config: 'config.json', theme: 'theme.json' } as const
const filePath = (f: FileName) => join(home.dir, NAMES[f])
const statusPath = () => join(home.state, 'status.json')

interface Rec { state: FileState; text?: string }
const emptyState = (): FileState => ({ present: false, ok: true, sha256: '', applied: { sha256: '', values: {} } })
const recs: Record<FileName, Rec> = { config: { state: emptyState() }, theme: { state: emptyState() } }
let lastWrite: FilesStatus['write']
let statusAt = 0

const changeFns = new Set<(f: FileName) => void>()
const statusFns = new Set<(s: FilesStatus) => void>()
const pillFns = new Set<(p: FilesPill | null) => void>()

/** Effective values: the defaults, then what is applied. */
export function values(): { config: Config; theme: ThemeFile } {
  return {
    config: { ...CONFIG_DEFAULTS, ...recs.config.state.applied.values } as Config,
    theme: { ...THEME_DEFAULTS, ...recs.theme.state.applied.values } as ThemeFile,
  }
}

export function filesStatus(): FilesStatus {
  return {
    v: 1, app: appVersion(), at: statusAt, writable: home.writable, ...(home.reason ? { reason: home.reason } : {}),
    files: { 'config.json': structuredClone(recs.config.state), 'theme.json': structuredClone(recs.theme.state) },
    ...(lastWrite ? { write: { ...lastWrite } } : {}),
  }
}

/** A file's record changed what is in force. */
export function onChange(fn: (f: FileName) => void): () => void { changeFns.add(fn); return () => changeFns.delete(fn) }
/** `status` for Settings: after every judgement and every failed or recovered write. */
export function onStatus(fn: (s: FilesStatus) => void): () => void { statusFns.add(fn); return () => statusFns.delete(fn) }

/** The files pill, as the window's pill feed takes it (it adds the `rev`). */
export type FilesPill = Omit<PillView, 'rev'> & { kind: 'files' }
export function onPill(fn: (p: FilesPill | null) => void): () => void { pillFns.add(fn); return () => pillFns.delete(fn) }

const WORDS: Record<string, string> = {
  ENOSPC: 'the disk is full', EDQUOT: 'the disk quota is full', EACCES: 'no permission', EPERM: 'no permission',
  EROFS: 'the disk is read-only', ENOTDIR: 'it is not a folder', EIO: 'the disk answered with an error',
}
export const errWords = (code: string): string => WORDS[code] ?? code
const cap = (s: string, n = 199) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const tildeOf = (p: string) => tilde(p, homedir())

/** The strip's quiet files pill (A2.2 tier 3; A2.14 #24): a file that did not apply, then a failed write, then a home that cannot be written. */
export function filesPill(): FilesPill | null {
  const bad = (['config', 'theme'] as const).find((f) => !recs[f].state.ok)
  if (bad) {
    const first = recs[bad].state.problems?.[0]?.message ?? 'it has a problem'
    return { kind: 'files', lead: NAMES[bad], text: 'did not apply · using the last good one', short: 'Settings not applied', tooltip: cap(`${NAMES[bad]}: ${first}`) }
  }
  if (lastWrite) {
    return { kind: 'files', lead: `Couldn't save ${basename(lastWrite.file)}`, text: errWords(lastWrite.code), short: 'Files not saved', tooltip: cap(lastWrite.file) }
  }
  if (!home.writable) {
    return { kind: 'files', lead: `${tildeOf(home.dir)} can't be written`, text: 'nothing is kept', short: 'Files not saved', tooltip: cap(`${tildeOf(home.dir)}: ${errWords(home.reason ?? 'EACCES')}`) }
  }
  return null
}

let lastPill = 'null'
let statusWrite: Promise<void> = Promise.resolve()

/** Writes status.json whole and tells Settings and the pill. Never fails loudly: status.json is a report. */
function published(): void {
  statusAt = Date.now()
  const s = filesStatus()
  if (home.writable) {
    statusWrite = writeWhole(statusPath(), JSON.stringify(s, null, 2) + '\n').catch((e) => {
      if (__MV_TEST__) note('files', { event: 'status-write-failed', code: errCode(e) })
    })
  }
  for (const fn of statusFns) fn(s)
  const p = filesPill()
  const pj = JSON.stringify(p)
  if (pj !== lastPill) { lastPill = pj; for (const fn of pillFns) fn(p) }
}

function applyJudgement(file: FileName, j: Judgement): void {
  const r = recs[file]
  const before = JSON.stringify(r.state.applied)
  r.state = {
    present: j.present, ok: j.ok, sha256: j.sha256,
    ...(j.ok ? {} : { problems: j.problems }),
    applied: j.ok ? { sha256: j.sha256, values: j.values } : r.state.applied,
  }
  r.text = j.ok ? undefined : j.text
  if (__MV_TEST__) note('files', { event: j.ok ? 'applied' : 'not-applied', file, sha256: j.sha256, problems: j.ok ? undefined : j.problems })
  if (JSON.stringify(r.state.applied) !== before) {
    if (file === 'theme') themeNow()
    for (const fn of changeFns) fn(file)
  }
  published()
}

function themeNow(): void {
  try { nativeTheme.themeSource = values().theme.mode } catch { /* before ready in a unit test */ }
}

/** status.json's shape, enough to stand in for a file that does not apply at launch (M14). */
function checkStatus(v: unknown): v is FilesStatus {
  const s = v as FilesStatus
  return !!s && typeof s === 'object' && s.v === 1 && !!s.files && typeof s.files === 'object'
}

/** The last applied values status.json recorded for a file - only when they still pass the validator. */
function fallbackApplied(prev: FilesStatus | undefined, file: FileName): FileState['applied'] {
  const a = prev?.files?.[NAMES[file]]?.applied
  if (!a || typeof a !== 'object' || typeof a.sha256 !== 'string' || !a.values) return { sha256: '', values: {} }
  const j = judgeObject(file, a.values)
  return j.ok ? { sha256: a.sha256, values: j.values } : { sha256: '', values: {} }
}

/**
 * The files' first read, at launch before ready: each judged whole; one that does not apply leaves in force what
 * status.json last recorded as applied, else the defaults (A2.14 #24).
 */
export function loadFiles(): void {
  const prev = home.state ? readState(statusPath(), checkStatus) : undefined
  for (const f of ['config', 'theme'] as const) {
    const j = judge(f, readCappedSync(filePath(f), FILE_MAX))
    recs[f] = {
      state: {
        present: j.present, ok: j.ok, sha256: j.sha256, ...(j.ok ? {} : { problems: j.problems }),
        applied: j.ok ? { sha256: j.sha256, values: j.values } : fallbackApplied(prev, f),
      },
      text: j.ok ? undefined : j.text,
    }
  }
  published()
}

/** The files' first read (main.ts's name for it): loads them and answers what is in force. */
export function readFiles(_home: Home = home): Files {
  loadFiles()
  const v = values()
  return { ...v, applied: recs.config.state.ok && recs.theme.state.ok }
}

/** At ready: `theme.json`'s mode drives `nativeTheme.themeSource` (A2.7), and so every view's colour scheme. */
export function applyTheme(files: Files = { ...values(), applied: true }): void {
  nativeTheme.themeSource = files.theme.mode
}

// ---- watching ---------------------------------------------------------------------------------------------------

let watcher: FSWatcher | undefined
let rereadTimer: ReturnType<typeof setTimeout> | undefined
let rewatchTimer: ReturnType<typeof setTimeout> | undefined
let rereading = Promise.resolve()

/** Reads both files again; judges one only when its bytes changed (our own writes echo here as no-ops). */
export function reread(): Promise<void> {
  rereading = rereading.then(async () => {
    for (const f of ['config', 'theme'] as const) {
      const raw = await readCapped(filePath(f), FILE_MAX)
      const present = raw !== undefined
      const hash = Buffer.isBuffer(raw) ? sha256(raw) : ''
      const st = recs[f].state
      if (present === st.present && hash === st.sha256 && (Buffer.isBuffer(raw) || !present)) continue
      applyJudgement(f, judge(f, raw))
    }
  }).catch(() => {})
  return rereading
}

function scheduleReread(): void {
  if (rereadTimer) clearTimeout(rereadTimer)
  rereadTimer = setTimeout(() => { rereadTimer = undefined; void reread() }, T.configDebounceMs)
}

/** Watches the home folder for config.json and theme.json. On the watcher's error: ensureHome again, rewatch after 5 s. */
export function watchFiles(): void {
  try { watcher?.close() } catch { /* closed */ }
  watcher = undefined
  try {
    watcher = watch(home.dir, { persistent: false }, (_ev, name) => {
      if (name && name !== NAMES.config && name !== NAMES.theme) return
      scheduleReread()
    })
    watcher.on('error', () => rewatch())
  } catch { rewatch() }
}

function rewatch(): void {
  try { watcher?.close() } catch { /* closed */ }
  watcher = undefined
  if (rewatchTimer) return
  rewatchTimer = setTimeout(() => {
    rewatchTimer = undefined
    ensureHome()
    watchFiles()
    void reread()
  }, 5000)
  rewatchTimer.unref?.()
}

export function stopFiles(): void {
  try { watcher?.close() } catch { /* closed */ }
  watcher = undefined
  for (const t of [rereadTimer, rewatchTimer]) if (t) clearTimeout(t)
  rereadTimer = rewatchTimer = undefined
}

// ---- writes the app makes ---------------------------------------------------------------------------------------

/** A write of an app-owned file failed (`err`) or, with null, succeeded: the pill, status.json and the log. */
export function noteWrite(file: string, err: NodeJS.ErrnoException | null): void {
  const shown = tildeOf(file)
  if (err) {
    lastWrite = { file: shown, code: errCode(err), at: Date.now() }
    if (__MV_TEST__) note('files', { event: 'write-failed', file: shown, code: lastWrite.code })
    else console.warn(`marver-app: couldn't save ${shown}: ${errCode(err)}`)
    published()
  } else if (lastWrite?.file === shown) {
    lastWrite = undefined
    published()
  }
}

/** What state writers report to. */
export const writeHooks: WriteHooks = { writable: () => home.writable, noted: noteWrite }

/** A debounced JSON writer for one `state/` file (tabs.json, recent.json). */
export function stateFileWriter<V>(name: string): StateWriter<V> {
  return stateWriter<V>(join(home.state, name), T.stateDebounceMs, writeHooks)
}

// ---- settings:get, settings:set, settings:reveal ----------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>()
function locked<R>(key: string, fn: () => Promise<R>): Promise<R> {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn)
  locks.set(key, run.catch(() => {}))
  return run
}

/** `settings:get`: each file's record, effective values and, when it does not apply, its text. */
export function settingsView(): SettingsView {
  const v = values()
  const file = (f: FileName) => ({
    ...structuredClone(recs[f].state),
    values: { ...(f === 'config' ? v.config : v.theme) } as Record<string, unknown>,
    ...(recs[f].text !== undefined ? { text: recs[f].text } : {}),
  })
  return { dir: tildeOf(home.dir), config: file('config'), theme: file('theme'), status: filesStatus(), shown: shownKeys() }
}

/** `settings:set`'s payload, checked again in main (the bridge checks it first). */
export function parseSet(raw: unknown): { file: FileName; key: string; value: boolean | number | string } | null {
  const r = raw as { file?: unknown; key?: unknown; value?: unknown } | null
  if (!r || typeof r !== 'object') return null
  if (r.file !== 'config' && r.file !== 'theme') return null
  if (typeof r.key !== 'string' || !/^[A-Za-z]{1,32}$/.test(r.key)) return null
  const v = r.value
  if (!(typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length < 16))) return null
  return { file: r.file, key: r.key, value: v }
}

/** `settings:set`: one key into one file, written whole; applied at once (the watcher's echo is then a no-op). */
export function settingsSet(raw: unknown): Promise<SettingsSetResult> {
  const s = parseSet(raw)
  if (!s) return Promise.resolve({ ok: false, why: 'bad-value' })
  const spec = keySpec(s.file, s.key)
  if (!spec || !shownIn(STAGE, spec)) return Promise.resolve({ ok: false, why: 'unknown-key' })
  if (check(spec, s.value)) return Promise.resolve({ ok: false, why: 'bad-value' })
  if (!home.writable) return Promise.resolve({ ok: false, why: 'unwritable' })
  const p = filePath(s.file)
  return locked(p, async (): Promise<SettingsSetResult> => {
    const raw = await readCapped(p, FILE_MAX)
    const j = judge(s.file, raw)
    let base: Record<string, unknown>
    if (raw === undefined) base = {}
    else if (j.ok) base = JSON.parse((raw as Buffer).toString('utf8').replace(/^﻿/, '')) as Record<string, unknown>
    else {
      if (Buffer.isBuffer(raw)) setAside(p, raw)
      base = { ...recs[s.file].state.applied.values }
    }
    const obj = { $schema: `./schemas/${s.file}.schema.json`, ...base, [s.key]: s.value }
    const text = JSON.stringify(obj, null, 2) + '\n'
    try { await writeWhole(p, text) } catch (e) {
      noteWrite(p, e as NodeJS.ErrnoException)
      return { ok: false, why: 'write-failed', code: errCode(e) }
    }
    noteWrite(p, null)
    applyJudgement(s.file, judge(s.file, Buffer.from(text)))
    return { ok: true }
  })
}

/** `settings:reveal` and Home's Show the Files: the folder itself, in Finder. */
export function settingsReveal(): void {
  effects.openPath(home.dir)
}

// ---- tabs.json (v1.12 r1 #5) ------------------------------------------------------------------------------------

const WS = /^[0-9a-f]{16}$/
const ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/
/** The shell's own document only - `/` or `/index.html`, its query and hash - under 2 KB; anything else is `/`. */
export const shellPath = (p: unknown): string =>
  typeof p === 'string' && p.length < 2048 && /^\/(index\.html)?([?#][^\0]*)?$/.test(p) ? p : '/'

export function checkTabsFile(v: unknown): v is TabsFile {
  const f = v as TabsFile
  if (!f || typeof f !== 'object' || f.v !== 1 || typeof f.settings !== 'boolean') return false
  const a = f.active as TabsFile['active'] | undefined
  if (!a || typeof a !== 'object') return false
  if (a.kind === 'canvas' ? !(WS.test(a.ws) && ORIGIN.test(a.origin)) : a.kind !== 'home' && a.kind !== 'settings') return false
  if (!Array.isArray(f.canvases) || f.canvases.length > 20) return false
  for (const c of f.canvases) {
    if (!c || typeof c !== 'object' || !WS.test(c.ws) || !ORIGIN.test(c.origin) || shellPath(c.path) !== c.path || !Number.isFinite(c.shownAt)) return false
  }
  if (!Array.isArray(f.closed) || f.closed.length > 64) return false
  for (const c of f.closed) if (!c || typeof c !== 'object' || !WS.test(c.ws) || typeof c.instance !== 'string' || !c.instance || c.instance.length > 64) return false
  return true
}

/** `tabs.json` read back at launch: undefined when absent; one with another `v` or a bad shape goes aside as `tabs.json.bad`. */
export function readTabsFile(): TabsFile | undefined {
  return home.state ? readState(join(home.state, 'tabs.json'), checkTabsFile) : undefined
}

let tabsW: StateWriter<TabsFile> | undefined
/** The one writer of `tabs.json` (debounced 1 s; `flushSync` at quit). */
export function tabsWriter(): StateWriter<TabsFile> {
  return tabsW ??= stateFileWriter<TabsFile>('tabs.json')
}

// ---- at ready ---------------------------------------------------------------------------------------------------

/** At ready: watch the files, and in test builds the hooks the files' cases drive. */
export function startFiles(): void {
  watchFiles()
  themeNow()
  if (__MV_TEST__) { provideFileHooks(); provideEffectHooks() }
}

function provideFileHooks(): void {
  provide('files.home', () => ({ ...home }))
  provide('files.values', () => values())
  provide('files.status', () => filesStatus())
  provide('files.pill', () => filesPill())
  provide('files.view', () => settingsView())
  provide('files.set', (a) => settingsSet(a))
  provide('files.reveal', () => { settingsReveal(); return true })
  provide('files.reread', () => reread().then(() => true))
  provide('files.theme', () => ({ themeSource: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }))
  provide('files.render', (a) => renderOwned(String((a as { version?: unknown })?.version ?? appVersion())))
  provide('files.statusWritten', async () => { await statusWrite; return true })
  provide('files.inject', (a) => { faults.inject(a as Parameters<typeof faults.inject>[0]); return faults.list() })
  provide('files.tabs', () => readTabsFile() ?? null)
  provide('files.tabsWrite', async (a) => { const w = tabsWriter(); w.set(a as TabsFile); await w.flush(); return true })
}
