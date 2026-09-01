/**
 * The notification ping - two soft sine tones, generated, no asset to load.
 * Autoplay policy makes this best-effort by nature: the context only runs
 * after the person has interacted with the page (they are ON the canvas, so
 * in practice it plays). Every failure path is silence, never an error.
 */
let ctx: AudioContext | null = null

export function playPing(): void {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') {
      // resume() only sticks inside a user gesture; fire-and-forget - if the
      // browser refuses, this ping is silent and the NEXT one plays
      void ctx.resume().catch(() => {})
      if (ctx.state === 'suspended') return
    }
    const t0 = ctx.currentTime
    for (const [freq, at, dur] of [[880, 0, .09], [1174.7, .09, .16]] as const) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, t0 + at)
      gain.gain.linearRampToValueAtTime(.14, t0 + at + .015)
      gain.gain.exponentialRampToValueAtTime(.0001, t0 + at + dur)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t0 + at)
      osc.stop(t0 + at + dur + .02)
    }
  } catch { /* no audio here - fine */ }
}
