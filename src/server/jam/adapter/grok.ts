/**
 * The grok adapter (xAI's Grok Build CLI). Spawns `grok -p` headless with
 * streaming-messages-json - an Anthropic-Messages-shaped stream: system/init and assistant
 * frames name the model, a terminal `result` event carries the reply and `is_error`.
 *
 * Jail: `--disallowed-tools run_terminal_cmd` REMOVES the shell tool entirely (the packet
 * carries untrusted text; a shell is an exfiltration channel), then `--yolo` auto-approves
 * what remains - reads, edits - so the headless run never stalls on a permission prompt.
 * Deny rules and removed tools still hold under --yolo; this is claude-parity.
 *
 * grok injects NO env marker into processes it spawns (verified in the grok-build source),
 * so detection finds it by PATH order only - naming `jam: "grok"` in config always works.
 */
import { extractReanchors, extractReplyBlock } from '../packet.ts'
import type { JamAdapter } from '../types.ts'

const cleanModel = (raw: unknown): string | undefined =>
  typeof raw === 'string' && raw && raw !== 'unknown' ? raw : undefined

const assistantText = (o: Record<string, any>): string | undefined => {
  if (o.type !== 'assistant') return undefined
  const t = (o.message?.content ?? []).find((c: any) => c?.type === 'text' && typeof c.text === 'string' && c.text.trim())
  return t ? String(t.text).trim() : undefined
}

export const grokAdapter: JamAdapter = {
  name: 'grok',
  // Enforced by --no-subagents in the argv, not just this prompt hint: whether a child
  // would inherit the disallowed-tools jail is unproven, so no children exist at all.
  supportsSubagents: false,
  spawnArgs(goal) {
    return {
      cmd: 'grok',
      args: ['-p', goal, '--output-format', 'streaming-messages-json', '--yolo', '--no-subagents', '--disallowed-tools', 'run_terminal_cmd'],
    }
  },
  earlyText(line) {
    try {
      const o = JSON.parse(line) as Record<string, any>
      const text = assistantText(o)
      return text ? { text, model: cleanModel(o.message?.model) } : null
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
        } else if (o.type === 'system' && o.subtype === 'init') {
          model ??= cleanModel(o.model)
        } else {
          const at = assistantText(o)
          if (at) { lastAssistant = at; model ??= cleanModel(o.message?.model) }
        }
      } catch { /* non-JSON line (the CLI mirrors errors as prose) - skip */ }
    }
    if (!text) text = lastAssistant   // stream cut before its result event
    const { reply: visible, reanchors } = extractReanchors(text)
    const reply = extractReplyBlock(visible)
    return { reply, model, reanchors, ok: code === 0 && !failed && !!reply }
  },
}
