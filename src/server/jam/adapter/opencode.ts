/**
 * The opencode adapter. Spawns `opencode run --format json` headless - NDJSON events where
 * finalized text parts are `{"type":"text","part":{type:"text",text}}` and errors are
 * `{"type":"error","error":{name,data}}`. The LAST text part is the reply.
 *
 * Jail: headless opencode auto-REJECTS permission asks, and its `--auto` flag approves
 * everything including arbitrary shell - so neither default works. The OPENCODE_PERMISSION
 * env var (verified: it merges over the user's config for this one process) is DEFAULT-DENY
 * with an explicit allowlist - so an unnamed or future tool is denied, not defaulted open.
 * `--pure` runs without external plugins, which execute code OUTSIDE the tool-permission
 * layer (a repo could otherwise ship a plugin the daemon's spawn would load and run).
 * Claude-parity: edits yes, shell no. Subagents inherit it (verified live).
 *
 * opencode's stream names NO model in any event (verified against its schema) - so replies
 * carry the harness without a model, same honest gap as codex. Never faked.
 */
import { extractReanchors, extractReplyBlock } from '../packet.ts'
import type { JamAdapter } from '../types.ts'

const textPart = (o: Record<string, any>): string | undefined =>
  o.type === 'text' && typeof o.part?.text === 'string' && o.part.text.trim() ? String(o.part.text).trim() : undefined

export const opencodeAdapter: JamAdapter = {
  name: 'opencode',
  supportsSubagents: true,
  spawnArgs(goal) {
    return {
      cmd: 'opencode',
      args: ['run', '--pure', '--format', 'json', goal],
      env: { OPENCODE_PERMISSION: '{"*":"deny","read":"allow","edit":"allow","glob":"allow","grep":"allow","list":"allow","ls":"allow","webfetch":"allow","websearch":"allow","task":"allow","todowrite":"allow","todoread":"allow"}' },
    }
  },
  earlyText(line) {
    try {
      const text = textPart(JSON.parse(line) as Record<string, any>)
      return text ? { text } : null
    } catch { return null }
  },
  parse(stdout, code) {
    // The reply is the LAST assistant message - which can arrive as SEVERAL finalized text
    // parts sharing one messageID (text, tool call, more text). Group by message, keep the
    // final group whole; taking just the last part would truncate a multi-part answer.
    let msgId: string | undefined
    let parts: string[] = []
    let failed = false
    for (const line of stdout.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const o = JSON.parse(t) as Record<string, any>
        const part = textPart(o)
        if (part) {
          const id = typeof o.part?.messageID === 'string' ? o.part.messageID : undefined
          if (id !== msgId) { msgId = id; parts = [] }
          parts.push(part)
        } else if (o.type === 'error') failed = true
      } catch { /* non-JSON line (banner) - skip */ }
    }
    // NO fallback to raw stdout: a status-only or error stream must not become a bogus reply.
    const { reply: visible, reanchors } = extractReanchors(parts.join('\n\n'))
    const reply = extractReplyBlock(visible)
    return { reply, reanchors, ok: code === 0 && !failed && !!reply }
  },
}
