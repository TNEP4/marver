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
import { CursorClickIcon, FileCodeIcon, ImagesSquareIcon, LaserIcon, MicrophoneIcon, MicrophoneSlashIcon, PencilSimpleIcon } from './icons.tsx'

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
}

/**
 * `tiles` in time order (the order made); `recording` renders the capture recording now as the LAST
 * tile; `selected` = the tile whose detail is open (the accent ring); `keyboard` = Q has the lane
 * (the selected tile is Q's focus); `onOpen(id)` = a tile was clicked; `followEnd` = any value that
 * changes when a new capture or draft arrives - the lane scrolls back to its right end then (a manual
 * scroll back stays put until the next change).
 */
export function Lane({ tiles, recording, selected, keyboard, onOpen, onMenu, followEnd }: {
  tiles: LaneTile[]
  recording?: LaneRecording
  selected?: string
  keyboard?: boolean
  onOpen(id: string): void
  /** a right-click on a tile: its menu */
  onMenu?(e: React.MouseEvent, id: string): void
  followEnd?: unknown
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState<'' | 'l' | 'r' | 'lr'>('')
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
  }, [followEnd, tiles.length, !!recording])
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
      <div ref={ref} className={`jm-lane-in${fade ? ' ' + fade.split('').map((c) => `fade-${c}`).join(' ') : ''}`}
        onScroll={measure}
        onWheel={(e) => { const el = ref.current; if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY }}>
        {tiles.map((t) => (
          <button key={t.id} data-tile={t.id} data-state={t.state}
            className={`jm-card ${t.state}${selected === t.id ? ' focus' : ''}`}
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
        {recording && <CaptureTile {...recording} />}
      </div>
    </div>
  )
}

/** The capture recording now: a pulsing teal dot, "Capturing" and the timer over what it holds so far,
 *  then the Note button (N, with the count) and Stop (E). After E it reads "Finishing". */
export function CaptureTile({ time, points, pictures = 0, picturesMax, steps, counts, notes, noteOn, finishing, mic, onMic, onNote, onStop }: LaneRecording) {
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
      <button className="stop" onClick={onStop} disabled={finishing}>Stop<kbd>E</kbd></button>
    </div>
  )
}
