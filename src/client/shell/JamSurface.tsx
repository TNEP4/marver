/**
 * Jam's surfaces in the shell (spec 27): the lane along the bottom (captures only, in the order made,
 * the one recording last), the one focus panel (a capture's detail - a draft's read-back - or a
 * review), the notes card over the capture tile, the teal edge ring and the numbered points while a
 * capture records. The pieces are presentational (jam-lane.tsx, jam-panel.tsx); this file feeds
 * them from the three stores and turns their clicks into queue actions.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ROUTE } from '../const.ts'
import { captureCounts, useJamCapture } from './jam-capture.ts'
import { useJamVoice, voiceSession, voiceSessionEnd, voiceSessionId, type Heard } from './jam-voice.ts'
import { holdsSessionMic, PlayCounter, RecordDetail, StartSheet, WrapSheet } from './jam-session.tsx'
import { FocusPanel, VoiceAsk } from './jam-panel.tsx'
import { decideDraft, laneCards, openTile, pendingEdit, resumeDraft, reveal, saveEdit, shownLane } from './jam-keys.ts'
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu.tsx'
import { ArrowBendUpLeftIcon, ArrowLineUpIcon, ArrowUpIcon, CheckSquareOffsetIcon, CommentIcon, EyeIcon, NotebookIcon, PencilSimpleIcon, PlayIcon, ReloadIcon, XIcon } from './icons.tsx'
import { laneLine, timelineLines } from './jam-lines.ts'
import { changedShots, useJamQueue, type JamCard } from './jam-queue.ts'
import { letGoOfTile, useJamUi } from './jam-state.ts'
import { CaptureLaneRow, FocusPanelView } from './jam-surface-parts.tsx'
import { clearMoreDraft, EdgeRing } from './jam-panel.tsx'
import { useComments } from './comments-store.ts'
import { HARNESS } from './Comments.tsx'
import { PUBLISHED, useStore } from './store.ts'
import type { CaptureRecord } from '../../server/jam/types.ts'

const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
const picture = (id?: string) => (id ? `${ROUTE}/api/jam/picture?id=${encodeURIComponent(id)}` : undefined)

/** Is the lane showing? While a run lasts with a capture in it, or a capture records. */
export function useLaneShown(): boolean {
  const cards = useJamQueue((s) => s.cards)
  const run = useJamQueue((s) => s.run)
  // a capture recording, sealing or waiting to send keeps the lane up until its server card arrives
  const busy = useJamCapture((s) => !!s.current || Object.keys(s.caps).length > 0 || s.unsent.length > 0)
  return !PUBLISHED && (busy || laneCards(cards, run).length > 0)
}

/** A capture's record, loaded once per id for its detail. */
function useRecord(id: string | undefined) {
  const [rec, setRec] = useState<{ id: string; record: CaptureRecord; edited?: string } | null>(null)
  useEffect(() => {
    if (!id || rec?.id === id) return
    let live = true
    fetch(`${ROUTE}/api/jam/capture?id=${encodeURIComponent(id)}`, { headers: { 'x-mv-c': csrf() } })
      .then((r) => (r.ok ? r.json() : null)).then((r) => { if (live && r?.record) setRec({ id, record: r.record, edited: r.edited }) }, () => {})
    return () => { live = false }
  }, [id])
  return rec?.id === id ? rec : null
}

export function JamSurface({ sidebarRight }: { sidebarRight: number }) {
  const cards = useJamQueue((s) => s.cards)
  const run = useJamQueue((s) => s.run)
  const agent = useJamQueue((s) => s.agent)
  const ui = useJamUi()
  const cap = useJamCapture()
  const voice = useJamVoice()
  const shown = useLaneShown()
  const session = useJamQueue((s) => s.session)
  const playing = useStore((s) => !!s.play)
  const [, setTick] = useState(0)
  // the capture tile's timer and a working card's clock move
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t) }, [])
  // a new capture or a new draft brings the lane back to its right end
  useEffect(() => { ui.follow() }, [cap.current, cards?.filter((c) => c.kind === 'capture').length])
  // the read-back of the capture just ended opens when capturing stops - over a review too (a capture
  // made during a review is confirmed in its read-back; the review it follows stays bound in its record).
  // It waits for that capture's own card: a resumed one replaces its draft, which must not open instead
  // the capture ENDED last, not the one that sealed last (pictures can keep an earlier one sealing longer)
  const [shownFor, setShownFor] = useState<string | null>(null)
  useEffect(() => {
    if (cap.current || !cap.lastEnded || cap.lastEnded === shownFor) return
    const sealed = cap.sealed.find((x) => x.id === cap.lastEnded)
    if (!sealed?.card) return
    const draft = cards?.find((c) => c.id === sealed.card!.id && c.state === 'draft')
    if (!draft) return
    setShownFor(cap.lastEnded)
    if (ui.panel?.kind === 'capture' && ui.panel.id === draft.id) return
    ui.open({ kind: 'capture', id: draft.id })
    reveal(draft)
  }, [cap.current, cap.sealed, cap.lastEnded, cards])

  // the session as the server holds it: a page opened (or reloaded) during one hears its talk again; one
  // ended elsewhere (another tab) stops the talk here
  useEffect(() => {
    // only the tab that holds the session's microphone hears its talk - another tab never takes it over
    const heard = voiceSessionId()
    if (session && heard !== session.id && holdsSessionMic(session.id)) void voiceSession(session.id, performance.timeOrigin + performance.now())
    // the talk of a session that is not the server's (ended, or another one) stops here
    else if (heard && heard !== session?.id) void voiceSessionEnd()
  }, [session?.id])

  // J pressed while a capture recorded: the wrap-up waits for that capture's read-back to have opened and
  // closed (or for it to have no draft at all - dropped, or kept at once)
  useEffect(() => {
    if (ui.sheet !== 'wrap-pending' || cap.current || Object.keys(cap.caps).length || cap.unsent.length) return
    const id = cap.lastEnded
    const card = id ? cards?.find((c) => c.id === id) : undefined
    // sealed but its card not here yet: wait for it (a dropped capture never sealed - nothing to wait for)
    if (id && !card && cap.sealed.some((x) => x.id === id)) return
    // a draft: its read-back first - opened, then closed (confirmed, kept, dropped, or set aside)
    if (card && card.state === 'draft' && (shownFor !== id || ui.panel?.id === id)) return
    ui.setSheet('wrap')
  }, [ui.sheet, ui.panel, cap.current, cap.caps, cap.unsent, cap.lastEnded, cards, shownFor])

  // a draft being resumed is the capture recording (or sealing) now: its own tile steps aside
  const list = shownLane(cards, run, cap.resuming)
  const cm = useContextMenu()
  // a comment opening (a pin, a thread, Open thread) takes the place of the read-back or review: the panel
  // closes; the tile lets go too, unless the thread is that tile's own (a capture that asks opens its thread)
  useEffect(() => useComments.subscribe((s, p) => {
    if (!s.active || s.active === p.active) return
    const st = useJamUi.getState()
    const sel = useJamQueue.getState().cards?.find((c) => c.id === st.selected)
    if (sel?.thread === s.active) { if (st.panel) st.close() } else letGoOfTile()
  }), [])
  const made = (id: string) => Number(/^cap-(\d+)-/.exec(id)?.[1] ?? 0)
  const withMade = list.map((c) => ({ made: c.made, tile: { id: c.id, state: c.state, title: c.title ?? 'Capture', line: laneLine(c), ...(c.exclusive ? { exclusive: true } : {}) } as { id: string; state: JamCard['state']; title: string; line: string; exclusive?: boolean } }))
  // captures the server does not hold yet: sealing (pictures and flushes still out) or waiting to send -
  // each in its place by when it started, so one sealing late never swaps with a newer one
  const known = new Set(list.map((c) => c.id))
  for (const c of Object.values(cap.caps)) if (c.state === 'draining' && !known.has(c.id)) withMade.push({ made: made(c.id), tile: { id: c.id, state: 'confirming', title: 'Capture', line: 'Finishing' } })
  for (const id of cap.unsent) if (!known.has(id) && !cap.caps[id]) withMade.push({ made: made(id), tile: { id, state: 'confirming', title: 'Capture', line: 'Waiting to send' } })
  const tiles = withMade.sort((a, b) => a.made - b.made).map((x) => x.tile)
  const recording = cap.current ? (() => {
    const c = cap.caps[cap.current!]
    const counts = captureCounts(c)
    const steps = (c?.steps ?? []).filter((x) => ['select', 'device', 'theme', 'copied', 'interact'].includes(x.event)).length
    return { time: counts.time, points: c?.points.length ?? 0, pictures: c?.pictures.length ?? 0, picturesMax: (c?.pictures.length ?? 0) >= 12, steps,
      notes: counts.notes, noteOn: cap.noteOpen, onNote: () => cap.setNoteOpen(!cap.noteOpen), onStop: () => cap.end(),
      // the microphone: on while it hears this capture; off once you were asked (a click asks again)
      ...(voice.hearing === cap.current ? { mic: 'on' as const } : voice.choice !== null || voice.denied ? { mic: 'off' as const, onMic: () => useJamVoice.setState({ asking: true, choice: null }) } : {}) }
  })() : undefined

  const panelCard = ui.panel ? cards?.find((c) => c.id === ui.panel!.id) : undefined
  const rec = useRecord(ui.panel?.kind === 'capture' || ui.panel?.kind === 'review' ? ui.panel.id : undefined)
  const agentName = agent ? HARNESS[agent] ?? agent : 'your agent'
  const act = (c: JamCard | undefined, action: Parameters<ReturnType<typeof useJamQueue.getState>['act']>[1], body?: string) => (c ? useJamQueue.getState().act(c, action, body) : Promise.resolve(false))
  const openThread = (c?: JamCard) => { if (c?.thread) useComments.getState().setActive(c.thread) }
  /** The panel's arrows: the previous or next card of the same kind on the lane (reviews among reviews). */
  const step = (d: number) => {
    if (!ui.panel || !panelCard) return undefined
    const of = list.filter((c) => (ui.panel!.kind === 'review' ? c.state === 'review' : true))
    const n = of[of.findIndex((c) => c.id === panelCard.id) + d]
    return n ? () => openTile(n.id) : undefined
  }
  const detail = useMemo(() => {
    if (!ui.panel || !panelCard) return null
    const of = list.filter((c) => (ui.panel!.kind === 'review' ? c.state === 'review' : true))
    const idx = of.findIndex((c) => c.id === panelCard.id)
    return { of: [idx + 1, of.length] as [number, number] }
  }, [ui.panel, panelCard, list])

  const sheetOpen = ui.sheet === 'start' || ui.sheet === 'wrap'
  // the microphone question in a session with no capture recording: under the Jam button
  const askAlone = voice.asking && !cap.current && !!session
  if (!shown && !ui.panel && !sheetOpen && !askAlone) return null
  // in play the lane folds to a counter beside the navigator (Q opens it); the capture recording stays
  const folded = playing && !ui.laneKeys
  return (
    <>
      {cap.current && <EdgeRing />}
      {ui.sheet === 'start' && <div className="jm-sheet-at"><StartSheet /></div>}
      {ui.sheet === 'wrap' && <div className="jm-sheet-at"><WrapSheet /></div>}
      {askAlone && !sheetOpen && <div className="jm-sheet-at"><VoiceAsk {...voiceAsk(voice)} /></div>}
      {folded && shown && <PlayCounter cards={list} style={{ left: playNavRight(), bottom: 'var(--edge)' }} />}
      {shown && (
        <CaptureLaneRow
          tiles={folded ? [] : tiles} recording={recording} selected={ui.selected ?? undefined} keyboard={ui.laneKeys} followEnd={ui.followEnd}
          onOpen={(id) => openTile(id)}
          onMenu={(e, id) => { const c = cards?.find((x) => x.id === id); if (c) { ui.select(id); cm.open(e, tileMenu(c)) } else e.preventDefault() }}
          ask={voice.asking && cap.current ? voiceAsk(voice) : undefined}
          caption={cap.current ? captionOf(voice.heard[cap.current]) : undefined}
          notes={cap.noteOpen ? {
            notes: (cap.current ? cap.caps[cap.current]?.steps ?? [] : []).filter((x) => x.event === 'note').map((x) => ({ t: captureCounts({ ...cap.caps[cap.current!]!, t0: cap.caps[cap.current!]!.t0 }, x.at).time, text: (x as { text: string }).text })),
            draft: cap.noteDraft, onDraft: cap.setNoteDraft, onAdd: () => cap.note(cap.noteDraft), onClose: () => cap.setNoteOpen(false),
          } : undefined}
        />
      )}
      {ui.panel && panelCard && panelCard.kind === 'wrapup' && (
        <FocusPanel left={sidebarRight} onClose={() => ui.close()}>
          <RecordDetail key={panelCard.id} card={panelCard} agent={agentName} more={ui.moreOpen} of={detail?.of} onPrev={step(-1)} onNext={step(1)}
            onMoreOpen={(on) => ui.setMoreOpen(on)}
            onGood={() => { void act(panelCard, 'good'); ui.close() }}
            onLater={() => { void act(panelCard, 'later'); ui.close() }}
            onRetry={() => { void act(panelCard, 'retry'); ui.close() }}
            onDrop={() => { void act(panelCard, 'drop'); ui.close() }}
            onMore={(text) => void (async () => {
              if (await act(panelCard, 'more', text)) { clearMoreDraft(panelCard.id); ui.setMoreOpen(false); ui.close() }
              else useStore.getState().toast('your note was not sent - try again')
            })()} />
        </FocusPanel>
      )}
      {ui.panel && panelCard && panelCard.kind !== 'wrapup' && (
        <FocusPanelView
          left={sidebarRight}
          kind={ui.panel.kind}
          card={panelCard}
          of={detail?.of}
          agent={agentName}
          reviewedTitle={panelCard.reviewing ? cards?.find((c) => c.id === panelCard.reviewing!.card)?.title : undefined}
          lines={rec ? timelineLines(rec.record, panelCard.edited ?? rec.edited) : []}
          pictures={(rec?.record.pictures ?? []).map((id, i) => ({ id, url: picture(id)!, caption: `picture ${i + 1}` }))}
          shots={changedShots(panelCard.shots).map((x) => ({ frame: x.frame, before: picture(x.before), after: picture(x.after) }))}
          reply={panelCard.reply ? replyText(panelCard) : ''}
          view={ui.view} tab={ui.tab} moreOpen={ui.moreOpen}
          onTab={(i) => ui.setTab(i)} onFlip={() => ui.flip()} onMoreOpen={(on) => ui.setMoreOpen(on)}
          onClose={() => ui.close()}
          onEdit={(text) => saveEdit(panelCard, text)}
          onConfirm={() => void decideDraft(panelCard.id, 'confirm')}
          onKeep={() => void decideDraft(panelCard.id, 'keep')}
          onDrop={() => void decideDraft(panelCard.id, 'drop')}
          onResume={() => void resumeDraft(panelCard.id)}
          onGood={() => { void act(panelCard, 'good'); ui.close() }}
          onMore={(text) => void (async () => {
            // the composer and its words stay until the follow-up is really queued
            if (await act(panelCard, 'more', text)) { clearMoreDraft(panelCard.id); ui.setMoreOpen(false); ui.close() }
            else useStore.getState().toast('your follow-up was not sent - try again')
          })()}
          onLater={() => { void act(panelCard, 'later'); ui.close() }}
          onOpenThread={() => openThread(panelCard)}
          onPrev={step(-1)} onNext={step(1)} pending={pendingEdit(panelCard.id)} locked={cap.settling === panelCard.id}
          onRetry={() => void (async () => { if (await act(useJamQueue.getState().cards?.find((x) => x.id === panelCard.id), 'retry')) ui.close(); else useStore.getState().toast('the capture could not be retried - look again') })()}
        />
      )}
      <ContextMenu menu={cm.menu} close={cm.close} />
    </>
  )
}

/** In play: just right of the stage's navigator (its restart and frame arrows), where the counter sits. */
function playNavRight(): number {
  const r = document.querySelector('.sh-play-nav')?.getBoundingClientRect()
  return r ? Math.round(r.right + 8) : 176
}

/** What the microphone question shows now: the question, the download, its progress. */
function voiceAsk(v: ReturnType<typeof useJamVoice.getState>) {
  const d = v.download
  const step = v.choice === null ? 'ask' as const
    // the engine could not start: why, and a way to try again - never a download that would not help
    : v.server === 'unavailable' ? 'unavailable' as const
    : d?.state === 'downloading' ? 'downloading' as const : d?.state === 'checking' ? 'checking' as const
    : d?.state === 'failed' ? 'failed' as const : 'download' as const
  return {
    step, mb: v.mb, progress: d && d.total ? d.received / d.total : 0, error: v.server === 'unavailable' ? v.reason : d?.error,
    onYes: () => v.setChoice('yes'), onNo: () => v.setChoice('no'), onDownload: () => void v.startDownload(),
  }
}

/** The caption's words: the newest phrase in ink, a little of what came before it dim. */
function captionOf(heard: Heard[] | undefined): { old: string; live: string } | undefined {
  if (!heard?.length) return undefined
  const text = heard.map((w) => w.w)
  const live = text.slice(-12)
  const old = text.slice(Math.max(0, text.length - 24), Math.max(0, text.length - 12))
  return { old: old.join(' '), live: live.join(' ') }
}

/** Open a card's thread with the caret in its reply field - to add to the conversation. */
function replyIn(c: JamCard) {
  if (!c.thread) return
  useComments.getState().setActive(c.thread)
  // once the thread's card has drawn
  let tries = 0
  const focus = () => {
    const el = document.querySelector<HTMLTextAreaElement>('.cm-card textarea')
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) } else if (++tries < 20) requestAnimationFrame(focus)
  }
  requestAnimationFrame(focus)
}

/** A tile's right-click menu: what can be done with this capture now. */
function tileMenu(c: JamCard): MenuItem[] {
  const q = useJamQueue.getState()
  const act = (a: Parameters<typeof q.act>[1], body?: string) => { const fresh = useJamQueue.getState().cards?.find((x) => x.id === c.id); if (fresh) void useJamQueue.getState().act(fresh, a, body) }
  const item = (label: string, icon: ReactNode, onClick: () => void): MenuItem => ({ label, icon, onClick })
  // one icon per action, never two alike in a menu: open (eye), review (checklist), resume (play), rename
  // (pencil), add to queue (send arrow), keep (notebook), do next (to the top), retry, reply, thread, drop
  const open = item(c.state === 'review' ? 'Review' : c.state === 'draft' ? 'Open read-back' : 'Open', c.state === 'review' ? <CheckSquareOffsetIcon size={14} /> : <EyeIcon size={14} />, () => openTile(c.id))
  const rename: MenuItem = { label: 'Rename', icon: <PencilSimpleIcon size={14} />, panel: (close) => <RenameField card={c} close={close} /> }
  const reply = c.thread ? [item('Reply in thread', <ArrowBendUpLeftIcon size={14} />, () => replyIn(c))] : []
  const thread = c.thread ? [item('Open thread', <CommentIcon size={14} />, () => { useComments.getState().setActive(c.thread!) })] : []
  switch (c.state) {
    case 'draft': return [open, item('Resume capture', <PlayIcon size={14} />, () => void resumeDraft(c.id)), rename,
      item('Add to queue', <ArrowUpIcon size={14} />, () => void decideDraft(c.id, 'confirm')), item('Keep, do not send', <NotebookIcon size={14} />, () => void decideDraft(c.id, 'keep')),
      item('Drop', <XIcon size={14} />, () => void decideDraft(c.id, 'drop'))]
    case 'queued': return c.kind === 'capture'
      ? [open, rename, item('Do next', <ArrowLineUpIcon size={14} />, () => act('first')), item('Keep, do not send', <NotebookIcon size={14} />, () => act('keep')), item('Drop', <XIcon size={14} />, () => act('drop'))]
      : [open, item('Drop', <XIcon size={14} />, () => act('drop'))]   // a queued record: open or drop it
    case 'review': return [open, ...reply, ...thread, rename]
    case 'asks': return [...reply, open, rename]
    case 'failed': return [item('Retry', <ReloadIcon size={14} />, () => act('retry')), open, ...thread, item('Drop', <XIcon size={14} />, () => act('drop'))]
    default: return [open, ...reply, ...thread, rename]
  }
}

/** Rename, in place of the menu: the title as it is, ⏎ saves, Esc leaves; empty gives back its first words. */
function RenameField({ card, close }: { card: JamCard; close: () => void }) {
  const [text, setText] = useState(card.named ? card.title ?? '' : card.title === 'Capture' ? '' : card.title ?? '')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { requestAnimationFrame(() => ref.current?.select()) }, [])
  const save = async () => {
    const fresh = useJamQueue.getState().cards?.find((x) => x.id === card.id)
    if (fresh && !(await useJamQueue.getState().act(fresh, 'rename', text))) useStore.getState().toast('the capture could not be renamed - look again')
    close()
  }
  return (
    <div className="jm-rename">
      <input ref={ref} value={text} maxLength={80} placeholder="Name this capture" aria-label="Capture name"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void save(); if (e.key === 'Escape') close() }} />
    </div>
  )
}

/** The agent's reply to a card, as the thread shows it. */
function replyText(c: JamCard): string {
  const threads = useComments.getState().threads
  const t = threads.find((x) => x.id === c.thread)
  return t?.replies.find((r) => r.id === c.reply)?.body ?? ''
}

/** Lift the bottom edge while the lane shows: the sidebar stops above it, the Update pill, toasts and
 *  notices rise one lane. Returns the class for `.sh-app` - in its className, so a re-render of the app
 *  (interact on or off, the theme) never drops it. */
export function useLaneLift(): string {
  return useLaneShown() ? ' jm-lane-on' : ''
}
