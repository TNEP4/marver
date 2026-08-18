/**
 * The Codex adapter (SPEC-live-jam §3.3, Validated Architecture). Spawns `codex exec --json`
 * workspace-jailed. Codex emits JSONL events (thread.started, item.completed, turn.completed);
 * the final agent_message is the reply. Codex has no in-process subagents, so a Codex job edits
 * its frames sequentially - correct, just no parallel-frame glow within one job.
 */
import { extractReanchors } from '../packet.ts'
import type { JamAdapter } from '../types.ts'

export const codexAdapter: JamAdapter = {
  name: 'codex',
  supportsSubagents: false,
  spawnArgs(goal) {
    // --skip-git-repo-check: the workspace may not be a git root; workspace-write jails edits.
    return { cmd: 'codex', args: ['exec', '--json', '-s', 'workspace-write', '--skip-git-repo-check', goal] }
  },
  parse(stdout, code) {
    let text = ''
    let model: string | undefined
    for (const line of stdout.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const o = JSON.parse(t) as Record<string, any>
        if (o.type === 'item.completed' && o.item?.type === 'agent_message' && typeof o.item.text === 'string') text = o.item.text.trim()
        if (typeof o.model === 'string') model = o.model
      } catch { /* non-JSON line (banner) - skip */ }
    }
    const { reply, reanchors } = extractReanchors(text || stdout.trim())
    return { reply, model, reanchors, ok: code === 0 && !!reply }
  },
}
