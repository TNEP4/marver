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
  /** try the engine again (it failed to start before) and refresh */
  retry(): Promise<void>
  startDownload(): Promise<void>
  dismiss(): void
}

export const useJamVoice = create<VoiceStore>((set, get) => ({
  choice: readChoice(), server: 'unknown', download: null, mb: 490, asking: false, hearing: null, denied: false, heard: {},
  setChoice(c) {
    try { localStorage.setItem(CHOICE, c) } catch { /* this page only */ }
    set({ choice: c, ...(c === 'no' ? { asking: false } : {}) })
    // no: a microphone opening is cancelled, one open is cut now - the words said so far are kept
    if (c === 'no') stopListening()
    // yes: an engine that failed to start is tried again, then the microphone opens for the capture now
    if (c === 'yes') void get().retry().then(() => { if (get().server === 'ready' || get().server === 'loading') { set({ asking: false }); const cur = current; if (cur) void listen(cur.capture, cur.t0) } })
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
    try { await fetch(`${ROUTE}/api/jam/voice`, { method: 'POST', headers: { 'x-mv-c': csrf(), 'content-type': 'application/json' }, body: JSON.stringify({ download: true }) }) } catch { /* the poll says */ }
    poll()
  },
  async retry() {
    toldUnavailable = false
    try {
      const r = await fetch(`${ROUTE}/api/jam/voice`, { method: 'POST', headers: { 'x-mv-c': csrf(), 'content-type': 'application/json' }, body: JSON.stringify({ retry: true }) })
      if (r.ok) { const b = await r.json(); set({ server: b.state, reason: b.reason, download: b.download ?? null, mb: b.mb ?? 490 }); return }
    } catch { /* below */ }
    await get().refresh()
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
  base: number                    // capture samples before this microphone opened (it opened late: the question answered later)
  from: number                    // the worklet sample the capture's audio starts at (-1 until the first mark)
  sent: number                    // the capture sample just after the last one sent
  ctx: AudioContext
  stream: MediaStream
  node: AudioWorkletNode
  closed: boolean                 // ended or dropped: nothing more of it is sent
}
let live: Live | null = null
/** A microphone being opened (its permission, its worklet): ending or dropping the capture cancels it. */
let opening: { capture: string; cancelled: boolean } | null = null
/** The capture recording now, for a microphone that opens after it started (the question answered). */
let current: { capture: string; t0: number } | null = null
/** Captures whose words are still taken (recording or ending) - a dropped or sealed one takes none. */
const accepting = new Set<string>()
/** Captures whose words may be incomplete: the connection or the engine went while they recorded. */
const broken = new Set<string>()
let ws: WebSocket | null = null
let wsOpen: Promise<WebSocket | null> | null = null
const finals = new Map<string, (complete: boolean) => void>()
let toldUnavailable = false

/** The microphone stops for a capture still recording (its connection or the engine went): the words heard
 *  so far are kept, the rest is typed notes - and the capture knows its words may be incomplete. */
function lost(capture: string, why: string) {
  broken.add(capture)
  const l = live
  if (l && l.capture === capture) { close(l); live = null; useJamVoice.setState({ hearing: null }) }
  useStore.getState().toast(why)
}
const close = (l: Live) => { l.closed = true; l.node.port.onmessage = null; l.stream.getTracks().forEach((t) => t.stop()); void l.ctx.close().catch(() => {}) }

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
        if (typeof m?.capture !== 'string') return
        if (m.type === 'words' && Array.isArray(m.words)) {
          if (!accepting.has(m.capture)) return   // dropped or sealed: nothing more of it
          const words = (m.words as Heard[]).filter((x) => typeof x?.w === 'string' && Number.isFinite(x?.at))
          useJamVoice.setState((st) => ({ heard: { ...st.heard, [m.capture]: [...(st.heard[m.capture] ?? []), ...words] } }))
          onWords?.(m.capture, words)
        } else if (m.type === 'final') {
          const f = finals.get(m.capture)
          finals.delete(m.capture)
          if (f) f(m.incomplete !== true)
          else if (m.incomplete === true && accepting.has(m.capture)) lost(m.capture, 'the words stopped (the speech engine went) - the rest of this capture is typed notes')
        } else if (m.type === 'unavailable') {
          // no words for it: the microphone closes, and the reason is said once
          useJamVoice.setState({ server: 'unavailable', reason: typeof m.reason === 'string' ? m.reason : undefined })
          broken.add(m.capture)
          const l = live
          if (l && l.capture === m.capture) { close(l); live = null; useJamVoice.setState({ hearing: null }) }
          if (!toldUnavailable) { toldUnavailable = true; useStore.getState().toast(typeof m.reason === 'string' ? m.reason : 'words are not available - typed notes only') }
        }
      }
      s.onclose = () => {
        if (ws === s) ws = null
        // a closed connection is not a final: what was waiting may be incomplete
        for (const f of finals.values()) f(false)
        finals.clear()
        const l = live
        if (l && !l.closed) lost(l.capture, 'the microphone connection closed - the words so far are kept')
      }
      ws = s
      return s
    } catch { return null } finally { wsOpen = null }
  })()
  return wsOpen
}

/** Words for a capture, as they come (jam-capture.ts records them in its timeline). */
let onWords: ((capture: string, words: Heard[]) => void) | null = null
export const setWordsListener = (f: typeof onWords) => { onWords = f }

const enc = new TextEncoder()
/** One chunk, naming its capture: [u8 id length][id][u32 offset][Int16 samples]. */
const send = (capture: string, offset: number, pcm: Int16Array) => {
  if (!ws || ws.readyState !== WebSocket.OPEN || !pcm.length) return
  const id = enc.encode(capture)
  const out = new Uint8Array(1 + id.length + 4 + pcm.byteLength)
  out[0] = id.length
  out.set(id, 1)
  new DataView(out.buffer).setUint32(1 + id.length, Math.max(0, offset), true)
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1 + id.length + 4)
  ws.send(out)
}

/** A chunk of a live capture, from worklet sample `start` - its capture sample is the base plus where it
 *  falls after the first mark; what was sent last is remembered (the end falls back on it). */
function sendLive(l: Live, start: number, pcm: Int16Array) {
  const offset = l.base + start - l.from
  send(l.capture, offset, pcm)
  l.sent = Math.max(l.sent, offset + pcm.length)
}

/** Open the microphone for `capture` (started at `t0` on the page clock). Every step checks the capture is
 *  still recording; ending or dropping it meanwhile cancels the opening, and whatever was opened closes. */
async function listen(capture: string, t0: number) {
  if (live?.capture === capture || opening?.capture === capture) return
  const v = useJamVoice.getState()
  if (v.choice !== 'yes' || (v.server !== 'ready' && v.server !== 'loading')) return
  const op = { capture, cancelled: false }
  opening = op
  const stale = () => op.cancelled || current?.capture !== capture || useJamVoice.getState().choice !== 'yes'
  let stream: MediaStream | null = null
  let ctx: AudioContext | null = null
  const undo = () => { stream?.getTracks().forEach((t) => t.stop()); void ctx?.close().catch(() => {}) }
  try {
    const s = await socket()
    if (!s || stale()) return
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }) }
    catch { useJamVoice.setState({ denied: true, hearing: null }); useStore.getState().toast('the microphone is blocked for this page - typed notes only'); return }
    if (stale()) { undo(); return }
    ctx = new AudioContext({ sampleRate: RATE })
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })))
    if (stale() || s.readyState !== WebSocket.OPEN) { undo(); return }
    const node = new AudioWorkletNode(ctx, 'mv-pcm')
    ctx.createMediaStreamSource(stream).connect(node)
    // the capture's sample clock: what was before the microphone opened counts too (silence, unheard)
    const base = Math.max(0, Math.round(((performance.timeOrigin + performance.now()) - t0) / 1000 * RATE))
    const l: Live = { capture, base, from: -1, sent: base, ctx, stream, node, closed: false }
    node.port.onmessage = (e) => {
      if (l.closed) return
      const d = e.data as { start: number; pcm: Int16Array; mark?: number }
      if (l.from < 0) { if (d.mark !== undefined) l.from = d.mark; return }   // the first mark sets the start
      if (d.mark === undefined) sendLive(l, d.start, d.pcm)
    }
    s.send(JSON.stringify({ type: 'begin', capture }))
    node.port.postMessage('mark')
    live = l
    useJamVoice.setState({ hearing: capture, denied: false })
  } catch {
    undo()
    useStore.getState().toast('the microphone could not start - typed notes only')
  } finally { if (opening === op) opening = null }
}

/** A capture starts: open the microphone if you said yes (ask first, once, if not asked yet). */
export async function voiceBegin(capture: string, t0: number) {
  current = { capture, t0 }
  accepting.add(capture)
  const v = useJamVoice.getState()
  if (v.choice === 'no') return
  await v.refresh()
  const s = useJamVoice.getState()
  if (s.server === 'unavailable') {
    // the one line why, once - and a first S takes it as the answer
    if (s.choice === null) useJamVoice.setState({ choice: 'no' })
    if (!toldUnavailable) { toldUnavailable = true; useStore.getState().toast(s.reason ?? 'words are not available here - typed notes only') }
    return
  }
  // first time, or yes but the model is missing: the question (the capture records meanwhile)
  if (s.choice === null || s.server === 'needs-model') { useJamVoice.setState({ asking: true }); if (s.choice === null) return }
  if (s.server === 'needs-model') return
  await listen(capture, t0)
}

/** The microphone's cut for a live capture: the worklet's partial chunk and the sample count at this
 *  instant, then `end` on the same socket - resolves whether its words came back complete. */
async function cut(l: Live): Promise<boolean> {
  const capture = l.capture
  const mark = await new Promise<{ start: number; pcm: Int16Array; mark: number } | null>((res) => {
    const t = setTimeout(() => res(null), 500)
    l.node.port.onmessage = (e) => {
      if ((e.data as any).mark !== undefined) { clearTimeout(t); res(e.data) }
      else if (l.from >= 0) sendLive(l, e.data.start, e.data.pcm)
    }
    l.node.port.postMessage('mark')
  })
  // without a clean mark (the worklet did not answer, or never marked the start) the end is what was
  // sent - and the words may then be incomplete
  const clean = !!mark && l.from >= 0
  if (clean) sendLive(l, mark!.start, mark!.pcm)
  const lastSample = clean ? l.base + mark!.mark - l.from : l.sent
  close(l)   // nothing of it after the cut
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  const done = new Promise<boolean>((res) => {
    const t = setTimeout(() => { finals.delete(capture); res(false) }, FINAL_MS)
    finals.set(capture, (complete) => { clearTimeout(t); res(complete && clean) })
  })
  ws.send(JSON.stringify({ type: 'end', capture, lastSample }))
  return done
}

/** Words cut early (you said no during the capture): what they come back as, awaited at E. */
const cutEarly = new Map<string, Promise<boolean>>()

/** Stop listening for the capture recording now (the microphone refused mid-capture): an opening is
 *  cancelled, an open microphone is cut - its words so far still come back. */
function stopListening() {
  if (opening) opening.cancelled = true
  const l = live
  if (!l) return
  live = null
  useJamVoice.setState({ hearing: null })
  cutEarly.set(l.capture, cut(l))
}

/** A capture ends: the audio cut at this instant, its words awaited (3 s at most). Resolves true when the
 *  words are complete, false when they may not be (lost on the way, or no clean cut). */
export async function voiceEnd(capture: string): Promise<boolean> {
  if (current?.capture === capture) current = null
  if (opening?.capture === capture) opening.cancelled = true
  useJamVoice.setState((st) => ({ asking: st.asking && st.choice === null ? false : st.asking }))
  const wasBroken = broken.delete(capture)
  const early = cutEarly.get(capture)
  cutEarly.delete(capture)
  const l = live
  if (!l || l.capture !== capture) return early ? (await early) && !wasBroken : !wasBroken
  live = null
  useJamVoice.setState({ hearing: null })
  return (await cut(l)) && !wasBroken
}

/** A capture dropped: the microphone closes, and its audio is discarded - nothing of it is transcribed. */
export function voiceDrop(capture: string) {
  if (current?.capture === capture) current = null
  if (opening?.capture === capture) opening.cancelled = true
  accepting.delete(capture)
  broken.delete(capture)
  cutEarly.delete(capture)
  useJamVoice.setState((st) => { const heard = { ...st.heard }; delete heard[capture]; return { heard, ...(st.hearing === capture ? { hearing: null } : {}) } })
  const l = live
  if (l && l.capture === capture) { close(l); live = null }
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'drop', capture }))
}

/** A capture sealed: its words are in its record - nothing more of it is taken. */
export const forgetHeard = (capture: string) => {
  accepting.delete(capture)
  useJamVoice.setState((st) => { if (!st.heard[capture]) return st; const heard = { ...st.heard }; delete heard[capture]; return { heard } })
}

if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) (window as any).__mvJamVoice = useJamVoice
