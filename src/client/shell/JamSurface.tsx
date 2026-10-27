/**
 * Jam's surfaces in the shell (spec 27): the lane along the bottom (captures only, in the order made,
 * the one recording last), the one focus panel (a capture's detail - a draft's read-back - or a
 * review), the notes card over the capture tile, the teal edge ring and the numbered points while a
 * capture records. The pieces are presentational (jam-lane.tsx, jam-panel.tsx); this file feeds
 * them from the three stores and turns their clicks into queue actions.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ROUTE } from '../const.ts'
import { captureCounts, endedToReview, useJamCapture } from './jam-capture.ts'
import { useJamVoice, voiceSession, voiceSessionEnd, voiceSessionId, type Heard } from './jam-voice.ts'
import { holdsSessionMic, PlayCounter, RecordDetail, StartSheet, WrapSheet } from './jam-session.tsx'
import { FocusPanel, VoiceAsk } from './jam-panel.tsx'
import { addNote, decideDraft, laneCards, openThread, openTile, pendingEdit, resumeDraft, reveal, saveEdit, shownLane, startCapture } from './jam-keys.ts'
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu.tsx'
import { ArrowBendUpLeftIcon, ArrowLineUpIcon, ArrowUpIcon, CheckSquareOffsetIcon, CommentIcon, EyeIcon, NotebookIcon, PencilSimpleIcon, PlayIcon, ReloadIcon, XIcon } from './icons.tsx'
import { laneLine, timelineLines } from './jam-lines.ts'
import { changedShots, useJamQueue, type JamCard } from './jam-queue.ts'
import { DONE_GROUP, doneFold, letGoOfTile, useJamUi } from './jam-state.ts'
import { CaptureLaneRow, FocusPanelView } from './jam-surface-parts.tsx'
import { clearMoreDraft, EdgeRing } from './jam-panel.tsx'
import { useComments } from './comments-store.ts'
import { HARNESS } from './Comments.tsx'
import { PUBLISHED, useStore } from './store.ts'
import { api, withWs } from './api.ts'
import type { CaptureRecord } from '../../server/jam/types.ts'

const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
/** An <img> cannot send a header: its URL names the workspace, which the server's guard reads (A1.11). */
const picture = (id?: string) => (id ? withWs(`${ROUTE}/api/jam/picture?id=${encodeURIComponent(id)}`) : undefined)

/** Is the lane showing? While a run lasts with a capture in it, or a capture records. */
export function useLaneShown(): boolean {
  const cards = useJamQueue((s) => s.cards)
  const run = useJamQueue((s) => s.run)
  // a capture recording, sealing or waiting to send keeps the lane up until its server card arrives
  const busy = useJamCapture((s) => !!s.current || Object.keys(s.caps).length > 0 || s.unsent.length > 0)
  // a session keeps it up from start to end: between captures its own tile says it is still on
  const session = useJamQueue((s) => !!s.session)
  return !PUBLISHED && (busy || session || laneCards(cards, run).length > 0)
}

/** A capture's record, loaded once per id for its detail. */
function useRecord(id: string | undefined) {
  const [rec, setRec] = useState<{ id: string; record: CaptureRecord; edited?: string } | null>(null)
  useEffect(() => {
    if (!id || rec?.id === id) return
    let live = true
    api(`jam/capture?id=${encodeURIComponent(id)}`, { headers: { 'x-mv-c': csrf() } })
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
  const made = (id: string) => Number(/^cap-(\d+)-/.exec(id)?.[1] ?? 0)
  // the read-back of the capture stopped TO REVIEW last (⇧E, or J's wrap-up) opens when capturing stops - over a
  // review too (a capture made during a review is confirmed in its read-back; the review it follows stays bound in
  // its record). It waits for that capture's own card: a resumed one replaces its draft, which must not open instead.
  // The one ENDED last among them, not the one that sealed last (pictures can keep an earlier one sealing longer) -
  // one capture records at a time, so that is the one started last. A capture stopped with E after it, before it
  // had finished, never takes its place; and one stopped with E never opens, selects or moves anything - not even
  // when the queue left it a draft (Nic, 27 Oct: "only when the user says Stop and Review should we have the To
  // confirm state and open the capture card")
  const [shownFor, setShownFor] = useState<string | null>(null)
  useEffect(() => {
    if (cap.current) return
    const toReview = cap.sealed.filter((x) => x.review).reduce<(typeof cap.sealed)[number] | undefined>((a, x) => (!a || made(x.id) > made(a.id) ? x : a), undefined)
    if (!toReview?.card || toReview.id === shownFor) return
    const draft = cards?.find((c) => c.id === toReview.card!.id && c.state === 'draft')
    if (!draft) return
    setShownFor(toReview.id)
    if (ui.panel?.kind === 'capture' && ui.panel.id === draft.id) return
    ui.open({ kind: 'capture', id: draft.id })
    reveal(draft)
  }, [cap.current, cap.sealed, cards])

  // a review whose card left review under it - a capture made over it and stopped with E took it as More work, or
  // another tab decided it: its panel closes (its verdicts would only fail now); nothing else opens or moves
  const reviewing = ui.panel?.kind === 'review' ? cards?.find((c) => c.id === ui.panel!.id)?.state : undefined
  const wasReviewing = useRef(reviewing)
  useEffect(() => {
    if (wasReviewing.current === 'review' && reviewing && reviewing !== 'review' && useJamUi.getState().panel?.kind === 'review') ui.close()
    wasReviewing.current = reviewing
  }, [reviewing, ui.panel?.id])

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
  const withMade = list.map((c) => ({ made: c.made, tile: { id: c.id, state: c.state, title: c.title ?? 'Capture', line: laneLine(c), ...(c.exclusive ? { exclusive: true } : {}), ...(c.state === 'done' && c.shots?.some((x) => !x.same) ? { frames: c.shots.filter((x) => !x.same).map((x) => x.frame) } : {}), ...(c.kind === 'wrapup' ? { record: true } : {}) } as { id: string; state: JamCard['state']; title: string; line: string; exclusive?: boolean; frames?: string[]; record?: boolean } }))
  // captures the server does not hold yet: sealing (pictures and flushes still out) or waiting to send -
  // each in its place by when it started, so one sealing late never swaps with a newer one. Stopped with E it is
  // being sent to the queue ("Sending", the spinning glyph of work under way - never To confirm); stopped to review
  // (⇧E) it is finishing for its read-back
  const known = new Set(list.map((c) => c.id))
  for (const c of Object.values(cap.caps)) if (c.state === 'draining' && !known.has(c.id)) withMade.push({ made: made(c.id), tile: { id: c.id, state: 'confirming', title: 'Capture', line: c.review ? 'Finishing' : 'Sending' } })
  for (const id of cap.unsent) if (!known.has(id) && !cap.caps[id]) withMade.push({ made: made(id), tile: { id, state: 'confirming', title: 'Capture', line: cap.away ? 'Waiting to send' : endedToReview(id) ? 'Finishing' : 'Sending' } })
  const tiles = withMade.sort((a, b) => a.made - b.made).map((x) => x.tile)
  // a selected tile that became done while the Done group is folded: the group holds the selection now
  const doneNow = doneFold(tiles, ui.doneOpen)
  useEffect(() => {
    if (doneNow.fold && !ui.doneOpen && ui.selected && doneNow.done.some((t) => t.id === ui.selected)) ui.select(DONE_GROUP)
  }, [doneNow.fold, ui.doneOpen, ui.selected, doneNow.done.length])
  const recording = cap.current ? (() => {
    const c = cap.caps[cap.current!]
    const counts = captureCounts(c)
    const steps = (c?.steps ?? []).filter((x) => ['select', 'device', 'theme', 'copied', 'interact'].includes(x.event)).length
    return { time: counts.time, points: c?.points.length ?? 0, pictures: c?.pictures.length ?? 0, picturesMax: (c?.pictures.length ?? 0) >= 12, steps,
      notes: counts.notes, noteOn: cap.noteOpen, onNote: () => cap.setNoteOpen(!cap.noteOpen), onStop: () => cap.end(), onStopReview: () => cap.end(true),
      // the microphone: on while it hears this capture; off once you were asked (a click asks again)
      ...(voice.hearing === cap.current ? { mic: 'on' as const } : voice.choice !== null || voice.denied ? { mic: 'off' as const, onMic: () => useJamVoice.setState({ asking: true, choice: null }) } : {}) }
  })() : undefined

  // a session between captures (none recording, none still sealing here): its own tile
  const between = session && !cap.current ? {
    since: session.since, mic: voice.live,
    onCapture: () => startCapture(),   // as S: one started over an open review follows it
  } : undefined

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
      {/* the edges glow while a capture records - and for the whole session, between captures too */}
      {(cap.current || session) && <EdgeRing />}
      {ui.sheet === 'start' && <div className="jm-sheet-at"><StartSheet /></div>}
      {ui.sheet === 'wrap' && <div className="jm-sheet-at"><WrapSheet /></div>}
      {askAlone && !sheetOpen && <div className="jm-sheet-at"><VoiceAsk {...voiceAsk(voice)} /></div>}
      {folded && shown && <PlayCounter cards={list} style={{ left: playNavRight(), bottom: 'var(--edge)' }} />}
      {shown && (
        <CaptureLaneRow
          tiles={folded ? [] : tiles} recording={recording} between={between} selected={ui.selected ?? undefined} keyboard={ui.laneKeys} followEnd={ui.followEnd}
          doneOpen={ui.doneOpen} onDoneOpen={(open, ids) => ui.setDoneOpen(open, ids)}
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
          shots={changedShots(panelCard.shots).map((x) => ({ frame: x.frame, before: picture(x.before), after: picture(x.after), ...(x.new ? { new: true } : {}) }))}
          reply={panelCard.reply ? replyText(panelCard) : ''}
          view={ui.view} tab={ui.tab} moreOpen={ui.moreOpen}
          onTab={(i) => ui.setTab(i)} onFlip={(v) => ui.setView(v)} onMoreOpen={(on) => ui.setMoreOpen(on)}
          onClose={() => ui.close()}
          onEdit={(text) => saveEdit(panelCard, text)}
          onConfirm={() => void decideDraft(panelCard.id, 'confirm')}
          onKeep={() => void decideDraft(panelCard.id, 'keep')}
          onDrop={() => void decideDraft(panelCard.id, 'drop')}
          onResume={() => void resumeDraft(panelCard.id)}
          onAddNote={async (text, id) => { const ok = await addNote(panelCard, text, id); if (!ok) useStore.getState().toast('the note was not added - try again'); return ok }}
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
  openThread(c)
  // once the thread's card has drawn (on another board, once that board has loaded)
  const until = performance.now() + 3_000
  const focus = () => {
    const el = useComments.getState().active === c.thread ? document.querySelector<HTMLTextAreaElement>('.cm-card textarea') : null
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) } else if (performance.now() < until) requestAnimationFrame(focus)
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
  const thread = c.thread ? [item('Open thread', <CommentIcon size={14} />, () => openThread(c))] : []
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
    case 'working': {
      // a run your session went quiet on (spec 29b): give it back, run it in the background, or drop it
      if (c.runner?.kind !== 'session' || c.runner.state !== 'stalled') return [open, ...reply, ...thread, rename]
      const run = (a: 'again' | 'background' | 'drop') => () => { const fresh = useJamQueue.getState().cards?.find((x) => x.id === c.id); if (fresh) void useJamQueue.getState().runAct(fresh, a) }
      return [item('Give it back to your session', <ReloadIcon size={14} />, run('again')), item('Run it in the background', <ArrowUpIcon size={14} />, run('background')), open, ...thread, item('Drop it', <XIcon size={14} />, run('drop'))]
    }
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
