/**
 * The Claude Code adapter. Spawns
 * `claude -p` headless with STREAM-JSON output, so the daemon can post the agent's first
 * message the moment it exists (the real quick ack / clarifying question - not a canned fake),
 * and the final `result` event as the completion reply.
 */
import { parseAgentText } from '../packet.ts'
import type { JamAdapter } from '../types.ts'

/** First key of an object, or undefined. */
const firstKey = (o: unknown): string | undefined =>
  o && typeof o === 'object' ? Object.keys(o as object)[0] : undefined

/** What no Jam run reads, whoever asks: keys and credentials. */
export const SECRETS = ['~/.ssh/**', '~/.aws/**', '~/.gnupg/**', '~/.config/gcloud/**', '~/.netrc', '~/.npmrc', '~/Library/Keychains/**']

const cleanModel = (raw: unknown): string | undefined =>
  typeof raw === 'string' ? raw.replace(/\[[^\]]*\]$/, '') || undefined : undefined   // drop the [1m] variant tag

export const claudeAdapter: JamAdapter = {
  name: 'claude',
  supportsSubagents: true,
  forks: true,
  spawnArgs(goal, o) {
    // Full power (spec 29b, Part 1): Bash runs inside Claude Code's own sandbox (writes in the repo only, no
    // network, keys unreadable, no way out of it), edits in the repo are accepted, and every other question
    // the run would ask - an MCP tool, a skill, the web, an edit outside the repo - goes to `marver jam
    // permit`, which allows what a Jam run may do and refuses the rest. A headless run can never ask anyone,
    // and Claude Code takes no wildcard over every MCP server, so the permission tool is what lets your
    // servers work here at all.
    // stream-json (requires --verbose) lets the daemon deliver the agent's first line live.
    if (!o) return { cmd: 'claude', args: ['-p', goal, '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write,Glob,Grep,WebSearch,WebFetch', '--disallowedTools', 'Bash', '--output-format', 'stream-json', '--verbose'] }
    const settings = {
      sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
      permissions: { deny: [...SECRETS.map((p) => `Read(${p})`), ...(o.skills ? [] : ['Skill'])] },
    }
    const permit = { mcpServers: { 'marver-jam': { command: o.marver?.cmd ?? 'npx', args: [...(o.marver?.args ?? ['marver']), 'jam', 'permit'], env: { MARVER_JAM_PERMIT: JSON.stringify({ root: o.root, mcp: o.mcp, skills: o.skills }) } } } }
    return {
      cmd: 'claude',
      args: ['-p', goal, '--permission-mode', 'acceptEdits', '--settings', JSON.stringify(settings),
        '--mcp-config', JSON.stringify(permit), ...(o.mcp ? [] : ['--strict-mcp-config']), ...(o.skills ? [] : ['--disable-slash-commands']), '--permission-prompt-tool', 'mcp__marver-jam__decide',
        ...(o.fork ? ['--resume', o.fork, '--fork-session'] : []),
        '--output-format', 'stream-json', '--verbose'],
    }
  },
  // a capture's short name: Haiku, no tools at all, no MCP servers, nothing kept - one answer in plain text
  namerArgs(prompt) {
    // (hooks off too: a hook of yours never sees the draft's words through this call)
    return { cmd: 'claude', args: ['-p', prompt, '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}', '--no-session-persistence', '--output-format', 'text'] }
  },
  earlyText(line) {
    try {
      const o = JSON.parse(line) as Record<string, any>
      if (o.type !== 'assistant') return null
      const text = (o.message?.content ?? []).find((c: any) => c?.type === 'text' && typeof c.text === 'string' && c.text.trim())
      // the assistant event names its model - carry it so the ack's tooltip matches the final's
      return text ? { text: String(text.text).trim(), model: cleanModel(o.message?.model) } : null
    } catch { return null }
  },
  parse(stdout, code) {
    let text = ''
    let model: string | undefined
    let failed = false
    let sawEvents = false
    for (const line of stdout.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const o = JSON.parse(t) as Record<string, any>
        sawEvents = true
        if (o.type === 'result') {
          if (typeof o.result === 'string') text = o.result.trim()
          if (o.is_error) failed = true
          model ??= cleanModel(firstKey(o.modelUsage))
        } else if (o.type === 'assistant') {
          model ??= cleanModel(o.message?.model)
        }
      } catch { /* non-JSON line - skip */ }
    }
    if (!text) {
      // fallback: the old single-JSON envelope (no `type` field), or raw text from an ancient CLI.
      // A typed stream that ended without a result (killed mid-run) stays empty -> not ok.
      try {
        const j = JSON.parse(stdout) as Record<string, any>
        if (typeof j.result === 'string') text = j.result.trim()
        model ??= cleanModel((typeof j.model === 'string' ? j.model : undefined) ?? j.canonicalModel ?? firstKey(j.modelUsage))
      } catch { if (!sawEvents) text = stdout.trim() }
    }
    const { reply, asks, reanchors, said } = parseAgentText(text)
    return { reply, model, asks, reanchors, said, ok: code === 0 && !failed && !!reply }
  },
}
