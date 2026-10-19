// Words on this Mac (spec 27, Part 4 - M3): the phrase cutting with a fake VAD and recognizer, the audio
// socket's gate, and - where the model is present (MARVER_MODELS or ~/.marver/models) - the real thing.
import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import WebSocket from 'ws'
import { MAX_PHRASE, MAX_WAITING, PREROLL, RATE, Segmenter, WINDOW, tokensToWords, type Recognized, type VadLike, type Word } from '../src/server/jam/speech-cut.ts'
import { AUDIO_PATH, createSpeech, issueTicket, takeTicket } from '../src/server/jam/audio.ts'
import { modelPaths, modelsReady } from '../src/server/jam/speech-models.ts'

/** A VAD stand-in: a window with any non-zero sample is speech; 0.4 s of silence ends a phrase; `flush`
 *  ends the phrase being said now (as sherpa's does). `start` is the first speech window's sample. */
class FakeVad implements VadLike {
  private at = 0
  private cur: { start: number; parts: Float32Array[] } | null = null
  private quiet = 0
  private out: { start: number; samples: Float32Array }[] = []
  acceptWaveform(w: Float32Array) {
    const speech = w.some((x) => x !== 0)
    if (speech) { this.cur ??= { start: this.at, parts: [] }; this.cur.parts.push(w.slice()); this.quiet = 0 }
    else if (this.cur) { this.quiet += w.length; this.cur.parts.push(w.slice()); if (this.quiet >= 0.4 * RATE) this.close() }
    this.at += w.length
  }
  private close() {
    if (!this.cur) return
    const n = this.cur.parts.reduce((k, p) => k + p.length, 0)
    const s = new Float32Array(n); let o = 0
    for (const p of this.cur.parts) { s.set(p, o); o += p.length }
    this.out.push({ start: this.cur.start, samples: s }); this.cur = null; this.quiet = 0
  }
  isEmpty() { return !this.out.length }
  front() { return this.out[0] }
  pop() { this.out.shift() }
  flush() { this.close() }
  isDetected() { return !!this.cur && this.quiet === 0 }
}

/** A recognizer stand-in: one word per 0.5 s of audio, named by where it falls; optionally held. */
const fakeRecognizer = (hold?: { wait: Promise<void> }) => async (samples: Float32Array): Promise<Recognized> => {
  if (hold) await hold.wait
  const tokens: string[] = [], timestamps: number[] = []
  for (let t = 0; t < samples.length; t += RATE / 2) { tokens.push(` w${tokens.length}`); timestamps.push(t / RATE) }
  return { tokens, timestamps }
}
const speech = (n: number) => new Float32Array(n).fill(0.1)
const silence = (n: number) => new Float32Array(n)

describe('words: cutting phrases (no model)', () => {
  it('tokens become words: a space or ▁ starts one, its time is its first token\'s', () => {
    const w = tokensToWords({ tokens: ['▁Th', 'is', ' bad', 'ge', '.'], timestamps: [0, 0.1, 0.24, 0.3, 0.5] }, 1000)
    expect(w).toEqual([{ w: 'This', at: 1000 }, { w: 'badge.', at: 1000 + Math.round(0.24 * RATE) }])
  })

  it('a 40-second monologue with no pause is cut at 15 s by Marver', async () => {
    const phrases: number[] = []
    const seg = new Segmenter(new FakeVad(), async (s) => { phrases.push(s.length); return { tokens: [], timestamps: [] } }, () => {})
    for (let o = 0; o < 40 * RATE; o += 1600) seg.push(o, speech(1600))
    await seg.end(40 * RATE)
    expect(phrases.length).toBe(3)
    for (const n of phrases.slice(0, 2)) { expect(n).toBeGreaterThanOrEqual(MAX_PHRASE - WINDOW); expect(n).toBeLessThanOrEqual(MAX_PHRASE + WINDOW) }   // no pre-roll across a forced cut
  })

  it('nothing waits beyond 30 s: while the recognizer is busy the oldest waiting phrase is dropped, and the words say so', async () => {
    let release!: () => void
    const hold = { wait: new Promise<void>((r) => { release = r }) }
    const words: Word[] = []
    const seg = new Segmenter(new FakeVad(), fakeRecognizer(hold), (w) => words.push(...w))
    let maxWaiting = 0
    for (let o = 0; o < 75 * RATE; o += 1600) {
      seg.push(o, speech(1600))
      maxWaiting = Math.max(maxWaiting, (seg as any).waiting.reduce((n: number, p: any) => n + p.samples.length, 0))
    }
    expect(maxWaiting).toBeLessThanOrEqual(MAX_WAITING)
    const lost = words.filter((w) => w.lost)
    expect(lost.length).toBeGreaterThanOrEqual(1)
    expect(lost[0].w).toBe('[words lost]')
    release()
    await seg.end(75 * RATE)
    // what survived is in time order, the lost marker where its phrase was
    const ats = words.map((w) => w.at)
    expect([...ats].sort((a, b) => a - b)).toEqual(ats.slice().sort((a, b) => a - b))
  })

  it('pre-roll: 250 ms before a phrase, never before the capture\'s start', async () => {
    const starts: number[] = []
    const seg = new Segmenter(new FakeVad(), async (s) => ({ tokens: [' x'], timestamps: [0] }), (w) => starts.push(...w.map((x) => x.at)))
    // in whole VAD windows (the VAD hears windows, not samples)
    seg.push(0, concatAll([silence(WINDOW), speech(32 * WINDOW), silence(52 * WINDOW), speech(32 * WINDOW), silence(32 * WINDOW)]))
    await seg.end(10 * RATE)
    expect(starts[0]).toBe(0)                                          // speech at 512: its pre-roll stops at sample 0
    const second = (1 + 32 + 52) * WINDOW
    expect(starts[1]).toBe(second - PREROLL)                           // 250 ms before the second phrase
  })

  it('an end that is not window-aligned keeps its last words and none after it', async () => {
    const words: Word[] = []
    const seg = new Segmenter(new FakeVad(), fakeRecognizer(), (w) => words.push(...w))
    const last = 3 * RATE + 300                                        // not a multiple of 512
    seg.push(0, speech(last))
    seg.push(last, speech(2 * RATE))                                   // sent past the end: not the capture's
    await seg.end(last)
    expect(words.length).toBeGreaterThan(0)
    expect(Math.max(...words.map((w) => w.at))).toBeLessThanOrEqual(last)
    expect(Math.max(...words.map((w) => w.at))).toBeGreaterThan(last - RATE)   // the last second still has its word
  })
})

function concatAll(parts: Float32Array[]) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

describe('words: the audio socket', () => {
  const serve = async () => {
    const server: Server = createServer((_q, r) => { r.statusCode = 404; r.end() })
    const speechSvc = createSpeech()
    speechSvc.attach(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    return { server, port, speechSvc, close: () => { speechSvc.stop(); server.close() } }
  }
  const open = (port: number, ticket: string | null, origin = `http://127.0.0.1:${port}`, cookie = 'mv_c=abc') => new Promise<{ ok: boolean; ws: WebSocket; closed: Promise<number> }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${AUDIO_PATH}${ticket ? `?ticket=${ticket}` : ''}`, { headers: { origin, cookie } })
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    ws.on('open', () => resolve({ ok: true, ws, closed }))
    ws.on('error', () => resolve({ ok: false, ws, closed }))
  })

  it('a ticket is single-use and lives 30 s', () => {
    const t = issueTicket(1000)
    expect(takeTicket(t, 2000)).toBe(true)
    expect(takeTicket(t, 2000)).toBe(false)
    const old = issueTicket(1000)
    expect(takeTicket(old, 1000 + 30_001)).toBe(false)
  })

  it('refused without a ticket, with a used one, an expired one, the wrong Origin or no owner cookie; a second socket closes the first', async () => {
    const s = await serve()
    try {
      expect((await open(s.port, null)).ok).toBe(false)
      const t = issueTicket()
      const first = await open(s.port, t)
      expect(first.ok).toBe(true)
      expect((await open(s.port, t)).ok).toBe(false)                                   // used
      const expired = issueTicket(Date.now() - 31_000)
      expect((await open(s.port, expired)).ok).toBe(false)
      expect((await open(s.port, issueTicket(), 'http://evil.test')).ok).toBe(false)   // another origin
      expect((await open(s.port, issueTicket(), `http://localhost:${s.port + 1}`)).ok).toBe(false)   // another port
      expect((await open(s.port, issueTicket(), undefined, '')).ok).toBe(false)         // not the owner
      const second = await open(s.port, issueTicket())
      expect(second.ok).toBe(true)
      expect(await first.closed).toBe(4000)                                            // the first gave way
      second.ws.close()
    } finally { s.close() }
  })

  it('without a model, an end still answers final at once (typed notes only)', async () => {
    const prev = process.env.MARVER_MODELS
    process.env.MARVER_MODELS = join(import.meta.dirname, 'fixtures', 'no-models-here')
    const s = await serve()
    try {
      const c = await open(s.port, issueTicket())
      const id = 'cap-1792399514739-abcd12'
      const final = new Promise<any>((r) => c.ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'final') r(m) }))
      c.ws.send(JSON.stringify({ type: 'begin', capture: id }))
      c.ws.send(JSON.stringify({ type: 'end', capture: id, lastSample: 0 }))
      expect((await final).capture).toBe(id)
      c.ws.close()
    } finally { s.close(); if (prev === undefined) delete process.env.MARVER_MODELS; else process.env.MARVER_MODELS = prev }
  })
})

const haveModel = await modelsReady().catch(() => false)
describe.skipIf(!haveModel)('words: the model, on this Mac', () => {
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
  const transcribe = async (file: string) => {
    const w = new Worker(new URL('../src/server/jam/speech-worker.ts', import.meta.url), { workerData: { paths: modelPaths() } })
    try {
      await new Promise<void>((res, rej) => w.on('message', (m) => { if (m.type === 'ready') res(); if (m.type === 'unavailable') rej(new Error(m.reason)) }))
      const wav = sherpa.readWave(join(import.meta.dirname, 'fixtures', 'speech', file))
      expect(wav.sampleRate).toBe(RATE)
      const id = 'cap-1792399514739-abcd12'
      const words: Word[] = []
      w.postMessage({ type: 'begin', capture: id })
      for (let i = 0; i < wav.samples.length; i += 1600) {
        const s = wav.samples.subarray(i, i + 1600); const pcm = new Int16Array(s.length)
        for (let k = 0; k < s.length; k++) pcm[k] = Math.max(-32768, Math.min(32767, Math.round(s[k] * 32767)))
        w.postMessage({ type: 'audio', capture: id, offset: i, pcm }, [pcm.buffer])
      }
      await new Promise<void>((res) => { w.on('message', (m) => { if (m.type === 'words') words.push(...m.words); if (m.type === 'final') res() }); w.postMessage({ type: 'end', capture: id, lastSample: wav.samples.length }) })
      return words
    } finally { await w.terminate() }
  }
  const text = (ws: Word[]) => ws.map((w) => w.w).join(' ')
  const inOrder = (ws: Word[]) => ws.every((w, i) => i === 0 || w.at >= ws[i - 1].at)

  it('en.wav comes back word for word, each word with its time', async () => {
    const ws = await transcribe('en.wav')
    expect(text(ws)).toBe('This badge should match the plan badge, and the header crowds the toggle on laptop.')
    expect(inOrder(ws)).toBe(true)
    expect(ws[ws.length - 1].at).toBeGreaterThan(3 * RATE)
  }, 60_000)

  it('fr.wav comes back word for word, each word with its time', async () => {
    const ws = await transcribe('fr.wav')
    expect(text(ws)).toBe('Ce badge devrait ressembler au badge du plan, et le titre est trop serré sur le portable.')
    expect(inOrder(ws)).toBe(true)
  }, 60_000)
})
