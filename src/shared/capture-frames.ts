// Shared by the server (a capture's frames: what its run reserves and shoots before and after, jam/capture.ts)
// and the page (what a capture pictures as it ends, shell/jam-capture.ts): one rule for which frames a capture
// is about.

type Step = { at: number; frame?: string; event: string; [k: string]: unknown }

/** The frames a capture is about: the ones you touched - selected, pointed at, clicked, typed in, scrolled,
 *  resized, copied or pictured with I, a screen you went to in play - and a frame you brought into view alone
 *  (zoomed or panned to it). A frame that was merely on screen beside them is not one of them: it costs a
 *  picture before and after the run, and holds the frame for nothing. A hover is the pointer resting - it
 *  counts only when nothing else was touched (trial 4: a pointer resting on a frame as a capture began held
 *  that frame, and the next capture, about it, waited for a run that never meant to change it). With none
 *  touched, the frames in view as it began (three at most) - the agent still has the place you were talking about. */
export function touchedFrames(timeline: readonly Step[], view?: { frames?: string[] }, fallback = true, resumedAt?: number): string[] {
  // a resumed capture is two recordings: each keeps the frames it was about (the first part's, as they were
  // before the resume, and the new part's) - the run must still reach what the first part asked for
  if (resumedAt !== undefined) {
    const before = touchedFrames(timeline.filter((s) => s.at < resumedAt), view, fallback)
    const after = touchedFrames(timeline.filter((s) => s.at >= resumedAt), undefined, false)
    return [...new Set([...before, ...after])]
  }
  const out: string[] = []
  const hovered: string[] = []
  const add = (f?: unknown, to = out) => { if (typeof f === 'string' && f && !to.includes(f)) to.push(f) }
  for (const s of timeline) {
    switch (s.event) {
      case 'select': (s.frames as string[] | undefined)?.forEach((f) => add(f)); break
      case 'pick': case 'click': case 'field': case 'scroll': case 'device': case 'copied': add(s.frame); break
      case 'hover': add(s.frame, hovered); break
      // a picture you asked for (I); the automatic ones follow the frames, they never make one
      case 'picture': if (s.why === 'key') add(s.frame); break
      case 'screen': add(s.to); break
      case 'view': { const f = (s.view as { frames?: string[] } | undefined)?.frames; if (f?.length === 1) add(f[0]); break }
    }
  }
  if (out.length) return out
  if (hovered.length || !fallback) return hovered
  // none touched: the first view that showed any frame (it may have begun over empty canvas), three at most
  const firstView = timeline.flatMap((s) => (s.event === 'view' ? [(s.view as { frames?: string[] } | undefined)?.frames ?? []] : [])).find((f) => f.length)
  return (firstView ?? view?.frames ?? []).slice(0, 3)
}
