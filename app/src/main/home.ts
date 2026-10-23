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
 * Who calls what, and when, is the frozen contract in ports.ts (`HomePorts`): the trust stream calls `noteVerified`
 * (a tab's first trusted commit of each instance), the window stream `noteHomeShown`, `noteGone`, `isFirstLaunch`
 * and, in the quit path, `flushRecent`; the bridge mounts `homeAction` and `openLink` as invokes; the home page's
 * `recent` and `home:info` come from `recentViews()` and `homeInfo()`, pushed again on `onRecentChange`.
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { CH, type HomeActionAnswer, type HomeInfo, type LinkOpenAnswer, type RecentView } from '../shared/channels.ts'
import { FIXED_COMMANDS, startCommand, tilde } from '../shared/command.ts'
import { hueOf } from '../shared/hue.ts'
import { LINK_MAX, parseLink, shellPath } from '../shared/links.ts'
import { currentHome, filesStatus, noteWrite, onPill, onStatus, settingsReveal, settingsSet, settingsView, stateDir, stateFileWriter } from './config.ts'
import { effects } from './effects.ts'
import { readState, writeWhole, type StateWriter } from './fsx.ts'
import type { HomePorts, PageBridge, WindowPorts } from './ports.ts'
import { provide } from './testing/index.ts'

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

/** Recently here as Home draws it: every recorded canvas not running now, newest first. Pure. */
export function recentViewsOf(list: RecentEntry[], running: Iterable<string>, home = homedir()): RecentView[] {
  const now = new Set(running)
  return tidyRecent(list).filter((e) => !now.has(e.workspace)).map((e) => ({
    id: recentId(e.workspace), name: e.name, folder: tilde(e.root, home), lastSeen: e.lastSeen, hue: hueOf(e.workspace),
  }))
}

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

export const recentViews = (running: Iterable<string>): RecentView[] => recentViewsOf(recent, running)
export const recentEntries = (): RecentEntry[] => recent.map((e) => ({ ...e }))
export function onRecentChange(fn: () => void): () => void { recentFns.add(fn); return () => recentFns.delete(fn) }

// ---- home:action ------------------------------------------------------------------------------------------------

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
    if (!e) return { ok: false }
    effects.copy(startCommand({ root: e.root, port: e.port }))
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
}

/** `link:open { url }` from the strip or Home (A2.7): checked again in main, never loading the host it wrote. */
export async function openLink(raw: unknown, ports: LinkPorts): Promise<LinkOpenAnswer> {
  const r = raw as { url?: unknown } | null
  const s = r && typeof r === 'object' ? r.url : undefined
  if (typeof s !== 'string' || s.length >= LINK_MAX) return { ok: false, why: 'bad' }
  const p = parseLink(s)
  if (p.kind === 'bad') return { ok: false, why: 'bad' }
  if (p.kind === 'https') return { ok: false, why: 'later' }   // shared canvases: A4.4
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
  const offs = [
    bridge.onReady((ctx) => {
      if (ctx.kind === 'home') { pushInfo(true); pushRecent() }
      else if (ctx.kind === 'settings') bridge.send('settings', CH.status, filesStatus())
    }),
    onRecentChange(pushRecent),
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
  provide('home.flush', async (a) => { flushRecent(((a as { running?: string[] })?.running) ?? []); return true })
  provide('home.link', (a) => {
    const o = a as { url: unknown; entries?: LinkEntry[]; answer?: LinkOpenAnswer }
    const opened: { url: string | null; rest: string }[] = []
    return openLink({ url: o.url }, {
      byPort: (port) => o.entries?.find((e) => e.port === port),
      open: async (_e, url, rest) => { opened.push({ url, rest }); return o.answer ?? { ok: true } },
    }).then((answer) => ({ answer, opened }))
  })
}
