/**
 * Words on this Mac - the transport and the service (spec 27, Part 4).
 *
 * The page asks `POST /__mv/api/jam/audio-ticket` (owner-gated) for a single-use ticket that lives 30 s,
 * then opens `ws://<host>/__mv/api/jam/audio?ticket=...`. The upgrade is refused without a ticket, with a
 * used or expired one, without the owner's cookie, or from any Origin but this canvas's own. One audio
 * socket per canvas: a second closes the first.
 *
 * On the socket, the page speaks in order - so `end` can never overtake the audio:
 *   text   { type: 'begin', capture } · { type: 'end', capture, lastSample } · { type: 'drop', capture }
 *   binary [u8 id length][capture id][u32 offset, little endian][16 kHz mono Int16 samples] - `offset` the
 *          chunk's sample number from that capture's start
 * and hears { type: 'words', capture, words: [{ w, at }] } (at = capture sample), { type: 'final', capture,
 * incomplete? } and { type: 'unavailable', capture, reason } (no words for it - typed notes only).
 * Decoding runs in a worker thread (speech-worker.ts); raw audio is never written anywhere.
 */
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { Worker } from 'node:worker_threads'
import { WebSocketServer, type WebSocket } from 'ws'
import { modelPaths, modelsReady } from './speech-models.ts'

export const AUDIO_PATH = '/__mv/api/jam/audio'
const TICKET_MS = 30_000
/** A segment on the socket: a capture's audio or a session's talk, numbered (`<owner>~<n>`). */
const ID = /^(cap|ses)-\d{10,16}-[a-z0-9]{4,12}~[a-z0-9]{1,24}$/
/** A session's talk, heard between its captures: its words go to the session's transcript. */
export interface TalkWords { session: string; words: { w: string; at: number; lost?: true }[] }

// ---- tickets -------------------------------------------------------------------------------------------

const tickets = new Map<string, number>()
/** A single-use ticket for the audio socket, good for 30 s. */
export function issueTicket(now = Date.now()): string {
  for (const [t, exp] of tickets) if (exp <= now) tickets.delete(t)
  const t = randomBytes(24).toString('hex')
  tickets.set(t, now + TICKET_MS)
  return t
}
/** Take a ticket: true once, while it lives. */
export function takeTicket(t: string | null, now = Date.now()): boolean {
  if (!t) return false
  const exp = tickets.get(t)
  tickets.delete(t)
  return exp !== undefined && exp > now
}

const cookie = (req: IncomingMessage, name: string) => new RegExp(`(?:^|;\\s*)${name}=([\\w-]+)`).exec(String(req.headers.cookie ?? ''))?.[1]

/** May this upgrade open the audio socket? The ticket (taken now), the owner's cookie, and an Origin that
 *  is exactly this canvas (its host:port equals the request's Host). */
export function upgradeAllowed(req: IncomingMessage, now = Date.now()): boolean {
  const url = new URL(req.url ?? '', 'http://x')
  const ticket = url.searchParams.get('ticket')
  const origin = req.headers.origin
  let sameOrigin = false
  try { sameOrigin = !!origin && new URL(String(origin)).host === String(req.headers.host ?? '') } catch { sameOrigin = false }
  // the ticket is spent whatever else fails: one try per ticket
  const fresh = takeTicket(ticket, now)
  return fresh && sameOrigin && !!cookie(req, 'mv_c')
}

// ---- the service ---------------------------------------------------------------------------------------

export type VoiceState = 'unavailable' | 'needs-model' | 'loading' | 'ready'
/** The running dev server's speech service, for the API routes. */
export const speechLive: { svc?: Speech } = {}
export interface Speech {
  state(): Promise<{ state: VoiceState; reason?: string }>
  /** You asked again (the microphone question answered yes): a failure to start is forgotten and the
   *  engine tried once more - the engine missing stays what it is. */
  retry(): void
  /** Attach the socket's upgrade handler to the dev server's HTTP server. */
  attach(server: Server): void
  /** Is the audio connection busy - a segment still open on it, or one whose last words are not back yet?
   *  A tab whose microphone another tab took over takes it back only once this is false. */
  busy(): boolean
  /** A session ends: its talk still coming in is ended here, at the last sample received, and its last words
   *  are awaited (10 s at most) - so the transcript is whole before a record is sealed, whichever tab ends it.
   *  False when some words were still not back: the transcript is not whole yet. */
  finishTalk(session: string): Promise<boolean>
  stop(): void
}

/** The model holds about a gigabyte while loaded: with no capture for this long, the worker lets it go
 *  (the next capture loads it again in under a second). */
const IDLE_MS = 10 * 60_000

export function createSpeech(opts: { workerUrl?: URL; idleMs?: number; onTalk?: (t: TalkWords) => void
  /** each phrase's timing, and the model's load time once a start - numbers only (spec 27a Part D) */
  onTiming?: (t: { audioMs?: number; waitMs?: number; decodeMs?: number; backlogMs?: number; modelLoadMs?: number }) => void
  /** how long a session's ending waits for its last words (tests shorten it) */
  talkWaitMs?: number
  /** (tests) whether the model is there, and why the engine is missing - by default the real checks */
  modelsReady?: () => Promise<boolean>; engineMissing?: () => string | undefined } = {}): Speech {
  const ready_ = opts.modelsReady ?? modelsReady
  /** talk segments: their start on the page clock (ms), so their words get the time they were said */
  const talkT0 = new Map<string, number>()
  let worker: Worker | null = null
  let ready: Promise<Worker | null> | null = null
  let unavailable: string | undefined
  let live: WebSocket | null = null
  let lastUse = Date.now()
  // capture -> the socket it came on and the worker it began on, until its final (or drop)
  const owners = new Map<string, { ws: WebSocket; w?: Worker; done?: () => void; onFinal?: (whole: boolean) => void }>()
  /** talk segments open on a socket: how to end each one from here */
  const talk = new Map<string, () => Promise<boolean>>()

  const idle = setInterval(() => {
    if (worker && owners.size === 0 && Date.now() - lastUse > (opts.idleMs ?? IDLE_MS)) { const w = worker; worker = null; ready = null; void w.terminate() }
  }, Math.min(60_000, opts.idleMs ?? IDLE_MS))
  idle.unref()

  const engineMissing = (): string | undefined => {
    if (opts.engineMissing) return opts.engineMissing()
    try { createRequire(import.meta.url).resolve('sherpa-onnx-node'); return undefined } catch { return 'the speech engine (sherpa-onnx-node) is not installed - typed notes only' }
  }
  const tell = (ws: WebSocket | undefined, m: unknown) => { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) }

  /** The worker, started once (and again after it went): resolves to it once the model is loaded, or to
   *  null - the engine missing or failing, the model not there - and says why in `unavailable`. */
  const start = (): Promise<Worker | null> => {
    if (ready) return ready
    const p: Promise<Worker | null> = (async () => {
      const missing = engineMissing()
      if (missing) { unavailable = missing; return null }
      if (!(await ready_())) return null
      const url = opts.workerUrl ?? new URL(import.meta.url.endsWith('.ts') ? './speech-worker.ts' : './speech-worker.mjs', import.meta.url)
      const w = new Worker(url, { workerData: { paths: modelPaths() } })
      w.unref()
      return new Promise<Worker | null>((resolve) => {
        let settled = false
        const settle = (v: Worker | null) => { if (!settled) { settled = true; resolve(v) } }
        w.on('message', (m: any) => {
          if (m?.type === 'timing') { try { opts.onTiming?.({ audioMs: m.audioMs, waitMs: m.waitMs, decodeMs: m.decodeMs, backlogMs: m.backlogMs }) } catch { /* numbers only, never in the way */ } return }
          if (m?.type === 'ready') {
            if (typeof m.modelLoadMs === 'number') try { opts.onTiming?.({ modelLoadMs: m.modelLoadMs }) } catch { /* never in the way */ }
            // one worker at a time: a start that lost a race to another gives way to it
            if (worker && worker !== w) { void w.terminate(); settle(worker); return }
            worker = w; settle(w)
          }
          else if (m?.type === 'unavailable') { unavailable = `the speech engine could not start: ${m.reason} - typed notes only`; void w.terminate(); settle(null) }
          else if (m?.type === 'words' || m?.type === 'final') {
            const o = owners.get(m.capture)
            if (!o || o.w !== w) return   // not this worker's capture (any more)
            if (m.type === 'final') { owners.delete(m.capture); o.done?.(); o.onFinal?.(m.incomplete !== true) }
            // a session's talk: its words go to the transcript, here, on this Mac
            const t0 = talkT0.get(m.capture)
            if (m.type === 'words' && t0 !== undefined && Array.isArray(m.words)) {
              try { opts.onTalk?.({ session: m.capture.split('~')[0], words: m.words.map((x: { w: string; at: number; lost?: true }) => ({ ...x, at: t0 + (x.at / 16_000) * 1000 })) }) } catch { /* the transcript is best effort */ }
            }
            if (m.type === 'final') talkT0.delete(m.capture)
            tell(o.ws, m)
          }
        })
        // a worker that dies takes ITS captures' words with it (each is told they may be incomplete) - a
        // newer worker's captures are not its to end; error and exit both come, the first one counts
        let down = false
        const gone = (why: string) => {
          if (down) return
          down = true
          if (worker === w) { worker = null; ready = null }
          if (!settled) { unavailable = `the speech engine stopped: ${why} - typed notes only`; settle(null); return }
          for (const [id, o] of [...owners]) if (o.w === w) { owners.delete(id); o.done?.(); o.onFinal?.(false); tell(o.ws, { type: 'final', capture: id, incomplete: true }) }
        }
        w.on('error', (err) => gone(err.message))
        w.on('exit', (code) => gone(`exit ${code}`))
      })
    })()
    ready = p
    void p.then((w) => { if (!w && ready === p) ready = null })
    return p
  }

  /** Busy: a segment open on the live connection, or its last words not back - or the connection just opened
   *  (its page is still starting its microphone: a few seconds before its first segment). */
  let liveSince = 0
  const busyNow = (): boolean => {
    const ws = live
    if (!ws || ws.readyState !== ws.OPEN) return false
    return [...owners.values()].some((o) => o.ws === ws) || Date.now() - liveSince < 5_000
  }

  const onSocket = (ws: WebSocket) => {
    // one audio socket per canvas: a second closes the first
    if (live && live !== ws) { try { live.close(4000, 'another audio connection took over') } catch { /* gone */ } }
    live = ws
    liveSince = Date.now()
    let closed = false
    // per capture, one gate: everything for it reaches the worker in the order it came, and only the
    // worker it began on (audio said while the model loads waits for it instead of being lost); a capture
    // ended, dropped or whose socket closed takes nothing more
    interface Cap { gate: Promise<Worker | null>; ended: boolean; dropped: boolean; sent: number; keep?: true }   // keep: talk finished after its socket closed
    const caps = new Map<string, Cap>()
    const then = (c: Cap, f: (w: Worker) => void, otherwise?: () => void) => {
      c.gate = c.gate.then((w) => {
        if (w && worker === w && (!closed || c.keep)) f(w)
        else otherwise?.()
        return w
      })
    }
    ws.on('message', (data, isBinary) => {
      lastUse = Date.now()
      if (isBinary) {
        // [u8 id length][capture id][u32 offset][Int16 samples] - every chunk names its capture
        const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[])
        const n = buf.length ? buf[0] : 0
        if (buf.length < 1 + n + 6 || (buf.length - 1 - n - 4) % 2) return
        const id = buf.toString('utf8', 1, 1 + n)
        const c = caps.get(id)
        if (!c || c.ended || c.dropped) return
        const offset = buf.readUInt32LE(1 + n)
        const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + 1 + n + 4, buf.byteOffset + buf.length))
        c.sent = Math.max(c.sent, offset + pcm.length)
        then(c, (w) => { if (!c.dropped) w.postMessage({ type: 'audio', capture: id, offset, pcm }, [pcm.buffer as ArrayBuffer]) })
        return
      }
      let m: any
      try { m = JSON.parse(String(data)) } catch { return }
      if (typeof m?.capture !== 'string' || !ID.test(m.capture)) return
      const id: string = m.capture
      if (m.type === 'begin') {
        // a capture begins once - unless its words stopped (its worker went, or it could not start): then
        // the microphone asked again begins it anew, on the worker there is now
        const prev = caps.get(id)
        if (prev && !prev.ended && !prev.dropped && owners.has(id)) return
        if (prev) prev.dropped = true
        const own: { ws: WebSocket; w?: Worker; done?: () => void; onFinal?: (whole: boolean) => void } = { ws }
        owners.set(id, own)
        if (id.startsWith('ses-') && Number.isFinite(m.t0)) talkT0.set(id, Number(m.t0))
        const c: Cap = { gate: Promise.resolve(null), ended: false, dropped: false, sent: 0 }
        // a segment that is over (final, dropped, or never started) is forgotten here
        own.done = () => { if (caps.get(id) === c) caps.delete(id); talkT0.delete(id); talk.delete(id) }
        // a talk segment can be ended from here (the session ends in another tab): at the last sample received;
        // one already ending (its page switched to a capture) is awaited too - until its final words, 10 s at most
        // (false when they are still not back)
        if (id.startsWith('ses-')) {
          // its words that never came back (the engine stopped, or the worker lost the segment) are marked
          // in the transcript where they went missing: a record reading it says so, never silently short
          let finished!: () => void
          const final = new Promise<void>((r) => { finished = r })
          let over = false
          own.onFinal = (whole) => {
            if (over) return
            over = true
            if (!whole && c.sent > 0) { try { opts.onTalk?.({ session: id.split('~')[0], words: [{ w: '[words lost]', at: Date.now(), lost: true }] }) } catch { /* best effort */ } }
            finished()
          }
          // its worker is gone before its last words: they are lost, and the segment is over
          const lose = () => { if (owners.get(id) === own) owners.delete(id); own.done?.(); own.onFinal?.(false) }
          talk.set(id, () => {
            if (!c.ended && !c.dropped) {
              c.ended = true
              then(c, (w) => w.postMessage({ type: 'end', capture: id, lastSample: c.sent }), () => lose())
            }
            if (c.dropped) finished()
            return Promise.race([final.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), opts.talkWaitMs ?? 10_000))])
          })
        }
        c.gate = start().then((w) => {
          if (!w) { owners.delete(id); own.done?.(); own.onFinal?.(false); tell(ws, { type: 'unavailable', capture: id, reason: unavailable ?? 'the speech model is not ready - typed notes only' }); return null }
          if ((closed && !c.keep) || c.dropped || worker !== w) return null
          own.w = w   // its words come from this worker only
          w.postMessage({ type: 'begin', capture: id })
          return w
        })
        caps.set(id, c)
      } else if (m.type === 'end') {
        const c = caps.get(id)
        if (!c || c.ended || c.dropped) { tell(ws, { type: 'final', capture: id, incomplete: true }); return }
        c.ended = true
        const lastSample = Number(m.lastSample)
        // the worker answers `final` after the last words; without the worker it began on, they may be incomplete
        then(c, (w) => w.postMessage({ type: 'end', capture: id, lastSample: Number.isFinite(lastSample) ? lastSample : 0 }),
          () => { const o = owners.get(id); o?.done?.(); o?.onFinal?.(false); owners.delete(id); tell(ws, { type: 'final', capture: id, incomplete: true }) })
      } else if (m.type === 'drop') {
        const c = caps.get(id)
        if (!c || c.dropped) return
        c.dropped = true
        owners.get(id)?.done?.()
        owners.get(id)?.onFinal?.(true)   // dropped on purpose: nothing is missing
        owners.delete(id)
        then(c, (w) => w.postMessage({ type: 'drop', capture: id }))
      }
    })
    ws.on('close', () => {
      closed = true
      if (live === ws) live = null
      for (const [id, c] of caps) {
        // a session's talk still coming in is finished at its last sample, its words still go to the
        // transcript (they need no page); a capture's audio goes - its page knows its words may be incomplete
        if (id.startsWith('ses-') && !c.dropped) {
          // everything already received - its begin and audio waiting for the model too - still drains, in order
          c.keep = true
          if (!c.ended) { c.ended = true; then(c, (w) => w.postMessage({ type: 'end', capture: id, lastSample: c.sent }), () => { const o = owners.get(id); owners.delete(id); o?.done?.(); o?.onFinal?.(false) }) }
          continue
        }
        talkT0.delete(id)
        if (owners.get(id)?.ws === ws) owners.delete(id)
        c.dropped = true
        worker?.postMessage({ type: 'drop', capture: id })
      }
    })
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })
  return {
    retry() {
      // only a start that FAILED is forgotten: one still under way (or a worker running) is left alone
      if (engineMissing() || worker || ready) return
      unavailable = undefined
    },
    async state() {
      const missing = engineMissing()
      if (missing) return { state: 'unavailable', reason: missing }
      if (unavailable) return { state: 'unavailable', reason: unavailable }
      if (!(await ready_())) return { state: 'needs-model' }
      if (worker) return { state: 'ready' }
      void start()
      return unavailable ? { state: 'unavailable', reason: unavailable } : { state: 'loading' }
    },
    busy() { return busyNow() },
    async finishTalk(session) {
      return (await Promise.all([...talk].filter(([id]) => id.startsWith(`${session}~`)).map(([, end]) => end()))).every(Boolean)
    },
    attach(server) {
      server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (!(req.url ?? '').startsWith(AUDIO_PATH)) return   // the HMR socket and anything else: not ours
        if (!upgradeAllowed(req)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        // a tab taking the connection BACK (its session's talk) never takes it from one still working: the
        // check and the swap are one step, here
        if (new URL(req.url ?? '', 'http://x').searchParams.get('reclaim') === '1' && busyNow()) {
          socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws))
      })
    },
    stop() {
      clearInterval(idle)
      try { live?.close() } catch { /* gone */ }
      void worker?.terminate()
      wss.close()
    },
  }
}
