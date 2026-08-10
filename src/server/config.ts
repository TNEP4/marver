import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface Viewport { width: number; height: number }
export interface ShConfig {
  mode: 'studio' | 'embedded'
  theme: string | null
  viewports: Record<string, Viewport>
  themes: string[]
  port: number
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
      port: typeof user.port === 'number' ? user.port : DEFAULTS.port,
    }
    return cfg
  } catch (err) {
    console.error(`[marver] design/config.ts failed to load, using defaults:\n  ${(err as Error).message}`)
    return { ...DEFAULTS }
  }
}

function validViewports(v: unknown): Record<string, Viewport> | null {
  if (!v || typeof v !== 'object') return null
  const out: Record<string, Viewport> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const vp = val as Partial<Viewport>
    if (typeof vp?.width === 'number' && typeof vp?.height === 'number') out[k] = { width: vp.width, height: vp.height }
  }
  return Object.keys(out).length ? out : null
}
