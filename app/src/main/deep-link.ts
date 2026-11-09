/**
 * `marver://` links into the app (spec 31 D1). The scheme is the app's alone: registered by the packaged app
 * (`CFBundleURLTypes`, build.mjs) and claimed at launch (`setAsDefaultProtocolClient`, release builds only - a dev build
 * never takes it from the app Nic uses). A link arrives as `open-url` (macOS, also before ready, at a cold start) or in
 * a second instance's argv; either way it is queued here until the registry and the tabs are ready, then routed.
 *
 *   marver://open?ws=<folder>&to=<hash>[&port=<p>]      (shared/deep-link.ts: written with URLSearchParams, 2 KB max)
 *
 * The routing (`planDeepLink`, pure):
 * - `ws` is realpath-canonicalised and must equal a running registry entry's folder; the `port` hint picks among the
 *   canvases of that folder only - a port reused by another canvas is never opened for this link;
 * - `to` is the hash grammar or nothing (the canvas's default board) - never a URL, never script;
 * - a canvas whose tab holds no live document opens one at that place through `openInTab` (the document proof and the
 *   guards; nothing to lose); a tab already open is never reloaded or hash-replaced by main: it is activated and the
 *   shell gets the navigation command over the bridge (tabs.ts `showForLink`), so a draft is never lost;
 * - a folder with no canvas running: Home, that canvas's card highlighted with its start command.
 */
import { createHash } from 'node:crypto'
import { hashOfTarget, parseDeepLink, type DeepLink, type ShowTarget } from '../../../src/shared/deep-link.ts'

/** What the router needs of a registry entry (registry.ts `RegistryEntry`, its `root` already its real path). */
export interface LinkCanvas { ws: string; root: string; port: number; slot: number | null; state: string; origin: string | null; name: string }

export type DeepPlan =
  /** a canvas of that folder runs: open or show there (`to` null: its default board) */
  | { kind: 'canvas'; entry: LinkCanvas }
  /** no canvas of that folder runs: Home, its card (its workspace id, from the real path) */
  | { kind: 'home'; root: string; ws: string; exists: boolean }

/** The app's workspace id of a real folder: the first 16 hex of its sha256 (src/server/workspace.ts `workspaceId`). */
export const workspaceOf = (real: string): string => createHash('sha256').update(real).digest('hex').slice(0, 16)

/**
 * Where a link goes (pure). `real` is `link.ws` through realpath (null: it does not resolve). Only an entry of that
 * same real folder, `ready` or `starting`, is ever chosen; the `port` hint picks that port's entry only when it is one
 * of them; else the first ready one, else the first starting one, in the registry's order.
 */
export function planDeepLink(link: DeepLink, real: string | null, entries: readonly LinkCanvas[]): DeepPlan {
  const root = real ?? link.ws
  const mine = real ? entries.filter((e) => e.root === real && (e.state === 'ready' || e.state === 'starting')) : []
  if (!mine.length) return { kind: 'home', root, ws: workspaceOf(root), exists: real !== null }
  const hinted = link.port !== undefined ? mine.find((e) => e.port === link.port) : undefined
  return { kind: 'canvas', entry: hinted ?? mine.find((e) => e.state === 'ready') ?? mine[0]! }
}

/** The most links held before the app is ready; past it the oldest go (a burst of clicks wants the last). */
export const QUEUE_MAX = 8

export interface LinkQueue {
  /** a link heard (`open-url`, argv): handled now when ready, else held */
  push(raw: unknown): void
  /** the registry and the tabs exist: every held link handled, in order, and each later one at once */
  ready(handle: (raw: string) => void): void
  /** held now (tests) */
  held(): string[]
}

/** Links heard before the app can route them, kept in order and handled once it can (a cold start's link). */
export function createLinkQueue(max = QUEUE_MAX): LinkQueue {
  const held: string[] = []
  let handler: ((raw: string) => void) | null = null
  const run = (raw: string) => { try { handler!(raw) } catch (err) { process.stderr.write(`marver-app: a link failed: ${(err as Error).message}\n`) } }
  return {
    push(raw) {
      if (typeof raw !== 'string' || raw.length > 4096) return
      if (handler) { run(raw); return }
      held.push(raw)
      while (held.length > max) held.shift()
    },
    ready(handle) {
      handler = handle
      for (const raw of held.splice(0)) run(raw)
    },
    held: () => [...held],
  }
}

/** What routing a link needs of the app (views.ts builds them from the registry, the tabs and Home). */
export interface RoutePorts<T> {
  entries(): LinkCanvas[]
  /** realpath, or null when it does not resolve */
  realpath(p: string): string | null
  /** the window forward (every routed link) */
  focus(): void
  /** the canvas's local tab, if the app has one */
  tabFor(e: LinkCanvas): T | undefined
  /** the tab holds a live document (tabs.ts `liveDoc`), proved: what a load would replace */
  live(t: T): boolean
  /** a tab with a live document: shown the place over the bridge (tabs.ts `showForLink`) - never reloaded */
  show(t: T, to: ShowTarget | null): void
  /** no live document: the place loaded through views.ts `openInTab` (the proof and the guards) */
  open(e: LinkCanvas, url: string | null, rest: string): void
  /** no canvas of that folder runs: Home, its card */
  home(root: string, ws: string, exists: boolean): void
}

/** One link, parsed and routed (spec 31 D1). Answers what was done. */
export function routeDeepLink<T>(raw: unknown, p: RoutePorts<T>): 'bad' | 'home' | 'opened' | 'shown' {
  const link = parseDeepLink(raw)
  if (!link) return 'bad'
  const real = p.realpath(link.ws)
  const entries = p.entries().map((e) => ({ ...e, root: p.realpath(e.root) ?? e.root }))
  const plan = planDeepLink(link, real, entries)
  p.focus()
  if (plan.kind === 'home') { p.home(plan.root, plan.ws, plan.exists); return 'home' }
  const e = plan.entry
  const t = p.tabFor(e)
  if (t !== undefined && p.live(t)) { p.show(t, link.to); return 'shown' }
  const rest = `/${link.to ? hashOfTarget(link.to) : ''}`
  let url: string | null = null
  if (e.state === 'ready' && e.origin) { try { url = `${new URL(e.origin).origin}${rest}` } catch { url = null } }
  p.open(e, url, rest)
  return 'opened'
}
