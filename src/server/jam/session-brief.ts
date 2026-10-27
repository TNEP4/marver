/**
 * What `marver jam next` prints for a session that takes a run (spec 29b): the request in the owner's own words,
 * the frames it may edit, and how to hand it back - a dozen lines, not the spawned agent's whole prompt. The session
 * already knows the contract (design/AGENTS.md, which its CLAUDE.md or AGENTS.md brings in); the full rules -
 * captures, re-pins, shared files - stay in design/instructions/jam.md for when a run needs them.
 */
import { requestWords } from './capture.ts'
import { packetPath, sanitize } from './packet.ts'
import type { JobPacket, Msg } from './types.ts'

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
    // several asks (tags joined, notes): the newest leads whole, the earlier ones after it, newest first - a later
    // correction is never clipped away behind a long first request
    const newest = (l: Msg[]) => [`the owner's newest words: ${quote(l[l.length - 1]?.body ?? '')}`,
      ...(l.length > 1 ? [`  (before that: ${quote(l.slice(0, -1).reverse().map((a) => a.body.replace(/^\s*@marver\b\s*/i, '')).join(' / '), 160)})`] : [])]
    const own = m.brief.asks
    if (m.brief.wrapup) {
      const w = m.brief.wrapup.content
      return [`- ${head}the session record: write it to ${w.file} - that file only, no design work.`,
        ...(w.instructions.trim() ? [`  The owner's instructions for it: ${quote(w.instructions)}`] : []),
        ...(w.more?.trim() ? [`  Their note on the record before (improve it by this): ${quote(w.more)}`] : [])]
    }
    if (!m.brief.capture) {
      if (own.length < 2) return [`- ${head}a tag on ${where}: ${quote(own[0]?.body ?? '')}`]
      const [lead, ...rest] = newest(own)
      return [`- ${head}a tag on ${where}, ${lead}`, ...rest]
    }
    // what was said and noted, then the notes added in its read-back (⇧E's pause to add context)
    const said = requestWords(m.brief.capture, ' / ')
    if (!own.length) return [`- ${head}a voice capture on ${where}: ${quote(said)}`]
    // the capture ran only if it was sent back with More work (its `mw-` note); a tag that joined it while it waited
    // (its frame reserved) is a clarification of a capture that never ran. A tag card on a capture's thread follows
    // one that ran - unless that capture was kept or dropped (its note says so)
    const ran = m.kind === 'capture' ? own.some((a) => a.id?.startsWith('mw-')) : !m.brief.capture.note
    // sent back again: the notes its last run already had are not asked again
    const before = new Set(ran ? (m.brief.follows?.asks ?? []).map((a) => a.id) : [])
    const fresh = own.filter((a) => !before.has(a.id))
    const [lead, ...rest] = newest(fresh.length ? fresh : own)
    // a capture sent back with More work: the owner's newest words lead; what was first said is context
    if (ran) return [`- ${head}more work on ${where}, ${lead}`, ...rest, `  (the capture it follows, done before: ${quote(said, 160)})`]
    if (m.brief.capture.note) return [`- ${head}a tag on ${where}, ${lead}`, ...rest, `  (the capture on its thread, ${m.brief.capture.note}: ${quote(said, 160)})`]
    return [`- ${head}a voice capture on ${where}, ${lead}`, ...rest, `  The capture they add to - not run yet, do it too: ${quote(said)}`]
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
