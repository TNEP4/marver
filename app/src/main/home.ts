/**
 * Home's main side (spec 28 A2.7, A2.12, A2.14 #5, #24, v1.13 r2 #6). Owner: the home-and-files stream.
 *
 * - **First launch** is known by `state/launched`, written once Home has first shown (the window calls
 *   `noteHomeShown()`), never by the folder, which `marver dev` may have made first. `home:info.welcome` stays what
 *   it was at launch for the whole run.
 * - **Recently here** is `state/recent.json`, the app's own: at most 20 `{ workspace, root, name, origin, port?,
 *   lastSeen }`, newest first, written (debounced) when a canvas is first verified and on each new instance. An
 *   entry whose root no longer exists is dropped at launch; a running canvas is never listed twice. `workspace` is
 *   the slot file's `ws` (A2.14 #10). In app 0.1 its cards wear initials: no logo files (A2.14 #5).
 * - **`home:action`**: Home names which command or which recent canvas, never a path or a command's text; main
 *   copies its own fixed command, or the start command it builds from the recorded root (src/shared/command.ts).
 * - **`link:open`**: parsed again here (src/shared/links.ts); a local link goes to the registry entry on its port and
 *   is rebuilt on that entry's bound origin - the host the link wrote is never loaded - and only to the canvas's own
 *   page (`/` or `/index.html`, its query and hash: the only documents the proof admits, A2.14 #11). Opening it is
 *   the tabs' (`LinkPorts.open`), through A2.2's guard when it changes more than the hash.
 *
 * - **Shared canvases** (A4, A4.6 #47) are `state/shared.json`, the app's own: at most 12 `{ url, host, lastSeen }`,
 *   newest first, one per origin, each `url` a shared tab's place (tabs.ts moves it only to a shell page of its
 *   origin, so no sign-in URL is ever kept), noted at each of its commits and moves (`noteShared`), written
 *   debounced and flushed at quit (`flushShared`). Home gets them on `shared`; a past card sends `link:open`.
 *
 * Who calls what, and when, is the frozen contract in ports.ts (`HomePorts`): the trust stream calls `noteVerified`
 * (a tab's first trusted commit of each instance), the window stream `noteHomeShown`, `noteGone`, `isFirstLaunch`
 * and, in the quit path, `flushRecent`; the bridge mounts `homeAction` and `openLink` as invokes; the home page's
 * `recent` and `home:info` come from `recentViews()` and `homeInfo()`, pushed again on `onRecentChange`.
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { app } from 'electron'
import { CH, type HomeActionAnswer, type HomeInfo, type LinkOpenAnswer, type RecentView, type SharedLink } from '../shared/channels.ts'
import { FIXED_COMMANDS, startCommand, tilde, updateCommand } from '../shared/command.ts'
import { hueOf } from '../shared/hue.ts'
import { LINK_MAX, parseLink, remoteStart, shellPath } from '../shared/links.ts'
import { currentHome, filesStatus, noteWrite, onPill, onStatus, settingsReveal, settingsSet, settingsView, stateDir, stateFileWriter } from './config.ts'
import { effects } from './effects.ts'
import { readState, writeWhole, type StateWriter } from './fsx.ts'
import type { HomePorts, PageBridge, WindowPorts } from './ports.ts'
import { provide } from './testing/index.ts'
import { T } from './timings.ts'
import { createLogoStore, siteKey, wsKey } from './logos.ts'

export interface RecentEntry {
  /** the slot file's `ws`, 16 hex */
  workspace: string
  /** the project's real path */
  root: string
  /** as the shell shows it */
  name: string
  /** the bound origin it last ran on */
  origin: string
  /** only for a canvas that ran on a port of its own (`port-<p>.json`): the start command's `--port` */
  port?: number
  lastSeen: number
}
export interface RecentFile { v: 1; canvases: RecentEntry[] }
export const RECENT_MAX = 20

const WS = /^[0-9a-f]{16}$/
const ORIGIN = /^http:\/\/[^/@\s]+:\d{1,5}$/

/** One Recently here entry (pure): what `noteVerified` records and what a launch keeps - the same rule both ways. */
export function checkEntry(v: unknown): v is RecentEntry {
  const e = v as RecentEntry
  return !!e && typeof e === 'object'
    && typeof e.workspace === 'string' && WS.test(e.workspace)
    && typeof e.root === 'string' && e.root.startsWith('/') && e.root.length < 4096 && !e.root.includes('\0')
    && typeof e.name === 'string' && e.name.length > 0 && e.name.length < 200
    && typeof e.origin === 'string' && ORIGIN.test(e.origin)
    && (e.port === undefined || (Number.isInteger(e.port) && e.port > 0 && e.port < 65536))
    && typeof e.lastSeen === 'number' && Number.isFinite(e.lastSeen)
}

/**
 * recent.json's envelope (pure). Its entries are checked one by one at launch (`checkEntry`), so one bad entry costs
 * only itself, never Recently here; a file that is not this envelope goes aside as `recent.json.bad`.
 */
export function checkRecent(v: unknown): v is { v: 1; canvases: unknown[] } {
  const f = v as { v?: unknown; canvases?: unknown } | null
  return !!f && typeof f === 'object' && f.v === 1 && Array.isArray(f.canvases)
}

/** Newest first, at most 20, one per workspace. Pure. */
export function tidyRecent(list: RecentEntry[]): RecentEntry[] {
  const seen = new Set<string>()
  return [...list].sort((a, b) => b.lastSeen - a.lastSeen).filter((e) => !seen.has(e.workspace) && !!seen.add(e.workspace)).slice(0, RECENT_MAX)
}

/** A Recently here card's id: `r_` and the workspace - within the bridge's id pattern (`[A-Za-z0-9_-]{1,32}`). */
export const recentId = (ws: string): string => `r_${ws}`

/**
 * The temp folders (spec 31 E1): a canvas whose folder is under one is a test's or a scratch copy, never one to come
 * back to - `os.tmpdir()` (and its real path: `/var/folders/...` is `/private/var/folders/...`), `/tmp`, `/private/tmp`,
 * `/var/folders`, `/private/var/folders`.
 */
export function tempFolders(): string[] {
  // a test build under the harness names its own (its fixtures live in the temp folder): `:`-separated, '' for none
  if (__MV_TEST__ && process.env.MARVER_APP_TEMP_DIRS !== undefined) return process.env.MARVER_APP_TEMP_DIRS.split(':').filter((d) => d.startsWith('/'))
  const t = tmpdir()
  let real = t
  try { real = realpathSync(t) } catch { /* as it is */ }
  return [...new Set([t, real, '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'].map((d) => d.replace(/\/+$/, '')).filter(Boolean))]
}
/** Under one of `temps` (pure). */
export const inTemp = (root: string, temps: readonly string[]): boolean => temps.some((d) => root === d || root.startsWith(`${d}/`))

/** Recently here as Home draws it: every recorded canvas not running now and not in a temp folder, newest first, each
 *  with the logo kept for it (`logoOf`). Pure. */
export function recentViewsOf(list: RecentEntry[], running: Iterable<string>, home = homedir(), o: { temps?: readonly string[]; logoOf?: (ws: string) => string | undefined } = {}): RecentView[] {
  const now = new Set(running)
  const temps = o.temps ?? tempFolders()
  return tidyRecent(list).filter((e) => !now.has(e.workspace) && !inTemp(e.root, temps)).map((e) => {
    const logo = o.logoOf?.(e.workspace)
    return { id: recentId(e.workspace), name: e.name, folder: tilde(e.root, home), lastSeen: e.lastSeen, hue: hueOf(e.workspace), ...(logo ? { logo } : {}) }
  })
}

// ---- Shared canvases (A4.6 #47) ---------------------------------------------------------------------------------

export interface SharedFile { v: 1; links: SharedLink[] }
export const SHARED_MAX = 12

/** shared.json's envelope (pure): its links are checked one by one, so one bad link costs only itself. */
export function checkSharedFile(v: unknown): v is { v: 1; links: unknown[] } {
  const f = v as { v?: unknown; links?: unknown } | null
  return !!f && typeof f === 'object' && f.v === 1 && Array.isArray(f.links)
}

/**
 * One past shared canvas (pure): an https link `parseLink` takes (no credentials, no loopback host, under 2 KB) that is
 * already where a tab would start (`remoteStart`: never a path under `/__mv/`), its `host` the link's own.
 */
export function checkSharedLink(v: unknown): v is SharedLink {
  const l = v as SharedLink
  if (!l || typeof l !== 'object' || typeof l.url !== 'string' || typeof l.host !== 'string' || typeof l.lastSeen !== 'number' || !Number.isFinite(l.lastSeen)) return false
  const p = parseLink(l.url)
  return p.kind === 'https' && p.url === l.url && p.host === l.host && remoteStart(l.url) === l.url
}

/** Newest first, one per origin, at most 12. Pure. */
export function tidyShared(list: SharedLink[]): SharedLink[] {
  const seen = new Set<string>()
  return [...list].sort((a, b) => b.lastSeen - a.lastSeen).filter((l) => { const o = new URL(l.url).origin; return !seen.has(o) && !!seen.add(o) }).slice(0, SHARED_MAX)
}

let shared: SharedLink[] = []
let sharedWriter: StateWriter<SharedFile> | undefined
const sharedFns = new Set<() => void>()
let sharedLater: ReturnType<typeof setTimeout> | undefined

/** A shared canvas committed or moved its place (views.ts, from tabs.ts): kept as its origin's newest link. */
export function noteShared(c: { url: string; host: string }): void {
  const l = { url: c?.url, host: c?.host, lastSeen: Date.now() }
  if (!checkSharedLink(l)) return
  const before = JSON.stringify(shared.map((x) => x.url))
  shared = tidyShared([l, ...shared])
  sharedWriter?.set({ v: 1, links: shared })
  // Home redraws at once when what it lists changed; a link only seen again, at most once a debounce later - its past
  // card, shown again when its tab closes, must not say "Opened 3 days ago" of a link just used
  if (JSON.stringify(shared.map((x) => x.url)) !== before) sharedChanged()
  else sharedLater ??= setTimeout(sharedChanged, T.stateDebounceMs)
}

function sharedChanged(): void {
  if (sharedLater) clearTimeout(sharedLater)
  sharedLater = undefined
  for (const fn of sharedFns) fn()
}

/** At quit: what waits, written now. */
export function flushShared(): void { sharedWriter?.flushSync(); sitesWriter?.flushSync() }

/**
 * A shared canvas's name and logo (spec 31 E3), read through its remote tab's own session (views.ts) and kept by origin,
 * only on success: the name in `sites.json` (at most `SHARED_MAX`, newest first), the logo in `logos/`.
 */
export interface SiteFile { v: 1; sites: { origin: string; name: string; at: number }[] }
export const checkSiteFile = (v: unknown): v is SiteFile => {
  const f = v as SiteFile | null
  return !!f && typeof f === 'object' && f.v === 1 && Array.isArray(f.sites)
    && f.sites.every((x) => !!x && typeof x.origin === 'string' && /^https:\/\/[^/]+$/.test(x.origin) && typeof x.name === 'string' && x.name.length > 0 && x.name.length <= 120 && typeof x.at === 'number')
}
let sites: SiteFile['sites'] = []
let sitesWriter: StateWriter<SiteFile> | undefined
export const logos = createLogoStore(() => { const d = stateDir(); return d ? join(d, 'logos') : undefined })

/** What a shared canvas's `meta.json` said: kept for its origin. Its name, its logo when one came. */
export function noteSite(origin: string, name: string, logo: string | undefined): void {
  if (!/^https:\/\/[^/]+$/.test(origin) || typeof name !== 'string' || !name.trim() || name.length > 120) return
  const was = sites.find((x) => x.origin === origin)
  sites = [{ origin, name: name.trim(), at: Date.now() }, ...sites.filter((x) => x.origin !== origin)].slice(0, SHARED_MAX)
  sitesWriter?.set({ v: 1, sites })
  if (logo) logos.keep(siteKey(origin), logo)
  if (!was || was.name !== name.trim() || logo) sharedChanged()
}
const siteOf = (url: string) => { try { const o = new URL(url).origin; return { site: sites.find((x) => x.origin === o), logo: logos.get(siteKey(o)) } } catch { return { site: undefined, logo: undefined } } }

export const sharedLinks = (): SharedLink[] => shared.map((l) => {
  const { site, logo } = siteOf(l.url)
  return { ...l, ...(site ? { name: site.name } : {}), ...(logo ? { logo } : {}) }
})
export function onSharedChange(fn: () => void): () => void { sharedFns.add(fn); return () => sharedFns.delete(fn) }

let recent: RecentEntry[] = []
let writer: StateWriter<RecentFile> | undefined
let firstLaunch = false
let launchedNoted = false
const recentFns = new Set<() => void>()

const isDir = (p: string) => { try { return statSync(p).isDirectory() } catch { return false } }

/** After ensureHome, before the window: reads recent.json (a bad one goes aside), drops entries whose folder is gone. */
export function startHome(): void {
  const state = stateDir()
  firstLaunch = !state || !existsSync(join(state, 'launched'))
  const file = state ? readState(join(state, 'recent.json'), checkRecent) : undefined
  const loaded = file?.canvases ?? []
  recent = tidyRecent(loaded.filter(checkEntry).filter((e) => isDir(e.root)))
  writer = state ? stateFileWriter<RecentFile>('recent.json') : undefined
  if (recent.length !== loaded.length) save()
  const links = (state ? readState(join(state, 'shared.json'), checkSharedFile) : undefined)?.links ?? []
  shared = tidyShared(links.filter(checkSharedLink))
  sharedWriter = state ? stateFileWriter<SharedFile>('shared.json') : undefined
  if (shared.length !== links.length) sharedWriter?.set({ v: 1, links: shared })
  const siteFile = state ? readState(join(state, 'sites.json'), checkSiteFile) : undefined
  sites = (siteFile?.sites ?? []).slice(0, SHARED_MAX)
  sitesWriter = state ? stateFileWriter<SiteFile>('sites.json') : undefined
  // the logos of canvases and sites no longer listed go
  logos.prune([...recent.map((e) => wsKey(e.workspace)).filter((k): k is string => !!k), ...sites.map((x) => siteKey(x.origin))])
  if (__MV_TEST__) provideHomeHooks()
}

function save(): void {
  writer?.set({ v: 1, canvases: recent })
  for (const fn of recentFns) fn()
}

/** True for the very first launch (no `state/launched`), for the whole run: Home's welcome, restore's active tab. */
export const isFirstLaunch = (): boolean => firstLaunch

/** `home:info`. */
export function homeInfo(): HomeInfo {
  return { welcome: firstLaunch, writable: currentHome().writable }
}

/** Home has shown for the first time this run (the window, at its first did-finish-load while active): the marker. */
export function noteHomeShown(): void {
  if (launchedNoted || !firstLaunch || !currentHome().writable) return
  launchedNoted = true
  const p = join(stateDir(), 'launched')
  writeWhole(p, JSON.stringify({ v: 1, at: Date.now(), app: app.getVersion() }) + '\n')
    .then(() => noteWrite(p, null), (e: NodeJS.ErrnoException) => { launchedNoted = false; noteWrite(p, e) })
}

/** A canvas the trust stream verified, or a new instance of one (`slot` null for a `port-<p>.json` canvas). */
export interface VerifiedCanvas { ws: string; root: string; name: string; origin: string; slot: number | null; port: number }

export function noteVerified(c: VerifiedCanvas): void {
  if (!c || typeof c !== 'object') return
  const e = {
    workspace: c.ws, root: c.root, name: (typeof c.name === 'string' ? c.name.slice(0, 199) : '') || c.ws, origin: c.origin,
    ...(c.slot === null ? { port: c.port } : {}), lastSeen: Date.now(),
  }
  // the launch's own rule: an entry it would refuse is never recorded, so it can never cost the others at launch
  if (!checkEntry(e)) return
  recent = tidyRecent([e, ...recent.filter((r) => r.workspace !== c.ws)])
  const held = early.get(c.ws)
  if (held) { early.delete(c.ws); noteLogo(c.ws, held) }
  save()
}

/** A canvas stopped: it was seen until now. */
export function noteGone(ws: string): void {
  const e = recent.find((r) => r.workspace === ws)
  if (!e) return
  e.lastSeen = Date.now()
  save()
}

/** At quit: every canvas still running was seen now; written at once. */
export function flushRecent(running: Iterable<string>): void {
  const now = Date.now()
  const r = new Set(running)
  for (const e of recent) if (r.has(e.workspace)) e.lastSeen = now
  if (r.size) writer?.set({ v: 1, canvases: recent })
  writer?.flushSync()
}

export const recentViews = (running: Iterable<string>): RecentView[] => {
  const run = [...running]
  const views = recentViewsOf(recent, run, homedir(), { logoOf: (ws) => { const k = wsKey(ws); return k ? logos.get(k) : undefined } })
  // a `marver://` link to a canvas that is not running (spec 31 D1): its card first - recorded or not - highlighted
  if (linked && !run.includes(linked.ws)) {
    const i = views.findIndex((v) => v.id === recentId(linked!.ws))
    if (i >= 0) views.unshift({ ...views.splice(i, 1)[0]!, linked: true })
    else views.unshift({ id: recentId(linked.ws), name: basename(linked.root) || linked.root, folder: tilde(linked.root, homedir()), lastSeen: 0, hue: hueOf(linked.ws), linked: true })
  }
  return views
}

/** A local canvas's logo, as its tab proved and fetched it (views.ts refreshLogo): kept for its Recently here card. */
export function noteLogo(ws: string, dataUrl: string): void {
  const k = wsKey(ws)
  if (!k) return
  if (recent.some((e) => e.workspace === ws)) { logos.keep(k, dataUrl); return }
  // proved before its canvas was recorded (the logo can land before the document's first trusted commit): held, and
  // kept once noteVerified records it - a few at most, the newest
  early.set(ws, dataUrl)
  while (early.size > 8) early.delete(early.keys().next().value!)
}
/** logos proved for canvases not recorded yet, by workspace */
const early = new Map<string, string>()

/** The canvas a `marver://` link named while it does not run (spec 31 D1): its card leads Recently here, highlighted. */
let linked: { ws: string; root: string } | null = null
/**
 * Home's card for that folder: its Recently here card, or - for a folder that exists and never ran here - a card of its
 * own with its start command. Answers the card's id for `home:focus`, or null (a folder that does not exist).
 */
export function showLinked(root: string, ws: string, exists: boolean): string | null {
  if (!exists && !recent.some((e) => e.workspace === ws)) { linked = null; return null }
  linked = { ws, root: recent.find((e) => e.workspace === ws)?.root ?? root }
  for (const fn of recentFns) fn()
  return recentId(ws)
}
export const recentEntries = (): RecentEntry[] => recent.map((e) => ({ ...e }))
export function onRecentChange(fn: () => void): () => void { recentFns.add(fn); return () => recentFns.delete(fn) }

// ---- home:action ------------------------------------------------------------------------------------------------

/** The folder of a running canvas's tab whose card offers an update (views.ts sets it): `copy-update`'s. */
let updateRootOf: ((tabId: string) => string | undefined) | null = null
export function setUpdateRoots(fn: ((tabId: string) => string | undefined) | null): void { updateRootOf = fn }

/** `home:action`: main copies its own command, or opens the folder. Checked again here. */
export async function homeAction(raw: unknown): Promise<HomeActionAnswer> {
  const a = raw as { action?: unknown; id?: unknown } | null
  if (!a || typeof a !== 'object') return { ok: false }
  if (a.action === 'copy' && typeof a.id === 'string' && Object.hasOwn(FIXED_COMMANDS, a.id)) {
    effects.copy(FIXED_COMMANDS[a.id as keyof typeof FIXED_COMMANDS])
    return { ok: true }
  }
  if (a.action === 'copy-start' && typeof a.id === 'string' && a.id.length < 80 && a.id.startsWith('r_')) {
    const e = recent.find((r) => recentId(r.workspace) === a.id)
    const root = e?.root ?? (linked && recentId(linked.ws) === a.id ? linked.root : undefined)
    if (!root) return { ok: false }
    effects.copy(startCommand({ root, port: e?.port }))
    return { ok: true }
  }
  // spec 31 E4: a running canvas's update, in its own folder - main's record of the tab, never a path from Home
  if (a.action === 'copy-update' && typeof a.id === 'string' && a.id.length < 80) {
    const root = updateRootOf?.(a.id)
    if (!root) return { ok: false }
    effects.copy(updateCommand(root))
    return { ok: true }
  }
  if (a.action === 'show-files') { settingsReveal(); return { ok: true } }
  return { ok: false }
}

// ---- link:open --------------------------------------------------------------------------------------------------

/** What `openLink` needs of the registry entry on a port. */
export interface LinkEntry { state: string; origin: string | null; port: number; ws: string; name: string }

/** What `openLink` needs of the tabs (the window stream builds it; ports.ts `HomePorts.openLink`). */
export interface LinkPorts {
  /** the registry's live entry on that port (`starting`, `ready`), else undefined */
  byPort(port: number): LinkEntry | undefined
  /**
   * Open it in that canvas's tab - found or made by the tabs' own rules, activated. `url` is the link rebuilt on the
   * entry's bound origin and checked here (same origin, no credentials, under 2 KB, the shell's own document:
   * `/` or `/index.html`), so the tabs do not check it again; `rest` is its path, query and hash. Duties:
   * - `url` null (the entry is `starting`): keep `rest` as the tab's path and load it at `ready` (A2.14 #24); `ok`.
   * - the tab is not verified (its proof failed, `unverified`): load nothing, answer `not-canvas`.
   * - only the hash differs from the tab's current document: a same-document navigation, no guard.
   * - otherwise `guard(tab, { kind: 'load', url })`: `done` is `ok`, `refused` is `refused`.
   */
  open(entry: LinkEntry, url: string | null, rest: string): Promise<LinkOpenAnswer>
  /**
   * A4 (A4.6 #39): an https link as `parseLink` gives it - its origin's remote tab, found or made by the tabs' own
   * rules and activated (the remote stream's). Its answer passes through; never `later`.
   */
  openRemote(url: string): Promise<LinkOpenAnswer>
}

/** `link:open { url }` from the strip or Home (A2.7): checked again in main, never loading the host it wrote. */
export async function openLink(raw: unknown, ports: LinkPorts): Promise<LinkOpenAnswer> {
  const r = raw as { url?: unknown } | null
  const s = r && typeof r === 'object' ? r.url : undefined
  if (typeof s !== 'string' || s.length >= LINK_MAX) return { ok: false, why: 'bad' }
  const p = parseLink(s)
  if (p.kind === 'bad') return { ok: false, why: 'bad' }
  if (p.kind === 'https') return ports.openRemote(p.url)   // shared canvases: A4.4
  const e = ports.byPort(p.port)
  if (!e || (e.state !== 'ready' && e.state !== 'starting')) return { ok: false, why: 'nothing' }
  if (e.state === 'starting' || !e.origin) return ports.open(e, null, p.rest)
  let url: URL
  let bound: string
  try { url = new URL(p.rest, e.origin); bound = new URL(e.origin).origin } catch { return { ok: false, why: 'bad' } }
  const rest = `${url.pathname}${url.search}${url.hash}`
  // the canvas's own page alone: any other document on its port is cancelled by the proof (A2.14 #11)
  if (url.origin !== bound || url.username || url.password || url.href.length >= LINK_MAX || shellPath(rest) !== rest) return { ok: false, why: 'bad' }
  return ports.open(e, url.href, rest)
}

// ---- the pages' channels, mounted once at ready ---------------------------------------------------------------

/**
 * At ready, once the bridge and the tabs exist (ports.ts): `home:action`, `link:open`, `settings:get`, `settings:set`
 * as invokes and `settings:reveal` as a send; `home:info` and `recent` to Home, `status` to Settings, at each page's
 * `app:ready` and on every change; the files pill to the window's feed. Answers what undoes it (tests).
 */
export function mountPages(bridge: PageBridge, w: WindowPorts): () => void {
  bridge.handle(CH.homeAction, (_c, p) => homeAction(p))
  bridge.handle(CH.linkOpen, (_c, p) => openLink(p, w.linkPorts))
  bridge.handle(CH.settingsGet, () => settingsView())
  bridge.handle(CH.settingsSet, (_c, p) => settingsSet(p))
  bridge.handle(CH.settingsReveal, () => { settingsReveal() })
  let info = ''
  const pushInfo = (force = false) => {
    const i = homeInfo()
    const j = JSON.stringify(i)
    if (!force && j === info) return
    info = j
    bridge.send('home', CH.homeInfo, i)
  }
  const pushRecent = () => { bridge.send('home', CH.recent, recentViews(w.running())) }
  const pushShared = () => { bridge.send('home', CH.shared, sharedLinks()) }
  const offs = [
    bridge.onReady((ctx) => {
      if (ctx.kind === 'home') { pushInfo(true); pushRecent(); pushShared() }
      else if (ctx.kind === 'settings') bridge.send('settings', CH.status, filesStatus())
    }),
    onRecentChange(pushRecent),
    onSharedChange(pushShared),
    w.onRunningChange(pushRecent),
    onStatus((s) => { bridge.send('settings', CH.status, s); pushInfo() }),
    onPill((p) => w.setFilesPill(p)),
  ]
  return () => { for (const off of offs) off() }
}

/** The contract the other streams call (ports.ts). */
export const homePorts = {
  startHome, noteVerified, noteHomeShown, noteGone, isFirstLaunch, flushRecent, homeInfo, recentViews, onRecentChange,
  homeAction, openLink, mountPages,
} satisfies HomePorts

// ---- test hooks -------------------------------------------------------------------------------------------------

function provideHomeHooks(): void {
  provide('home.info', () => homeInfo())
  provide('home.shown', () => { noteHomeShown(); return true })
  provide('home.verified', (a) => { noteVerified(a as VerifiedCanvas); return true })
  provide('home.gone', (a) => { noteGone(String((a as { ws?: unknown })?.ws)); return true })
  provide('home.views', (a) => recentViews(((a as { running?: string[] })?.running) ?? []))
  provide('home.entries', () => recentEntries())
  provide('home.action', (a) => homeAction(a))
  provide('home.flush', async (a) => { flushRecent(((a as { running?: string[] })?.running) ?? []); flushShared(); return true })
  provide('home.shared', () => sharedLinks())
  provide('home.link', (a) => {
    const o = a as { url: unknown; entries?: LinkEntry[]; answer?: LinkOpenAnswer }
    const opened: { url: string | null; rest: string }[] = []
    const remote: string[] = []
    return openLink({ url: o.url }, {
      byPort: (port) => o.entries?.find((e) => e.port === port),
      open: async (_e, url, rest) => { opened.push({ url, rest }); return o.answer ?? { ok: true } },
      openRemote: async (url) => { remote.push(url); return o.answer ?? { ok: true } },
    }).then((answer) => ({ answer, opened, remote }))
  })
}
