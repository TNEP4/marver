/**
 * The adapters between Jam's stores (JamSurface.tsx) and its presentational pieces (jam-lane.tsx,
 * jam-panel.tsx): the lane row with the notes card floating over the capture tile, and the focus
 * panel showing a capture's detail (a draft's read-back) or a review.
 */
import { useEffect, useState } from 'react'
import { Lane, type LaneBetween, type LaneRecording, type LaneTile } from './jam-lane.tsx'
import { Caption, FocusPanel, NotesCard, ReadBack, ReviewDetail, VoiceAsk } from './jam-panel.tsx'
import type { TimelineLine } from './jam-lines.ts'
import type { JamCard } from './jam-queue.ts'

export function CaptureLaneRow({ tiles, recording, between, selected, keyboard, followEnd, onOpen, onMenu, notes, ask, caption }: {
  tiles: LaneTile[]; recording?: LaneRecording; between?: LaneBetween; selected?: string; keyboard?: boolean; followEnd?: number; onOpen(id: string): void
  onMenu?(e: React.MouseEvent, id: string): void
  notes?: { notes: { t: string; text: string }[]; draft: string; onDraft(t: string): void; onAdd(): void; onClose(): void }
  /** the microphone question (and the model's download), over the capture tile */
  ask?: Parameters<typeof VoiceAsk>[0]
  /** the words heard so far: the earlier ones and the newest phrase */
  caption?: { old: string; live: string }
}) {
  // the notes card floats one lane up over the capture tile, left edges aligned, clamped on screen
  const [at, setAt] = useState<{ left: number } | null>(null)
  useEffect(() => {
    if (!notes && !ask && !caption) return
    const place = () => {
      const tile = document.querySelector('.jm-lane .jm-chip, .jm-lane [data-jam-recording]') as HTMLElement | null
      const r = tile?.getBoundingClientRect()
      setAt(r ? { left: Math.max(10, Math.min(r.left, window.innerWidth - 340)) } : { left: 10 })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [!!notes, !!ask, !!caption, tiles.length])
  const words = !!caption && !!(caption.old || caption.live)
  const roomLeft = (at?.left ?? 10) - 8 >= 300
  return (
    <>
      <Lane tiles={tiles} recording={recording} between={between} selected={selected} keyboard={keyboard} followEnd={followEnd} onOpen={onOpen} onMenu={onMenu} />
      {/* one lane up, over the capture tile: the question, then the notes card above it; the words just
          left of the notes card (bottoms aligned), or over the tile when it is closed */}
      {(notes || ask) && (
        <div className="jm-over" style={{ position: 'absolute', left: at?.left ?? 10, bottom: 'calc(var(--edge) + 56px + 8px)', zIndex: 41, display: 'flex', flexDirection: 'column-reverse', gap: 8, alignItems: 'flex-start' }}>
          {ask && <VoiceAsk {...ask} />}
          {notes && <NotesCard {...notes} />}
          {/* no room to its left (the tile near the window's left edge): the words go on top */}
          {words && !roomLeft && <Caption old={caption!.old} live={caption!.live} />}
        </div>
      )}
      {words && (!(notes || ask) || roomLeft) && (
        <Caption old={caption!.old} live={caption!.live} style={notes || ask
          ? { position: 'absolute', right: `calc(100% - ${(at?.left ?? 10) - 8}px)`, bottom: 'calc(var(--edge) + 56px + 8px)', zIndex: 41 }
          : { position: 'absolute', left: at?.left ?? 10, bottom: 'calc(var(--edge) + 56px + 8px)', zIndex: 41 }} />
      )}
    </>
  )
}

export function FocusPanelView(p: {
  left: number; kind: 'capture' | 'review' | 'wrapup'; card: JamCard; of: [number, number] | undefined; agent: string; reviewedTitle?: string
  lines: TimelineLine[]; pictures: { id: string; url: string; caption: string }[]
  shots: { frame: string; before?: string; after?: string; new?: boolean }[]; reply: string
  view: 'after' | 'before'; tab: number; moreOpen: boolean
  onTab(i: number): void; onFlip(): void; onMoreOpen(on: boolean): void; onClose(): void
  onEdit(text: string): void; onConfirm(): void; onKeep(): void; onDrop(): void; onResume?: () => void
  onGood(): void; onMore(text: string): void; onLater(): void; onOpenThread(): void
  onPrev?: () => void; onNext?: () => void; pending?: string; onRetry?: () => void; locked?: boolean
  /** a note added in the read-back (a draft) */
  onAddNote?(text: string, id: string): Promise<boolean>
}) {
  const c = p.card
  const title = c.title ?? 'Capture'
  // a capture under review: its review, or the capture itself as it was read back (its pictures, its timeline)
  const [pane, setPane] = useState<'review' | 'capture'>('review')
  useEffect(() => { setPane('review') }, [c.id])
  const head = p.kind === 'review' ? (
    <div className="jm-ftabs jm-panes" role="tablist" data-jam-panes="">
      {(['review', 'capture'] as const).map((v) => <button key={v} role="tab" aria-selected={v === pane} className={v === pane ? 'on' : undefined} onClick={() => setPane(v)}>{v === 'review' ? 'Review' : 'Capture'}</button>)}
    </div>
  ) : undefined
  // points are picks and clicks (a picture line carries its own number, not a point)
  const points = p.lines.filter((l) => l.point != null && (l.kind === 'pick' || l.kind === 'click')).length
  const notes = p.lines.filter((l) => l.kind === 'note').length
  const meta = [p.lines.length ? p.lines[p.lines.length - 1].t : '0:00', `${c.frames.length} frame${c.frames.length === 1 ? '' : 's'}`,
    points ? `${points} point${points === 1 ? '' : 's'}` : '', p.pictures.length ? `${p.pictures.length} picture${p.pictures.length === 1 ? '' : 's'}` : '',
    notes ? `${notes} note${notes === 1 ? '' : 's'}` : ''].filter(Boolean)
  return (
    <FocusPanel left={p.left} onClose={p.onClose}>
      {p.kind === 'review' && pane === 'review' ? (
        <ReviewDetail key={c.id} title={title} head={head} of={p.of} onPrev={p.onPrev} onNext={p.onNext} frames={p.shots.map((s) => s.frame)} active={p.tab} onTab={p.onTab}
          view={p.view} onFlip={() => p.onFlip()} reply={p.reply} shots={p.shots} agent={p.agent}
          more={p.moreOpen} draftKey={c.id} onMore={p.onMore} onMoreOpen={p.onMoreOpen} onGood={p.onGood} onLater={p.onLater} onOpenThread={p.onOpenThread} />
      ) : (
        <ReadBack key={c.id} title={title} head={head} of={p.of} onPrev={p.onPrev} onNext={p.onNext} meta={meta} lines={p.lines} pictures={p.pictures} edited={c.edited} pending={p.pending}
          added={c.added} onAddNote={c.state === 'draft' ? p.onAddNote : undefined} autoNamed={!!c.name && !c.named && title === c.name}
          readOnly={c.state !== 'draft'} locked={p.locked} agent={p.agent}
          follows={c.reviewing ? p.reviewedTitle ?? 'the review on screen' : undefined}
          onEdit={p.onEdit} onConfirm={p.onConfirm} onKeep={p.onKeep} onDrop={p.onDrop} onResume={c.state === 'draft' ? p.onResume : undefined} onOpenThread={c.thread ? p.onOpenThread : undefined}
          onRetry={c.state === 'failed' ? p.onRetry : undefined} />
      )}
    </FocusPanel>
  )
}
