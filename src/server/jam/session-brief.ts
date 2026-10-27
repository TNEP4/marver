/**
 * What `marver jam next` prints for a session that takes a run (spec 29b): the request in the owner's own words,
 * the frames it may edit, and how to hand it back - a dozen lines, not the spawned agent's whole prompt. The session
 * already knows the contract (design/AGENTS.md, which its CLAUDE.md or AGENTS.md brings in); the full rules -
 * captures, re-pins, shared files - stay in design/instructions/jam.md for when a run needs them.
 */
import { captureWords, madeOf, wordsSince, wordsUntil } from './capture.ts'
import { packetPath, sanitize } from './packet.ts'
import type { JobPacket, PacketMember } from './types.ts'

const clip = (s: string, n: number) => { const t = sanitize(s, 4096).replace(/^\s*@marver\b\s*/i, '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }

/** The owner's words for a run, newest first, each with its kind - never what became of them (whether an earlier run
 *  did them is in the packet). Oldest to newest they come in the order they were said: the capture, its read-back
 *  notes, then tags and More-work notes in their order. A capture resumed after its read-back (⇧E, a note, Resume) is
 *  two parts - what was said before the pause, the notes written in it, then what was said after - so a correction
 *  spoken after the resume leads; edited, its edit stands for both parts, after those notes. A note is before the
 *  resume when its time is before the resumed capture's id (both the page's wall clock; the record's steps run on
 *  another, so they are split by `resumes.at` alone). */
const wordsOf = (m: PacketMember): { kind: string; text: string }[] => {
  const c = m.brief.capture
  const rs = c?.record.context?.resumes
  const from = c && rs ? madeOf(c.record.id) : 0
  const notes = (c?.added ?? []).map((a) => ({ kind: 'a read-back note', text: a.text, early: a.at < from }))
  const early = notes.filter((n) => n.early), late = notes.filter((n) => !n.early)
  const said = !c ? [] : rs && c.edited === undefined
    ? [{ kind: 'the capture', text: wordsUntil(c.record, rs.at) }, ...early, { kind: 'the capture, resumed', text: wordsSince(c.record, rs.at) }]
    : [...early, { kind: 'the capture', text: captureWords(c.record, c.edited) }]
  return [...said, ...late, ...m.brief.asks.map((a) => ({ kind: a.id?.startsWith('mw-') ? 'a More-work note' : 'a tag', text: a.body }))]
    .filter((w) => clip(w.text, Infinity)).reverse()
}

export function sessionBrief(packet: JobPacket, handle: string, as?: string): string {
  const jam = (op: string, rest = '') => `npx marver jam ${op} ${handle}${as ? ` --as ${as}` : ''}${rest}`
  const one = packet.members.length === 1
  // a session record: one file written from the packet - no thread to answer early in, no frame to edit
  const record = packet.members.every((m) => m.brief.wrapup)
  const files = packet.members.flatMap((m) => (m.brief.wrapup ? [m.brief.wrapup.content.file] : []))
  const asks = packet.members.flatMap((m) => {
    const at = `${one ? '' : `${m.id} `}on ${m.frames.join(', ') || 'the board'}`
    if (m.brief.wrapup) {
      const w = m.brief.wrapup.content
      return [`- ${one ? '' : `${m.id}, `}the session record: write it to ${w.file} - that file only, no design work.`,
        ...(w.instructions.trim() ? [`  The owner's instructions for it: "${clip(w.instructions, 1200)}"`] : []),
        ...(w.more?.trim() ? [`  Their note on the record before (improve it by this): "${clip(w.more, 1200)}"`] : [])]
    }
    // the newest whole (past ~1200 characters clipped), each earlier one short: a correction always leads
    const words = wordsOf(m).map((w, i) => `${w.kind}: "${clip(w.text, i ? 200 : 1200)}"`)
    if (words.length < 2) return [`- ${at}, ${words[0] ?? '(no words - see the packet)'}`]
    return [`- ${at}, the owner's words, newest first:`, ...words.map((w) => `  ${w}`)]
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
    `The thread, ${packet.members.some((m) => m.brief.capture) ? 'the capture\'s picks and pictures, ' : ''}and what earlier runs did: ${packetPath(packet.batchId)}`,
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
