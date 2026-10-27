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
  const asks = packet.members.map((m) => {
    const said = m.brief.capture ? captureWords(m.brief.capture.record, m.brief.capture.edited) : m.brief.asks.map((a) => a.body).join(' / ')
    const what = m.brief.wrapup ? 'the session record' : m.brief.capture ? 'a voice capture' : 'a tag'
    return `- ${one ? '' : `${m.id}, `}${what} on ${m.frames.join(', ') || 'the board'}: "${clip(sanitize(said, 4096)) || '(no words - see the packet)'}"`
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
