import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { detectAgent, onPath, type JamAgent } from './jam/agent.ts'

export interface Viewport { width: number; height: number }
/** Live Jam: the dev-server daemon config, already RESOLVED - present means armed.
 *  It arms itself: see `resolveJam`. */
export interface JamConfig {
  agent: JamAgent              // which CLI the daemon spawns
  concurrency: number          // frames worked on at once (default 6)
  subagents: boolean           // fan-out one subagent per frame (default true)
  proactive: boolean           // P2, inert in v1: act on the owner's untagged backlog (default false)
}
export interface ShConfig {
  mode: 'studio' | 'embedded'
  theme: string | null
  viewports: Record<string, Viewport>
  themes: string[]
  port: number
  /** Canvas zoom multiplier: 1 = default feel, 1.2 = 20% faster, 0.8 = 20% slower. */
  zoomSpeed: number
  /** Publish options: branding=false removes the gate page footer.
   *  name/logo override the auto-detected gate identity (host package.json name;
   *  design/logo.svg|png → public/logo.* → public/favicon.svg → the Marver mark). */
  share: { branding: boolean; name?: string; logo?: string }
  /** Live Jam daemon. On by default with the detected agent; `jam: false` in
   *  design/config.ts is the off switch. Undefined = off - `jamOff` says why. */
  jam?: JamConfig
  /** Why jam is not armed, set only when `jam` is undefined. `no-agent` is the one state
   *  nothing else has already reported, so it is the one the dev server speaks up about. */
  jamOff?: 'no-agent' | 'opted-out' | 'bad-agent' | 'unreadable'
}

export const DEFAULTS: ShConfig = {
  mode: 'studio',
  theme: null,
  viewports: {
    mobile: { width: 390, height: 844 },
    tablet: { width: 768, height: 1024 },
    laptop: { width: 1280, height: 800 },
    monitor: { width: 1920, height: 1080 },
    // tv intentionally not a default - the scaffolded config ships it commented out
  },
  themes: ['light', 'dark'],
  port: 5199,
  zoomSpeed: 1,
  share: { branding: true },
}

/** Load design/config.ts via native TS import (Node >= 22.18). Missing or broken fields fall back to defaults. */
export async function loadConfig(root: string): Promise<ShConfig> {
  const file = join(root, 'design', 'config.ts')
  if (!existsSync(file)) return { ...DEFAULTS, ...jamFields(undefined) }
  try {
    // Cache-bust so a restart after edits picks up changes.
    const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`)
    const user = (mod.default ?? {}) as Partial<ShConfig>
    const cfg: ShConfig = {
      ...DEFAULTS,
      ...user,
      viewports: validViewports(user.viewports) ?? DEFAULTS.viewports,
      themes: Array.isArray(user.themes) && user.themes.length ? user.themes.map(String) : DEFAULTS.themes,
      port: validPort(user.port) ?? DEFAULTS.port,
      zoomSpeed: validZoom(user.zoomSpeed) ?? DEFAULTS.zoomSpeed,
      share: {
        branding: (user.share as { branding?: unknown } | undefined)?.branding !== false,
        name: typeof (user.share as any)?.name === 'string' ? (user.share as any).name : undefined,
        logo: typeof (user.share as any)?.logo === 'string' ? (user.share as any).logo : undefined,
      },
      ...jamFields(user.jam),
    }
    return cfg
  } catch (err) {
    console.error(`[marver] design/config.ts failed to load, using defaults and leaving Live Jam OFF:\n  ${(err as Error).message}`)
    // Live Jam stays OFF here, unlike the missing-file case: a config we could not parse
    // may well have said `jam: false`, and arming a process spawn against intent we cannot
    // read is the one wrong-way error worth avoiding. Fix the file and it comes back.
    return { ...DEFAULTS, jamOff: 'unreadable' }
  }
}

const validDim = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= 20000

function validPort(n: unknown): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 65536 ? n : null
}

function validZoom(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0.1 && n <= 10 ? n : null
}

/** Six frames at once is what a jam actually feels like - at 3, half of a multi-frame
 *  ask sat waiting on the other half while the human watched. */
const DEFAULT_CONCURRENCY = 6

/** A config value, printable in a warning. Never throws - a formatter that can crash inside an
 *  error path (JSON.stringify does, on a BigInt) turns a clear message into a mystery. */
const show = (v: unknown): string => { try { return JSON.stringify(v) ?? String(v) } catch { return String(v) } }

/** A `{...}` written by hand, not a Date/Map/class instance that merely types as "object". */
const plainObject = (v: unknown): boolean => {
  if (!v || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** The agent to arm with - or, when the human NAMED one we cannot use, why not (said once,
 *  here, because a bad `jam.agent` is a config-file error like any other).
 *
 *  A named agent is never quietly swapped for another: running a different tool than the one
 *  asked for is worse than not running. Nor is one armed that cannot be spawned - that would
 *  claim every @marver mention, fail it, and never retry. */
function resolveAgent(named: unknown): JamAgent | 'no-agent' | 'bad-agent' {
  if (named === undefined) return detectAgent() ?? 'no-agent'
  if (named !== 'claude' && named !== 'codex') {
    console.warn(`[marver] design/config.ts: jam.agent ${show(named)} is not an agent marver can spawn - Live Jam is off. Use "claude" or "codex".`)
    return 'bad-agent'
  }
  if (!onPath(named)) {
    console.warn(`[marver] design/config.ts names jam.agent "${named}", which is not on PATH - Live Jam is off until it is installed.`)
    return 'bad-agent'
  }
  return named
}

/** Resolve the jam block. Live Jam is ON by default: an absent or partial `jam` resolves
 *  to whatever agent CLI this machine has, so a fresh workspace jams with nothing
 *  configured and an old one needs no re-init. `jam: false` is the off switch. */
function resolveJam(v: unknown): JamConfig | ShConfig['jamOff'] {
  if (v === false) return 'opted-out'
  // Four shapes are `jam`: absent, `true`, an agent name, or an options object. Anything else
  // (null, 0, an array) is a mistake, and a mistake in the block that spawns processes gets the
  // same fail-closed treatment as a config that would not parse at all.
  // `jam: "codex"` is the shorthand a human reaches for - read it as NAMING the agent, so a typo
  // there gets an honest warning instead of silently detecting some other tool.
  const shape = v === undefined || v === true ? {}
    : typeof v === 'string' ? { agent: v }
    : plainObject(v) ? v
    : null
  if (!shape) {
    console.warn(`[marver] design/config.ts: jam must be false, an agent name, or an options object - got ${show(v)}. Live Jam is off.`)
    return 'bad-agent'
  }
  const j = shape as Partial<JamConfig>
  const agent = resolveAgent(j.agent)
  if (agent === 'no-agent' || agent === 'bad-agent') return agent
  const c = j.concurrency
  return {
    agent,
    concurrency: typeof c === 'number' && Number.isInteger(c) && c >= 1 && c <= 16 ? c : DEFAULT_CONCURRENCY,
    subagents: j.subagents !== false,   // default on
    proactive: j.proactive === true,    // default off (and inert in v1)
  }
}

/** Exactly one of `jam` (armed) or `jamOff` (why not) - so the dev server can speak up about
 *  the one off-state nothing has reported yet, and stay quiet about the rest. BOTH keys are
 *  always written: these spread over the user's own `jam`, and a raw `jam: false` reaching the
 *  server as config would arm the daemon against a truthy object check. */
function jamFields(v: unknown): Pick<ShConfig, 'jam' | 'jamOff'> {
  const r = resolveJam(v)
  return typeof r === 'string' ? { jam: undefined, jamOff: r } : { jam: r, jamOff: undefined }
}

function validViewports(v: unknown): Record<string, Viewport> | null {
  if (!v || typeof v !== 'object') return null
  const out: Record<string, Viewport> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const vp = val as Partial<Viewport>
    if (validDim(vp?.width) && validDim(vp?.height)) out[k] = { width: Math.round(vp.width), height: Math.round(vp.height) }
  }
  return Object.keys(out).length ? out : null
}
