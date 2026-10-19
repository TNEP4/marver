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
import { downloadModels, downloadState, dropLock, modelPaths, modelsReady, takeLock } from '../src/server/jam/speech-models.ts'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

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
    // the marker stands where its phrase was: the second 15 s (the first was being transcribed), and
    // words survive on both sides of it
    expect(lost[0].at).toBeGreaterThanOrEqual(MAX_PHRASE - WINDOW)
    expect(lost[0].at).toBeLessThanOrEqual(MAX_PHRASE + WINDOW)
    expect(words.some((w) => !w.lost && w.at < lost[0].at)).toBe(true)
    expect(words.some((w) => !w.lost && w.at > 2 * MAX_PHRASE)).toBe(true)
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

describe('words: review fixes (no model)', () => {
  it('a gap of minutes (a microphone opened late, a resumed capture) keeps every sample at its exact number', async () => {
    const words: Word[] = []
    const seg = new Segmenter(new FakeVad(), fakeRecognizer(), (w) => words.push(...w))
    seg.push(0, concatAll([speech(RATE), silence(RATE)]))
    seg.push(120 * RATE, concatAll([speech(RATE), silence(RATE)]))   // two minutes later
    await seg.end(123 * RATE)
    const later = words.filter((w) => w.at >= 100 * RATE)
    expect(later.length).toBeGreaterThan(0)
    expect(Math.min(...later.map((w) => w.at))).toBe(120 * RATE)      // no pre-roll across the gap, no drift
  })

  it('a dropped capture is discarded: nothing it holds is transcribed, no word is given', async () => {
    let calls = 0
    const words: Word[] = []
    const seg = new Segmenter(new FakeVad(), async () => { calls++; return { tokens: [' x'], timestamps: [0] } }, (w) => words.push(...w))
    seg.push(0, speech(2 * RATE))                                      // a phrase still being said
    seg.cancel()
    await seg.end(2 * RATE)
    seg.push(2 * RATE, concatAll([speech(RATE), silence(RATE)]))
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toBe(0)
    expect(words).toEqual([])
  })
})

describe('words: the download lock', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'mv-models-'))
  it('one installer at a time: a lock whose process is gone is reclaimed; a lock is released only by its owner', async () => {
    const d = dir(), lock = join(d, '.download.lock')
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, token: 'dead' }))   // no such process
    const t = await takeLock(lock, d)
    expect(typeof t === 'string' && t !== 'done').toBe(true)
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe(t)
    dropLock(lock, 'someone-else')
    expect(existsSync(lock)).toBe(true)                                              // not theirs to release
    dropLock(lock, t as string)
    expect(existsSync(lock)).toBe(false)
    rmSync(d, { recursive: true, force: true })
  })

  it('a lock that cannot be read fails the download with a reason - it never spins; an unwritable models folder fails it too', async () => {
    const d = dir(), lock = join(d, '.download.lock')
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'x' }))
    chmodSync(lock, 0o000)
    await expect(takeLock(lock, d)).rejects.toThrow()
    chmodSync(lock, 0o600)
    // a "folder" that is a file: nothing can be made in it
    const f = join(d, 'not-a-folder')
    writeFileSync(f, 'x')
    await downloadModels(join(f, 'models'), (async () => { throw new Error('no network in tests') }) as any)
    expect(downloadState().state).toBe('failed')
    expect(downloadState().error).toMatch(/could not start/)
    rmSync(d, { recursive: true, force: true })
  })

  it('a lock left half written by a process that died is reclaimed after the grace, never before', async () => {
    const d = dir(), lock = join(d, '.download.lock')
    writeFileSync(lock, '')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    const t = await takeLock(lock, d)
    expect(t).not.toBe('done')
    dropLock(lock, t as string)
    // a fresh empty one is someone writing it: waited for
    writeFileSync(lock, '')
    const waited = await Promise.race([takeLock(lock, d).then(() => 'took', () => 'gone'), new Promise((r) => setTimeout(() => r('waiting'), 1500))])
    expect(waited).toBe('waiting')
    rmSync(d, { recursive: true, force: true })
  })
})

describe('words: one audio connection, refereed (no model needed)', () => {
  it('the audio connection is busy while a segment is open, while its last words are not back, and just after it opened; a reclaim is refused while busy', async () => {
    // a stand-in engine that holds each final back for half a second
    const d = mkdtempSync(join(tmpdir(), 'mv-slowworker-'))
    const slow = join(d, 'w.mjs')
    writeFileSync(slow, "import { parentPort } from 'node:worker_threads'\nparentPort.postMessage({ type: 'ready' })\nparentPort.on('message', (m) => { if (m.type === 'end') setTimeout(() => parentPort.postMessage({ type: 'final', capture: m.capture }), 500) })\n")
    const server: Server = createServer((_q, r) => { r.statusCode = 404; r.end() })
    const svc = createSpeech({ workerUrl: new URL(`file://${slow}`), modelsReady: async () => true, engineMissing: () => undefined })
    svc.attach(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const connect = (reclaim = false) => new Promise<{ ok: boolean; ws: WebSocket }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${AUDIO_PATH}?ticket=${issueTicket()}${reclaim ? '&reclaim=1' : ''}`, { headers: { origin: `http://127.0.0.1:${port}`, cookie: 'mv_c=abc' } })
      ws.on('open', () => resolve({ ok: true, ws })); ws.on('error', () => resolve({ ok: false, ws }))
    })
    try {
      const a = await connect()
      expect(svc.busy()).toBe(true)                                   // just opened: its page is still starting
      expect((await connect(true)).ok).toBe(false)
      await new Promise((r) => setTimeout(r, 5_100))                  // past the opening's grace: idle, free
      expect(svc.busy()).toBe(false)
      const id = 'cap-1792399514739-busy01~p1'
      a.ws.send(JSON.stringify({ type: 'begin', capture: id }))
      await new Promise((r) => setTimeout(r, 200))
      expect(svc.busy()).toBe(true)                                   // a segment open
      expect((await connect(true)).ok).toBe(false)                    // a reclaim never takes it from a working tab
      a.ws.send(JSON.stringify({ type: 'end', capture: id, lastSample: 0 }))
      await new Promise((r) => setTimeout(r, 150))
      expect(svc.busy()).toBe(true)                                   // ended, its final held back
      expect((await connect(true)).ok).toBe(false)
      await new Promise((r) => setTimeout(r, 700))
      expect(svc.busy()).toBe(false)                                  // the final is back
      const b = await connect(true)
      expect(b.ok).toBe(true)                                         // free: taken back
      b.ws.close()
    } finally { svc.stop(); server.close(); rmSync(d, { recursive: true, force: true }) }
  }, 30_000)
})

describe('words: a session ending waits for its last words (no model needed)', () => {
  it('finishTalk says whether the talk is whole: false while its last words are still not back, true once they are', async () => {
    // a stand-in engine that holds each final back for 1.2 s; the ending waits 400 ms here
    const d = mkdtempSync(join(tmpdir(), 'mv-slowtalk-'))
    const slow = join(d, 'w.mjs')
    writeFileSync(slow, "import { parentPort } from 'node:worker_threads'\nparentPort.postMessage({ type: 'ready' })\nparentPort.on('message', (m) => { if (m.type === 'end') setTimeout(() => parentPort.postMessage({ type: 'final', capture: m.capture }), 1200) })\n")
    const server: Server = createServer((_q, r) => { r.statusCode = 404; r.end() })
    const svc = createSpeech({ workerUrl: new URL(`file://${slow}`), talkWaitMs: 400, modelsReady: async () => true, engineMissing: () => undefined })
    svc.attach(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}${AUDIO_PATH}?ticket=${issueTicket()}`, { headers: { origin: `http://127.0.0.1:${port}`, cookie: 'mv_c=abc' } })
      w.on('open', () => resolve(w)); w.on('error', reject)
    })
    try {
      const ses = 'ses-1792399514739-talk01'
      ws.send(JSON.stringify({ type: 'begin', capture: `${ses}~p1`, t0: 0 }))
      await new Promise((r) => setTimeout(r, 300))
      expect(await svc.finishTalk(ses)).toBe(false)                    // its final is still held back
      expect(await svc.finishTalk('ses-1792399514739-other1')).toBe(true)   // another session: nothing to wait for
      await new Promise((r) => setTimeout(r, 1200))
      expect(await svc.finishTalk(ses)).toBe(true)                     // back: the transcript is whole
    } finally { ws.close(); svc.stop(); server.close(); rmSync(d, { recursive: true, force: true }) }
  }, 20_000)
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

  it('an audio chunk names its capture: one for a capture not begun, ended or dropped is not taken; an end for an unknown capture is final, incomplete', async () => {
    const s = await serve()
    try {
      const c = await open(s.port, issueTicket())
      const got: any[] = []
      c.ws.on('message', (d) => got.push(JSON.parse(String(d))))
      const frame = (id: string, offset: number) => { const idb = Buffer.from(id); const pcm = Buffer.alloc(3200); const b = Buffer.alloc(1 + idb.length + 4); b[0] = idb.length; idb.copy(b, 1); b.writeUInt32LE(offset, 1 + idb.length); return Buffer.concat([b, pcm]) }
      c.ws.send(frame('cap-1792399514739-nobody~p1', 0))                    // never begun: dropped quietly
      c.ws.send(JSON.stringify({ type: 'end', capture: 'cap-1792399514739-nobody~p1', lastSample: 0 }))
      await new Promise((r) => setTimeout(r, 100))
      expect(got).toContainEqual({ type: 'final', capture: 'cap-1792399514739-nobody~p1', incomplete: true })
      c.ws.close()
    } finally { s.close() }
  })

  it('a capture whose words could not start can begin again (the microphone asked again) - it is told again, never left silent', async () => {
    const prev = process.env.MARVER_MODELS
    process.env.MARVER_MODELS = join(import.meta.dirname, 'fixtures', 'no-models-here')
    const s = await serve()
    try {
      const c = await open(s.port, issueTicket())
      const got: any[] = []
      c.ws.on('message', (d) => got.push(JSON.parse(String(d))))
      const id = 'cap-1792399514739-again1~p1'
      c.ws.send(JSON.stringify({ type: 'begin', capture: id }))
      await new Promise((r) => setTimeout(r, 150))
      c.ws.send(JSON.stringify({ type: 'begin', capture: id }))
      await new Promise((r) => setTimeout(r, 150))
      expect(got.filter((m) => m.type === 'unavailable' && m.capture === id).length).toBe(2)
      c.ws.close()
    } finally { s.close(); if (prev === undefined) delete process.env.MARVER_MODELS; else process.env.MARVER_MODELS = prev }
  })

  it('without a model, an end still answers final at once (typed notes only)', async () => {
    const prev = process.env.MARVER_MODELS
    process.env.MARVER_MODELS = join(import.meta.dirname, 'fixtures', 'no-models-here')
    const s = await serve()
    try {
      const c = await open(s.port, issueTicket())
      const id = 'cap-1792399514739-abcd12~p1'
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
  it('a dropped capture gives no words, even with speech already sent', async () => {
    const w = new Worker(new URL('../src/server/jam/speech-worker.ts', import.meta.url), { workerData: { paths: modelPaths() } })
    try {
      await new Promise<void>((res, rej) => w.on('message', (m) => { if (m.type === 'ready') res(); if (m.type === 'unavailable') rej(new Error(m.reason)) }))
      const wav = sherpa.readWave(join(import.meta.dirname, 'fixtures', 'speech', 'en.wav'))
      const id = 'cap-1792399514739-drop12'
      const out: any[] = []
      w.on('message', (m) => { if (m.capture === id) out.push(m) })
      w.postMessage({ type: 'begin', capture: id })
      const pcm = new Int16Array(wav.samples.length)
      for (let k = 0; k < pcm.length; k++) pcm[k] = Math.round(wav.samples[k] * 32767)
      w.postMessage({ type: 'audio', capture: id, offset: 0, pcm })
      w.postMessage({ type: 'drop', capture: id })
      await new Promise((r) => setTimeout(r, 1500))
      expect(out.filter((m) => m.type === 'words')).toEqual([])
    } finally { await w.terminate() }
  }, 60_000)

  it('an engine that fails to start says why, and a yes tries it again (only the engine missing stays)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'mv-failworker-'))
    const bad = join(d, 'w.mjs')
    writeFileSync(bad, "import { parentPort } from 'node:worker_threads'\nparentPort.postMessage({ type: 'unavailable', reason: 'native module failed' })\n")
    const svc = createSpeech({ workerUrl: new URL(`file://${bad}`) })
    try {
      await svc.state()                                    // starts it
      await new Promise((r) => setTimeout(r, 500))
      const st = await svc.state()
      expect(st.state).toBe('unavailable')
      expect(st.reason).toMatch(/native module failed/)
      svc.retry()
      expect((await svc.state()).state).toBe('loading')    // tried again, not latched
    } finally { svc.stop(); rmSync(d, { recursive: true, force: true }) }
  }, 30_000)


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
