/**
 * Jam's surfaces in the shell (spec 27): the lane along the bottom (captures only, in the order made,
 * the one recording last), the one focus panel (a capture's detail - a draft's read-back - or a
 * review), the notes card over the capture tile, the teal edge ring and the numbered points while a
 * capture records. The pieces are presentational (jam-lane.tsx, jam-panel.tsx); this file feeds
 * them from the three stores and turns their clicks into queue actions.
 */
import { useEffect, useMemo, useState } from 'react'
import { ROUTE } from '../const.ts'
import { captureCounts, useJamCapture } from './jam-capture.ts'
import { decideDraft, laneCards, openTile, reveal, saveEdit } from './jam-keys.ts'
import { laneLine, timelineLines } from './jam-lines.ts'
import { useJamQueue, type JamCard } from './jam-queue.ts'
import { useJamUi } from './jam-state.ts'
import { CaptureLaneRow, FocusPanelView } from './jam-surface-parts.tsx'
import { EdgeRing } from './jam-panel.tsx'
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
  const recording = useJamCapture((s) => !!s.current)
  return !PUBLISHED && (recording || laneCards(cards, run).length > 0)
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
  const shown = useLaneShown()
  const [, setTick] = useState(0)
  // the capture tile's timer and a working card's clock move
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t) }, [])
  // a new capture or a new draft brings the lane back to its right end
  useEffect(() => { ui.follow() }, [cap.current, cards?.filter((c) => c.kind === 'capture').length])
  // the oldest draft's read-back opens when capturing stops - over a review too (a capture made during a
  // review is confirmed in its read-back; the review it follows stays bound in its record)
  const [shownSeal, setShownSeal] = useState(0)
  useEffect(() => {
    if (cap.current || cap.sealed.length <= shownSeal) return
    const sealed = cap.sealed[cap.sealed.length - 1]
    if (!sealed?.card) return
    const draft = laneCards(cards, run).find((c) => c.state === 'draft')
    if (!draft) return
    setShownSeal(cap.sealed.length)
    if (ui.panel?.kind === 'capture' && ui.panel.id === draft.id) return
    ui.open({ kind: 'capture', id: draft.id })
    reveal(draft)
  }, [cap.current, cap.sealed, cards])

  const list = laneCards(cards, run)
  const tiles = list.map((c) => ({ id: c.id, state: c.state, title: c.title ?? 'Capture', line: laneLine(c), ...(c.exclusive ? { exclusive: true } : {}) }))
  const recording = cap.current ? (() => {
    const c = cap.caps[cap.current!]
    const counts = captureCounts(c)
    const steps = (c?.steps ?? []).filter((x) => ['select', 'device', 'theme', 'copied', 'interact'].includes(x.event)).length
    return { time: counts.time, points: c?.points.length ?? 0, pictures: c?.pictures.length ?? 0, picturesMax: (c?.pictures.length ?? 0) >= 12, steps,
      notes: counts.notes, noteOn: cap.noteOpen, onNote: () => cap.setNoteOpen(!cap.noteOpen), onStop: () => cap.end() }
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

  if (!shown && !ui.panel) return null
  return (
    <>
      {cap.current && <EdgeRing />}
      {shown && (
        <CaptureLaneRow
          tiles={tiles} recording={recording} selected={ui.selected ?? undefined} keyboard={ui.laneKeys} followEnd={ui.followEnd}
          onOpen={(id) => openTile(id)}
          notes={cap.noteOpen ? {
            notes: (cap.current ? cap.caps[cap.current]?.steps ?? [] : []).filter((x) => x.event === 'note').map((x) => ({ t: captureCounts({ ...cap.caps[cap.current!]!, t0: cap.caps[cap.current!]!.t0 }, x.at).time, text: (x as { text: string }).text })),
            draft: cap.noteDraft, onDraft: cap.setNoteDraft, onAdd: () => cap.note(cap.noteDraft), onClose: () => cap.setNoteOpen(false),
          } : undefined}
        />
      )}
      {ui.panel && panelCard && (
        <FocusPanelView
          left={sidebarRight}
          kind={ui.panel.kind}
          card={panelCard}
          of={detail?.of}
          agent={agentName}
          reviewedTitle={panelCard.reviewing ? cards?.find((c) => c.id === panelCard.reviewing!.card)?.title : undefined}
          lines={rec ? timelineLines(rec.record, panelCard.edited ?? rec.edited) : []}
          pictures={(rec?.record.pictures ?? []).map((id, i) => ({ id, url: picture(id)!, caption: `picture ${i + 1}` }))}
          shots={(panelCard.shots ?? []).map((x) => ({ frame: x.frame, before: picture(x.before), after: picture(x.after) }))}
          reply={panelCard.reply ? replyText(panelCard) : ''}
          view={ui.view} tab={ui.tab} moreOpen={ui.moreOpen}
          onTab={(i) => ui.setTab(i)} onFlip={() => ui.flip()} onMoreOpen={(on) => ui.setMoreOpen(on)}
          onClose={() => ui.close()}
          onEdit={(text) => saveEdit(panelCard, text)}
          onConfirm={() => void decideDraft(panelCard.id, 'confirm')}
          onKeep={() => void decideDraft(panelCard.id, 'keep')}
          onDrop={() => void decideDraft(panelCard.id, 'drop')}
          onGood={() => { void act(panelCard, 'good'); ui.close() }}
          onMore={(text) => void (async () => {
            // the composer and its words stay until the follow-up is really queued
            if (await act(panelCard, 'more', text)) { ui.setMoreOpen(false); ui.close() }
            else useStore.getState().toast('your follow-up was not sent - try again')
          })()}
          onLater={() => { void act(panelCard, 'later'); ui.close() }}
          onOpenThread={() => openThread(panelCard)}
          onPrev={step(-1)} onNext={step(1)}
        />
      )}
    </>
  )
}

/** The agent's reply to a card, as the thread shows it. */
function replyText(c: JamCard): string {
  const threads = useComments.getState().threads
  const t = threads.find((x) => x.id === c.thread)
  return t?.replies.find((r) => r.id === c.reply)?.body ?? ''
}

/** Lift the bottom edge while the lane shows: the sidebar stops above it, the Update pill, toasts and
 *  notices rise one lane. */
export function useLaneLift() {
  const shown = useLaneShown()
  useEffect(() => {
    const app = document.querySelector('.sh-app')
    app?.classList.toggle('jm-lane-on', shown)
    return () => app?.classList.remove('jm-lane-on')
  }, [shown])
  void useStore
}
