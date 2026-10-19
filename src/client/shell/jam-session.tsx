/**
 * The Jam session in the shell (spec 27, Part 5): `J` (or the Jam button) opens the start sheet; Start
 * begins the session - the microphone (if you said yes) hears its talk between captures; `J` again ends
 * it with the wrap-up sheet: every capture of the session with where it stands, your instructions to the
 * agent, whether to include what was said between captures - "Write the record" queues the record job,
 * "End without a record" just ends it. The record comes back as the run's last tile, reviewed in the focus
 * panel like a capture.
 *
 * The Jam button (between Laser and Tidy): the waveform at rest; the session's minutes while one runs (a
 * crossed microphone without one); a teal dot only while a capture records. Blue only on hover and press.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ROUTE } from '../const.ts'
import { setSessionEnding, useJamCapture } from './jam-capture.ts'
import { laneCards } from './jam-keys.ts'
import { useJamQueue, type JamCard } from './jam-queue.ts'
import { useJamUi } from './jam-state.ts'
import { JamStateIcon } from './jam-ui.tsx'
import { Marver, moreDraftOf, setMoreDraft } from './jam-panel.tsx'
import { useJamVoice, voiceSession, voiceSessionEnd, voiceSessionId } from './jam-voice.ts'
import { HARNESS } from './Comments.tsx'
import { ArrowRightIcon, CaretIcon, KeyboardIcon, MicrophoneIcon, MicrophoneSlashIcon, WarningIcon, WaveformIcon } from './icons.tsx'
import { Tip } from './Tip.tsx'
import { useSessionClock } from './jam-lane.tsx'
import { useStore } from './store.ts'

const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
const now = () => performance.timeOrigin + performance.now()

// ---- the session's moves -------------------------------------------------------------------------------

/** Why the last session move was refused (the server's words), for the one line that says so. */
let lastError: string | undefined
async function post(body: Record<string, unknown>, onAnswer?: (ok: boolean) => void): Promise<boolean> {
  const r = await fetch(`${ROUTE}/api/jam/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf() }, body: JSON.stringify(body) }).catch(() => null)
  lastError = r && !r.ok ? ((await r.json().catch(() => null)) as { error?: string } | null)?.error : r ? undefined : 'marver dev did not answer'
  // what the server's answer settles happens at once, never behind the refresh (which may be slow, and a push
  // may come first)
  try { onAnswer?.(!!r?.ok) } catch { /* the refresh still runs */ }
  await useJamQueue.getState().load()
  return !!r?.ok
}

/** Start a session: the dev server holds it (it survives a reload); the microphone hears its talk. */
export async function startSession(): Promise<boolean> {
  const id = `ses-${Date.now()}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`
  // this tab holds the session's microphone (a reload of it takes it back; other tabs never take it) - from
  // the moment the server has it: the push of it may come before the refresh
  // the talk starts once the queue shows the session - whichever comes first: the push (before the answer,
  // or after it), or the refresh; a session ended meanwhile never gets the microphone
  const hear = () => { if (useJamQueue.getState().session?.id === id && voiceSessionId() !== id) void voiceSession(id, now()) }
  const ok = await post({ action: 'start', id }, (ok) => {
    if (!ok) return
    try { sessionStorage.setItem(MIC_OWNER, id) } catch { /* this page only */ }
    useJamUi.getState().setSheet(null)
    // the session starts capturing at once - its first capture is under way as soon as it starts (its talk
    // begins when that capture ends)
    if (!useJamCapture.getState().current) useJamCapture.getState().start(undefined, id)
    hear()
  })
  if (!ok) { useStore.getState().toast('the session could not start - look again'); return false }
  useJamUi.getState().setSheet(null)
  hear()
  return true
}
/** The session whose microphone this tab holds (per tab: it survives a reload, not another tab). */
export const MIC_OWNER = 'mv-jam-session-mic'
export const holdsSessionMic = (id: string): boolean => { try { return sessionStorage.getItem(MIC_OWNER) === id } catch { return false } }

/** End the session - with a record (the wrap-up's instructions and talk switch), or without one. */
export async function endSession(write: { instructions: string; includeTalk: boolean } | null, onAnswer?: () => void): Promise<boolean> {
  const ses = useJamQueue.getState().session
  if (!ses) { useJamUi.getState().setSheet(null); return true }
  // never over a capture still recording, sealing or sending: it belongs in the session (and its record)
  const cap = useJamCapture.getState()
  if (cap.current || Object.keys(cap.caps).length || cap.unsent.length) {
    useStore.getState().toast(cap.current ? 'a capture is recording - end it first (E), then wrap up' : 'a capture is still being sent - a moment, then wrap up')
    return false
  }
  // from here until the server answers, no capture starts (the record must not miss it); the server also
  // refuses the record while a capture of the session is open in any tab
  setSessionEnding(true)
  // each try is its own: an older one finishing late (its refresh slow) never frees what a newer one holds
  const op = ++endingOp
  const mine = () => op === endingOp
  // the server's answer, acted on at once (not behind the refresh): captures may start again; refused, the
  // session goes on - its talk heard again in the tab that holds its microphone, and you are told why
  const answered = (ok: boolean) => {
    if (!mine()) return
    // ended: gone from this page at once - a capture started from here on is not the session's
    if (ok) useJamQueue.getState().forget(ses.id)
    setSessionEnding(false)
    onAnswer?.()
    if (ok) { useJamUi.getState().setSheet(null); return }
    if (useJamQueue.getState().session?.id === ses.id && holdsSessionMic(ses.id) && voiceSessionId() !== ses.id) void voiceSession(ses.id, now())
    useStore.getState().toast(write ? `the record could not be written - ${lastError ?? 'look again'}` : 'the session could not end - look again')
  }
  try {
    // the talk's last words first: they belong in the transcript the record reads
    await voiceSessionEnd()
    return write
      ? await post({ action: 'wrapup', id: ses.id, instructions: write.instructions, includeTalk: write.includeTalk, board: useStore.getState().board }, answered)
      : await post({ action: 'end', id: ses.id }, answered)
  } finally { if (mine()) setSessionEnding(false) }
}
/** The latest try at ending the session (each Write or End is one). */
let endingOp = 0


/** `J` (or the Jam button): at rest, the start sheet (again: closes it); in a session, the wrap-up - a
 *  capture recording ends first, and the wrap-up waits for its read-back to close. */
export function pressJ() {
  const ui = useJamUi.getState()
  if (!useJamQueue.getState().session) { ui.setSheet(ui.sheet === 'start' ? null : 'start'); return }
  if (ui.sheet === 'wrap' || ui.sheet === 'wrap-pending') { ui.setSheet(null); return }
  if (useJamCapture.getState().current) { useJamCapture.getState().end(); ui.setSheet('wrap-pending'); return }
  ui.setSheet('wrap')
}

// ---- the Jam button ----------------------------------------------------------------------------------------

/** The session's length in minutes, ticking. */


export function JamButton({ inPlay }: { inPlay?: boolean }) {
  const session = useJamQueue((s) => s.session)
  const recording = useJamCapture((s) => !!s.current)
  const sheet = useJamUi((s) => s.sheet)
  const voice = useJamVoice()
  const minutes = useSessionClock(session?.since)
  // off: no, blocked, no engine - or stopped (another tab has it, the connection went) while you said yes
  const micOff = voice.choice === 'no' || voice.denied || voice.server === 'unavailable' || (!!session && voice.choice === 'yes' && !voice.live && !recording)
  const state = recording ? 'rec' : session ? 'live' : 'idle'
  const label = session ? <><b>End the session</b><span>J</span></> : <><b>Jam session</b><span>J</span></>
  return (
    <Tip side="bottom" inv={inPlay} label={label}>
      <button className={`sh-pill-btn jm-jam${state !== 'idle' ? ` ${state}` : ''}${sheet === 'start' || sheet === 'wrap' ? ' press' : ''}`}
        data-jam-button={state} aria-label={session ? 'End the Jam session' : 'Jam session'} onClick={pressJ}>
        {/* the whole session reads as on: the dot pulses from start to end, between captures too */}
        {session || recording ? <i className="jm-live-dot" /> : <WaveformIcon size={16} />}
        {session && <span className="jm-clock">{minutes}</span>}
        {session && micOff && <MicrophoneSlashIcon size={14} className="jm-nomic" />}
      </button>
    </Tip>
  )
}

// ---- the start sheet -----------------------------------------------------------------------------------------

/** Jam's keys, one list: the shortcuts tooltip (the key table in jam-keys.ts is the source of truth). */
export const JAM_KEYS: [string, string][] = [
  ['Start a capture', 'S'], ['End it', 'E'], ['Drop it', 'esc'], ['Add a note', 'N'], ['Picture of the frame', 'I'],
  ['Resume a capture', 'R'], ['The captures', 'Q'], ['Open a capture', '⏎'], ['Keep it, not sent', 'K'], ['Review the next', 'V'], ['End the session', 'J'],
]

/** "Keyboard shortcuts": one row; hovering or focusing it shows every Jam key in one column, action then
 *  key, in the inverse theme. */
function ShortcutsRow() {
  const [on, setOn] = useState(false)
  return (
    <div className={`jm-sc-row${on ? ' hover' : ''}`} tabIndex={0} data-jam-shortcuts=""
      onMouseEnter={() => setOn(true)} onMouseLeave={() => setOn(false)} onFocus={() => setOn(true)} onBlur={() => setOn(false)}>
      <KeyboardIcon size={15} /><span>Keyboard shortcuts</span><span className="v">View<CaretIcon size={10} style={{ transform: 'rotate(-90deg)' }} /></span>
      {on && (
        <div className="jm-sctip" style={{ right: 'calc(100% + 18px)', top: -8 }} role="tooltip">
          <div className="hd">Jam keys</div>
          {JAM_KEYS.map(([a, k]) => <div key={a}>{a}<b>{k}</b></div>)}
        </div>
      )}
    </div>
  )
}

export function StartSheet({ style }: { style?: CSSProperties }) {
  const agent = useJamQueue((s) => s.agent)
  const voice = useJamVoice()
  const mic = voice.choice === 'yes' && voice.server !== 'unavailable' && !voice.denied
  const name = agent ? HARNESS[agent] ?? agent : null
  return (
    <div className="jm-panel jm-sheet" data-jam-sheet="start" style={style}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h3>Jam session</h3>
        <p>Start captures at once. Between captures the session stays on; S captures again, J wraps up.</p>
      </div>
      <div className="rows">
        <button className="row" data-jam-mic-switch={mic ? 'on' : 'off'} onClick={() => voice.setChoice(mic ? 'no' : 'yes')}>
          {mic ? <MicrophoneIcon size={15} /> : <MicrophoneSlashIcon size={15} />}
          <span>Microphone<br /><small>Words stay on this Mac</small></span>
          <span className="v">{mic ? 'On' : 'Off'}<i className={`jm-switch${mic ? ' on' : ''}`} /></span>
        </button>
        {name
          ? <div className="row"><ArrowRightIcon size={15} /><span>Hands work to</span><span className="v"><span className="jm-agent"><i />{name}</span></span></div>
          : <div className="note-line warn" style={{ margin: '4px 0' }}><WarningIcon size={14} /><span>No coding agent found - work waits in the queue.<br /><code style={{ color: 'inherit', opacity: .8 }}>npx marver init</code> sets one up.</span></div>}
      </div>
      <ShortcutsRow />
      <div className="actions">
        <span className="sp" />
        <button className="jm-btn ghost" onClick={() => useJamUi.getState().setSheet(null)}>Not now</button>
        <button className="jm-btn primary" onClick={() => void startSession()}>Start <kbd>⏎</kbd></button>
      </div>
    </div>
  )
}

// ---- the wrap-up ----------------------------------------------------------------------------------------------

/** The open wrap-up sheet's Write the record (the key row calls it). */
export const wrapWrite: { current: (() => void) | null } = { current: null }

const STATE_NOTE: Partial<Record<JamCard['state'], string>> = {
  draft: 'to confirm', confirming: 'sending', queued: 'queued', working: 'with the agent', asks: 'asks you', review: 'to review',
  done: 'done', kept: 'kept - for the record', failed: 'failed',
}

export function WrapSheet({ style }: { style?: CSSProperties }) {
  const session = useJamQueue((s) => s.session)
  const cards = useJamQueue((s) => s.cards)
  const run = useJamQueue((s) => s.run)
  const agent = useJamQueue((s) => s.agent)
  const [text, setText] = useState('')
  const [talk, setTalk] = useState(true)
  const [talkMin, setTalkMin] = useState(0)
  const [tags, setTags] = useState(0)
  const [folder, setFolder] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    fetch(`${ROUTE}/api/jam/session`, { headers: { 'x-mv-c': csrf() } }).then((r) => (r.ok ? r.json() : null)).then((b) => { setTalkMin(b?.talkMinutes ?? 0); setTags(b?.tags ?? 0); setFolder(typeof b?.folder === 'string' ? b.folder : null) }, () => {})
    requestAnimationFrame(() => field.current?.focus())
  }, [])
  // the field grows with its words: three lines at least
  useEffect(() => { const el = field.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.max(el.scrollHeight, 66)}px` } }, [text])
  useEffect(() => () => { wrapWrite.current = null }, [])
  const tries = useRef(0)   // (a hook: above the early return)
  if (!session) return null
  const minutes = Math.max(1, Math.round((Date.now() - session.since) / 60_000))
  // the session's captures - the lane's tiles - with where each stands
  const caps = laneCards(cards, run).filter((c) => c.kind === 'capture' && c.session === session.id && c.state !== 'dropped')
  const name = agent ? HARNESS[agent] ?? agent : 'your agent'
  // Write is busy until the server answers THIS try (an older try's late end never frees it)
  const write = async () => {
    if (busy) return
    const n = ++tries.current
    setBusy(true)
    await endSession({ instructions: text.trim(), includeTalk: talk }, () => { if (n === tries.current) setBusy(false) })
    if (n === tries.current) setBusy(false)
  }
  // ⏎ anywhere in the sheet writes the record - it never reaches a panel beneath it (jam-keys' sheet row)
  wrapWrite.current = () => void write()
  const summary = caps.length
    ? `${caps.length} capture${caps.length === 1 ? '' : 's'} in ${minutes} min.`
    : `No captures in ${minutes} min.`
  return (
    <div className="jm-panel jm-wrapup" data-jam-sheet="wrap" style={style}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div className="top"><h3>Wrap up the session</h3><span className="dim">{minutes} min</span></div>
        <p>{summary}{tags ? ` ${tags} tag${tags === 1 ? ' was' : 's were'} answered in ${tags === 1 ? 'its thread' : 'their threads'}.` : ''}</p>
      </div>
      {caps.length > 0 && (
        <div className="jm-list">
          {caps.map((c) => (
            <div key={c.id} className={c.state === 'done' || c.state === 'kept' ? 'dim' : undefined} data-jam-wrap-row={c.state}>
              <JamStateIcon state={c.state as any} /><span>{c.title ?? 'Capture'}</span><small>{STATE_NOTE[c.state] ?? c.state}</small>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="hd">For {name}</span>
        <textarea ref={field} className="jm-field" rows={3} value={text} data-jam-wrap-field=""
          placeholder="How should it take this in? Do the checkout fixes first, file the small ideas as backlog..."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void write() }
            else if (e.key === 'Escape') { e.preventDefault(); useJamUi.getState().setSheet(null) }
          }} />
      </div>
      <div className="rows">
        <button className="row" data-jam-talk={talk ? 'on' : 'off'} onClick={() => setTalk(!talk)}>
          <span>Include what was said between captures</span>
          <span className="v">{talkMin ? <small>{talkMin} min</small> : null}<i className={`jm-switch${talk ? ' on' : ''}`} /></span>
        </button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--glass-ink-3)', margin: 0 }}>
        {name} reads your instructions, every capture you sent or kept with its reply, and your verdicts{talk ? ', and what was said between captures' : ''}. It writes one page{folder ? <> in <code>{folder}</code></> : null} and nothing else.
      </p>
      <div className="actions">
        <button className="jm-btn ghost" onClick={() => void endSession(null)}>End without a record</button>
        <span className="sp" />
        <button className="jm-btn primary" disabled={busy} onClick={() => void write()}>Write the record <kbd>⏎</kbd></button>
      </div>
    </div>
  )
}

// ---- the record, in the focus panel ------------------------------------------------------------------------

/** A session record (a wrap-up card): the page the agent wrote, its reply, and the review's moves. */
export function RecordDetail({ card, agent, more, onMore, onMoreOpen, onGood, onLater, onRetry, onDrop, of, onPrev, onNext }: {
  card: JamCard; agent: string; more: boolean; of?: [number, number]
  onMore(text: string): void; onMoreOpen(on: boolean): void; onGood(): void; onLater(): void
  /** a record job that failed: try it again, or let it go */
  onRetry(): void; onDrop(): void
  onPrev?: () => void; onNext?: () => void
}) {
  const [rec, setRec] = useState<{ file: string; text: string | null; reply?: string } | null>(null)
  useEffect(() => {
    let live = true
    fetch(`${ROUTE}/api/jam/record?id=${encodeURIComponent(card.id)}`, { headers: { 'x-mv-c': csrf() } })
      .then((r) => (r.ok ? r.json() : null)).then((b) => { if (live && b) setRec(b) }, () => {})
    return () => { live = false }
  }, [card.id, card.state, card.rev])
  // unsent words outlive the panel (a click elsewhere closes it), as a capture review's do
  const [note, setNoteState] = useState(() => moreDraftOf(card.id))
  const setNote = (t: string) => { setNoteState(t); setMoreDraft(card.id, t) }
  useEffect(() => { if (moreDraftOf(card.id) && !more) onMoreOpen(true) }, [])
  // left on purpose (Esc cleared the draft): the field's words go too; closed by a click elsewhere, they stay
  useEffect(() => { if (!more && !moreDraftOf(card.id)) setNoteState('') }, [more])
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (more) field.current?.focus() }, [more])
  const review = card.state === 'review'
  const failed = card.state === 'failed'
  return (
    <div className="jm-panel jm-review jm-record-panel" data-jam-record="">
      <div className="top">
        <JamStateIcon state={card.state as any} />
        <h3>{card.title ?? 'Session record'}</h3>
        {of && <><span className="dim">{of[0]} of {of[1]}</span>
          <button className="jm-iconbtn" disabled={!onPrev} onClick={onPrev} aria-label="Previous"><CaretIcon size={11} style={{ transform: 'rotate(90deg)' }} /></button>
          <button className="jm-iconbtn" disabled={!onNext} onClick={onNext} aria-label="Next"><CaretIcon size={11} style={{ transform: 'rotate(-90deg)' }} /></button></>}
      </div>
      <div className="meta"><span><code>{rec?.file ?? card.file ?? 'context/sessions/'}</code></span><i /><span>{agent}</span></div>
      {rec?.reply && <div className="jm-reply"><Marver size={20} /><p>{rec.reply}</p></div>}
      <div className="jm-body">
        {failed ? <div className="note-line err" data-jam-record-failed=""><WarningIcon size={14} /><span>The record was not written{card.note ? ` - ${card.note}` : ''}. Retry runs it again.</span></div>
          : rec?.text ? <div className="jm-record">{rec.text}</div>
          : <div className="note-line info"><span>{review ? 'The record file is not there - the agent may not have written it.' : card.state === 'working' ? 'The agent is writing the record...' : 'Queued - the record is written when the agent is free.'}</span></div>}
      </div>
      {failed && <div className="rule" />}
      {failed && (
        <div className="actions">
          <button className="jm-btn primary" onClick={onRetry}>Retry</button>
          <button className="jm-btn ghost" onClick={onDrop}>Drop</button>
        </div>
      )}
      {review && <div className="rule" />}
      {review && (more ? (
        <div className="jm-more">
          <textarea ref={field} className="txt" rows={1} value={note} placeholder="What should the record add or change?"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (note.trim()) onMore(note.trim()) }
              if (e.key === 'Escape') { e.preventDefault(); setNote(''); onMoreOpen(false) }
            }} />
          <button className="jm-send" disabled={!note.trim()} onClick={() => onMore(note.trim())}>Send <kbd>⏎</kbd></button>
        </div>
      ) : (
        <div className="actions">
          <button className="jm-btn primary" onClick={onGood}>Looks good <kbd>⏎</kbd></button>
          <button className="jm-btn" onClick={() => onMoreOpen(true)}>More work <kbd>⇧⏎</kbd></button>
          <button className="jm-btn ghost" onClick={onLater}>Later <kbd>→</kbd></button>
        </div>
      ))}
    </div>
  )
}

// ---- in play: the lane folds to a counter ---------------------------------------------------------------

/** The run's captures as a counter beside the navigator, by where they stand; Q opens the lane. */
export function PlayCounter({ cards, style }: { cards: JamCard[]; style?: CSSProperties }) {
  const n = (s: JamCard['state']) => cards.filter((c) => c.state === s).length
  // what needs you first, then what runs; what is settled counts as one more pair (the run still shows)
  const pairs = (['asks', 'failed', 'review', 'draft', 'confirming', 'working', 'queued'] as const).map((s) => [s, n(s)] as const).filter(([, k]) => k > 0)
  const settled = cards.filter((c) => c.state === 'done' || c.state === 'kept').length
  if (!pairs.length && !settled) return null
  return (
    <div className="jm-count jm-stage" data-jam-counter="" style={style} onClick={() => useJamUi.getState().setLaneKeys(true)}>
      {pairs.map(([s, k]) => <span key={s}><JamStateIcon state={s as any} size={13} />{k}</span>)}
      {settled > 0 && <span key="done"><JamStateIcon state="done" size={13} />{settled}</span>}
      <i className="sep" /><span className="q">Q</span>
    </div>
  )
}
