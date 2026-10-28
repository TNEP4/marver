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
  const notes = (c?.added ?? []).map((a) => ({ kind: 'a read-back note', text: a.text, at: a.at }))
  const before = (t: number) => notes.filter((n) => n.at <= t), after = (t: number) => notes.filter((n) => n.at > t)
  const said = !c ? []
    // edited in the read-back: as new as the edit among its notes (a note written after it is newer, one before older)
    : c.edited !== undefined && c.editedAt ? [...before(c.editedAt), { kind: 'the capture (your edit)', text: captureWords(c.record, c.edited) }, ...after(c.editedAt)]
    : rs && c.edited === undefined
      ? [{ kind: 'the capture', text: wordsUntil(c.record, rs.at) }, ...before(from - 1), { kind: 'the capture, resumed', text: wordsSince(c.record, rs.at) }, ...after(from - 1)]
      : [...before(from - 1), { kind: 'the capture', text: captureWords(c.record, c.edited) }, ...after(from - 1)]
  // tags and More-work notes in the order they were written - an edit makes one as new as the edit
  const asks = m.brief.asks.map((a, i) => ({ a, i, t: a.edited ?? a.ts ?? 0 })).sort((x, y) => x.t - y.t || x.i - y.i).map((x) => x.a)
  return [...said, ...asks.map((a) => ({ kind: a.id?.startsWith('mw-') ? 'a More-work note' : 'a tag', text: a.body }))]
    .filter((w) => clip(w.text, Infinity)).reverse()
}

/** A run of the same session this one shares a frame with (F4): its handle, the frames they share, what it is called. */
export interface Overlap { handle: string; frames: string[]; title: string }
export interface BriefOpts {
  /** the session's tool: Claude Code dispatches the run to a background subagent (F3); Codex and Cursor do it here */
  agent?: 'claude' | 'codex' | 'cursor'
  /** its connection id - what a command names (`--as`) when the session's id does not reach it */
  conn?: string
  overlaps?: Overlap[]
}

export function sessionBrief(packet: JobPacket, handle: string, as?: string, o: BriefOpts = {}): string {
  const jam = (op: string, rest = '') => `npx marver jam ${op} ${handle}${as ? ` --as ${as}` : ''}${rest}`
  const one = packet.members.length === 1
  // a session record: one file written from the packet - no thread to answer early in, no frame to edit
  const record = packet.members.every((m) => m.brief.wrapup)
  const files = packet.members.flatMap((m) => (m.brief.wrapup ? [m.brief.wrapup.content.file] : []))
  // several requests in one run: the one the owner added to last first, as the words within each (each still answered
  // in its own block) - a correction joins its request without moving it in the queue
  const last = (m: PacketMember) => Math.max(0, ...m.brief.asks.map((a) => a.edited ?? a.ts ?? 0), ...(m.brief.capture?.added ?? []).map((a) => a.at), m.brief.capture?.editedAt ?? 0, m.brief.capture ? madeOf(m.brief.capture.record.id) : 0)
  const asks = packet.members.map((m, i) => ({ m, i, t: last(m) })).sort((a, b) => b.t - a.t || b.i - a.i).map((x) => x.m).flatMap((m) => {
    const at = `${one ? '' : `${m.id} `}on ${m.frames.join(', ') || `board ${m.board}`}`
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
  // F5: a run that reserves no frame (a capture made on an empty board, a comment on the board itself) makes new ones
  const none = !packet.frames.length && !packet.exclusive?.files.length
  const board = packet.members[0]?.board ?? '<board>'
  const what = [
    ...asks,
    none ? 'It reserves no frame: make what it asks for as new frames, in a scene of their own if nothing on the board fits (a scene the run makes is its own, its _ files included).'
      : `Frames you may edit: ${packet.frames.join(', ') || '(none)'}${packet.exclusive ? `; and these shared files: ${packet.exclusive.files.join(', ')}` : ''}.`,
    `The thread, ${packet.members.some((m) => m.brief.capture) ? 'the capture\'s picks and pictures, ' : ''}and what earlier runs did: ${packetPath(packet.batchId)}`,
  ]
  const reply = [
    `Write your reply to a file, one block per request, plain text, about as long as the ask:`,
    ...packet.members.map((m) => `   \`\`\`marver-reply ${m.id}\n   Done - ...\n   \`\`\``),
    `   Need an answer from the owner first? Open the block with \`\`\`marver-reply ${packet.members[0]?.id ?? 'm1'} asks instead.`,
  ]
  const run = ` --run ${handle}${as ? ` --as ${as}` : ''}`
  const newFrame = none
    ? `Edit no frame that exists; each new frame goes on board ${board} with npx marver boards place ${board} <scene/frame> --after <scene/frame>${run} (on an empty board: npx marver boards pin ${board} <scene/frame>${run})`
    : `Edit only those frames; a new frame goes on the board with npx marver boards place <board> <scene/frame> --after <scene/frame>${run}`
  // F4: a run of this same session holds a frame of this one - whoever does it decides how the two meet
  const ov = o.overlaps ?? []
  const overlapping = ov.length ? `It overlaps your run${ov.length === 1 ? '' : 's'} ${ov.map((x) => `${x.handle} ("${x.title}") on ${x.frames.join(', ')}`).join('; ')}.` : ''
  if (o.agent === 'claude') {
    // the dispatcher (F3): a few lines for the session itself, then the worker's own prompt below the line - the
    // subagent it starts owns this handle, and never takes another run
    const n = (i: number) => `${i}.`
    return [
      `Live Jam run ${handle} from the owner's canvas - dispatch it, so you are free for the next request:`,
      'start ONE background subagent (Agent tool, run_in_background: true) whose prompt is everything below the line, plus what this conversation knows that matters for it.',
      `Then run \`npx marver jam next\` again until nothing waits, and end your turn. Dispatch every run, however small - the next request may be on its way, and it waits while you work. Only if you cannot start a background subagent, do it here by the same steps. Cannot take it: ${jam('release')}.`,
      ...(overlapping ? [`${overlapping.slice(0, -1)} - a subagent of yours may be editing ${ov.length === 1 ? 'it' : 'them'}. Your call, for speed and quality:`,
        'send this run to that subagent (SendMessage: do it after, or fold it in now - it answers both handles), or run it in parallel as a variant in a NEW frame placed beside it. Never two subagents on one frame.'] : []),
      '----',
      `You own Live Jam run ${handle} - the owner's request from their Marver canvas. Do it and hand it back yourself; never run \`jam next\` or take another run.`,
      ...what,
      ...(one ? [`${n(1)} One line to the owner now: ${jam('say', ' "On it - ..."')}`] : []),
      `${n(one ? 2 : 1)} Do the work (design/AGENTS.md; design/instructions/jam.md, "Runs from the canvas"). ${jam('progress')} every few minutes.`,
      `${n(one ? 3 : 2)} ${reply[0]}`, ...reply.slice(1),
      `${n(one ? 4 : 3)} ${jam('done', ' --file <that file>')} - the canvas posts it and frees the frames.`,
      `${newFrame}. A command that answers "the owner moved this run elsewhere": stop editing at once and run ${jam('release')}.`,
      ...(o.conn && !as ? [`A command that answers "this session is not connected": add --as ${o.conn}.`] : []),
    ].join('\n')
  }
  const tool = o.agent === 'codex' ? 'Codex' : o.agent === 'cursor' ? 'Cursor' : ''
  return [
    `Live Jam run ${handle} - the owner's request from the canvas.`,
    ...what,
    ...(overlapping ? [`${overlapping} Do it after ${ov.length === 1 ? 'that one' : 'those'}, or together with ${ov.length === 1 ? 'it' : 'them'} (answer every handle).`] : []),
    '',
    tool ? `Do it in this session (Marver gives ${tool} runs to it one at a time), then:` : 'Do it in this session, then:',
    ...(one ? [`1. One line to the owner now: ${jam('say', ' "On it - ..."')}`] : []),
    `${one ? '2' : '1'}. ${reply[0]}`, ...reply.slice(1),
    `${one ? '3' : '2'}. ${jam('done', ' --file <that file>')} - the canvas posts it and frees the frames.`,
    `A long run: ${jam('progress')} every few minutes. Cannot do it now: ${jam('release')}.`,
    `${newFrame}. Captures, re-pins and shared files: design/instructions/jam.md, "Runs from the canvas".`,
  ].join('\n')
}
