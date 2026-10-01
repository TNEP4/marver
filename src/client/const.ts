/** Client-safe constants. The single source - src/cli/name.ts re-exports for node-side code.
 *  Lives under src/client because that is the only source directory shipped in the package. */
export const NAME = 'marver'
export const PKG = '@marver-design/marver'   // registry identity; bin stays `marver`
export const ROUTE = '/__mv'

/** Content-frame natural widths: Doc layout -> own-size width.
 *  Shared by the Doc primitive (measurement messages) and the server-side
 *  manifest scan (defaultSize for content frames) - one source, no drift. */
export const CONTENT_WIDTH: Record<string, number> = { document: 760, wide: 1280 }

/** The default slide stage: 16:9 at 1280×720, deliberately NOT a config viewport - no
 *  migration for existing projects, no deck device in sweeps. Dependency-neutral so
 *  server (shot) and shell (store, play) share it. */
export const SLIDE_INTRINSIC = { width: 1280, height: 720 }

/** The one sizing rule for slide frames, shared by canvas, shot and slides mode: a
 *  `slide: true` frame's stage is its declared viewport when the project defines one
 *  (a 16:10 deck authored at `laptop` stays 1280×800), else the 1280×720 default. A
 *  slide is an ordinary frame at that size - slides mode scales the whole stage to the
 *  screen, so the frame never has to. */
export function slideSize(
  frame: { slide?: boolean; viewport?: string },
  viewports: Record<string, { width: number; height: number }> = {},
): { width: number; height: number } | null {
  if (!frame.slide) return null
  const vp = frame.viewport ? viewports[frame.viewport] : undefined
  return vp ? { width: vp.width, height: vp.height } : SLIDE_INTRINSIC
}

/** How a slide's stage sits in a box of any other size: scaled uniformly to fit and centred.
 *  A slide never reflows - the canvas node, the player and a shot all show the same stage. */
export function stageFit(stage: { width: number; height: number }, box: { w: number; h: number }): { k: number; ox: number; oy: number } {
  const k = Math.max(0.01, Math.min(box.w / stage.width, box.h / stage.height))
  return { k, ox: (box.w - stage.width * k) / 2, oy: (box.h - stage.height * k) / 2 }
}
