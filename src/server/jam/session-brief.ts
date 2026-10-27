/**
 * What `marver jam next` prints for a session that takes a run (spec 29b): the request in the owner's own words,
 * the frames it may edit, and how to hand it back - a dozen lines, not the spawned agent's whole prompt. The session
 * already knows the contract (design/AGENTS.md, which its CLAUDE.md or AGENTS.md brings in); the full rules -
 * captures, re-pins, shared files - stay in design/instructions/jam.md for when a run needs them.
 */
import { requestWords } from './capture.ts'
import { packetPath, sanitize } from './packet.ts'
import type { JobPacket } from './types.ts'

const LINE = 280
const clip = (s: string, n = LINE) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }

export function sessionBrief(packet: JobPacket, handle: string, as?: string): string {
  const jam = (op: string, rest = '') => `npx marver jam ${op} ${handle}${as ? ` --as ${as}` : ''}${rest}`
  const one = packet.members.length === 1
  // a session record: one file written from the packet - no thread to answer early in, no frame to edit
  const record = packet.members.every((m) => m.brief.wrapup)
  const files = packet.members.flatMap((m) => (m.brief.wrapup ? [m.brief.wrapup.content.file] : []))
  const asks = packet.members.flatMap((m) => {
    const where = m.frames.join(', ') || 'the board'
    const head = one ? '' : `${m.id}, `
    const quote = (t: string, n?: number) => `"${clip(sanitize(t, 4096).replace(/^\s*@marver\b\s*/i, ''), n) || '(no words - see the packet)'}"`
    const asked = m.brief.asks.map((a) => a.body).join(' / ')
    if (m.brief.wrapup) {
      const w = m.brief.wrapup.content
      return [`- ${head}the session record: write it to ${w.file} - that file only, no design work.`,
        ...(w.instructions.trim() ? [`  The owner's instructions for it: ${quote(w.instructions)}`] : []),
        ...(w.more?.trim() ? [`  Their note on the record before (improve it by this): ${quote(w.more)}`] : [])]
    }
    if (!m.brief.capture) return [`- ${head}a tag on ${where}: ${quote(asked)}`]
    // what was said and noted, then the notes added in its read-back (⇧E's pause to add context)
    const said = requestWords(m.brief.capture, ' / ')
    // a capture sent back with More work: the owner's newest words lead; what was first said is context
    if (asked) return [`- ${head}more work on ${where}, the owner's newest words: ${quote(m.brief.asks[m.brief.asks.length - 1]!.body)}`, `  (the capture it follows, done before: ${quote(said, 160)})`]
    return [`- ${head}a voice capture on ${where}: ${quote(said)}`]
  })
  if (record) return [
    `Live Jam run ${handle} - the owner's request from the canvas.`,
    ...asks,
    `The captures and talk it is written from: ${packetPath(packet.batchId)}`,
    '',
    'Do it in this session, then:',
    `1. Write your reply to a file - ONE or TWO plain sentences on what the record says:`,
    ...packet.members.map((m) => `   \`\`\`marver-reply ${m.id}\n   The record ...\n   \`\`\``),
    `2. ${jam('done', ' --file <that file>')} - the canvas posts it.`,
    `A long run: ${jam('progress')} every few minutes. Cannot do it now: ${jam('release')}.`,
    `Edit nothing but ${files.join(', ')}. The full rules: design/instructions/jam.md, "Runs from the canvas".`,
  ].join('\n')
  return [
    `Live Jam run ${handle} - the owner's request from the canvas.`,
    ...asks,
    `Frames you may edit: ${packet.frames.join(', ') || '(none)'}${packet.exclusive ? `; and these shared files: ${packet.exclusive.files.join(', ')}` : ''}.`,
    `${packet.members.some((m) => m.brief.capture) ? 'The capture (words, picks, notes), thread and history' : 'The thread and its history'}: ${packetPath(packet.batchId)}`,
    '',
    'Do it in this session, then:',
    ...(one ? [`1. One line to the owner now: ${jam('say', ' "On it - ..."')}`] : []),
    `${one ? '2' : '1'}. Write your reply to a file, one block per request, plain text, about as long as the ask:`,
    ...packet.members.map((m) => `   \`\`\`marver-reply ${m.id}\n   Done - ...\n   \`\`\``),
    `   Need an answer from the owner first? Open the block with \`\`\`marver-reply ${packet.members[0]?.id ?? 'm1'} asks instead.`,
    `${one ? '3' : '2'}. ${jam('done', ' --file <that file>')} - the canvas posts it and frees the frames.`,
    `A long run: ${jam('progress')} every few minutes. Cannot do it now: ${jam('release')}.`,
    'Edit only those frames. Captures, re-pins and shared files: design/instructions/jam.md, "Runs from the canvas".',
  ].join('\n')
}
