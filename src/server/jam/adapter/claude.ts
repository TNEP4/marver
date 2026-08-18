/**
 * The Claude Code adapter (SPEC-live-jam §3.3, Validated Architecture). Spawns
 * `claude -p` headless, workspace-jailed (acceptEdits, a bounded tool set, never full
 * access), and reads the JSON envelope: `.result` is the agent's final message (its reply).
 * The model id lives under `modelUsage` (verified against claude 2.1.234, e.g.
 * `claude-opus-5[1m]`); we strip the `[..]` context-variant tag for a clean tooltip value.
 */
import { extractReanchors } from '../packet.ts'
import type { JamAdapter } from '../types.ts'

/** First key of an object, or undefined. */
const firstKey = (o: unknown): string | undefined =>
  o && typeof o === 'object' ? Object.keys(o as object)[0] : undefined

export const claudeAdapter: JamAdapter = {
  name: 'claude',
  supportsSubagents: true,
  spawnArgs(goal) {
    // No open Bash: acceptEdits + a full shell is not a workspace jail (SPEC §1). But great design
    // needs the web: WebSearch/WebFetch for reference designs + brand assets, and a NARROW
    // Bash(curl:*) so images can be downloaded into the workspace. Owner-gated triggers + the
    // human reviewing every diff are the trust boundary; this widens capability, not authority.
    return {
      cmd: 'claude',
      args: ['-p', goal, '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write,Glob,Grep,WebSearch,WebFetch,Bash(curl:*)', '--output-format', 'json'],
    }
  },
  parse(stdout, code) {
    let text = stdout.trim()
    let model: string | undefined
    try {
      const j = JSON.parse(stdout) as Record<string, any>
      if (typeof j.result === 'string') text = j.result.trim()
      const raw = (typeof j.model === 'string' ? j.model : undefined) ?? j.canonicalModel ?? firstKey(j.modelUsage)
      model = typeof raw === 'string' ? raw.replace(/\[[^\]]*\]$/, '') || undefined : undefined   // drop the [1m] variant tag
    } catch { /* not JSON (older CLI / error) - fall back to raw stdout as the reply */ }
    const { reply, reanchors } = extractReanchors(text)
    return { reply, model, reanchors, ok: code === 0 && !!reply }
  },
}
