/**
 * The Claude Code adapter (SPEC-live-jam §3.3, Validated Architecture). Spawns
 * `claude -p` headless, workspace-jailed (acceptEdits, a bounded tool set, never full
 * access), and reads the JSON envelope: `.result` is the agent's final message (its reply),
 * and the model id rides `canonicalModel` (validated in the overnight spike).
 */
import type { JamAdapter } from '../types.ts'

export const claudeAdapter: JamAdapter = {
  name: 'claude',
  supportsSubagents: true,
  spawnArgs(goal) {
    return {
      cmd: 'claude',
      args: ['-p', goal, '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write,Bash', '--output-format', 'json'],
    }
  },
  parse(stdout, code) {
    let reply = stdout.trim()
    let model: string | undefined
    try {
      const j = JSON.parse(stdout) as Record<string, any>
      if (typeof j.result === 'string') reply = j.result.trim()
      model = j.canonicalModel ?? j.model ?? (j.modelUsage && typeof j.modelUsage === 'object' ? Object.keys(j.modelUsage)[0] : undefined)
    } catch { /* not JSON (older CLI / error) - fall back to raw stdout as the reply */ }
    return { reply, model, ok: code === 0 && !!reply }
  },
}
