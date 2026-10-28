/**
 * Jam V2's panels (spec 27 Parts 1-3): the focus panel the review and the capture detail open in, the
 * read-back, the review detail, the notes card, how a capture's comment reads in its thread, and the
 * capture's marks on the canvas (the teal edge ring, numbered points).
 *
 * Presentational only: every component takes what it shows and calls back what was chosen. The shell
 * (jam-capture.ts, App) owns state, keys and the API.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { JamStateIcon } from './jam-ui.tsx'
import type { TimelineLine } from './jam-lines.ts'
import { speechLines } from '../../shared/speech.ts'
import {
  ArrowBendUpLeftIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, CopyIcon, CursorClickIcon, CursorIcon, EyeIcon, FileCodeIcon,
  FrameRectIcon, ImagesSquareIcon, LaserIcon, MicrophoneIcon, MoonIcon, PencilSimpleIcon, SignpostIcon, SunIcon, TextboxIcon,
  ParallelogramFillIcon, WarningIcon, WaveformIcon, XIcon, deviceIcon,
} from './icons.tsx'
import { LANE_H } from './jam-lane.tsx'
import { Tip } from './Tip.tsx'
import { useJamQueue } from './jam-queue.ts'
import { holdsReload } from './api.ts'
import { unsavedWhen, workChanged } from './unsaved.ts'

/** A heading cut short by its ellipsis: its tooltip shows it whole (one that fits shows none). */
const cutShort = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1

/** Marver's mark, as the thread draws it (Comments.tsx MarverAvatar) - drawn here from the same classes
 *  so the panels never import the comments module (which will import these panels). */
export const Marver = ({ size = 20 }: { size?: number }) => (
  <span className="cm-avatar cm-marver" style={{ width: size, height: size }} aria-label="Marver"><ParallelogramFillIcon size={Math.round(size * 0.5)} /></span>
)

// ---- the focus panel ---------------------------------------------------------------------------------

/** The one place a detail opens (v9): its top level with the sidebar's and the toolbar's tops, its
 *  bottom just above the lane, its left edge at `left` (the sidebar's right edge plus an inset - the
 *  shell passes it), `width` px wide (520 at least). The panel inside fills it; its middle scrolls and
 *  its footer stays in view. `onClose` adds a quiet close button in its corner. */
export function FocusPanel({ children, left, width = 580, onClose }: { children: ReactNode; left: number; width?: number; onClose?: () => void }) {
  // the window's width is the last word: follow it as it changes
  const [, setTick] = useState(0)
  useEffect(() => { const on = () => setTick((n) => n + 1); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on) }, [])
  // 580: the footer's "For Claude Code" and its four actions on one line; never wider than the window allows
  // the window is the last word: a narrow one gets a narrower panel, never one past its edge
  const room = (typeof window !== 'undefined' ? window.innerWidth : 1400) - left - 12
  const w = Math.min(room, Math.max(360, Math.max(580, width)))
  return (
    <div className="jm-focus" data-jam-focus="" style={{ left, width: w, bottom: `calc(var(--edge) + ${LANE_H + 2}px)` }}>
      {children}
      {onClose && <button className="jm-iconbtn jm-focus-x" aria-label="Close" onClick={onClose}><XIcon size={13} /></button>}
    </div>
  )
}

// ---- the timeline --------------------------------------------------------------------------------------

/** More work words not sent yet, by card - they survive the panel closing on a click elsewhere. */
const moreDrafts = new Map<string, string>()
export const clearMoreDraft = (id: string) => { moreDrafts.delete(id); workChanged() }
export const moreDraftOf = (id: string): string => moreDrafts.get(id) ?? ''
export const setMoreDraft = (id: string, t: string) => { if (t) moreDrafts.set(id, t); else moreDrafts.delete(id); workChanged() }
// spec 28 A1.11: a page whose canvas came back reloads only once no such words wait (a reload would drop them)
holdsReload(() => moreDrafts.size > 0)
// and leaving the page asks first (spec 28 A2.9)
unsavedWhen('typing', () => moreDrafts.size > 0)

const unquote = (s: string) => s.replace(/^"(.*)"$/s, '$1')
const DEVICE: Record<string, string> = { phone: 'mobile', mobile: 'mobile', tablet: 'tablet', laptop: 'laptop', desktop: 'monitor', monitor: 'monitor', tv: 'tv' }

/** One line: time | glyph | what happened (the read-back's merged timeline, jam-lines.ts). */
function LineRow({ l }: { l: TimelineLine }) {
  const ui = (s: string) => <b className="ui">{s}</b>
  const code = l.source ? <code>{l.source.split('/').pop()}</code> : null
  let glyph: ReactNode = null, body: ReactNode = l.text
  switch (l.kind) {
    case 'words': glyph = <MicrophoneIcon size={13} />; body = <span className="words">“{unquote(l.text)}”</span>; break
    case 'note': glyph = <PencilSimpleIcon size={13} />; body = <span className="words">{unquote(l.text)}</span>; break
    case 'view': glyph = <EyeIcon size={13} />; break
    case 'pick': glyph = <LaserIcon size={13} />; body = <>{l.point != null && <span className="pt pick">{l.point}</span>}{l.text}{code}</>; break
    case 'click': glyph = <CursorClickIcon size={13} />; body = <>{l.point != null && <span className="pt click">{l.point}</span>}{l.text}{code}</>; break
    case 'hover': glyph = <CursorIcon size={13} />; body = <>{l.text}{code}</>; break
    case 'field': glyph = <TextboxIcon size={13} />; body = <>{l.text}{code}</>; break
    case 'screen': glyph = <ArrowRightIcon size={13} />; break
    case 'scroll': glyph = <ArrowUpIcon size={13} style={{ transform: 'rotate(180deg)' }} />; break
    case 'select': glyph = <FrameRectIcon size={13} />; body = <>selected {ui(l.text)}</>; break
    case 'device': {
      const name = (l.text.split(' · ')[1] ?? '').split(' ')[0].toLowerCase()
      glyph = deviceIcon(DEVICE[name] ?? null, 13); body = <>viewed at {ui(l.text.split(' · ').slice(1).join(' · ') || l.text)}</>; break
    }
    case 'theme': glyph = l.text === 'dark' ? <MoonIcon size={13} /> : <SunIcon size={13} />; body = <>switched to {ui(l.text)}</>; break
    case 'copied': {
      const [what, of] = l.text.split(' of ')
      glyph = what === 'path' ? <SignpostIcon size={13} /> : <CopyIcon size={13} />; body = <>copied the {what} of {ui(of ?? '')}</>; break
    }
    case 'interact': glyph = <CursorClickIcon size={13} />; body = <>interactive mode {ui(l.text)}</>; break
    case 'picture': glyph = <ImagesSquareIcon size={13} />; body = <>picture {l.point} · {l.text}</>; break
    case 'missing': glyph = <WarningIcon size={13} />; body = <span className="miss">{l.text}</span>; break
  }
  return <div data-kind={l.kind}><span className="ts">{l.t}</span><span className="g">{glyph}</span><span>{body}</span></div>
}

/** The merged timeline: words and notes among every step, each at its moment. */
export const Lines = ({ lines }: { lines: TimelineLine[] }) => <div className="jm-lines">{lines.map((l, i) => <LineRow key={i} l={l} />)}</div>

const newNoteId = () => `n-${Math.random().toString(36).slice(2, 12).padEnd(8, '0')}`

/** Notes written in a read-back after the capture ended: under a divider, in the timeline's own rows, then a
 *  clean field and Add note (⏎). What you type is never a capture key. */
function AddedNotes({ added, onAdd }: { added: { at: number; text: string }[]; onAdd?: (text: string, id: string) => Promise<boolean> }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  // the note in the field: one id until it saves (a failed one sent again is the same note)
  const nid = useRef(newNoteId())
  const add = async () => {
    const t = text.trim()
    if (!t || busy || !onAdd) return
    setBusy(true)
    const ok = await onAdd(t, nid.current)
    setBusy(false)
    if (ok) { setText(''); nid.current = newNoteId() }
  }
  return (
    <div className="jm-added" data-jam-added="">
      {added.length > 0 && <>
        <div className="jm-added-rule"><span>Added after</span></div>
        <div className="jm-lines">{added.map((a, i) => (
          <div key={i} data-jam-added-note=""><span className="ts">{new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span className="g"><PencilSimpleIcon size={12} /></span><span className="words">{a.text}</span></div>
        ))}</div>
      </>}
      {onAdd && (
        <div className="jm-addnote">
          {/* read-only while it saves (never disabled: a disabled field lets its focus go, and the next ⏎ would
              reach the read-back's own keys) */}
          <input value={text} placeholder="Add a note..." data-jam-addnote="" readOnly={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return
              if (e.key === 'Enter') { e.preventDefault(); void add() }
              else if (e.key === 'Escape') { e.preventDefault(); setText(''); (e.target as HTMLInputElement).blur() }
            }} />
          <button className="jm-btn" disabled={!text.trim() || busy} onClick={() => void add()}>Add note</button>
        </div>
      )}
    </div>
  )
}

/** A picture, or the dashed "No picture" where a shot failed. */
export function Shot({ url, cap, alt, onSize }: { url?: string; cap?: ReactNode; alt?: string; onSize?: (w: number, h: number) => void }) {
  // a picture that cannot load (gone, refused) is "No picture" too - never a broken image
  const [failed, setFailed] = useState<string | null>(null)
  const ok = !!url && failed !== url
  return (
    <div className="jm-shot">
      {ok ? <div className="pic"><img src={url} alt={alt ?? ''} draggable={false} onError={() => setFailed(url!)}
        onLoad={onSize ? (e) => onSize(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight) : undefined} /></div>
        : <div className="pic none"><ImagesSquareIcon size={13} />No picture</div>}
      {cap && <span className="cap">{cap}</span>}
    </div>
  )
}

/** "1 of 3" with its arrows - the walk's ends disable the arrow that has nowhere to go. */
const Walk = ({ of, onPrev, onNext }: { of?: [number, number]; onPrev?: () => void; onNext?: () => void }) => of ? (
  <>
    <span className="dim">{of[0]} of {of[1]}</span>
    <button className="jm-iconbtn" disabled={of[0] <= 1 || !onPrev} onClick={onPrev} aria-label="Previous"><ArrowLeftIcon size={13} /></button>
    <button className="jm-iconbtn" disabled={of[0] >= of[1] || !onNext} onClick={onNext} aria-label="Next"><ArrowRightIcon size={13} /></button>
  </>
) : null

const Meta = ({ items }: { items: ReactNode[] }) => (
  <div className="meta">{items.map((m, i) => <span key={i} style={{ display: 'contents' }}>{i > 0 && <i />}<span>{m}</span></span>)}</div>
)

// ---- the read-back --------------------------------------------------------------------------------------

/**
 * A capture's detail (the read-back of a draft; read-only once confirmed). Head: its first words and
 * "1 of N". Then a line of meta (length, frames, points, pictures, notes, steps), the pictures large
 * (two to a row), and the merged timeline. Click the timeline to edit the words (a field; saved on blur
 * through `onEdit`). A draft's footer names the agent: Drop (esc), Keep (K), Add to queue (⏎). Read-only
 * shows Open thread instead.
 *
 * `edited` = your edit so far (the field opens on it; else on the words of `lines`); `editing` opens
 * the field from outside (it is also opened by a click); `follows` = the reviewed card's title for a
 * capture made during a review; `err` = a confirm that failed closed; `warn` = degraded content
 * ("words may be incomplete").
 */
export function ReadBack({ title, head, of, onPrev, onNext, meta, lines, pictures, edited, pending, editing, onEdit, onRetry, onConfirm, onKeep, onDrop, onResume, agent, follows, readOnly, locked, onOpenThread, added, onAddNote, autoNamed, err, warn, asks, style }: {
  title: string
  /** beside the title: the Review | Capture switch (a capture under review) */
  head?: ReactNode
  of?: [number, number]
  onPrev?: () => void
  onNext?: () => void
  meta: ReactNode[]
  lines: TimelineLine[]
  pictures: { id: string; url: string; caption: ReactNode }[]
  edited?: string
  /** words written that have not saved yet - they win over `edited` */
  pending?: string
  /** a failed capture: its Retry (with Drop beside it) in the read-only footer */
  onRetry?: () => void
  editing?: boolean
  onEdit?: (text: string) => void
  onConfirm?: () => void
  onKeep?: () => void
  onDrop?: () => void
  /** ended too soon: recording goes on where it stopped (R) */
  onResume?: () => void
  agent?: string | null
  follows?: string
  readOnly?: boolean
  /** the words cannot be edited for now (its Resume is starting) - the rest stays as it is */
  locked?: boolean
  onOpenThread?: () => void
  /** notes written here after it ended - under a divider, as the timeline shows its own */
  added?: { at: number; text: string }[]
  /** the title came from Claude Haiku (jam.names): its tooltip says so, and where the words went */
  autoNamed?: boolean
  /** a note added from here (a draft): resolves whether it saved */
  onAddNote?: (text: string, id: string) => Promise<boolean>
  err?: ReactNode
  warn?: ReactNode
  /** a capture whose run asks you something, opened here because its thread cannot show on this board: the question,
   *  and a field whose answer goes to its thread with @marver (an answer with a tag is what carries the work on) */
  asks?: { question: string; onAnswer(text: string): Promise<boolean> }
  style?: CSSProperties
}) {
  const [open, setOpen] = useState(!!editing)
  useEffect(() => { if (editing) setOpen(true) }, [editing])
  // the words and the notes, in time order - what the capture says (server captureWords)
  const words = speechLines(lines.flatMap((l) => (l.kind === 'words' || l.kind === 'note' ? [{ kind: l.kind, text: unquote(l.text) }] : [])))
  const [text, setText] = useState(pending ?? edited ?? words)
  // the field follows the saved edit only while you are not writing and nothing newer waits to save
  // (`pending`): an older save's answer never overwrites newer words, and a failed one never loses them
  useEffect(() => { if (!open) setText(pending ?? edited ?? words) }, [edited, words, pending])
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (open) { const el = field.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) } } }, [open])
  // compared with what is meant now - a pending save included: going back to the saved words while a
  // newer save is out is a save of its own, queued after it
  const lastSent = useRef<string | undefined>(undefined)
  const save = () => {
    setOpen(false)
    if (text !== (lastSent.current ?? pending ?? edited ?? words)) { lastSent.current = text; onEdit?.(text) }
  }
  // once the saved edit is what was last sent, the intent is settled
  useEffect(() => { if (lastSent.current !== undefined && edited === lastSent.current && pending === undefined) lastSent.current = undefined }, [edited, pending])
  return (
    <div className="jm-panel jm-readback" data-jam-readback="" style={style}>
      <div className="top">
        <span className="jm-capglyph"><WaveformIcon size={14} /></span>
        <Tip side="bottom" label={<span className="jm-tip-title">{title}{autoNamed && <><br /><small>Named by Claude Haiku from its words, sent to Anthropic through Claude Code - <code>jam.names: false</code> turns it off</small></>}</span>} only={autoNamed ? undefined : cutShort}><h3>{title || 'Capture'}</h3></Tip>
        {head}
        <Walk of={of} onPrev={onPrev} onNext={onNext} />
      </div>
      <Meta items={meta} />
      <div className="jm-body">
        {asks && <AsksAnswer question={asks.question} onAnswer={asks.onAnswer} />}
        {follows && <div className="note-line info"><ArrowBendUpLeftIcon size={14} /><span>Follows <b style={{ color: 'var(--glass-ink)' }}>{follows}</b> - confirming sends that review back as more work</span></div>}
        {err && <div className="note-line err"><WarningIcon size={14} /><span>{err}</span></div>}
        {warn && <div className="note-line warn"><WarningIcon size={14} /><span>{warn}</span></div>}
        {pictures.length > 0 && <div className="jm-thumbs">{pictures.map((p) => <Shot key={p.id} url={p.url} cap={p.caption} />)}</div>}
        {open && !readOnly && !locked ? (
          <textarea ref={field} className="jm-edit" value={text} rows={Math.min(10, Math.max(3, Math.ceil(text.length / 60)))}
            onChange={(e) => setText(e.target.value)} onBlur={save}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { setText(edited ?? words); setOpen(false) } }} />
        ) : (
          <div className={readOnly || locked ? undefined : 'jm-editable'} title={readOnly || locked ? undefined : 'Click to edit the words'} onClick={readOnly || locked ? undefined : () => setOpen(true)}>
            {edited !== undefined && !readOnly && <div className="jm-edited"><PencilSimpleIcon size={12} />Your edit</div>}
            <Lines lines={lines} />
          </div>
        )}
        {(added?.length || (onAddNote && !readOnly)) ? <AddedNotes added={added ?? []} onAdd={readOnly || locked ? undefined : onAddNote} /> : null}
      </div>
      <div className="rule" />
      <div className="actions">
        {readOnly ? (
          <><span className="sp" />{onOpenThread && <button className="jm-btn" onClick={onOpenThread}>Open thread</button>}
            {onRetry && <><button className="jm-btn ghost" onClick={onDrop}>Drop</button><button className="jm-btn primary" onClick={onRetry}>Retry</button></>}</>
        ) : (
          <>
            <span className="dim">{agent ? <>For <b style={{ color: 'var(--glass-ink-2)', fontWeight: 600 }}>{agent}</b></> : 'No agent yet - it waits in the queue'}</span>
            <span className="sp" />
            {onResume && <button className="jm-btn ghost" onClick={onResume}>Resume <kbd>R</kbd></button>}
            <button className="jm-btn ghost" onClick={onDrop}>Drop <kbd>esc</kbd></button>
            <button className="jm-btn ghost" onClick={onKeep}>Keep <kbd>K</kbd></button>
            <button className="jm-btn primary" onClick={onConfirm}>Add to queue <kbd>⏎</kbd></button>
          </>
        )}
      </div>
    </div>
  )
}

/** What a capture's run asked you, and your answer - for a thread this board cannot show (its frame is on no node
 *  here). Sent with @marver in its thread: the answer goes back to the agent, as a tagged reply does. */
function AsksAnswer({ question, onAnswer }: { question: string; onAnswer(text: string): Promise<boolean> }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const send = () => {
    if (!text.trim() || sending) return
    setSending(true)
    void onAnswer(text.trim()).then((ok) => { setSending(false); if (ok) setText('') })
  }
  return (
    <div className="jm-asks" data-jam-asks="" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div className="jm-reply">
        <Marver size={20} />
        <p>{question || 'It asks you something - see its thread.'}</p>
      </div>
      <div className="jm-more">
        <span className="at">@marver</span>
        <textarea className="txt" rows={1} value={text} placeholder="Your answer" disabled={sending}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) { e.preventDefault(); send() }
          }} />
        <button className="jm-send" disabled={!text.trim() || sending} onClick={send}>Send <kbd>⏎</kbd></button>
      </div>
    </div>
  )
}

// ---- the review --------------------------------------------------------------------------------------

/**
 * A capture's review (v9): one big picture at a time at the panel's width - frame tabs when several
 * frames changed, a Before | After switch (B; it opens on After), a dashed "No picture" where a shot
 * failed. Above it the agent's reply and "Open thread"; below it the verdicts - Looks good (⏎), More
 * work (⇧⏎), Later (→). `more` turns the verdict row into a composer whose ⏎ (or Send) calls
 * `onMore(text)`; esc (or `onMoreOpen(false)`) closes it.
 *
 * `shots` are picture URLs per frame (`frames` names the tabs; it defaults to the shots' frames);
 * `alsoChanged` = shared files the job changed anyway.
 */
export function ReviewDetail({ title, head, of, onPrev, onNext, frames, active, onTab, view, onFlip, onFit, reply, shots, alsoChanged, agent, when, more, onMore, onMoreOpen, onGood, onLater, onOpenThread, style, draftKey }: {
  title: string
  /** beside the title: the Review | Capture switch */
  head?: ReactNode
  of?: [number, number]
  onPrev?: () => void
  onNext?: () => void
  frames?: string[]
  active: number
  onTab(i: number): void
  view: 'both' | 'before' | 'after'
  onFlip(view: 'both' | 'before' | 'after'): void
  /** the panel width the pictures need (0.26.1): both at once, as big as the panel's height allows; undefined: the default */
  onFit?(width: number | undefined): void
  reply: ReactNode
  /** `new`: a frame the run made - nothing before it */
  shots: { frame: string; before?: string; after?: string; new?: boolean }[]
  alsoChanged?: string[]
  agent?: string
  when?: string
  more?: boolean
  onMore(text: string): void
  onMoreOpen(open: boolean): void
  onGood(): void
  onLater(): void
  onOpenThread?: () => void
  /** the card the More work words belong to (kept across the panel closing) */
  draftKey?: string
  style?: CSSProperties
}) {
  const names = frames ?? shots.map((s) => s.frame)
  const shot = shots[active] ?? shots.find((s) => s.frame === names[active])
  const isNew = (f: string) => !!shots.find((s) => s.frame === f)?.new
  // the frame's shape, from its pictures as they load (After's, else Before's): taller than wide (or square) side by
  // side, wider than tall stacked - and the panel as wide as that needs (0.26.1, the owner's first real session)
  const [sizes, setSizes] = useState<Record<string, number>>({})
  const sized = (url?: string) => (url ? (w: number, h: number) => { if (w > 0 && h > 0) setSizes((m) => (m[url] === w / h ? m : { ...m, [url]: w / h })) } : undefined)
  const aspect = (shot?.after && sizes[shot.after]) || (shot?.before && sizes[shot.before]) || undefined
  // both slots whenever the frame has a before at all (either may read "No picture") - a missing After never hides a Before
  const both = view === 'both' && !!shot && !shot.new && !!(shot.before || shot.after)
  const side = (aspect ?? 1.6) <= 1.1
  const big = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = big.current
    if (!el || !onFit) return
    // no picture of this one measured yet (loading, or none loads): the default width - never the last tab's
    if (!aspect) { onFit(undefined); return }
    const ask = () => {
      const panel = el.closest('.jm-panel') as HTMLElement | null
      if (!panel) return
      // the chrome around the pictures: the panel's width minus the well's; the well's height is what they get
      const chrome = panel.getBoundingClientRect().width - el.getBoundingClientRect().width
      const h = el.getBoundingClientRect().height - 20                 // the well's padding
      const CAP = 18, GAP = 10
      let well: number
      if (both && side) well = 2 * (h - CAP) * aspect + GAP           // side by side: each the whole height
      else if (both) well = ((h - GAP - 2 * CAP) / 2) * aspect        // stacked: each half of it
      else well = h * aspect                                          // one picture
      const want = Math.round(chrome + well + 20)
      onFit(Math.round(want / 8) * 8)
    }
    ask()
    const ro = new ResizeObserver(ask)
    ro.observe(el)
    return () => ro.disconnect()
  }, [aspect, both, side, onFit])
  const label = (f: string) => f.split('/').pop() ?? f
  // the More work words outlive the panel: a click elsewhere closes it, and the words wait for its return -
  // they go only when sent, or when you leave the composer yourself (Esc)
  const [text, setTextState] = useState(() => (draftKey ? moreDrafts.get(draftKey) ?? '' : ''))
  const setText = (t: string) => { setTextState(t); if (draftKey) { if (t) moreDrafts.set(draftKey, t); else moreDrafts.delete(draftKey); workChanged() } }
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (draftKey && moreDrafts.get(draftKey) && !more) onMoreOpen(true) }, [])   // back with words waiting: the composer is open
  // left on purpose (Esc cleared its words from the map): the composer's words go too; closed by a click
  // elsewhere, the map still holds them
  useEffect(() => { if (more) field.current?.focus(); else if (draftKey && !moreDrafts.has(draftKey)) setTextState('') }, [more])
  // sent as More work, always: the canvas settles a note that only approves ("looks good") as Looks good
  const send = () => { if (text.trim()) onMore(text.trim()) }
  return (
    <div className="jm-panel jm-review" data-jam-review="" style={style}>
      <div className="top">
        <JamStateIcon state="review" />
        <Tip side="bottom" label={<span className="jm-tip-title">{title}</span>} only={cutShort}><h3>{title}</h3></Tip>
        {head}
        <Walk of={of} onPrev={onPrev} onNext={onNext} />
      </div>
      <Meta items={[...names.map((f) => <span key={f} className="jm-flink"><FrameRectIcon size={11} />{label(f)}</span>), ...(agent ? [agent] : []), ...(when ? [when] : [])]} />
      <div className="jm-reply">
        <Marver size={20} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <p>{reply}</p>
          {onOpenThread && <button className="jm-link" onClick={onOpenThread}>Open thread</button>}
        </div>
      </div>
      {names.length > 0 && (
        <div className="jm-fbar">
          {names.length > 1
            ? <div className="jm-ftabs" role="tablist">{names.map((f, i) => <button key={f} role="tab" aria-selected={i === active} className={i === active ? 'on' : undefined} onClick={() => onTab(i)}><FrameRectIcon size={12} />{label(f)}{isNew(f) && <span className="jm-newtag">New</span>}</button>)}</div>
            : <span className="jm-framehd"><FrameRectIcon size={12} />{label(names[0])}{isNew(names[0]) && <span className="jm-newtag">New</span>}</span>}
          <span className="sp" />
          {/* a frame the run made has nothing before it: no switch */}
          {shot?.new ? <span className="dim" data-jam-new="">New frame</span> : (
            <Tip side="bottom" label={<span>Both / Before / After<kbd style={{ marginLeft: 8 }}>B</kbd></span>}>
              <div className="jm-ftabs" data-jam-flip="">{(['both', 'before', 'after'] as const).map((v) => <button key={v} className={v === view ? 'on' : undefined} aria-pressed={v === view} onClick={() => onFlip(v)}>{v === 'both' ? 'Both' : v === 'before' ? 'Before' : 'After'}</button>)}</div>
            </Tip>
          )}
        </div>
      )}
      <div ref={big} className={`jm-big${both ? ` pair ${side ? 'side' : 'stack'}` : ''}`} data-jam-pair={both ? (side ? 'side' : 'stack') : 'one'}>
        {both
          ? <><Shot key={`b-${shot!.before ?? 'none'}`} url={shot!.before} cap="Before" alt={`${label(names[active] ?? '')} before`} onSize={sized(shot!.before)} /><Shot key={`a-${shot!.after ?? 'none'}`} url={shot!.after} cap="After" alt={`${label(names[active] ?? '')} after`} onSize={sized(shot!.after)} /></>
          : <Shot url={view === 'before' && !shot?.new ? shot?.before : shot?.after} alt={`${label(names[active] ?? '')} ${shot?.new ? 'new' : view}`}
              onSize={sized(view === 'before' && !shot?.new ? shot?.before : shot?.after)} />}
      </div>
      {alsoChanged && alsoChanged.length > 0 && (
        <div className="jm-file"><FileCodeIcon size={14} /><span>Also changed {alsoChanged.map((f, i) => <span key={f}>{i > 0 && ', '}<code>{f.split('/').pop()}</code></span>)}</span></div>
      )}
      <div className="rule" />
      {more ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div className="jm-more">
            <span className="at">@marver</span>
            <textarea ref={field} className="txt" rows={1} value={text} placeholder="What else should change?"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') { e.preventDefault(); setText(''); onMoreOpen(false) }
                else if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) { e.preventDefault(); send() }
              }} />
            <button className="jm-send" disabled={!text.trim()} onClick={send}>Send <kbd>⏎</kbd></button>
          </div>
          <span className="dim" style={{ paddingLeft: 4 }}>Back to the agent, next in line - the tile keeps its place · esc to cancel</span>
        </div>
      ) : (
        <div className="actions">
          <button className="jm-btn primary" onClick={onGood}>Looks good <kbd>⏎</kbd></button>
          <button className="jm-btn" onClick={() => onMoreOpen(true)}>More work <kbd>⇧⏎</kbd></button>
          <button className="jm-btn ghost" onClick={onLater}>Later <kbd>→</kbd></button>
          <span className="sp" /><kbd>esc</kbd>
        </div>
      )}
    </div>
  )
}

// ---- notes --------------------------------------------------------------------------------------------

/**
 * The notes card (v9): opened by the capture tile's Note button (or N), floating one lane up over the
 * tile (the shell positions it with `style`). The notes added so far, each with its time in the
 * capture, then a field for the next one. ⏎ calls `onAdd` (the shell adds the note step at that
 * moment and clears `draft`); esc calls `onClose`. The field swallows its keys so no Jam key fires
 * while you type (E, S, L and I type letters). The capture keeps recording throughout.
 */
export function NotesCard({ notes, draft, onDraft, onAdd, onClose, style }: {
  notes: { t: string; text: string }[]
  draft: string
  onDraft(text: string): void
  onAdd(): void
  onClose(): void
  style?: CSSProperties
}) {
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { field.current?.focus() }, [])
  return (
    <div className="jm-panel jm-notes" data-jam-notes="" style={style}>
      <div className="top"><PencilSimpleIcon size={14} style={{ color: 'var(--glass-ink-3)' }} /><h3>Notes</h3><span className="dim">in the timeline</span></div>
      {notes.length > 0 && <div className="jm-notelist">{notes.map((n, i) => <div key={i}><span className="ts">{n.t}</span><span>{n.text}</span></div>)}</div>}
      <textarea ref={field} className="jm-notefield" rows={2} value={draft} placeholder="Write a note…"
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return
          if (e.key === 'Escape') { e.preventDefault(); onClose() }
          else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (draft.trim()) onAdd() }
        }} />
      <div className="foot"><span>⏎ add</span><span>esc close</span></div>
    </div>
  )
}

/** The words, streaming above the capture tile (spec 27 Part 4): the earlier ones dim, the newest in ink;
 *  a dropped phrase reads "[words lost]". */
export const Caption = ({ old, live, style }: { old?: string; live?: string; style?: CSSProperties }) => (
  <div className="jm-caption" data-jam-caption="" style={style}>
    <span className="jm-bars"><i /><i /><i /><i /></span>
    <span>{old && <span className="old">{old} </span>}{live}</span>
  </div>
)

/** The one question words need (first `S` on a canvas), then the model's download if it is missing:
 *  a header that says what is happening, a line on why, then what the model is (trial 3: "Words on this
 *  Mac" said neither). */
export function VoiceAsk({ step, mb, progress, error, onYes, onNo, onDownload, style }: {
  step: 'ask' | 'download' | 'downloading' | 'checking' | 'failed' | 'unavailable'
  mb: number
  progress?: number
  error?: string
  onYes(): void; onNo(): void; onDownload(): void
  style?: CSSProperties
}) {
  const pct = Math.round((progress ?? 0) * 100)
  const title = {
    ask: 'Say it instead of typing?',
    download: 'Add voice to Jam',
    downloading: 'Downloading the voice model',
    checking: 'Almost ready',
    failed: 'The download stopped',
    unavailable: 'Voice is not available here',
  }[step]
  return (
    <div className="jm-panel jm-voiceask" data-jam-voiceask={step} style={style}>
      <div className="top"><MicrophoneIcon size={14} style={{ color: 'var(--jm-rec)' }} /><h3>{title}</h3></div>
      {step === 'ask' && <p className="dim">While a capture records, what you say becomes words in it - transcribed on this Mac. The audio is never kept or sent anywhere.</p>}
      {step === 'download' && <>
        <p className="lead">Jam needs a speech-to-text model to turn what you say into words in each capture.</p>
        <p className="dim">It is NVIDIA's Parakeet v3: small, fast and accurate, and it runs on this Mac, so your audio never leaves it. One {mb}{'\u00a0'}MB download, shared by every canvas.</p>
      </>}
      {step === 'downloading' && <p className="dim">{pct}% of {mb}{'\u00a0'}MB. Keep going: this capture records as usual, and your words start with the next one.</p>}
      {step === 'checking' && <p className="dim">Checking the download, then voice is on.</p>}
      {step === 'failed' && <p className="dim">{error ?? 'Unknown error'}. Try again, or keep going with typed notes.</p>}
      {step === 'unavailable' && <p className="dim">{error ?? 'The speech engine could not start. Captures keep typed notes.'}</p>}
      {step === 'downloading' && <div className="jm-progress"><i style={{ width: `${pct}%` }} /></div>}
      {step === 'checking' && <div className="jm-progress busy"><i /></div>}
      <div className="actions">
        <span className="sp" />
        {step === 'ask' && <><button className="jm-btn ghost" onClick={onNo}>Not now</button><button className="jm-btn primary" onClick={onYes}>Use the microphone</button></>}
        {(step === 'download' || step === 'failed') && <><button className="jm-btn ghost" onClick={onNo}>Not now</button><button className="jm-btn primary" onClick={onDownload}>{step === 'failed' ? 'Try again' : `Download ${mb} MB`}</button></>}
        {step === 'unavailable' && <><button className="jm-btn ghost" onClick={onNo}>Typed notes only</button><button className="jm-btn primary" onClick={onYes}>Try again</button></>}
      </div>
    </div>
  )
}

// ---- in a thread, and on the canvas ---------------------------------------------------------------

/** A capture's comment in its thread (round 3): labelled as a capture - a teal waveform, "Capture"
 *  with its short id and facts - then its words. Where its card stands is the status icon in the
 *  message header, not here. */
export const CaptureBlock = ({ id, facts, words }: { id: string; facts?: string; words: ReactNode }) => {
  // its name, once it has one (yours, or the one a small model gave it) - else "Capture" and its short id
  const name = useJamQueue((s) => s.cards?.find((c) => c.id === id)?.name)
  return (
  <span className="jm-capcm" data-capture={id}>
    <span className="hd"><WaveformIcon size={13} /><span>{name ?? `Capture ${id.replace(/^cap-\d+-/, '')}`}</span>{facts && <span className="dim">· {facts}</span>}</span>
    <span className="w">{words}</span>
  </span>
  )
}

/** The thin teal ring round the canvas edge (or the play stage) while a capture records. */
export const EdgeRing = ({ style }: { style?: CSSProperties }) => <div className="jm-edge" data-jam-edge="" style={style} />

/** A capture's numbered point: `pick` (filled teal), `click` (teal ring), `hover` (dashed, no
 *  number). Screen-constant inside a world (it scales by --sh-inv). */
export const CapturePoint = ({ x, y, n, type = 'pick' }: { x: number; y: number; n?: number; type?: 'pick' | 'click' | 'hover' }) => (
  <span className={`jm-pt ${type}`} style={{ left: x, top: y }}>{type === 'hover' ? null : n}</span>
)
