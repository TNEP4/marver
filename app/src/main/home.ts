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
 *   is rebuilt on that entry's bound origin - the host the link wrote is never loaded. Opening it is the tabs'
 *   (`LinkPorts.open`), through A2.2's guard when it changes more than the hash.
 *
 * The trust and window streams call `noteVerified` (a tab verified, or a new instance) and `noteGone`; the bridge
 * mounts `homeAction` and `openLink`; the home page's `recent` and `home:info` come from `recentViews()` and
 * `homeInfo()`, pushed again on `onRecentChange`.
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { HomeActionAnswer, HomeInfo, LinkOpenAnswer, RecentView } from '../shared/channels.ts'
import { FIXED_COMMANDS, startCommand, tilde } from '../shared/command.ts'
import { hueOf } from '../shared/hue.ts'
import { LINK_MAX, parseLink } from '../shared/links.ts'
import { currentHome, noteWrite, settingsReveal, stateDir, stateFileWriter } from './config.ts'
import { effects } from './effects.ts'
import { readState, writeWhole, type StateWriter } from './fsx.ts'
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

/** recent.json's shape (pure). */
export function checkRecent(v: unknown): v is RecentFile {
  const f = v as RecentFile
  if (!f || typeof f !== 'object' || f.v !== 1 || !Array.isArray(f.canvases) || f.canvases.length > RECENT_MAX) return false
  return f.canvases.every((e) => !!e && typeof e === 'object'
    && typeof e.workspace === 'string' && WS.test(e.workspace)
    && typeof e.root === 'string' && e.root.startsWith('/') && e.root.length < 4096 && !e.root.includes('\0')
    && typeof e.name === 'string' && e.name.length > 0 && e.name.length < 200
    && typeof e.origin === 'string' && ORIGIN.test(e.origin)
    && (e.port === undefined || (Number.isInteger(e.port) && e.port > 0 && e.port < 65536))
    && Number.isFinite(e.lastSeen))
}

/** Newest first, at most 20, one per workspace. Pure. */
export function tidyRecent(list: RecentEntry[]): RecentEntry[] {
  const seen = new Set<string>()
  return [...list].sort((a, b) => b.lastSeen - a.lastSeen).filter((e) => !seen.has(e.workspace) && !!seen.add(e.workspace)).slice(0, RECENT_MAX)
}

/** Recently here as Home draws it: every recorded canvas not running now, newest first. Pure. */
export function recentViewsOf(list: RecentEntry[], running: Iterable<string>, home = homedir()): RecentView[] {
  const now = new Set(running)
  return tidyRecent(list).filter((e) => !now.has(e.workspace)).map((e) => ({
    id: `r:${e.workspace}`, name: e.name, folder: tilde(e.root, home), lastSeen: e.lastSeen, hue: hueOf(e.workspace),
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
  recent = tidyRecent(loaded.filter((e) => isDir(e.root)))
  writer = state ? stateFileWriter<RecentFile>('recent.json') : undefined
  if (recent.length !== loaded.length) save()
  if (__MV_TEST__) provideHomeHooks()
}

function save(): void {
  writer?.set({ v: 1, canvases: recent })
  for (const fn of recentFns) fn()
}

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
  if (!WS.test(c.ws) || !c.root.startsWith('/') || !ORIGIN.test(c.origin)) return
  const e: RecentEntry = {
    workspace: c.ws, root: c.root, name: c.name.slice(0, 199) || c.ws, origin: c.origin,
    ...(c.slot === null ? { port: c.port } : {}), lastSeen: Date.now(),
  }
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
  if (a.action === 'copy-start' && typeof a.id === 'string' && a.id.length < 80 && a.id.startsWith('r:')) {
    const e = recent.find((r) => r.workspace === a.id!.toString().slice(2))
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

export interface LinkPorts {
  /** the registry's live entry on that port (`starting`, `ready`), else undefined */
  byPort(port: number): LinkEntry | undefined
  /**
   * Open it in that canvas's tab (the window stream): `url` is the link rebuilt on the entry's bound origin and
   * checked, or null while the entry is `starting` (keep `rest` as the tab's path, load it at `ready`, A2.14 #24).
   * A link that changes more than the hash goes through `guard(tab, { kind: 'load', url })`; `refused` when it
   * refuses, `not-canvas` when that tab's proof failed.
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
  try { url = new URL(p.rest, e.origin) } catch { return { ok: false, why: 'bad' } }
  if (url.origin !== new URL(e.origin).origin || url.username || url.password || url.href.length >= LINK_MAX) return { ok: false, why: 'bad' }
  return ports.open(e, url.href, p.rest)
}

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
