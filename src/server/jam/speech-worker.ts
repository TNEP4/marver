/**
 * The speech worker (spec 27, Part 4): a worker thread, so decoding never blocks the dev server. It
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

const port = parentPort!
const paths = (workerData as { paths: ModelPaths }).paths

let sherpa: any
let recognizer: any
try {
  sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: paths.encoder, decoder: paths.decoder, joiner: paths.joiner },
      tokens: paths.tokens, numThreads: 2, provider: 'cpu', modelType: 'nemo_transducer',
    },
  })
  port.postMessage({ type: 'ready' })
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
  const s = recognizer.createStream()
  s.acceptWaveform({ sampleRate: RATE, samples })
  recognizer.decode(s)
  const r = recognizer.getResult(s)
  return { tokens: r.tokens ?? [], timestamps: r.timestamps ?? [] }
}

const captures = new Map<string, Segmenter>()

port.on('message', (m: any) => {
  if (!recognizer || !m || typeof m.capture !== 'string') return
  const id: string = m.capture
  if (m.type === 'begin') {
    if (!captures.has(id)) captures.set(id, new Segmenter(vadFor(), recognize, (words) => port.postMessage({ type: 'words', capture: id, words })))
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
