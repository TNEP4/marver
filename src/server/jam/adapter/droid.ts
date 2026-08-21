/**
 * The Factory droid adapter. Spawns `droid exec -o stream-json` headless - a
 * Claude-Code-shaped stream (system/init carries the model, a terminal `result` event
 * carries the reply and `is_error`). Factory marks stream-json deprecated but it works
 * (v0.200.0); parse() also reads the `-o json` single-envelope shape, so if a future droid
 * drops the stream the switch is one argv word, not a parser rewrite.
 *
 * Jail: `--auto low` approves file creation/edit, and `--disabled-tools` then REMOVES the
 * shell (`Execute`) and the outbound connectors (Slack posting, connector search) outright -
 * the packet carries untrusted text, and both are exfiltration channels. Tool names come
 * from droid's own `--list-tools` (v0.200.0). Claude-parity: edits yes, shell no.
 */
import { extractReanchors, extractReplyBlock } from '../packet.ts'
import type { JamAdapter } from '../types.ts'

export const droidAdapter: JamAdapter = {
  name: 'droid',
  // Enforced by the disabled-tools list (Task + the mission tools), not just this prompt
  // hint: whether a child would inherit the jail is unproven, so no children exist at all.
  supportsSubagents: false,
  spawnArgs(goal) {
    return {
      cmd: 'droid',
      args: ['exec', '-o', 'stream-json', '--auto', 'low', '--disabled-tools', 'Execute,Task,ProposeMission,StartMissionRun,GenerateDroid,slack_post_message,slack_post_file,ConnectorSearch', '--disable-builtin-skills', goal],
    }
  },
  earlyText(line) {
    try {
      const o = JSON.parse(line) as Record<string, any>
      if (o.type !== 'assistant') return null
      const t = (o.message?.content ?? []).find((c: any) => c?.type === 'text' && typeof c.text === 'string' && c.text.trim())
      return t ? { text: String(t.text).trim() } : null
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
        } else if (o.type === 'system' && o.subtype === 'init' && typeof o.model === 'string') {
          model = o.model
        } else if (o.type === 'error') {
          failed = true
        }
      } catch { /* non-JSON line - skip */ }
    }
    if (!sawEvents) {
      // the `-o json` single envelope: {"type":"result","subtype":"success","result":...}
      try {
        const j = JSON.parse(stdout) as Record<string, any>
        if (typeof j.result === 'string') text = j.result.trim()
        if (j.is_error) failed = true
      } catch { /* raw prose (no auth, crash banner) - never a reply */ }
    }
    const { reply: visible, reanchors } = extractReanchors(text)
    const reply = extractReplyBlock(visible)
    return { reply, model, reanchors, ok: code === 0 && !failed && !!reply }
  },
}
