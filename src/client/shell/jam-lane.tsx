/**
 * The lane (spec 27 Part 1): the run's captures along the bottom of the canvas, in the order they
 * were made - oldest at the left, the capture recording now always the last tile, at the right end,
 * never cut. No bar behind it: every item is its own floating frosted tile, two lines, 44 px. Full,
 * it scrolls sideways and keeps the newest in view; earlier tiles scroll away under the left fade.
 * A tile never moves: a state change rewrites its status line in place. Colour lives only in the
 * glyph; the selected tile alone wears the accent ring. Every tile is one width - selecting one never
 * resizes it; a title cut short shows whole in a tooltip, and a right-click opens the tile's menu.
 *
 * Presentational only - the shell decides what is on it (jam-capture.ts and App mount it).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { JamStateIcon, type JamGlyph } from './jam-ui.tsx'
import { Tip } from './Tip.tsx'
import { DONE_CLOSE, DONE_GROUP, doneFold, doneLine } from './jam-state.ts'
import { ArrowsInLineHorizontalIcon, CursorClickIcon, FileCodeIcon, ImagesSquareIcon, LaserIcon, MicrophoneIcon, MicrophoneSlashIcon, PauseIcon, PencilSimpleIcon } from './icons.tsx'

/** The lane's height with its air: the 44 px tile + 12 px. While the lane shows, the sidebar stops
 *  above it and everything else on the bottom edge (the Update pill, toasts, notices) rises this much. */
export const LANE_H = 56

export interface LaneTile {
  id: string
  state: JamGlyph
  /** the capture's first words (the whole title is the tooltip) */
  title: string
  /** the status line - jam-lines.ts `laneLine` */
  line: string
  /** an exclusive card wears a file glyph: it changes how the queue runs */
  exclusive?: boolean
  /** a done tile: the frames it changed (not the ones it left as they were) - the Done group counts each frame once */
  frames?: string[]
  /** a session record's tile (the Done group counts records apart from captures) */
  record?: boolean
}

export interface LaneRecording {
  /** the capture's timer, "0:14" */
  time: string
  /** what it holds so far, drawn as the hi-fi's quiet stats (laser 2 · pictures 1 · steps 3); a
   *  picture count shows from the first picture, "12 · max" at the cap. `counts` is a plain-text
   *  fallback when the numbers are not known. */
  points?: number
  pictures?: number
  picturesMax?: boolean
  steps?: number
  counts?: string
  /** notes added so far (the count on the Note button) */
  notes: number
  /** the notes card is open */
  noteOn: boolean
  /** after E, waiting for the last words and the frames' flush */
  finishing?: boolean
  /** the microphone: hearing you (`on`), or not (`off` - a click asks again); none when never asked */
  mic?: 'on' | 'off'
  onMic?(): void
  onNote(): void
  onStop(): void
  onStopReview(): void
}

/**
 * `tiles` in time order (the order made); `recording` renders the capture recording now as the LAST
 * tile; `selected` = the tile whose detail is open (the accent ring); `keyboard` = Q has the lane
 * (the selected tile is Q's focus); `onOpen(id)` = a tile was clicked; `followEnd` = any value that
 * changes when a new capture or draft arrives - the lane scrolls back to its right end then (a manual
 * scroll back stays put until the next change).
 */
/** The session's length: seconds in its first minute ("42s"), then minutes ("3m"). */
export const sessionClock = (since: number, t = Date.now()): string => {
  const sec = Math.max(0, Math.floor((t - since) / 1000))
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m`
}
/** The session's clock, ticking - every second in its first minute, then often enough for the minutes. */
export function useSessionClock(since: number | undefined): string {
  const [, tick] = useState(0)
  useEffect(() => {
    if (since === undefined) return
    let t: ReturnType<typeof setTimeout>
    const next = () => { t = setTimeout(() => { tick((n) => n + 1); next() }, Date.now() - since < 60_000 ? 1000 : 5000) }
    next()
    return () => clearTimeout(t)
  }, [since])
  return since === undefined ? '' : sessionClock(since)
}

/** A session between captures: still on - its talk heard - and S starts the next capture. */
export interface LaneBetween {
  /** when the session began (its clock) */
  since: number
  /** the microphone hears the session's talk */
  mic: boolean
  onCapture(): void
}

export function Lane({ tiles, recording, between, selected, keyboard, onOpen, onMenu, followEnd, doneOpen = false, onDoneOpen }: {
  tiles: LaneTile[]
  /** two or more done tiles fold into one Done tile (0.26.1): shown open, or folded */
  doneOpen?: boolean
  onDoneOpen?(open: boolean, doneIds: string[]): void
  recording?: LaneRecording
  /** no capture recording in a session: its own tile, last */
  between?: LaneBetween
  selected?: string
  keyboard?: boolean
  onOpen(id: string): void
  /** a right-click on a tile: its menu */
  onMenu?(e: React.MouseEvent, id: string): void
  followEnd?: unknown
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState<'' | 'l' | 'r' | 'lr'>('')
  // done tiles: folded into one (two or more), or shown first behind the collapse tile
  const { fold, done, rest } = doneFold(tiles, doneOpen)
  const shown = fold ? (doneOpen ? [...done, ...rest] : rest) : tiles
  const doneFrames = new Set(done.flatMap((t) => t.frames ?? [])).size
  // opening shows the done tiles where they are (the lane's start); folding goes back to the newest end
  const firstOpen = useRef(true)
  useLayoutEffect(() => {
    if (firstOpen.current) { firstOpen.current = false; return }
    const el = ref.current
    // (folding with the group selected: the selection's own scroll shows the group)
    if (el && (doneOpen || selected !== DONE_GROUP)) el.scrollLeft = doneOpen ? 0 : el.scrollWidth
    measure()
  }, [doneOpen])
  const measure = () => {
    const el = ref.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setFade(left && right ? 'lr' : left ? 'l' : right ? 'r' : '')
  }
  // a new capture or draft brings the lane back to its right end
  useLayoutEffect(() => {
    const el = ref.current
    if (el) el.scrollLeft = el.scrollWidth
    measure()
  }, [followEnd, tiles.length, !!recording, !!between])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Q's arrows and Review all move the selection: keep the selected tile in view - only when it
  // MOVES, so a lane that opens with a tile selected still starts at its newest end
  const was = useRef(selected)
  useEffect(() => {
    if (selected === was.current) return
    was.current = selected
    if (!selected) return
    const el = ref.current?.querySelector<HTMLElement>(`[data-tile="${CSS.escape(selected)}"]`)
    const box = ref.current
    if (!el || !box) return
    // nearest, by hand: scrollIntoView would also scroll the page's ancestors
    const l = el.offsetLeft - box.offsetLeft, r = l + el.offsetWidth
    if (l < box.scrollLeft + 56) box.scrollLeft = Math.max(0, l - 56)
    else if (r > box.scrollLeft + box.clientWidth - 56) box.scrollLeft = r - box.clientWidth + 56
  }, [selected])
  return (
    <div className={`jm-lane${keyboard ? ' keyboard' : ''}`} data-jam-lane="">
      {fade.includes('l') && <span className="jm-lane-edge l" aria-hidden="true" />}
      {fade.includes('r') && <span className="jm-lane-edge r" aria-hidden="true" />}
      <div ref={ref} className="jm-lane-in"
        onScroll={measure}
        onWheel={(e) => { const el = ref.current; if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY }}>
        {fold && !doneOpen && (
          <button key={DONE_GROUP} data-tile={DONE_GROUP} data-state="done" data-jam-done="folded"
            className={`jm-card done group${selected === DONE_GROUP ? ' focus' : ''}`}
            onClick={() => onDoneOpen?.(true, done.map((t) => t.id))}>
            <JamStateIcon state="done" />
            <span className="tx">
              <span className="t">Done</span>
              <span className="m">{doneLine(done, doneFrames)}</span>
            </span>
          </button>
        )}
        {fold && doneOpen && (
          <button key={DONE_CLOSE} data-tile={DONE_CLOSE} data-jam-done="open" aria-label="Fold the done captures"
            className={`jm-card close${selected === DONE_CLOSE ? ' focus' : ''}`}
            onClick={() => onDoneOpen?.(false, done.map((t) => t.id))}>
            <ArrowsInLineHorizontalIcon size={15} /><span className="t">Done</span>
          </button>
        )}
        {shown.map((t) => (
          <button key={t.id} data-tile={t.id} data-state={t.state}
            className={`jm-card ${t.state}${selected === t.id ? ' focus' : ''}${fold && t.state === 'done' ? ' unfold' : ''}`}
            onClick={() => onOpen(t.id)} onContextMenu={onMenu ? (e) => onMenu(e, t.id) : undefined}>
            <JamStateIcon state={t.state} />
            <span className="tx">
              {/* the whole title, in the shell's own tooltip - only when the tile cuts it short */}
              <Tip label={<span className="jm-tip-title">{t.title}</span>} only={(el) => el.scrollWidth > el.clientWidth + 1}><span className="t">{t.title}</span></Tip>
              <span className="m">{t.line}</span>
            </span>
            {t.exclusive && <span className="x" aria-label="changes a shared file"><FileCodeIcon size={13} /></span>}
          </button>
        ))}
        {recording ? <CaptureTile {...recording} /> : between ? <BetweenTile {...between} /> : null}
      </div>
    </div>
  )
}

/** The session between captures: the same pulsing dot, "Jam on" and its clock, what it hears - then Capture (S). */
export function BetweenTile({ since, mic, onCapture }: LaneBetween) {
  const time = useSessionClock(since)
  return (
    <div className="jm-chip between" data-tile="between">
      <i className="jm-live-dot" />
      <span className="tx">
        <span className="lead">Jam on<span className="time">{time}</span></span>
        <span className="stats">{mic ? <><MicrophoneIcon size={12} />Listening between captures</> : <><MicrophoneSlashIcon size={12} />Between captures</>}</span>
      </span>
      <i className="sep" />
      <button className="go" onClick={onCapture}>Capture<kbd>S</kbd></button>
    </div>
  )
}

/** The capture recording now: a pulsing teal dot, "Capturing" and the timer over what it holds so far,
 *  then the Note button (N, with the count), Stop (E: queued at once) and Stop to review (⇧E, a pause icon: its read-back opens).
 *  After either it reads "Finishing". */
export function CaptureTile({ time, points, pictures = 0, picturesMax, steps, counts, notes, noteOn, finishing, mic, onMic, onNote, onStop, onStopReview }: LaneRecording) {
  return (
    <div className={`jm-chip${finishing ? ' finishing' : ''}`} data-tile="capturing">
      {finishing ? <JamStateIcon state="confirming" /> : <i className="jm-live-dot" />}
      {mic && !finishing && (
        <Tip label={mic === 'on' ? 'Hearing you - words on this Mac' : 'Microphone off - click to use it'}>
          <button className={`mic${mic === 'off' ? ' off' : ''}`} data-jam-mic={mic} onClick={onMic} aria-label={mic === 'on' ? 'Microphone on' : 'Microphone off'}>
            {mic === 'on' ? <MicrophoneIcon size={13} /> : <MicrophoneSlashIcon size={13} />}
          </button>
        </Tip>
      )}
      <span className="tx">
        <span className="lead">{finishing ? 'Finishing' : 'Capturing'}{!finishing && <span className="time">{time}</span>}</span>
        <span className="stats">
          {points != null && <span className="stat" title="points"><LaserIcon size={12} />{points}</span>}
          {(pictures > 0 || picturesMax) && <span className={`stat${picturesMax ? ' warn' : ''}`} title="pictures"><ImagesSquareIcon size={12} />{picturesMax ? '12 · max' : pictures}</span>}
          {steps != null && <span className="stat" title="UI steps"><CursorClickIcon size={11} />{steps}</span>}
          {points == null && counts && <span className="stat">{counts}</span>}
        </span>
      </span>
      <i className="sep" />
      <button className={`notebtn${noteOn ? ' on' : ''}`} onClick={onNote} disabled={finishing} aria-pressed={noteOn}>
        <PencilSimpleIcon size={13} />Note{notes ? <b>{notes}</b> : null}<kbd>N</kbd>
      </button>
      <Tip label="Stop and queue it - the agent starts on it">
        <button className="stop" onClick={onStop} disabled={finishing}>Stop<kbd>E</kbd></button>
      </Tip>
      <Tip label="Stop and look it over first - add notes, then queue it">
        <button className="stop review" onClick={onStopReview} disabled={finishing}><PauseIcon size={12} />Stop to review<kbd>⇧E</kbd></button>
      </Tip>
    </div>
  )
}
