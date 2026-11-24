/**
 * Search (spec 35): the live preview - the selected result's frame, rendered by the real frame host in an iframe,
 * scaled to fit. Two slots: the selected frame, and the next result's frame prefetched, so arrowing down shows a frame
 * that is already there. Never a canvas frame: the URL carries `purpose=search-preview` (the bridge sends no
 * telemetry), the shell's canvas registry never hears of these windows, the iframe is inert and sandboxed, and the
 * frame's dimensions never reach the board's sizes.
 *
 * One rule keeps it honest (Codex's step 2-3 review): ONLY the selected frame is ever drawn. What is on screen is
 * derived from the selection and the slots, never remembered - so the caption, the skeleton and the frame always name
 * the same thing; a frame that stops being selected disappears in the same paint (no fade out over the next one).
 *
 * A load: loading → committed (its own sh:ready, from THIS window, of THIS generation) → ready (fonts, two animation
 * frames) → shown, fading in over its skeleton. The skeleton (Nic, 24 Nov) is the frame's exact shape, known before it
 * loads (frameSize), scaled and placed where the frame will be. A load that errors or does not commit in 5 s is torn
 * down (failed); selected again, it is tried once more. Every load and prefetch waits for memory (heap under 60 %);
 * prefetch also for the canvas to load nothing, re-checked until it can.
 */
import { useEffect, useRef, useState } from 'react'
import { frameSize, frameUrl, useStore, type FrameEntry } from '../store.ts'
import { admissionIdle } from '../canvas/admission.ts'

export interface PreviewTarget { frame: FrameEntry; board?: string; title: string; where: string }

const STAGE = { w: 380, h: 440 }   // the pane less a margin all round (Nic: white space around the preview)
const COMMIT_WITHIN = 5000, FADE = 150

type Phase = 'loading' | 'committed' | 'ready' | 'failed'
interface Slot { key: string; gen: number; t: PreviewTarget; phase: Phase; at: number; readyAt?: number }

const themeOf = (f: FrameEntry) => f.theme ?? useStore.getState().viewTheme
/** The full rendering identity: the frame's URL carries its id, revision and theme; the board it renders on. */
const srcOf = (t: PreviewTarget) => `${frameUrl(t.frame, themeOf(t.frame))}&purpose=search-preview${t.board ? `&board=${encodeURIComponent(t.board)}` : ''}`
const keyOf = (t: PreviewTarget) => `${srcOf(t)}|${frameSize(t.frame).w}x${frameSize(t.frame).h}`
export const heapOk = (): boolean => {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory
  return !m || m.usedJSHeapSize / m.jsHeapSizeLimit < 0.6
}
/** the lens is min(580, 100vh - 200) tall; the frame keeps 70 px clear above and below in a short window too */
const fit = (f: FrameEntry) => { const { w, h } = frameSize(f); const room = Math.min(STAGE.h, Math.min(580, innerHeight - 200) - 140); const s = Math.min(STAGE.w / w, Math.max(120, room) / h); return { w, h, s } }
let gens = 0

/**
 * `target` is the selected result's frame (null: nothing to preview - a folder, no results); `paused` while an arrow is
 * held: nothing new loads or shows until it rests, and what is drawn stays drawn with its own caption.
 */
export function Preview({ target, next, paused }: { target: PreviewTarget | null; next: PreviewTarget | null; paused: boolean }) {
  const [slots, setSlots] = useState<(Slot | null)[]>([null, null])
  const [, tick] = useState(0)
  const frames = useRef<(HTMLIFrameElement | null)[]>([null, null])
  const retried = useRef(new Set<string>())
  const [held, setHeld] = useState<PreviewTarget | null>(null)   // what stays drawn while paused
  const [memory, setMemory] = useState(true)

  const shownTarget = paused ? held : target
  const want = shownTarget ? keyOf(shownTarget) : null
  useEffect(() => { if (!paused) setHeld(target) }, [paused, target ? keyOf(target) : null])   // eslint-disable-line react-hooks/exhaustive-deps

  // the selection: reuse a slot that has it (a failed one once more), else load it into a slot not holding the next
  useEffect(() => {
    if (paused || !target) return
    const key = keyOf(target)
    if (!heapOk()) { setMemory(false); return }
    setMemory(true)
    const nextKey = next ? keyOf(next) : null
    setSlots((cur) => {
      const have = cur.findIndex((s) => s?.key === key)
      if (have >= 0 && cur[have]!.phase !== 'failed') return cur
      if (have >= 0 && retried.current.has(key)) return cur   // failed twice: stays failed
      if (have >= 0) retried.current.add(key)
      // into: the failed slot itself; else an empty one; else the older one - never the next result's prefetch
      const free = [0, 1].filter((k) => cur[k]?.key !== nextKey || !nextKey)
      const into = have >= 0 ? have : free.find((k) => !cur[k]) ?? free.sort((x, y) => cur[x]!.at - cur[y]!.at)[0] ?? 0
      const n = [...cur]; n[into] = { key, gen: ++gens, t: target, phase: 'loading', at: performance.now() }; return n
    })
  }, [want, paused])   // eslint-disable-line react-hooks/exhaustive-deps

  // prefetch the next result into the other slot - when the selected one is ready, the canvas loads nothing and memory
  // allows; checked again every half second until it can (admission clears later)
  useEffect(() => {
    if (paused || !next || !want) return
    const key = keyOf(next)
    if (key === want) return
    const tryNow = () => {
      if (!admissionIdle() || !heapOk()) return false
      let done = false
      setSlots((cur) => {
        const on = cur.findIndex((s) => s?.key === want)
        if (on < 0 || cur[on]!.phase !== 'ready') return cur   // never ahead of what is selected
        if (cur.some((s) => s?.key === key)) { done = true; return cur }
        done = true
        const n = [...cur]; n[on === 0 ? 1 : 0] = { key, gen: ++gens, t: next, phase: 'loading', at: performance.now() }; return n
      })
      return done
    }
    const id = setInterval(() => { if (tryNow()) clearInterval(id) }, 500)
    const first = setTimeout(() => { if (tryNow()) clearInterval(id) }, 60)
    return () => { clearInterval(id); clearTimeout(first) }
  }, [next ? keyOf(next) : null, want, paused])   // eslint-disable-line react-hooks/exhaustive-deps

  // memory: over the line, the slot not selected is released at once
  useEffect(() => {
    const id = setInterval(() => {
      if (heapOk()) return
      setSlots((cur) => (cur.some((s) => s && s.key !== want) ? cur.map((s) => (s && s.key !== want ? null : s)) : cur))
    }, 1000)
    return () => clearInterval(id)
  }, [want])

  // readiness and failure: messages from THIS slot's window, of THIS generation, checked again after every wait
  useEffect(() => {
    const slotOf = (src: MessageEventSource | null) => frames.current.findIndex((f) => !!f && f.contentWindow === src)
    const onMsg = (e: MessageEvent) => {
      const type = e.data?.type
      if ((type !== 'sh:ready' && type !== 'sh:error') || (e.origin && e.origin !== location.origin)) return
      const i = slotOf(e.source)
      if (i < 0) return
      const s = slots[i]
      if (!s) return
      const gen = s.gen, win = e.source
      const still = (cur: (Slot | null)[]) => cur[i]?.gen === gen && frames.current[i]?.contentWindow === win
      if (type === 'sh:error') { setSlots((cur) => (still(cur) && cur[i]!.phase !== 'ready' ? cur.map((x, k) => (k === i ? { ...x!, phase: 'failed' as const } : x)) : cur)); return }
      if (s.phase !== 'loading') return
      setSlots((cur) => (still(cur) ? cur.map((x, k) => (k === i ? { ...x!, phase: 'committed' as const } : x)) : cur))
      const doc = frames.current[i]?.contentDocument
      const fonts = doc?.fonts?.ready ?? Promise.resolve()
      void Promise.race([fonts, new Promise((r) => setTimeout(r, 1000))])
        .then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
        .then(() => setSlots((cur) => (still(cur) && cur[i]!.phase === 'committed' ? cur.map((x, k) => (k === i ? { ...x!, phase: 'ready' as const, readyAt: performance.now() } : x)) : cur)))
    }
    window.addEventListener('message', onMsg)
    // the commitment deadline: loading too long is failed (and its iframe released below)
    const deadline = setInterval(() => setSlots((cur) => (cur.some((s) => s?.phase === 'loading' && performance.now() - s.at > COMMIT_WITHIN)
      ? cur.map((s) => (s?.phase === 'loading' && performance.now() - s.at > COMMIT_WITHIN ? { ...s, phase: 'failed' as const } : s)) : cur)), 500)
    return () => { window.removeEventListener('message', onMsg); clearInterval(deadline) }
  }, [slots])

  // the fade: re-render once it is over, so the skeleton beneath goes
  const shownSlot = want ? slots.find((s) => s?.key === want) : undefined
  const fading = !!shownSlot?.readyAt && performance.now() - shownSlot.readyAt < FADE
  useEffect(() => { if (!fading) return; const t = setTimeout(() => tick((n) => n + 1), FADE); return () => clearTimeout(t) }, [fading, shownSlot?.readyAt])

  if (!shownTarget) return null
  const ready = shownSlot?.phase === 'ready'
  const failed = shownSlot?.phase === 'failed'
  const { w, h, s } = fit(shownTarget.frame)
  return (
    <>
      {(!ready || fading) && (
        <div className={`sr-skel${failed || !memory ? ' failed' : ''}`} style={{ width: Math.round(w * s), height: Math.round(h * s) }}>
          {failed ? 'This frame could not render here' : !memory ? 'Preview paused - memory is short' : null}
        </div>
      )}
      {slots.map((sl, i) => {
        // a failed load is released: no iframe kept running for it
        if (!sl || sl.phase === 'failed') return null
        const f = fit(sl.t.frame)
        const visible = sl.key === want && sl.phase === 'ready'
        return (
          <div key={`slot-${i}`} className={`sr-stage${visible ? ' on' : ''}`} style={{ width: Math.round(f.w * f.s), height: Math.round(f.h * f.s) }} aria-hidden>
            <iframe ref={(el) => { frames.current[i] = el; el?.setAttribute('inert', '') }} key={sl.gen} src={srcOf(sl.t)} title={sl.t.frame.title ?? sl.t.frame.id} data-frame={sl.t.frame.id}
              sandbox="allow-scripts allow-same-origin" tabIndex={-1}
              style={{ width: f.w, height: f.h, transform: `scale(${f.s})` }} />
          </div>
        )
      })}
      <div className="sr-cap" data-frame={shownTarget.frame.id}><b>{shownTarget.title}</b><span>{shownTarget.where}</span></div>
    </>
  )
}
