/**
 * One capture's audio, cut into phrases and transcribed in order (spec 27, Part 4) - the logic, free of
 * the model, so it is tested with a fake VAD and a fake recognizer. Samples are 16 kHz mono, numbered
 * from the capture's start (sample 0 is the mark at `S`): pre-roll can never reach before it.
 *
 * - Silero VAD cuts phrases (0.4 s of silence ends one). Marver also cuts at 15 s: it counts the samples
 *   since a phrase began and, at 15 s, calls `vad.flush()` - the next phrase starts at the next sample.
 * - Each phrase keeps 250 ms of the audio before it (the VAD clipped first words), never from before the
 *   capture, and never across a forced cut (that audio is already in the phrase before).
 * - At most 30 s of audio waits for transcription; past that the oldest waiting phrase is dropped and
 *   the transcript says "[words lost]" where it was.
 * - `end(lastSample)` pads the last partial VAD window with silence (the VAD only takes whole windows),
 *   flushes, transcribes what is left, drops any word timed after `lastSample`, and resolves.
 * Raw audio lives only in memory, and only as long as it is needed.
 */

export const RATE = 16_000
export const WINDOW = 512
export const PREROLL = Math.round(0.25 * RATE)
export const MAX_PHRASE = 15 * RATE
export const MAX_WAITING = 30 * RATE
/** How much recent audio is kept for pre-roll - a little over the longest phrase plus its pre-roll. */
const HISTORY = MAX_PHRASE + 2 * RATE

/** The slice of sherpa-onnx's Vad this needs. */
export interface VadLike {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  front(): { start: number; samples: Float32Array }
  pop(): void
  flush(): void
  isDetected(): boolean
}
/** A recognizer's answer for one phrase: its tokens and each token's start in seconds from the phrase's start. */
export interface Recognized { tokens: string[]; timestamps: number[] }
export type Recognize = (samples: Float32Array) => Promise<Recognized> | Recognized

/** A word and the sample it starts at (capture samples). `lost` marks dropped audio. */
export interface Word { w: string; at: number; lost?: true }

/** Tokens to words: a token that starts with a space or `▁` starts a word; the word's time is its first
 *  token's. */
export function tokensToWords(r: Recognized, phraseStart: number): Word[] {
  const out: Word[] = []
  r.tokens.forEach((t, i) => {
    const at = phraseStart + Math.round((r.timestamps[i] ?? 0) * RATE)
    const starts = /^[\s▁]/.test(t) || !out.length
    const text = t.replace(/^[\s▁]+/, '')
    if (starts) { if (text) out.push({ w: text, at }) } else if (out.length) out[out.length - 1].w += text
  })
  return out
}

interface Phrase { start: number; samples: Float32Array }

export class Segmenter {
  private pending = new Float32Array(0)       // a partial VAD window, kept for the next samples
  private fed = 0                             // samples given to the VAD so far
  private history = new Float32Array(HISTORY) // the last HISTORY samples, by sample number mod HISTORY
  private speech = 0                          // samples since the phrase now being said began
  private forcedAt = -1                       // where the last forced cut fell (no pre-roll across it)
  private waiting: Phrase[] = []              // phrases waiting for the recognizer
  private busy = false
  private idle: (() => void)[] = []
  private last = Infinity                     // the capture's last sample, once it ended
  private ended = false
  private vad: VadLike
  private recognize: Recognize
  private onWords: (words: Word[]) => void
  constructor(vad: VadLike, recognize: Recognize, onWords: (words: Word[]) => void) {
    this.vad = vad; this.recognize = recognize; this.onWords = onWords
  }

  /** The samples from `offset` on (the page numbers them; a gap is silence, an overlap is skipped). */
  push(offset: number, pcm: Float32Array) {
    if (this.ended) return
    const have = this.fed + this.pending.length
    if (offset > have) this.push(have, new Float32Array(Math.min(offset - have, 60 * RATE)))   // a gap: silence
    const skip = Math.max(0, have - offset)
    if (skip >= pcm.length) return
    this.take(pcm.subarray(skip))
  }

  private take(pcm: Float32Array) {
    let buf = this.pending.length ? concat(this.pending, pcm) : pcm
    let i = 0
    for (; i + WINDOW <= buf.length; i += WINDOW) this.window(buf.subarray(i, i + WINDOW))
    this.pending = buf.slice(i)
  }

  private window(w: Float32Array) {
    for (let k = 0; k < w.length; k++) this.history[(this.fed + k) % HISTORY] = w[k]
    this.vad.acceptWaveform(w)
    this.fed += w.length
    if (this.vad.isDetected()) {
      this.speech += w.length
      // continuous speech: Marver cuts at 15 s (the VAD's own limit only lowers its silence threshold)
      // (the phrase the cut closes is taken first, measured against the cut before it - then this cut counts)
      if (this.speech >= MAX_PHRASE) { this.vad.flush(); this.drain(); this.forcedAt = this.fed; this.speech = 0 }
    } else this.speech = 0
    this.drain()
  }

  /** Phrases the VAD has finished, each with its pre-roll, into the waiting list. */
  private drain() {
    while (!this.vad.isEmpty()) {
      const seg = this.vad.front()
      this.vad.pop()
      // never before the capture's start, never across a forced cut, never older than the history holds
      const floor = Math.max(0, this.forcedAt >= 0 && this.forcedAt <= seg.start ? this.forcedAt : 0, this.fed - HISTORY)
      const from = Math.max(floor, seg.start - PREROLL)
      const pre = new Float32Array(Math.max(0, seg.start - from))
      for (let k = 0; k < pre.length; k++) pre[k] = this.history[(from + k) % HISTORY]
      this.enqueue({ start: from, samples: pre.length ? concat(pre, seg.samples) : seg.samples })
    }
  }

  private enqueue(p: Phrase) {
    this.waiting.push(p)
    // at most 30 s waits: the oldest waiting phrase goes, and the transcript says so where it was
    while (this.waiting.length > 1 && this.waiting.reduce((n, x) => n + x.samples.length, 0) > MAX_WAITING) {
      const gone = this.waiting.shift()!
      this.onWords([{ w: '[words lost]', at: gone.start, lost: true }])
    }
    void this.run()
  }

  private async run() {
    if (this.busy) return
    this.busy = true
    try {
      while (this.waiting.length) {
        const p = this.waiting.shift()!
        let words: Word[] = []
        try { words = tokensToWords(await this.recognize(p.samples), p.start) } catch { words = [{ w: '[words lost]', at: p.start, lost: true }] }
        const kept = words.filter((x) => x.at <= this.last)
        if (kept.length) this.onWords(kept)
      }
    } finally {
      this.busy = false
      if (!this.waiting.length) for (const f of this.idle.splice(0)) f()
      else void this.run()
    }
  }

  /** The capture ended at `lastSample`: the partial window padded with silence, the VAD flushed, the
   *  rest transcribed; resolves when every word up to `lastSample` has been given. */
  end(lastSample: number): Promise<void> {
    if (!this.ended) {
      this.last = lastSample
      // only what was said up to the last sample: anything sent past it is not the capture's
      const keep = Math.max(0, Math.min(this.pending.length, lastSample - this.fed))
      if (keep > 0) { const w = new Float32Array(WINDOW); w.set(this.pending.subarray(0, Math.min(keep, WINDOW))); this.pending = new Float32Array(0); this.window(w) }
      this.pending = new Float32Array(0)
      this.ended = true
      this.vad.flush()
      this.drain()
    }
    return this.busy || this.waiting.length ? new Promise((r) => { this.idle.push(r); void this.run() }) : Promise.resolve()
  }
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length)
  out.set(a, 0); out.set(b, a.length)
  return out
}
