// Shared by the server (a capture's frames: what its run reserves and shoots before and after, jam/capture.ts)
// and the page (what a capture pictures as it ends, shell/jam-capture.ts): one rule for which frames a capture
// is about.

type Step = { at: number; frame?: string; event: string; [k: string]: unknown }

/** The frames a capture is about: the ones you touched - selected, pointed at, clicked, hovered, typed in,
 *  scrolled, resized, copied or pictured with I, a screen you went to in play - and a frame you brought into
 *  view alone (zoomed or panned to it). A frame that was merely on screen beside them is not one of them: it
 *  costs a picture before and after the run, and holds the frame for nothing. With none touched, the frames
 *  in view as it began (three at most) - the agent still has the place you were talking about. */
export function touchedFrames(timeline: readonly Step[], view?: { frames?: string[] }, fallback = true): string[] {
  const out: string[] = []
  const add = (f?: unknown) => { if (typeof f === 'string' && f && !out.includes(f)) out.push(f) }
  for (const s of timeline) {
    switch (s.event) {
      case 'select': (s.frames as string[] | undefined)?.forEach(add); break
      case 'pick': case 'click': case 'hover': case 'field': case 'scroll': case 'device': case 'copied': add(s.frame); break
      // a picture you asked for (I); the automatic ones follow the frames, they never make one
      case 'picture': if (s.why === 'key') add(s.frame); break
      case 'screen': add(s.to); break
      case 'view': { const f = (s.view as { frames?: string[] } | undefined)?.frames; if (f?.length === 1) add(f[0]); break }
    }
  }
  if (out.length || !fallback) return out
  const first = (timeline.find((s) => s.event === 'view')?.view as { frames?: string[] } | undefined)?.frames ?? view?.frames ?? []
  return first.slice(0, 3)
}
