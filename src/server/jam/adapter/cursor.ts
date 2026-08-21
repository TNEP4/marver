/**
 * The Cursor adapter. Spawns `cursor-agent -p` headless with stream-json output - a
 * Claude-Code-shaped stream (system/init carries the model, assistant events carry complete
 * messages, a terminal `result` event carries the reply).
 *
 * The long binary name is deliberate: cursor's installer ships BOTH `cursor-agent` and a bare
 * `agent`, and grok's installer symlinks `agent` too - on a machine with both, the short name
 * is whichever installed last. `cursor-agent` is unambiguous.
 *
 * Jail: codex-parity, not claude-parity - cursor's print mode carries write AND shell
 * tools, and the CLI has no per-run flag that removes the shell outright. So the OS
 * sandbox is switched ON (`--sandbox enabled`, overriding any config that turned it off)
 * to bound what commands can touch, and `--force` is never passed, so nothing gets blanket
 * command approval. The packet carries untrusted text (synced collaborators' comments);
 * the sandbox is what stands between it and the machine.
 */
import { extractReanchors, extractReplyBlock } from '../packet.ts'
import type { JamAdapter } from '../types.ts'

const assistantText = (o: Record<string, any>): string | undefined => {
  if (o.type !== 'assistant') return undefined
  const t = (o.message?.content ?? []).find((c: any) => c?.type === 'text' && typeof c.text === 'string' && c.text.trim())
  return t ? String(t.text).trim() : undefined
}

export const cursorAdapter: JamAdapter = {
  name: 'cursor',
  supportsSubagents: false,
  spawnArgs(goal) {
    return { cmd: 'cursor-agent', args: ['-p', goal, '--output-format', 'stream-json', '--sandbox', 'enabled'] }
  },
  earlyText(line) {
    try {
      const o = JSON.parse(line) as Record<string, any>
      const text = assistantText(o)
      return text ? { text } : null
    } catch { return null }
  },
  parse(stdout, code) {
    let text = ''
    let lastAssistant = ''
    let model: string | undefined
    let failed = false
    for (const line of stdout.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const o = JSON.parse(t) as Record<string, any>
        if (o.type === 'result') {
          if (typeof o.result === 'string' && o.result.trim()) text = o.result.trim()
          if (o.is_error) failed = true
        } else if (o.type === 'system' && o.subtype === 'init' && typeof o.model === 'string' && o.model !== 'unknown') {
          model = o.model
        } else {
          const at = assistantText(o)
          if (at) lastAssistant = at
        }
      } catch { /* non-JSON line (unauthenticated CLIs print prose errors) - skip */ }
    }
    // a stream cut before its result event: the last assistant message is the best truth
    if (!text) text = lastAssistant
    // NO fallback to raw stdout: an error banner must never become a bogus reply.
    const { reply: visible, reanchors } = extractReanchors(text)
    const reply = extractReplyBlock(visible)
    return { reply, model, reanchors, ok: code === 0 && !failed && !!reply }
  },
}
