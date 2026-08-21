/**
 * Every agent CLI Live Jam can spawn, by config name. One entry per file; the daemon looks
 * up `adapters[cfg.agent]`, and detection order lives in agent.ts - this map is the "how",
 * that list is the "which first".
 */
import type { JamAgent } from '../agent.ts'
import type { JamAdapter } from '../types.ts'
import { claudeAdapter } from './claude.ts'
import { codexAdapter } from './codex.ts'
import { cursorAdapter } from './cursor.ts'
import { droidAdapter } from './droid.ts'
import { grokAdapter } from './grok.ts'
import { opencodeAdapter } from './opencode.ts'
import { piAdapter } from './pi.ts'

export const adapters: Readonly<Record<JamAgent, JamAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  droid: droidAdapter,
  opencode: opencodeAdapter,
  grok: grokAdapter,
  pi: piAdapter,
}
