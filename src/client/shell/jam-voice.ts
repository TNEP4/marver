/**
 * Words on this Mac, in the page (spec 27, Part 4): the microphone, the audio socket, and the words that
 * come back for each capture.
 *
 * The first `S` on a canvas asks once whether to use the microphone (the answer is kept for this
 * canvas); if the model is missing, it offers the download. The microphone is open only while a capture
 * records. An AudioWorklet turns it into 16 kHz mono PCM in 100 ms chunks; each chunk goes over the audio
 * socket tagged with its sample offset from the capture's start - so words get capture time from the
 * audio itself. At `E` the worklet marks the instant: the chunk up to it is sent, then `end` with that
 * last sample, on the same socket (it cannot overtake the audio). The words come back as the phrases are
 * transcribed; `final` closes the capture's words (3 s at most).
 */
import { create } from 'zustand'
import { ROUTE } from '../const.ts'
import { CONFIG, useStore } from './store.ts'

export const RATE = 16_000
const FINAL_MS = 3_000
const CHUNK = 1_600   // 100 ms

const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
const CHOICE = `mv-jam-voice:${CONFIG.workspace ?? 'unknown'}`
const readChoice = (): 'yes' | 'no' | null => { try { const v = localStorage.getItem(CHOICE); return v === 'yes' || v === 'no' ? v : null } catch { return null } }

export type ServerVoice = 'unknown' | 'unavailable' | 'needs-model' | 'loading' | 'ready'
export interface Heard { w: string; at: number; lost?: true }   // `at`: capture sample

interface VoiceStore {
  /** your answer for this canvas: use the microphone in captures, or not (null: not asked yet) */
  choice: 'yes' | 'no' | null
  server: ServerVoice
  reason?: string
  download: { state: 'idle' | 'downloading' | 'checking' | 'done' | 'failed'; received: number; total: number; error?: string } | null
  mb: number
  /** the question is on screen (first S, or the model missing) */
  asking: boolean
  /** the microphone is live for this capture */
  hearing: string | null
  /** the browser refused the microphone */
  denied: boolean
  /** words heard so far, by capture - the live caption */
  heard: Record<string, Heard[]>
  setChoice(c: 'yes' | 'no'): void
  refresh(): Promise<void>
  startDownload(): Promise<void>
  dismiss(): void
}

export const useJamVoice = create<VoiceStore>((set, get) => ({
  choice: readChoice(), server: 'unknown', download: null, mb: 490, asking: false, hearing: null, denied: false, heard: {},
  setChoice(c) {
    try { localStorage.setItem(CHOICE, c) } catch { /* this page only */ }
    set({ choice: c, ...(c === 'no' ? { asking: false } : {}) })
    if (c === 'yes') void get().refresh().then(() => { if (get().server === 'ready' || get().server === 'loading') { set({ asking: false }); const cur = current; if (cur) void listen(cur.capture, cur.t0) } })
  },
  async refresh() {
    try {
      const r = await fetch(`${ROUTE}/api/jam/voice`, { headers: { 'x-mv-c': csrf() } })
      if (!r.ok) { set({ server: 'unavailable', reason: 'jam is not running here' }); return }
      const b = await r.json()
      set({ server: b.state, reason: b.reason, download: b.download ?? null, mb: b.mb ?? 490 })
    } catch { set({ server: 'unavailable', reason: 'marver dev did not answer' }) }
  },
  async startDownload() {
    try { await fetch(`${ROUTE}/api/jam/voice`, { method: 'POST', headers: { 'x-mv-c': csrf() } }) } catch { /* the poll says */ }
    poll()
  },
  dismiss() { set({ asking: false }) },
}))

let polling: ReturnType<typeof setInterval> | null = null
function poll() {
  if (polling) return
  polling = setInterval(async () => {
    await useJamVoice.getState().refresh()
    const s = useJamVoice.getState()
    const d = s.download?.state
    if (d !== 'downloading' && d !== 'checking') {
      clearInterval(polling!); polling = null
      if (s.server === 'ready' || s.server === 'loading') { useJamVoice.setState({ asking: false }); const cur = current; if (cur) void listen(cur.capture, cur.t0) }
    }
  }, 1_000)
}

// ---- the audio --------------------------------------------------------------------------------------

/** The worklet: 16 kHz mono floats to Int16 chunks of 100 ms, each with the sample number it starts at.
 *  `mark` answers with the samples since the last chunk and the sample count at that instant. */
const WORKLET = `
class MvPcm extends AudioWorkletProcessor {
  constructor() { super(); this.n = 0; this.buf = new Int16Array(${CHUNK}); this.k = 0; this.port.onmessage = (e) => { if (e.data === 'mark') { this.port.postMessage({ mark: this.n, start: this.n - this.k, pcm: this.buf.slice(0, this.k) }); this.k = 0 } } }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]))
      this.buf[this.k++] = v < 0 ? v * 32768 : v * 32767
      this.n++
      if (this.k === ${CHUNK}) { this.port.postMessage({ start: this.n - this.k, pcm: this.buf.slice(0) }); this.k = 0 }
    }
    return true
  }
}
registerProcessor('mv-pcm', MvPcm)`

interface Live {
  capture: string
  t0: number                      // the capture's start on the page clock (ms)
  base: number                    // capture samples before this microphone opened (it opened late: the first S answered later)
  from: number                    // the worklet sample the capture's audio starts at
  ctx: AudioContext
  stream: MediaStream
  node: AudioWorkletNode
}
let live: Live | null = null
/** The capture recording now, for a microphone that opens after it started (the question answered). */
let current: { capture: string; t0: number } | null = null
let ws: WebSocket | null = null
let wsOpen: Promise<WebSocket | null> | null = null
const finals = new Map<string, () => void>()

function socket(): Promise<WebSocket | null> {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws)
  if (wsOpen) return wsOpen
  wsOpen = (async () => {
    try {
      const r = await fetch(`${ROUTE}/api/jam/audio-ticket`, { method: 'POST', headers: { 'x-mv-c': csrf() } })
      if (!r.ok) return null
      const { ticket } = await r.json()
      const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${ROUTE}/api/jam/audio?ticket=${encodeURIComponent(ticket)}`)
      s.binaryType = 'arraybuffer'
      await new Promise<void>((res, rej) => { s.onopen = () => res(); s.onerror = () => rej(new Error('audio socket refused')) })
      s.onmessage = (e) => {
        let m: any
        try { m = JSON.parse(String(e.data)) } catch { return }
        if (m?.type === 'words' && typeof m.capture === 'string' && Array.isArray(m.words)) {
          const words = (m.words as Heard[]).filter((x) => typeof x?.w === 'string' && Number.isFinite(x?.at))
          useJamVoice.setState((st) => ({ heard: { ...st.heard, [m.capture]: [...(st.heard[m.capture] ?? []), ...words] } }))
          onWords?.(m.capture, words)
        } else if (m?.type === 'final' && typeof m.capture === 'string') { finals.get(m.capture)?.(); finals.delete(m.capture) }
      }
      s.onclose = () => { if (ws === s) ws = null; for (const f of finals.values()) f(); finals.clear() }
      ws = s
      return s
    } catch { return null } finally { wsOpen = null }
  })()
  return wsOpen
}

/** Words for a capture, as they come (jam-capture.ts records them in its timeline). */
let onWords: ((capture: string, words: Heard[]) => void) | null = null
export const setWordsListener = (f: typeof onWords) => { onWords = f }

const send = (capture: string, offset: number, pcm: Int16Array) => {
  if (!ws || ws.readyState !== WebSocket.OPEN || !pcm.length) return
  const out = new Uint8Array(4 + pcm.byteLength)
  new DataView(out.buffer).setUint32(0, Math.max(0, offset), true)
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 4)
  ws.send(out)
}

/** Open the microphone for `capture` (started at `t0` on the page clock). */
async function listen(capture: string, t0: number) {
  if (live?.capture === capture) return
  const v = useJamVoice.getState()
  if (v.choice !== 'yes' || (v.server !== 'ready' && v.server !== 'loading')) return
  const s = await socket()
  if (!s || current?.capture !== capture) return
  let stream: MediaStream
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }) }
  catch { useJamVoice.setState({ denied: true, hearing: null }); useStore.getState().toast('the microphone is blocked for this page - typed notes only'); return }
  if (current?.capture !== capture) { stream.getTracks().forEach((t) => t.stop()); return }
  const ctx = new AudioContext({ sampleRate: RATE })
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })))
  const node = new AudioWorkletNode(ctx, 'mv-pcm')
  ctx.createMediaStreamSource(stream).connect(node)
  // the capture's sample clock: what was before the microphone opened counts too (silence, unheard)
  const base = Math.max(0, Math.round(((performance.timeOrigin + performance.now()) - t0) / 1000 * RATE))
  const l: Live = { capture, t0, base, from: -1, ctx, stream, node }
  node.port.onmessage = (e) => {
    const d = e.data as { start: number; pcm: Int16Array; mark?: number }
    if (l.from < 0) { if (d.mark === undefined) return; l.from = d.mark; return }   // the first mark sets the start
    if (d.mark !== undefined) return                                                // a mark answered elsewhere (end)
    send(capture, l.base + d.start - l.from, d.pcm)
  }
  s.send(JSON.stringify({ type: 'begin', capture }))
  node.port.postMessage('mark')
  live = l
  useJamVoice.setState({ hearing: capture, denied: false })
}

/** A capture starts: open the microphone if you said yes (ask first, once, if not asked yet). */
export async function voiceBegin(capture: string, t0: number) {
  current = { capture, t0 }
  const v = useJamVoice.getState()
  if (v.choice === 'no') return
  await v.refresh()
  const s = useJamVoice.getState()
  if (s.server === 'unavailable') { if (s.choice === null) { useJamVoice.setState({ choice: 'no' }); useStore.getState().toast(s.reason ?? 'words are not available here - typed notes only') } return }
  // first time, or yes but the model is missing: the question (the capture records meanwhile)
  if (s.choice === null || s.server === 'needs-model') { useJamVoice.setState({ asking: true }); if (s.choice === null) return }
  if (s.server === 'needs-model') return
  await listen(capture, t0)
}

/** A capture ends: the audio cut at this instant, its words awaited (3 s at most). Resolves true when the
 *  words are complete, false when they may not be. */
export async function voiceEnd(capture: string): Promise<boolean> {
  if (current?.capture === capture) current = null
  useJamVoice.setState((st) => ({ asking: st.asking && st.choice === null ? false : st.asking }))
  const l = live
  if (!l || l.capture !== capture) return true
  live = null
  useJamVoice.setState({ hearing: null })
  // the cut: the worklet's partial chunk and the sample count at this instant, then `end` - in order
  const cut = await new Promise<{ start: number; pcm: Int16Array; mark: number } | null>((res) => {
    const t = setTimeout(() => res(null), 500)
    l.node.port.onmessage = (e) => { if ((e.data as any).mark !== undefined) { clearTimeout(t); res(e.data) } else if (l.from >= 0) send(capture, l.base + e.data.start - l.from, e.data.pcm) }
    l.node.port.postMessage('mark')
  })
  l.stream.getTracks().forEach((t) => t.stop())
  void l.ctx.close()
  const lastSample = cut && l.from >= 0 ? l.base + cut.mark - l.from : l.base
  if (cut && l.from >= 0) send(capture, l.base + cut.start - l.from, cut.pcm)
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  const done = new Promise<boolean>((res) => { const t = setTimeout(() => { finals.delete(capture); res(false) }, FINAL_MS); finals.set(capture, () => { clearTimeout(t); res(true) }) })
  ws.send(JSON.stringify({ type: 'end', capture, lastSample }))
  return done
}

/** A capture dropped: the microphone closes, nothing more is sent for it. */
export function voiceDrop(capture: string) {
  if (current?.capture === capture) current = null
  const l = live
  if (!l || l.capture !== capture) return
  live = null
  l.stream.getTracks().forEach((t) => t.stop())
  void l.ctx.close()
  useJamVoice.setState((st) => { const heard = { ...st.heard }; delete heard[capture]; return { hearing: null, heard } })
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end', capture, lastSample: 0 }))
}

/** Words heard for a capture can be forgotten once it is sealed (they are in its record). */
export const forgetHeard = (capture: string) => useJamVoice.setState((st) => { if (!st.heard[capture]) return st; const heard = { ...st.heard }; delete heard[capture]; return { heard } })

if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) (window as any).__mvJamVoice = useJamVoice
