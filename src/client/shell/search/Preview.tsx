/**
 * Search (spec 35): the live preview - the selected result's frame, rendered by the real frame host in an iframe,
 * scaled to fit. Two slots: the one on screen, and the next result's frame prefetched, so arrowing down shows a frame
 * that is already there. Never a canvas frame: the URL carries `purpose=search-preview` (the bridge sends no
 * telemetry), the shell's canvas registry never hears of these windows, the iframe is inert and sandboxed, and the
 * frame's dimensions never reach the board's sizes.
 *
 * States: skeleton → committed (sh:ready) → visually ready (fonts, two animation frames) → shown. The skeleton (Nic, 24
 * Nov) is the frame's exact shape - its size is known before it loads (the canvas's own rule, frameSize) - scaled and
 * placed exactly where the frame will be: one translucent glass-grey fill with a touch of blue, no border, no shadow,
 * gently pulsing; the real frame fades in over it. The frame renders at its real size and is scaled down whole, as a
 * zoomed-out canvas frame is. A caption always belongs to what is drawn. Prefetch only while the canvas loads nothing and the heap is under 60 %.
 */
import { useEffect, useRef, useState } from 'react'
import { frameSize, frameUrl, useStore, type FrameEntry } from '../store.ts'
import { admissionIdle } from '../canvas/admission.ts'

export interface PreviewTarget { frame: FrameEntry; board?: string; title: string; where: string }

const STAGE = { w: 424, h: 396 }
// a target not ready yet shows its skeleton at once (Nic, 24 Nov): the picture never lags the selection
const CARD_AFTER = 0, FAIL_AFTER = 5000

interface Slot { key: string; t: PreviewTarget; src: string; state: 'loading' | 'ready' | 'failed'; at: number }

const themeOf = (f: FrameEntry) => f.theme ?? useStore.getState().viewTheme
const keyOf = (t: PreviewTarget) => `${t.frame.id}|${t.board ?? ''}|${themeOf(t.frame)}`
const srcOf = (t: PreviewTarget) => `${frameUrl(t.frame, themeOf(t.frame))}&purpose=search-preview${t.board ? `&board=${encodeURIComponent(t.board)}` : ''}`
const heapOk = () => {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory
  return !m || m.usedJSHeapSize / m.jsHeapSizeLimit < 0.6
}
const fit = (f: FrameEntry) => { const { w, h } = frameSize(f); const s = Math.min(STAGE.w / w, STAGE.h / h); return { w, h, s } }

export function Preview({ target, next }: { target: PreviewTarget | null; next: PreviewTarget | null }) {
  const [slots, setSlots] = useState<(Slot | null)[]>([null, null])
  const [shown, setShown] = useState<number | null>(null)   // the slot on screen (visually ready)
  const [card, setCard] = useState<PreviewTarget | null>(null)   // the skeleton standing in for a target still loading
  const [under, setUnder] = useState<PreviewTarget | null>(null)   // the skeleton kept beneath a frame while it fades in
  const frames = useRef<(HTMLIFrameElement | null)[]>([null, null])
  const want = useRef<string | null>(null)
  // the slot on screen, always current - an effect's closure must never overwrite it with a new target
  const shownRef = useRef<number | null>(null)
  shownRef.current = shown

  // the selected target: reuse a slot that has it, else load it into the slot not on screen
  useEffect(() => {
    if (!target) return   // an arrow held: nothing changes until it rests
    const key = keyOf(target)
    want.current = key
    setSlots((cur) => {
      const have = cur.findIndex((s) => s?.key === key)
      if (have >= 0) return cur
      const on = shownRef.current
      const free = on === 0 ? 1 : on === 1 ? 0 : (cur[0] ? 1 : 0)
      const nextSlots = [...cur]
      nextSlots[free] = { key, t: target, src: srcOf(target), state: 'loading', at: performance.now() }
      return nextSlots
    })
    const cardTimer = setTimeout(() => { if (want.current === key) setCard(target) }, shownRef.current === null ? 0 : CARD_AFTER)
    return () => clearTimeout(cardTimer)
  }, [target ? keyOf(target) : null])   // eslint-disable-line react-hooks/exhaustive-deps

  // show the wanted slot the moment it is ready
  useEffect(() => {
    const i = slots.findIndex((s) => s?.key === want.current)
    if (i >= 0 && slots[i]!.state === 'ready' && shown !== i) { setUnder(card ?? slots[i]!.t); setShown(i); setCard(null) }
    if (i >= 0 && slots[i]!.state === 'failed') setCard(slots[i]!.t)
  }, [slots, shown])

  // prefetch the next result into the other slot - only when the canvas loads nothing and memory allows
  useEffect(() => {
    if (!next || shown === null || slots[shown]?.key !== want.current) return
    const key = keyOf(next)
    if (slots.some((s) => s?.key === key)) return
    const id = setTimeout(() => {
      if (!admissionIdle() || !heapOk()) return
      setSlots((cur) => {
        const on = shownRef.current
        if (on === null || cur[on]?.key !== want.current) return cur   // never prefetch over what is on screen
        const other = on === 0 ? 1 : 0
        if (cur.some((s) => s?.key === key)) return cur
        const n = [...cur]; n[other] = { key, t: next, src: srcOf(next), state: 'loading', at: performance.now() }; return n
      })
    }, 60)
    return () => clearTimeout(id)
  }, [next ? keyOf(next) : null, shown, slots])   // eslint-disable-line react-hooks/exhaustive-deps

  // readiness: the frame's own sh:ready from THIS window, then fonts and two animation frames; a deadline
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type !== 'sh:ready' || (e.origin && e.origin !== location.origin)) return
      const i = frames.current.findIndex((f) => f?.contentWindow === e.source)
      if (i < 0) return
      const key = slots[i]?.key
      const doc = frames.current[i]?.contentDocument
      const fonts = doc?.fonts?.ready ?? Promise.resolve()
      void Promise.race([fonts, new Promise((r) => setTimeout(r, 1000))]).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).then(() => {
        setSlots((cur) => (cur[i]?.key === key && cur[i]!.state === 'loading' ? cur.map((s, k) => (k === i ? { ...s!, state: 'ready' as const } : s)) : cur))
      })
    }
    window.addEventListener('message', onMsg)
    const deadline = setInterval(() => setSlots((cur) => cur.some((s) => s?.state === 'loading' && performance.now() - s.at > FAIL_AFTER) ? cur.map((s) => (s?.state === 'loading' && performance.now() - s.at > FAIL_AFTER ? { ...s, state: 'failed' as const } : s)) : cur), 500)
    return () => { window.removeEventListener('message', onMsg); clearInterval(deadline) }
  }, [slots])

  useEffect(() => { if (!under) return; const t = setTimeout(() => setUnder(null), 150); return () => clearTimeout(t) }, [under])
  const caption = card ?? (shown !== null ? slots[shown]?.t : null) ?? null
  const skel = card ?? under
  return (
    <>
      {skel && (() => {
        const { w, h, s } = fit(skel.frame)
        const failed = !!card && slots.find((x) => x?.key === keyOf(card))?.state === 'failed'
        return <div className={`sr-skel${failed ? ' failed' : ''}`} style={{ width: Math.round(w * s), height: Math.round(h * s) }}>{failed ? 'This frame could not render here' : null}</div>
      })()}
      {slots.map((s, i) => {
        if (!s) return null
        const { w, h, s: scale } = fit(s.t.frame)
        const visible = shown === i && !card
        return (
          <div key={`slot-${i}`} className={`sr-stage${visible ? ' on' : ''}`} style={{ width: Math.round(w * scale), height: Math.round(h * scale) }} aria-hidden={!visible}>
            <iframe ref={(el) => { frames.current[i] = el; el?.setAttribute('inert', '') }} key={s.key} src={s.src} title={s.t.title}
              sandbox="allow-scripts allow-same-origin" tabIndex={-1}
              style={{ width: w, height: h, transform: `scale(${scale})` }} />
          </div>
        )
      })}
      {caption && <div className="sr-cap"><b>{caption.title}</b><span>{caption.where}</span></div>}
    </>
  )
}
