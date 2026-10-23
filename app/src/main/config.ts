/**
 * ~/.marver: the files (spec 28 A2.7, A2.12, A2.14 #23, #24). Owner: the home-and-files stream.
 *
 * SKELETON (ship stream): the contract and the least main.ts needs to start - the home and its crash-dump
 * folder, the files' defaults. Still to build: README.md and schemas/ written whole and repaired, state/
 * (state-dev/ in Marver Dev), the folder watch, the validator (settings-keys.ts), status.json, `settings:set`,
 * the first-launch marker, recent.json.
 */
import { mkdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { nativeTheme } from 'electron'

/** `MARVER_HOME` honoured, as the package does (slots.ts). */
export const marverHome = (): string => process.env.MARVER_HOME || join(homedir(), '.marver')

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

export const CONFIG_DEFAULTS: Config = { restoreTabs: true, unloadUnderPressure: true, recorder: true, dockBadge: true, keepPerfDays: 14 }
export const THEME_DEFAULTS: ThemeFile = { mode: 'system' }

export interface Files { config: Config; theme: ThemeFile; applied: boolean }

export interface Home {
  dir: string
  /** false when the folder cannot be written: the app runs on defaults with the files pill (A2.12) */
  writable: boolean
  /** state/ or, in Marver Dev, state-dev/ (A2.14 #23) */
  state: string
  /** perf/crashpad, 700 - made before crashReporter.start (A2.14 #24) */
  crashpad: string
}

/**
 * Made at every launch, before the window and before `crashReporter.start()` (A2.12). The skeleton makes
 * only the home (700, when missing) and perf/crashpad (700). Never writes config.json or theme.json.
 */
export function ensureHome(): Home {
  const dir = marverHome()
  const state = join(dir, __MARVER_RELEASE__ ? 'state' : 'state-dev')
  const crashpad = join(dir, 'perf', 'crashpad')
  let writable = true
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (const d of [join(dir, 'perf'), crashpad]) {
      mkdirSync(d, { recursive: true, mode: 0o700 })
      chmodSync(d, 0o700)
    }
  } catch { writable = false }
  return { dir, writable, state, crashpad }
}

/** The files' first read, before ready. The skeleton returns the defaults. */
export function readFiles(_home: Home): Files {
  return { config: { ...CONFIG_DEFAULTS }, theme: { ...THEME_DEFAULTS }, applied: true }
}

/** At ready: `theme.json`'s mode drives `nativeTheme.themeSource` (A2.7). */
export function applyTheme(files: Files): void {
  nativeTheme.themeSource = files.theme.mode
}
