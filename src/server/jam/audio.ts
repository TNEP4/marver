/**
 * Words on this Mac - the transport and the service (spec 27, Part 4).
 *
 * The page asks `POST /__mv/api/jam/audio-ticket` (owner-gated) for a single-use ticket that lives 30 s,
 * then opens `ws://<host>/__mv/api/jam/audio?ticket=...`. The upgrade is refused without a ticket, with a
 * used or expired one, without the owner's cookie, or from any Origin but this canvas's own. One audio
 * socket per canvas: a second closes the first.
 *
 * On the socket, the page speaks in order - so `end` can never overtake the audio:
 *   text   { type: 'begin', capture } · { type: 'end', capture, lastSample }
 *   binary [u32 offset, little endian][16 kHz mono Int16 samples] - the capture begun last, `offset` its
 *          sample number from the capture's start
 * and hears { type: 'words', capture, words: [{ w, at }] } (at = capture sample) and { type: 'final', capture }.
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
  let lastUse = Date.now()
  const idle = setInterval(() => {
    if (worker && owners.size === 0 && Date.now() - lastUse > (opts.idleMs ?? IDLE_MS)) { const w = worker; worker = null; ready = null; void w.terminate() }
  }, Math.min(60_000, opts.idleMs ?? IDLE_MS))
  idle.unref()
  let ready: Promise<boolean> | null = null
  let unavailable: string | undefined
  let live: WebSocket | null = null
  const owners = new Map<string, WebSocket>()   // capture -> the socket it came on

  const engineMissing = (): string | undefined => {
    try { import.meta.resolve('sherpa-onnx-node'); return undefined } catch { return 'the speech engine (sherpa-onnx-node) is not installed - typed notes only' }
  }

  const start = (): Promise<boolean> => {
    if (ready) return ready
    ready = (async () => {
      const missing = engineMissing()
      if (missing) { unavailable = missing; return false }
      if (!(await modelsReady())) return false
      const url = opts.workerUrl ?? new URL(import.meta.url.endsWith('.ts') ? './speech-worker.ts' : './speech-worker.mjs', import.meta.url)
      const w = new Worker(url, { workerData: { paths: modelPaths() } })
      worker = w
      w.unref()
      w.on('message', (m: any) => {
        if (m?.type === 'words' || m?.type === 'final') {
          const s = owners.get(m.capture)
          if (m.type === 'final') owners.delete(m.capture)
          if (s && s.readyState === s.OPEN) s.send(JSON.stringify(m))
        }
      })
      w.on('error', () => { if (worker === w) { worker = null; ready = null } })
      w.on('exit', () => { if (worker === w) { worker = null; ready = null } })
      return new Promise<boolean>((resolve) => {
        const first = (m: any) => {
          if (m?.type === 'ready') { w.off('message', first); resolve(true) }
          else if (m?.type === 'unavailable') { w.off('message', first); unavailable = `the speech engine could not start: ${m.reason}`; void w.terminate(); resolve(false) }
        }
        w.on('message', first)
      })
    })()
    const p = ready
    void p.then((ok) => { if (!ok && ready === p) ready = null })
    return p
  }

  const onSocket = (ws: WebSocket) => {
    // one audio socket per canvas: a second closes the first
    if (live && live !== ws) { try { live.close(4000, 'another audio connection took over') } catch { /* gone */ } }
    live = ws
    let current: string | null = null
    const mine = new Set<string>()
    // per capture, everything goes to the worker through one gate, in the order it came: audio said while
    // the model loads (the first capture) waits for it instead of being lost
    const gates = new Map<string, Promise<boolean>>()
    const send = (capture: string, msg: unknown, transfer: ArrayBuffer[] = []) => {
      const g = gates.get(capture)
      if (g) gates.set(capture, g.then((ok) => { if (ok && worker) worker.postMessage(msg, transfer); return ok }))
    }
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[])
        if (!current || buf.length < 6 || (buf.length - 4) % 2) return
        const offset = buf.readUInt32LE(0)
        const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + 4, buf.byteOffset + buf.length))
        send(current, { type: 'audio', capture: current, offset, pcm }, [pcm.buffer as ArrayBuffer])
        return
      }
      let m: any
      try { m = JSON.parse(String(data)) } catch { return }
      if (typeof m?.capture !== 'string' || !ID.test(m.capture)) return
      const id: string = m.capture
      lastUse = Date.now()
      if (m.type === 'begin') {
        if (gates.has(id)) return
        current = id
        mine.add(id)
        owners.set(id, ws)
        gates.set(id, start().then((ok) => { if (ok && worker) worker.postMessage({ type: 'begin', capture: id }); return ok && !!worker }))
      } else if (m.type === 'end') {
        if (current === id) current = null
        const lastSample = Number(m.lastSample)
        const g = gates.get(id) ?? Promise.resolve(false)
        gates.delete(id)
        // the worker answers `final` after the last words; with no worker there is nothing to wait for
        void g.then((ok) => {
          if (ok && worker) worker.postMessage({ type: 'end', capture: id, lastSample: Number.isFinite(lastSample) ? lastSample : 0 })
          else { owners.delete(id); if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'final', capture: id })) }
        })
      }
    })
    ws.on('close', () => {
      if (live === ws) live = null
      for (const id of mine) { owners.delete(id); worker?.postMessage({ type: 'drop', capture: id }) }
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
      return { state: 'loading' }
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
