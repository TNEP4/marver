/**
 * What `marver jam next` prints for a session that takes a run (spec 29b): the request in the owner's own words,
 * the frames it may edit, and how to hand it back - a dozen lines, not the spawned agent's whole prompt. The session
 * already knows the contract (design/AGENTS.md, which its CLAUDE.md or AGENTS.md brings in); the full rules -
 * captures, re-pins, shared files - stay in design/instructions/jam.md for when a run needs them.
 */
import { captureWords } from './capture.ts'
import { packetPath, sanitize } from './packet.ts'
import type { JobPacket } from './types.ts'

const LINE = 280
const clip = (s: string, n = LINE) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }

export function sessionBrief(packet: JobPacket, handle: string, as?: string): string {
  const jam = (op: string, rest = '') => `npx marver jam ${op} ${handle}${as ? ` --as ${as}` : ''}${rest}`
  const one = packet.members.length === 1
  const asks = packet.members.flatMap((m) => {
    const where = m.frames.join(', ') || 'the board'
    const head = one ? '' : `${m.id}, `
    const quote = (t: string, n?: number) => `"${clip(sanitize(t, 4096), n) || '(no words - see the packet)'}"`
    const asked = m.brief.asks.map((a) => a.body).join(' / ')
    if (m.brief.wrapup) return [`- ${head}the session record: ${quote(asked || 'write the session record - the packet holds the captures')}`]
    if (!m.brief.capture) return [`- ${head}a tag on ${where}: ${quote(asked)}`]
    const said = captureWords(m.brief.capture.record, m.brief.capture.edited)
    // a capture sent back with More work: the owner's newest words lead; what was first said is context
    if (asked) return [`- ${head}more work on ${where}, the owner's newest words: ${quote(m.brief.asks[m.brief.asks.length - 1]!.body)}`, `  (the capture it follows, done before: ${quote(said, 160)})`]
    return [`- ${head}a voice capture on ${where}: ${quote(said)}`]
  })
  return [
    `Live Jam run ${handle} - the owner's request from the canvas.`,
    ...asks,
    `Frames you may edit: ${packet.frames.join(', ') || '(none - a session record: its one file)'}${packet.exclusive ? `; and these shared files: ${packet.exclusive.files.join(', ')}` : ''}.`,
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
