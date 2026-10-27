/**
 * The speech worker (spec 27, Part 4): a process of its own, so decoding never blocks the dev server - and a
 * native crash in the engine (an ONNX error is a C++ exception no thread can catch) ends transcription, never
 * the canvas (27 Oct: one took a whole canvas down mid-session). It also still runs as a worker thread. It
 * loads `sherpa-onnx-node` (an optional dependency) and the checked model once, then runs one Segmenter
 * per capture - Silero VAD for phrases, Parakeet v3 for words.
 *
 *   in  : { type: 'begin', capture } · { type: 'audio', capture, offset, pcm: Int16Array }
 *         { type: 'end', capture, lastSample } · { type: 'drop', capture }
 *   out : { type: 'ready' } · { type: 'unavailable', reason } · { type: 'words', capture, words }
 *         { type: 'final', capture }
 */
import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'
import { Segmenter, RATE, WINDOW, type Recognized, type VadLike } from './speech-cut.ts'
import type { ModelPaths } from './speech-models.ts'

// a child process (the dev server forks it) or a worker thread: the same messages either way
const port: { postMessage(m: unknown): void; on(ev: 'message', f: (m: any) => void): void } = parentPort ?? {
  postMessage: (m) => { try { process.send?.(m) } catch { /* the server went: nothing to tell */ } },
  on: (ev, f) => { process.on(ev, f) },
}
const paths: ModelPaths = parentPort ? (workerData as { paths: ModelPaths }).paths : JSON.parse(process.env.MARVER_SPEECH_PATHS ?? '{}')
// a forked engine ends with the server that forked it
if (!parentPort) process.on('disconnect', () => process.exit(0))

/** Shorter than this is no phrase at all: the recognizer is never handed it (an empty one crashed it, 27 Oct). */
const MIN_SAMPLES = RATE / 10

let sherpa: any
let recognizer: any
const loadStart = performance.now()
try {
  sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: paths.encoder, decoder: paths.decoder, joiner: paths.joiner },
      tokens: paths.tokens, numThreads: 2, provider: 'cpu', modelType: 'nemo_transducer',
    },
  })
  port.postMessage({ type: 'ready', modelLoadMs: performance.now() - loadStart })
} catch (err) {
  port.postMessage({ type: 'unavailable', reason: (err as Error).message })
}

const vadFor = (): VadLike => new sherpa.Vad({
  sileroVad: { model: paths.vad, threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.4, windowSize: WINDOW },
  sampleRate: RATE, debug: false, numThreads: 1,
}, 30)

// Decoding is synchronous and blocks this thread's messages: before each phrase the thread yields a turn,
// so audio that arrived meanwhile is cut into phrases first - and counted against the 30 s that may wait.
const turn = () => new Promise<void>((r) => setImmediate(r))
const recognize = async (samples: Float32Array): Promise<Recognized> => {
  await turn()
  if (samples.length < MIN_SAMPLES) return { tokens: [], timestamps: [], ms: 0 }
  // timed after its turn: the wait for it is the phrase's wait, not its transcription
  const t0 = performance.now()
  const s = recognizer.createStream()
  s.acceptWaveform({ sampleRate: RATE, samples })
  recognizer.decode(s)
  const r = recognizer.getResult(s)
  return { tokens: r.tokens ?? [], timestamps: r.timestamps ?? [], ms: performance.now() - t0 }
}

const captures = new Map<string, Segmenter>()

port.on('message', (m: any) => {
  if (!recognizer || !m || typeof m.capture !== 'string') return
  const id: string = m.capture
  if (m.type === 'begin') {
    // one recognizer for every capture: what waits for it is all of theirs
    if (!captures.has(id)) captures.set(id, new Segmenter(vadFor(), recognize, (words) => port.postMessage({ type: 'words', capture: id, words }), (t) => port.postMessage({ type: 'timing', ...t }),
      () => [...captures.values()].reduce((n, x) => n + x.waitingSamples + x.decodingSamples, 0)))
  } else if (m.type === 'audio') {
    const seg = captures.get(id)
    if (!seg || !(m.pcm instanceof Int16Array)) return
    const f = new Float32Array(m.pcm.length)
    for (let i = 0; i < f.length; i++) f[i] = m.pcm[i] / 32768
    seg.push(m.offset, f)
  } else if (m.type === 'end') {
    const seg = captures.get(id)
    if (!seg) { port.postMessage({ type: 'final', capture: id, incomplete: true }); return }   // never begun here (a new worker)
    void seg.end(Number(m.lastSample) || 0).then(() => { captures.delete(id); port.postMessage({ type: 'final', capture: id }) })
  } else if (m.type === 'drop') {
    // dropped: what it holds goes, untranscribed; nothing more is said about it
    captures.get(id)?.cancel()
    captures.delete(id)
  }
})
