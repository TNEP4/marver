/**
 * Words on this Mac, in the page (spec 27, Parts 4 and 5): the microphone, the audio socket, and the
 * words that come back.
 *
 * The first `S` (or `J`) on a canvas asks once whether to use the microphone (the answer is kept for this
 * canvas); if the model is missing, it offers the download. Outside a session the microphone is open only
 * while a capture records; in a session it stays open, and what is said between captures is the session's
 * talk (kept on this Mac in its transcript).
 *
 * The audio is cut into SEGMENTS, each with its own id on the socket (`<owner>~<n>`): a capture's audio
 * (maybe several segments - the microphone closed and opened again), or a stretch of session talk. An
 * AudioWorklet makes 16 kHz mono PCM in 100 ms chunks, each sent with its sample offset from the OWNER's
 * start, so words get the owner's time from the audio itself. A cut is a mark in the worklet: the chunk up
 * to it goes to the old segment, then `end` with that last sample, on the same socket (it cannot overtake
 * the audio) - and the next segment, if any, starts exactly at the mark. A capture's words are complete
 * only if every one of its segments ended cleanly and came back final.
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
const now = () => performance.timeOrigin + performance.now()

export type ServerVoice = 'unknown' | 'unavailable' | 'needs-model' | 'loading' | 'ready'
export interface Heard { w: string; at: number; lost?: true }   // `at`: the owner's sample

interface VoiceStore {
  /** your answer for this canvas: use the microphone, or not (null: not asked yet) */
  choice: 'yes' | 'no' | null
  server: ServerVoice
  reason?: string
  download: { state: 'idle' | 'downloading' | 'checking' | 'done' | 'failed'; received: number; total: number; error?: string } | null
  mb: number
  /** the question is on screen (first S or J, or the model missing) */
  asking: boolean
  /** the microphone is live for this capture (null: not a capture's - off, or a session's talk) */
  hearing: string | null
  /** the microphone is live at all (a capture or a session's talk) */
  live: boolean
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
  choice: readChoice(), server: 'unknown', download: null, mb: 490, asking: false, hearing: null, live: false, denied: false, heard: {},
  setChoice(c) {
    try { localStorage.setItem(CHOICE, c) } catch { /* this page only */ }
    set({ choice: c, ...(c === 'no' ? { asking: false } : {}) })
    // no: an opening is cancelled, an open microphone is cut now - the words said so far are kept
    if (c === 'no') { cancelOpening(); void closeMic() }
    // yes: an engine that failed to start is tried again, then the microphone opens for what runs now
    if (c === 'yes') void get().retry().then(() => { if (get().server === 'ready' || get().server === 'loading') { set({ asking: false }); void openFor(target()) } })
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
      if (s.server === 'ready' || s.server === 'loading') { useJamVoice.setState({ asking: false }); void openFor(target()) }
    }
  }, 1_000)
}

// ---- who the microphone is for --------------------------------------------------------------------------

/** What the microphone hears for: a capture recording, or - in a session, between captures - its talk. */
interface Owner { kind: 'capture' | 'talk'; id: string; t0: number }
/** The capture recording now (its start on the page clock). */
let capture: { id: string; t0: number } | null = null
/** The session running now: its talk is heard between captures. */
let session: { id: string; t0: number } | null = null
const target = (): Owner | null => capture ? { kind: 'capture', ...capture } : session ? { kind: 'talk', ...session } : null

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

/** One segment on the socket: whose it is, and where its audio starts. */
interface Segment {
  seg: string                     // `<owner>~<n>` - its own id on the socket
  owner: Owner
  base: number                    // the owner's sample at the segment's first sample (the time before it, unheard)
  from: number                    // the worklet sample the segment starts at (-1 until the first mark)
  sent: number                    // the owner's sample just after the last one sent
}
interface Mic { ctx: AudioContext; stream: MediaStream; node: AudioWorkletNode; seg: Segment | null; closed: boolean }
let mic: Mic | null = null
/** A microphone being opened (its permission, its worklet): a newer change cancels it. */
let opening: { cancelled: boolean } | null = null
let segN = 0
/** segment -> its owner (the words it brings back belong to it) */
const owners = new Map<string, Owner>()
/** per owner: every cut segment's promise - true when its words came back whole */
const cuts = new Map<string, Promise<boolean>[]>()
/** owners whose words may be incomplete: audio lost on the way */
const broken = new Set<string>()
/** captures whose words are still taken (recording or ending) - a dropped or sealed one takes none */
const accepting = new Set<string>()
let ws: WebSocket | null = null
let wsOpen: Promise<WebSocket | null> | null = null
const finals = new Map<string, (complete: boolean) => void>()   // segment -> its final
let toldUnavailable = false

const setLive = () => useJamVoice.setState({ live: !!mic && !mic.closed, hearing: mic && !mic.closed && mic.seg?.owner.kind === 'capture' ? mic.seg.owner.id : null })

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
        const owner = owners.get(m.capture)
        if (m.type === 'words' && Array.isArray(m.words)) {
          if (!owner || owner.kind !== 'capture' || !accepting.has(owner.id)) return   // talk goes to the transcript on the server
          const words = (m.words as Heard[]).filter((x) => typeof x?.w === 'string' && Number.isFinite(x?.at))
          useJamVoice.setState((st) => ({ heard: { ...st.heard, [owner.id]: [...(st.heard[owner.id] ?? []), ...words] } }))
          onWords?.(owner.id, words)
        } else if (m.type === 'final') {
          const f = finals.get(m.capture)
          finals.delete(m.capture)
          if (owner && (owner.kind === 'talk' || !accepting.has(owner.id))) owners.delete(m.capture)
          if (f) f(m.incomplete !== true)
          else if (m.incomplete === true && owner) lost(owner, 'the words stopped (the speech engine went)')
        } else if (m.type === 'unavailable') {
          // no words for it: the microphone closes, and the reason is said once
          useJamVoice.setState({ server: 'unavailable', reason: typeof m.reason === 'string' ? m.reason : undefined })
          if (owner) broken.add(owner.id)
          const cur = mic
          if (cur && cur.seg?.seg === m.capture) { closeNow(cur); mic = null; setLive() }
          if (!toldUnavailable) { toldUnavailable = true; useStore.getState().toast(typeof m.reason === 'string' ? m.reason : 'words are not available - typed notes only') }
        }
      }
      s.onclose = () => {
        if (ws === s) ws = null
        // a closed connection is not a final: what was waiting may be incomplete
        for (const f of finals.values()) f(false)
        finals.clear()
        if (mic && !mic.closed && mic.seg) lost(mic.seg.owner, 'the microphone connection closed')
      }
      ws = s
      return s
    } catch { return null } finally { wsOpen = null }
  })()
  return wsOpen
}

/** The microphone stops (its connection or the engine went): the words heard so far are kept, the owner's
 *  words are marked as maybe incomplete. */
function lost(owner: Owner, why: string) {
  broken.add(owner.id)
  if (mic && !mic.closed && mic.seg?.owner.id === owner.id) { closeNow(mic); mic = null; setLive() }
  useStore.getState().toast(`${why} - the words so far are kept`)
}
const closeNow = (m: Mic) => { m.closed = true; m.node.port.onmessage = null; m.stream.getTracks().forEach((t) => t.stop()); void m.ctx.close().catch(() => {}) }

/** Words for a capture, as they come (jam-capture.ts records them in its timeline). */
let onWords: ((capture: string, words: Heard[]) => void) | null = null
export const setWordsListener = (f: typeof onWords) => { onWords = f }

const enc = new TextEncoder()
/** One chunk, naming its segment: [u8 id length][id][u32 offset][Int16 samples]. */
function sendChunk(s: Segment, start: number, pcm: Int16Array) {
  if (s.from < 0 || !pcm.length) return
  const offset = s.base + start - s.from
  s.sent = Math.max(s.sent, offset + pcm.length)
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const id = enc.encode(s.seg)
  const out = new Uint8Array(1 + id.length + 4 + pcm.byteLength)
  out[0] = id.length
  out.set(id, 1)
  new DataView(out.buffer).setUint32(1 + id.length, Math.max(0, offset), true)
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1 + id.length + 4)
  ws.send(out)
}

/** A new segment for `owner`, starting at worklet sample `from` (-1: at the next mark). */
function segmentFor(owner: Owner, from: number): Segment {
  const seg = `${owner.id}~${++segN}`
  owners.set(seg, owner)
  // the owner's clock: the time before this segment counts too (unheard)
  const base = Math.max(0, Math.round((now() - owner.t0) / 1000 * RATE))
  const s: Segment = { seg, owner, base, from, sent: base }
  ws?.send(JSON.stringify({ type: 'begin', capture: seg, ...(owner.kind === 'talk' ? { t0: owner.t0 } : {}) }))
  return s
}

/** Mark the worklet: resolves with the partial chunk and the sample count at this instant (null if it
 *  does not answer in 500 ms). Chunks that arrive first go to `s`. */
function mark(m: Mic, s: Segment | null): Promise<{ start: number; pcm: Int16Array; mark: number } | null> {
  return new Promise((res) => {
    const t = setTimeout(() => res(null), 500)
    m.node.port.onmessage = (e) => {
      if ((e.data as any).mark !== undefined) { clearTimeout(t); res(e.data) }
      else if (s) sendChunk(s, e.data.start, e.data.pcm)
    }
    m.node.port.postMessage('mark')
  })
}
const listenTo = (m: Mic) => { m.node.port.onmessage = (e) => { if (!m.closed && m.seg && (e.data as any).mark === undefined) sendChunk(m.seg, e.data.start, e.data.pcm) } }

/** End a segment at a mark: what it holds up to the mark, then `end`; its final is awaited by its owner. */
function endSegment(s: Segment, at: { start: number; pcm: Int16Array; mark: number } | null) {
  const clean = !!at && s.from >= 0
  if (clean) sendChunk(s, at!.start, at!.pcm)
  const lastSample = clean ? s.base + at!.mark - s.from : s.sent
  const done = !ws || ws.readyState !== WebSocket.OPEN ? Promise.resolve(false) : new Promise<boolean>((res) => {
    const t = setTimeout(() => { finals.delete(s.seg); res(false) }, FINAL_MS)
    finals.set(s.seg, (complete) => { clearTimeout(t); res(complete && clean) })
    ws!.send(JSON.stringify({ type: 'end', capture: s.seg, lastSample }))
  })
  const list = cuts.get(s.owner.id) ?? []
  list.push(done)
  cuts.set(s.owner.id, list)
}

/** Switch the open microphone to `next` at one instant: the current segment ends at the mark, the next
 *  starts at it - nothing between them is lost or heard twice. `next` null closes the microphone. */
let switching: Promise<void> = Promise.resolve()
function switchTo(next: Owner | null): Promise<void> {
  switching = switching.then(async () => {
    const m = mic
    if (!m || m.closed) return
    const cur = m.seg
    const at = await mark(m, cur)
    if (cur) endSegment(cur, at)
    if (next && !m.closed && at) { m.seg = segmentFor(next, at.mark); listenTo(m) }
    else { closeNow(m); if (mic === m) mic = null }
    setLive()
  })
  return switching
}

/** Open the microphone for `owner` (it may be cancelled meanwhile by a newer change, or the answer no). */
async function openFor(owner: Owner | null) {
  if (!owner) return
  if (mic && !mic.closed) { if (mic.seg?.owner.id !== owner.id) await switchTo(owner); return }
  const v = useJamVoice.getState()
  if (v.choice !== 'yes' || (v.server !== 'ready' && v.server !== 'loading')) return
  cancelOpening()
  const op = { cancelled: false }
  opening = op
  const stale = () => op.cancelled || target()?.id !== owner.id || useJamVoice.getState().choice !== 'yes'
  let stream: MediaStream | null = null
  let ctx: AudioContext | null = null
  const undo = () => { stream?.getTracks().forEach((t) => t.stop()); void ctx?.close().catch(() => {}) }
  try {
    const s = await socket()
    if (!s || stale()) return
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }) }
    catch { useJamVoice.setState({ denied: true }); useStore.getState().toast('the microphone is blocked for this page - typed notes only'); return }
    if (stale()) { undo(); return }
    ctx = new AudioContext({ sampleRate: RATE })
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })))
    if (stale() || s.readyState !== WebSocket.OPEN) { undo(); return }
    const node = new AudioWorkletNode(ctx, 'mv-pcm')
    ctx.createMediaStreamSource(stream).connect(node)
    const m: Mic = { ctx, stream, node, seg: null, closed: false }
    mic = m
    const seg = segmentFor(owner, -1)
    m.seg = seg
    // the first mark sets where the segment starts; chunks before it are not its
    node.port.onmessage = (e) => { if ((e.data as any).mark !== undefined && seg.from < 0) { seg.from = e.data.mark; listenTo(m) } }
    node.port.postMessage('mark')
    useJamVoice.setState({ denied: false })
    setLive()
  } catch {
    undo()
    useStore.getState().toast('the microphone could not start - typed notes only')
  } finally { if (opening === op) opening = null }
}
const cancelOpening = () => { if (opening) opening.cancelled = true }
/** Close the microphone now (its current segment ends at the mark). */
const closeMic = () => switchTo(null)

/** What the question and the server say before the microphone opens for `owner`. */
async function begin(owner: Owner) {
  const v = useJamVoice.getState()
  if (v.choice === 'no') return
  await v.refresh()
  const s = useJamVoice.getState()
  if (s.server === 'unavailable') {
    // the one line why, once - and a first S or J takes it as the answer
    if (s.choice === null) useJamVoice.setState({ choice: 'no' })
    if (!toldUnavailable) { toldUnavailable = true; useStore.getState().toast(s.reason ?? 'words are not available here - typed notes only') }
    return
  }
  // first time, or yes but the model is missing: the question (the capture or session runs meanwhile)
  if (s.choice === null || s.server === 'needs-model') { useJamVoice.setState({ asking: true }); return }
  await openFor(target())
}

/** Every segment of an owner ended: true when all its words came back whole. */
async function settled(owner: string): Promise<boolean> {
  const list = cuts.get(owner) ?? []
  cuts.delete(owner)
  const all = await Promise.all(list)
  const ok = all.every(Boolean) && !broken.has(owner)
  broken.delete(owner)
  return ok
}

// ---- captures and sessions --------------------------------------------------------------------------------

/** A capture starts: the microphone hears it (from the session's talk at the same instant, or opened now). */
export async function voiceBegin(id: string, t0: number) {
  capture = { id, t0 }
  accepting.add(id)
  if (mic && !mic.closed) { await switchTo(target()); return }
  await begin({ kind: 'capture', id, t0 })
}

/** A capture ends: its audio cut at this instant (in a session the talk goes on from it), its words awaited
 *  (3 s at most). Resolves true when the words are complete, false when they may not be. */
export async function voiceEnd(id: string): Promise<boolean> {
  if (capture?.id === id) capture = null
  cancelOpening()
  useJamVoice.setState((st) => ({ asking: st.asking && st.choice === null && !session ? false : st.asking }))
  if (mic && !mic.closed && mic.seg?.owner.id === id) await switchTo(target())
  return settled(id)
}

/** A capture dropped: what was heard for it is discarded - nothing of it is transcribed. */
export async function voiceDrop(id: string) {
  if (capture?.id === id) capture = null
  cancelOpening()
  accepting.delete(id)
  useJamVoice.setState((st) => { const heard = { ...st.heard }; delete heard[id]; return { heard } })
  if (mic && !mic.closed && mic.seg?.owner.id === id) await switchTo(target())
  // every segment it had: dropped on the server (discarded, untranscribed)
  for (const [seg, o] of owners) if (o.id === id) { ws?.send(JSON.stringify({ type: 'drop', capture: seg })); finals.get(seg)?.(false); finals.delete(seg); owners.delete(seg) }
  cuts.delete(id)
  broken.delete(id)
}

/** A capture sealed: its words are in its record - nothing more of it is taken. */
export const forgetHeard = (id: string) => {
  accepting.delete(id)
  for (const [seg, o] of owners) if (o.id === id && !finals.has(seg)) owners.delete(seg)
  useJamVoice.setState((st) => { if (!st.heard[id]) return st; const heard = { ...st.heard }; delete heard[id]; return { heard } })
}

/** A session starts: the microphone (if you said yes) hears its talk from now on, between captures. */
export async function voiceSession(id: string, t0: number) {
  session = { id, t0 }
  if (capture) return   // the capture keeps the microphone; the talk starts when it ends
  if (mic && !mic.closed) { await switchTo(target()); return }
  await begin({ kind: 'talk', id, t0 })
}

/** A session ends: its talk's last segment is cut; the microphone closes (unless a capture records). */
export async function voiceSessionEnd(): Promise<void> {
  const s = session
  session = null
  if (!s) return
  if (mic && !mic.closed && mic.seg?.owner.id === s.id) await switchTo(target())
  await settled(s.id)
}

if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) (window as any).__mvJamVoice = useJamVoice
