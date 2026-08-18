import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface Viewport { width: number; height: number }
/** Live Jam (SPEC-live-jam): the dev-server daemon config. `agent` unset = Live Jam off. */
export interface JamConfig {
  agent?: 'claude' | 'codex'   // which CLI the daemon spawns; unset = off
  concurrency: number          // frames built at once within a batch (default 3)
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
  /** Publish options (SPEC-M2 §4): branding=false removes the gate page footer.
   *  name/logo override the auto-detected gate identity (host package.json name;
   *  design/logo.svg|png → public/logo.* → public/favicon.svg → the Marver mark). */
  share: { branding: boolean; name?: string; logo?: string }
  /** Live Jam daemon; undefined until the user opts in with a `jam.agent`. */
  jam?: JamConfig
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
  if (!existsSync(file)) return { ...DEFAULTS }
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
      jam: validJam(user.jam),
    }
    return cfg
  } catch (err) {
    console.error(`[marver] design/config.ts failed to load, using defaults:\n  ${(err as Error).message}`)
    return { ...DEFAULTS }
  }
}

const validDim = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= 20000

function validPort(n: unknown): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 65536 ? n : null
}

function validZoom(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0.1 && n <= 10 ? n : null
}

/** Normalize the jam block. An unknown/missing `agent` means Live Jam stays OFF (returns undefined),
 *  so a stray `jam: {}` never silently arms the daemon. Other fields fall back to lean defaults. */
function validJam(v: unknown): JamConfig | undefined {
  if (!v || typeof v !== 'object') return undefined
  const j = v as Partial<JamConfig>
  if (j.agent !== 'claude' && j.agent !== 'codex') return undefined
  const concurrency = typeof j.concurrency === 'number' && Number.isInteger(j.concurrency) && j.concurrency >= 1 && j.concurrency <= 16 ? j.concurrency : 3
  return {
    agent: j.agent,
    concurrency,
    subagents: j.subagents !== false,   // default on
    proactive: j.proactive === true,    // default off (and inert in v1)
  }
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
