/**
 * The pi adapter (the pi coding agent). Spawns `pi -p --mode json` headless - NDJSON events
 * where `message_end` carries each finished message and the terminal `agent_end` carries the
 * authoritative full transcript. The reply is the last assistant text in `agent_end`
 * (falling back to the last `message_end` when the stream was cut before it).
 *
 * Jail: pi has NO runtime permission system - the tool allowlist IS the jail, so bash is
 * simply not on the list: read/edit/write/grep/find/ls. Claude-parity - edits yes, shell no
 * (the packet carries untrusted text; a shell is an exfiltration channel).
 * `--no-extensions --no-skills` keeps the headless run to those built-ins: extensions load
 * arbitrary code outside the allowlist, which has no place in an unattended spawn.
 */
import { extractReanchors, extractReplyBlock } from '../packet.ts'
import type { JamAdapter } from '../types.ts'

/** Assistant text + model of one message object (message_end payload or agent_end member). */
const assistantText = (m: unknown): { text: string; model?: string; error?: boolean } | null => {
  const msg = m as Record<string, any>
  if (!msg || msg.role !== 'assistant') return null
  const content = Array.isArray(msg.content) ? msg.content : []
  const text = content
    .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: any) => String(c.text).trim()).filter(Boolean).join('\n\n')
  if (!text && !msg.errorMessage) return null
  return {
    text,
    model: typeof msg.model === 'string' && msg.model ? msg.model : undefined,
    error: Boolean(msg.errorMessage) || msg.stopReason === 'error',
  }
}

export const piAdapter: JamAdapter = {
  name: 'pi',
  supportsSubagents: false,
  spawnArgs(goal) {
    return { cmd: 'pi', args: ['-p', '--mode', 'json', '--no-extensions', '--no-skills', '--tools', 'read,edit,write,grep,find,ls', goal] }
  },
  earlyText(line) {
    try {
      const o = JSON.parse(line) as Record<string, any>
      if (o.type !== 'message_end') return null
      const a = assistantText(o.message)
      return a?.text && !a.error ? { text: a.text, model: a.model } : null
    } catch { return null }
  },
  parse(stdout, code) {
    let last: { text: string; model?: string; error?: boolean } | null = null
    let fromEnd = false
    let failed = false
    for (const line of stdout.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const o = JSON.parse(t) as Record<string, any>
        if (o.type === 'agent_end' && Array.isArray(o.messages)) {
          // authoritative transcript: the last assistant message wins outright
          for (let i = o.messages.length - 1; i >= 0; i--) {
            const a = assistantText(o.messages[i])
            if (a) { last = a; fromEnd = true; break }
          }
        } else if (o.type === 'message_end' && !fromEnd) {
          const a = assistantText(o.message)
          if (a) last = a
        } else if (o.type === 'error') failed = true
      } catch { /* non-JSON line (auth prose) - skip */ }
    }
    if (last?.error) failed = true
    // NO fallback to raw stdout: pi prints auth errors as prose; prose is never a reply.
    const { reply: visible, reanchors } = extractReanchors(last?.text ?? '')
    const reply = extractReplyBlock(visible)
    return { reply, model: last?.model, reanchors, ok: code === 0 && !failed && !!reply }
  },
}
