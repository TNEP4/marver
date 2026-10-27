/**
 * The Codex adapter. Spawns `codex exec --json`
 * workspace-jailed. Codex emits JSONL events (thread.started, item.completed, turn.completed);
 * the final agent_message is the reply.
 *
 * Subagents are ON: `codex exec` carries collaboration.spawn_agent / list_agents / wait_agent,
 * so a multi-frame job fans out the same way Claude Code's does. The job prompt only ever says
 * "you MAY", so an older codex without those tools simply works serially instead of failing.
 */
import { execFileSync } from 'node:child_process'
import { parseAgentText } from '../packet.ts'
import type { JamAdapter } from '../types.ts'

/** The MCP servers Codex would start for a run in `cwd` (`codex mcp list --json`: your config, the project's,
 *  plugins'), or null when it cannot say - then a run with MCP off leaves your config out entirely. */
export function codexMcpServers(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] | null {
  try {
    const out = execFileSync('codex', ['mcp', 'list', '--json'], { cwd, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'], env })
    const list = JSON.parse(out)
    if (Array.isArray(list)) return [...new Set(list.map((x: { name?: unknown }) => x?.name).filter((n): n is string => typeof n === 'string' && /^[A-Za-z0-9_-]+$/.test(n)))]
  } catch { /* said below */ }
  return null
}
export const codexAdapter: JamAdapter = {
  name: 'codex',
  supportsSubagents: true,
  forks: true,
  spawnArgs(goal, o) {
    // --skip-git-repo-check: the workspace may not be a git root; workspace-write jails edits.
    if (!o) return { cmd: 'codex', args: ['exec', '--json', '-s', 'workspace-write', '--skip-git-repo-check', goal] }
    // Full power (spec 29b, Part 1): Codex's own automatic reviewer answers the approvals a headless run
    // meets - an MCP call included, which `approval_policy = never` refuses - inside workspace-write.
    // `--approve-for-me` is those three settings; `exec fork` takes them as config.
    const review = ['-c', 'approvals_reviewer="auto_review"', '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"']
    // MCP off: each server Codex would start here turned off. When Codex cannot list them, the run is refused, not
    // started with servers you turned off still on.
    const listed = o.mcp ? [] : codexMcpServers(o.root)
    if (!listed) throw new Error('MCP servers are off for Jam runs, and Codex could not list them to turn them off - run `codex mcp list` here, or turn MCP back on in the start sheet')
    const mcpOff = listed.flatMap((n) => ['-c', `mcp_servers.${n}.enabled=false`])
    return o.fork
      ? { cmd: 'codex', args: ['exec', 'fork', o.fork, '--json', '--skip-git-repo-check', ...review, ...mcpOff, goal] }
      : { cmd: 'codex', args: ['exec', '--json', '--skip-git-repo-check', ...review, ...mcpOff, goal] }
  },
  earlyText(line) {
    try {
      const o = JSON.parse(line) as Record<string, any>
      if (o.type === 'item.completed' && o.item?.type === 'agent_message' && typeof o.item.text === 'string' && o.item.text.trim()) return { text: o.item.text.trim() }
    } catch { /* not JSON */ }
    return null
  },
  parse(stdout, code) {
    let text = ''
    let model: string | undefined
    let failed = false
    for (const line of stdout.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const o = JSON.parse(t) as Record<string, any>
        if (o.type === 'item.completed' && o.item?.type === 'agent_message' && typeof o.item.text === 'string') text = o.item.text.trim()
        else if (o.type === 'turn.failed' || o.type === 'error') failed = true
        if (typeof o.model === 'string') model = o.model
      } catch { /* non-JSON line (banner) - skip */ }
    }
    // NO fallback to raw stdout: a status-only or error stream must not become a bogus reply.
    const { reply, asks, reanchors, said } = parseAgentText(text)
    return { reply, model, asks, reanchors, said, ok: code === 0 && !failed && !!reply }
  },
}
