/**
 * The Claude Code adapter (SPEC-live-jam §3.3, Validated Architecture). Spawns
 * `claude -p` headless with STREAM-JSON output, so the daemon can post the agent's first
 * message the moment it exists (the real quick ack / clarifying question - not a canned fake),
 * and the final `result` event as the completion reply.
 */
import { extractReanchors, extractReplyBlock } from '../packet.ts'
import type { JamAdapter } from '../types.ts'

/** First key of an object, or undefined. */
const firstKey = (o: unknown): string | undefined =>
  o && typeof o === 'object' ? Object.keys(o as object)[0] : undefined

const cleanModel = (raw: unknown): string | undefined =>
  typeof raw === 'string' ? raw.replace(/\[[^\]]*\]$/, '') || undefined : undefined   // drop the [1m] variant tag

export const claudeAdapter: JamAdapter = {
  name: 'claude',
  supportsSubagents: true,
  spawnArgs(goal) {
    // No Bash AT ALL - not even Bash(curl:*): the packet carries untrusted text (incl. synced
    // collaborators' comments), and curl -d is a one-line exfiltration channel for anything Read
    // can see (Codex pre-publish P0). WebSearch/WebFetch stay for craft (reference designs, brand
    // SVG paths to inline); binary asset download is a P2 that needs a jailed fetch path.
    // stream-json (requires --verbose) lets the daemon deliver the agent's first line live.
    return {
      cmd: 'claude',
      args: ['-p', goal, '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write,Glob,Grep,WebSearch,WebFetch', '--output-format', 'stream-json', '--verbose'],
    }
  },
  earlyText(line) {
    try {
      const o = JSON.parse(line) as Record<string, any>
      if (o.type !== 'assistant') return null
      const text = (o.message?.content ?? []).find((c: any) => c?.type === 'text' && typeof c.text === 'string' && c.text.trim())
      return text ? String(text.text).trim() : null
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
    const { reply: visible, reanchors } = extractReanchors(text)
    const reply = extractReplyBlock(visible)
    return { reply, model, reanchors, ok: code === 0 && !failed && !!reply }
  },
}
