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
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { Worker } from 'node:worker_threads'
import { WebSocketServer, type WebSocket } from 'ws'
import { modelPaths, modelsReady } from './speech-models.ts'

export const AUDIO_PATH = '/__mv/api/jam/audio'
const TICKET_MS = 30_000
const ID = /^cap-\d{10,16}-[a-z0-9]{4,12}$/

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
  /** Attach the socket's upgrade handler to the dev server's HTTP server. */
  attach(server: Server): void
  stop(): void
}

/** The model holds about a gigabyte while loaded: with no capture for this long, the worker lets it go
 *  (the next capture loads it again in under a second). */
const IDLE_MS = 10 * 60_000

export function createSpeech(opts: { workerUrl?: URL; idleMs?: number } = {}): Speech {
  let worker: Worker | null = null
  let ready: Promise<Worker | null> | null = null
  let unavailable: string | undefined
  let live: WebSocket | null = null
  let lastUse = Date.now()
  const owners = new Map<string, WebSocket>()   // capture -> the socket it came on, until its final (or drop)

  const idle = setInterval(() => {
    if (worker && owners.size === 0 && Date.now() - lastUse > (opts.idleMs ?? IDLE_MS)) { const w = worker; worker = null; ready = null; void w.terminate() }
  }, Math.min(60_000, opts.idleMs ?? IDLE_MS))
  idle.unref()

  const engineMissing = (): string | undefined => {
    try { import.meta.resolve('sherpa-onnx-node'); return undefined } catch { return 'the speech engine (sherpa-onnx-node) is not installed - typed notes only' }
  }
  const tell = (ws: WebSocket | undefined, m: unknown) => { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) }

  /** The worker, started once (and again after it went): resolves to it once the model is loaded, or to
   *  null - the engine missing or failing, the model not there - and says why in `unavailable`. */
  const start = (): Promise<Worker | null> => {
    if (ready) return ready
    const p: Promise<Worker | null> = (async () => {
      const missing = engineMissing()
      if (missing) { unavailable = missing; return null }
      if (!(await modelsReady())) return null
      const url = opts.workerUrl ?? new URL(import.meta.url.endsWith('.ts') ? './speech-worker.ts' : './speech-worker.mjs', import.meta.url)
      const w = new Worker(url, { workerData: { paths: modelPaths() } })
      w.unref()
      return new Promise<Worker | null>((resolve) => {
        let settled = false
        const settle = (v: Worker | null) => { if (!settled) { settled = true; resolve(v) } }
        w.on('message', (m: any) => {
          if (m?.type === 'ready') { worker = w; settle(w) }
          else if (m?.type === 'unavailable') { unavailable = `the speech engine could not start: ${m.reason} - typed notes only`; void w.terminate(); settle(null) }
          else if (m?.type === 'words' || m?.type === 'final') {
            const ws = owners.get(m.capture)
            if (m.type === 'final') owners.delete(m.capture)
            tell(ws, m)
          }
        })
        // a worker that dies takes its captures' words with it: each is told they may be incomplete
        const gone = (why: string) => {
          if (worker === w) { worker = null; ready = null }
          if (!settled) { unavailable = `the speech engine stopped: ${why} - typed notes only`; settle(null); return }
          for (const [id, ws] of [...owners]) { owners.delete(id); tell(ws, { type: 'final', capture: id, incomplete: true }) }
        }
        w.on('error', (err) => gone(err.message))
        w.on('exit', (code) => gone(`exit ${code}`))
      })
    })()
    ready = p
    void p.then((w) => { if (!w && ready === p) ready = null })
    return p
  }

  const onSocket = (ws: WebSocket) => {
    // one audio socket per canvas: a second closes the first
    if (live && live !== ws) { try { live.close(4000, 'another audio connection took over') } catch { /* gone */ } }
    live = ws
    let closed = false
    // per capture, one gate: everything for it reaches the worker in the order it came, and only the
    // worker it began on (audio said while the model loads waits for it instead of being lost); a capture
    // ended, dropped or whose socket closed takes nothing more
    interface Cap { gate: Promise<Worker | null>; ended: boolean; dropped: boolean }
    const caps = new Map<string, Cap>()
    const then = (c: Cap, f: (w: Worker) => void, otherwise?: () => void) => {
      c.gate = c.gate.then((w) => {
        if (w && worker === w && !closed) f(w)
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
        then(c, (w) => { if (!c.dropped) w.postMessage({ type: 'audio', capture: id, offset, pcm }, [pcm.buffer as ArrayBuffer]) })
        return
      }
      let m: any
      try { m = JSON.parse(String(data)) } catch { return }
      if (typeof m?.capture !== 'string' || !ID.test(m.capture)) return
      const id: string = m.capture
      if (m.type === 'begin') {
        if (caps.has(id)) return
        owners.set(id, ws)
        const c: Cap = { gate: Promise.resolve(null), ended: false, dropped: false }
        c.gate = start().then((w) => {
          if (!w) { tell(ws, { type: 'unavailable', capture: id, reason: unavailable ?? 'the speech model is not ready - typed notes only' }); return null }
          if (closed || c.dropped || worker !== w) return null
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
          () => { owners.delete(id); tell(ws, { type: 'final', capture: id, incomplete: true }) })
      } else if (m.type === 'drop') {
        const c = caps.get(id)
        if (!c || c.dropped) return
        c.dropped = true
        owners.delete(id)
        then(c, (w) => w.postMessage({ type: 'drop', capture: id }))
      }
    })
    ws.on('close', () => {
      closed = true
      if (live === ws) live = null
      for (const [id, c] of caps) {
        if (owners.get(id) === ws) owners.delete(id)
        c.dropped = true
        worker?.postMessage({ type: 'drop', capture: id })
      }
    })
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })
  return {
    async state() {
      const missing = engineMissing()
      if (missing) return { state: 'unavailable', reason: missing }
      if (unavailable) return { state: 'unavailable', reason: unavailable }
      if (!(await modelsReady())) return { state: 'needs-model' }
      if (worker) return { state: 'ready' }
      void start()
      return unavailable ? { state: 'unavailable', reason: unavailable } : { state: 'loading' }
    },
    attach(server) {
      server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (!(req.url ?? '').startsWith(AUDIO_PATH)) return   // the HMR socket and anything else: not ours
        if (!upgradeAllowed(req)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
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
